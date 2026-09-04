import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type HnsCommunityRootImportPreparation,
  HnsCommunityRootImportStorageFailed,
  startHnsCommunityRootImport,
} from "./hns-community-root-import.ts";

const preparation: HnsCommunityRootImportPreparation = {
  actor_id: "actor-1",
  community_id: "community-1",
  attachment_intent_id: "attachment-1",
  ceremony_intent_id: "ceremony-1",
  root_label: "dankmemes",
  attachment_revision: 1,
  root_import_session_id: "root-import-1",
  provision_job_id: "provision-1",
};

function services(options: { readonly mismatch?: boolean; readonly conflict?: boolean } = {}) {
  let ownershipInput: unknown;
  let stored: unknown;
  return {
    ownershipInput: () => ownershipInput,
    stored: () => stored,
    value: {
      ids: {
        attachmentIntent: () => "unused-attachment",
        ceremonyIntent: () => "unused-ceremony",
        rootImportSession: () => "unused-session",
        provisionJob: () => "unused-job",
      },
      ownership: {
        start: (input: unknown) => {
          ownershipInput = input;
          return Effect.succeed({
            operation_kind: "route_attachment" as const,
            community_id: options.mismatch ? "community-2" : preparation.community_id,
            attachment_intent_id: preparation.attachment_intent_id,
            ceremony_intent_id: preparation.ceremony_intent_id,
            generation: 1,
            session_id: "namespace-1",
            channel: "poll_result" as const,
            status: "pending" as const,
            expires_at: "2026-09-11T00:00:00.000Z",
            challenge: {
              ownership_source: "hns_parent_chain_txt" as const,
              challenge_name: "dankmemes",
              challenge_value: "pirate-verification=challenge",
              record: { type: "TXT" as const, txt: ["pirate-verification=challenge"] as const },
              expires_at: "2026-09-11T00:00:00.000Z",
            },
            replayed: false,
          });
        },
      },
      store: {
        prepare: () =>
          Effect.succeed(
            options.conflict
              ? ({ kind: "conflict" as const } as const)
              : ({ kind: "created" as const, value: preparation } as const),
          ),
        start: (input: unknown) => {
          stored = input;
          return Effect.succeed({
            kind: "created" as const,
            session: {
              community_id: preparation.community_id,
              attachment_intent_id: preparation.attachment_intent_id,
              root_import_session_id: preparation.root_import_session_id,
              root_label: preparation.root_label,
              revision: 1,
              expires_at: "2026-09-11T00:00:00.000Z",
              replayed: false,
              status: "awaiting_ownership" as const,
              provisioning_authorization: {
                kind: "hns_name_signature_v1" as const,
                wallet_rpc_method: "signmessagewithname" as const,
                message: '["pirate-hns-community-root-import-name-proof-v1","fixture"]',
                expires_at: "2026-09-11T00:00:00.000Z",
              },
              publish_plan: null,
              publish_plan_sha256: null,
              readiness_result_sha256: null,
              retry_after_seconds: 5,
            },
          });
        },
      },
    },
  };
}

describe("community HNS root import", () => {
  test("creates a community-keyed attachment and retains the provider challenge", async () => {
    const dependencies = services();
    const result = await Effect.runPromise(
      startHnsCommunityRootImport(
        {
          actor_id: "actor-1",
          community_id: "community-1",
          root_label: "dankmemes",
          idempotency_key: "start-1",
        },
        dependencies.value,
      ),
    );
    expect(result.status).toBe("awaiting_ownership");
    expect(dependencies.ownershipInput()).toMatchObject({
      actor_id: "actor-1",
      community_id: "community-1",
      attachment_intent_id: "attachment-1",
      ceremony_intent_id: "ceremony-1",
      expected_revision: 1,
    });
    expect(dependencies.stored()).toMatchObject({
      preparation,
      ownership: { status: "pending", session_id: "namespace-1" },
      idempotency_key: "start-1",
    });
  });

  test("fails before provider work when current community authority is unavailable", async () => {
    const dependencies = services({ conflict: true });
    await expect(
      Effect.runPromise(
        startHnsCommunityRootImport(
          {
            actor_id: "actor-1",
            community_id: "community-1",
            root_label: "dankmemes",
            idempotency_key: "start-1",
          },
          dependencies.value,
        ),
      ),
    ).rejects.toMatchObject({ _tag: "HnsCommunityRootImportRejected", reason: "conflict" });
    expect(dependencies.ownershipInput()).toBeUndefined();
  });

  test("rejects substituted provider authority before persistence", async () => {
    const dependencies = services({ mismatch: true });
    await expect(
      Effect.runPromise(
        startHnsCommunityRootImport(
          {
            actor_id: "actor-1",
            community_id: "community-1",
            root_label: "dankmemes",
            idempotency_key: "start-1",
          },
          dependencies.value,
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "HnsCommunityRootImportRejected",
      reason: "ownership_unavailable",
    });
    expect(dependencies.stored()).toBeUndefined();
  });

  test("surfaces storage failure without converting it to a client conflict", async () => {
    const dependencies = services();
    const failing = {
      ...dependencies.value,
      store: {
        ...dependencies.value.store,
        prepare: () => Effect.fail(new HnsCommunityRootImportStorageFailed()),
      },
    };
    await expect(
      Effect.runPromise(
        startHnsCommunityRootImport(
          {
            actor_id: "actor-1",
            community_id: "community-1",
            root_label: "dankmemes",
            idempotency_key: "start-1",
          },
          failing,
        ),
      ),
    ).rejects.toMatchObject({ _tag: "HnsCommunityRootImportStorageFailed" });
  });
});
