import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  getHnsCommunityRootImport,
  type HnsCommunityRootImportPreparation,
  HnsCommunityRootImportStorageFailed,
  pollHnsCommunityRootImport,
  startHnsCommunityRootImport,
} from "./hns-community-root-import.ts";
import {
  encodeHnsRootImportNameProofResultV1,
  HNS_ROOT_IMPORT_NAME_PROOF_RESULT_VERSION,
} from "./hns-root-import-name-proof.ts";

const encoder = new TextEncoder();
const signature = btoa("s".repeat(64));

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
  test("verifies the retained community message before provisioning", async () => {
    const message = '["pirate-hns-community-root-import-name-proof-v1","fixture"]';
    const awaiting = {
      community_id: "community-1",
      attachment_intent_id: "attachment-1",
      root_import_session_id: "root-import-1",
      root_label: "dankmemes",
      revision: 1,
      expires_at: "2099-01-01T00:00:00.000Z",
      replayed: false,
      status: "awaiting_ownership" as const,
      provisioning_authorization: {
        kind: "hns_name_signature_v1" as const,
        wallet_rpc_method: "signmessagewithname" as const,
        message,
        expires_at: "2099-01-01T00:00:00.000Z",
      },
      publish_plan: null,
      publish_plan_sha256: null,
      readiness_result_sha256: null,
      retry_after_seconds: 5,
    };
    const provisioning = {
      community_id: awaiting.community_id,
      attachment_intent_id: awaiting.attachment_intent_id,
      root_import_session_id: awaiting.root_import_session_id,
      root_label: awaiting.root_label,
      revision: 2,
      expires_at: awaiting.expires_at,
      replayed: false,
      status: "provisioning" as const,
      publish_plan: null,
      publish_plan_sha256: null,
      readiness_result_sha256: null,
      retry_after_seconds: 2,
    };
    let stored: unknown;
    const result = await Effect.runPromise(
      pollHnsCommunityRootImport(
        {
          actor_id: "actor-1",
          community_id: "community-1",
          root_import_session_id: "root-import-1",
          expected_revision: 1,
          idempotency_key: "poll-1",
          provisioning_name_signature: signature,
        },
        {
          nameProof: {
            verify: (input) =>
              Effect.promise(async () => {
                const bytes = encodeHnsRootImportNameProofResultV1({
                  version: HNS_ROOT_IMPORT_NAME_PROOF_RESULT_VERSION,
                  root_label: input.root_label,
                  message_sha256: await digest(encoder.encode(input.message)),
                  signature_sha256: await digest(encoder.encode(input.signature)),
                  safe: true,
                  verified: true,
                });
                return { result_bytes: bytes, result_sha256: await digest(bytes) };
              }),
          },
          completion: { complete: () => Effect.die("completion not expected") },
          store: {
            get: () => Effect.die("get not expected"),
            loadPollAuthority: () =>
              Effect.succeed({
                session: awaiting,
                ceremony_intent_id: "ceremony-1",
                namespace_session_id: "namespace-1",
                ownership_expected_revision: 1,
                challenge_txt_value: "pirate-verification=challenge",
                provision_job_id: "provision-1",
                ownership_result_sha256: null,
                provision_result_sha256: null,
              }),
            beginProvisioning: (input) => {
              stored = input;
              return Effect.succeed({ kind: "provisioning" as const, session: provisioning });
            },
            beginObservation: () => Effect.die("observation not expected"),
          },
        },
      ),
    );
    expect(result.status).toBe("provisioning");
    expect(stored).toMatchObject({
      proof_signature_sha256: await digest(encoder.encode(signature)),
      provision_job_id: "provision-1",
    });
  });

  test("observes the published replacement only after parent-chain verification", async () => {
    const planHash = "a".repeat(64);
    const awaitingOwner = {
      community_id: "community-1",
      attachment_intent_id: "attachment-1",
      root_import_session_id: "root-import-1",
      root_label: "dankmemes",
      revision: 3,
      expires_at: "2099-01-01T00:00:00.000Z",
      replayed: false,
      status: "awaiting_owner_update" as const,
      publish_plan: {
        version: "pirate-hns-root-import-publish-plan-v1" as const,
        replacement_semantics: "complete_resource" as const,
        current_records: [],
        preserved_records: [],
        removed_conflicts: [],
        added_records: [],
        replacement_records: [],
        preserved_unknown_record_types: [],
        acknowledgement_required: true as const,
      },
      publish_plan_sha256: planHash,
      readiness_result_sha256: null,
      retry_after_seconds: 5,
    };
    const observing = { ...awaitingOwner, revision: 4, status: "observing" as const };
    let observed: unknown;
    const result = await Effect.runPromise(
      pollHnsCommunityRootImport(
        {
          actor_id: "actor-1",
          community_id: "community-1",
          root_import_session_id: "root-import-1",
          expected_revision: 3,
          idempotency_key: "poll-2",
        },
        {
          nameProof: { verify: () => Effect.die("name proof not expected") },
          completion: {
            complete: () =>
              Effect.succeed({
                ceremony_intent_id: "ceremony-1",
                session_id: "namespace-1",
                revision: 2,
                status: "verified" as const,
                replayed: false,
                result_hash: "b".repeat(64),
                retry_after_seconds: null,
              }),
          },
          store: {
            get: () => Effect.die("get not expected"),
            loadPollAuthority: () =>
              Effect.succeed({
                session: awaitingOwner,
                ceremony_intent_id: "ceremony-1",
                namespace_session_id: "namespace-1",
                ownership_expected_revision: 1,
                challenge_txt_value: "pirate-verification=challenge",
                provision_job_id: "provision-1",
                ownership_result_sha256: null,
                provision_result_sha256: "c".repeat(64),
              }),
            beginProvisioning: () => Effect.die("provisioning not expected"),
            beginObservation: (input) => {
              observed = input;
              return Effect.succeed({ kind: "observing" as const, session: observing });
            },
          },
          ids: { observationJob: () => "observation-1" },
        },
      ),
    );
    expect(result.status).toBe("observing");
    expect(observed).toMatchObject({
      ownership_result_sha256: "b".repeat(64),
      observation_job_id: "observation-1",
    });
  });

  test("loads a session only through its community origin", async () => {
    const expected = {
      community_id: "community-1",
      attachment_intent_id: "attachment-1",
      root_import_session_id: "root-import-1",
      root_label: "dankmemes",
      revision: 2,
      expires_at: "2026-09-11T00:00:00.000Z",
      replayed: false,
      status: "provisioning" as const,
      publish_plan: null,
      publish_plan_sha256: null,
      readiness_result_sha256: null,
      retry_after_seconds: 2,
    };
    let loaded: unknown;
    const result = await Effect.runPromise(
      getHnsCommunityRootImport(
        {
          actor_id: "actor-1",
          community_id: "community-1",
          root_import_session_id: "root-import-1",
        },
        {
          store: {
            get: (input) => {
              loaded = input;
              return Effect.succeed(expected);
            },
          },
        },
      ),
    );
    expect(loaded).toEqual({
      actor_id: "actor-1",
      community_id: "community-1",
      root_import_session_id: "root-import-1",
    });
    expect(result).toEqual(expected);
  });

  test("does not disclose a session outside its community origin", async () => {
    await expect(
      Effect.runPromise(
        getHnsCommunityRootImport(
          {
            actor_id: "actor-1",
            community_id: "community-2",
            root_import_session_id: "root-import-1",
          },
          { store: { get: () => Effect.succeed(null) } },
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "HnsCommunityRootImportRejected",
      reason: "not_found",
    });
  });

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
