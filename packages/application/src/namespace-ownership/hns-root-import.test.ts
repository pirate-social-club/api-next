import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  activateHnsRootImport,
  getHnsRootImport,
  type HnsRootImportActivationRecord,
  HnsRootImportRejected,
  type HnsRootImportStartRecord,
  type HnsRootImportStore,
  pollHnsRootImport,
  startHnsRootImport,
} from "./hns-root-import.ts";
import type { NamespaceOwnershipStartResponse } from "./start.ts";

const pendingOwnership: NamespaceOwnershipStartResponse = {
  creation_intent_id: "intent-1",
  ceremony_intent_id: "ceremony-1",
  generation: 3,
  session_id: "namespace-session-1",
  channel: "poll_result",
  status: "pending",
  expires_at: "2026-09-02T00:00:00.000Z",
  challenge: {
    ownership_source: "hns_parent_chain_txt",
    challenge_name: "newroot",
    challenge_value: "pirate-verification=namespace-session-1",
    expires_at: "2026-09-02T00:00:00.000Z",
  },
  replayed: false,
};

function response(record: HnsRootImportStartRecord, replayed: boolean) {
  return {
    creation_intent_id: record.creation_intent_id,
    ceremony_intent_id: record.ceremony_intent_id,
    root_import_session_id: record.root_import_session_id,
    namespace_session_id: record.namespace_session_id,
    root_label: record.root_label,
    revision: 1,
    expires_at: record.expires_at,
    replayed,
    status: "awaiting_ownership" as const,
    ownership_challenge: {
      ownership_source: "hns_parent_chain_txt" as const,
      record: { type: "TXT" as const, txt: [record.challenge_txt_value] as const },
    },
    publish_plan: null,
    publish_plan_sha256: null,
    readiness_result_sha256: null,
    retry_after_seconds: 5,
  };
}

function memoryStore() {
  let retained: HnsRootImportStartRecord | null = null;
  const store: Pick<HnsRootImportStore, "start" | "get"> = {
    start: (input) => {
      if (retained === null) {
        retained = input;
        return Effect.succeed({ kind: "created", session: response(input, false) });
      }
      if (
        retained.actor_id === input.actor_id &&
        retained.creation_intent_id === input.creation_intent_id &&
        retained.idempotency_key === input.idempotency_key &&
        retained.request_sha256 === input.request_sha256
      ) {
        return Effect.succeed({ kind: "replay", session: response(retained, true) });
      }
      return Effect.succeed({ kind: "conflict" });
    },
    get: (input) =>
      Effect.succeed(
        retained !== null &&
          retained.actor_id === input.actor_id &&
          retained.creation_intent_id === input.creation_intent_id &&
          retained.root_import_session_id === input.root_import_session_id
          ? response(retained, false)
          : null,
      ),
  };
  return { store, retained: () => retained };
}

const input = {
  actor_id: "account-1",
  creation_intent_id: "intent-1",
  ceremony_intent_id: "ceremony-1",
  expected_revision: 4,
  idempotency_key: "root-import-1",
};

describe("HNS root import start", () => {
  test("retains the parent-chain challenge without provisioning an unproven root", async () => {
    const memory = memoryStore();
    const result = await Effect.runPromise(
      startHnsRootImport(input, {
        ownership: { start: () => Effect.succeed(pendingOwnership) },
        store: memory.store,
        ids: {
          session: () => "root-import-session-1",
          provisionJob: () => "root-provision-job-1",
        },
      }),
    );

    expect(result.status).toBe("awaiting_ownership");
    expect(result.root_label).toBe("newroot");
    expect(memory.retained()).toMatchObject({
      namespace_session_id: "namespace-session-1",
      root_label: "newroot",
      challenge_txt_value: "pirate-verification=namespace-session-1",
      provision_job_id: "root-provision-job-1",
    });
    expect(memory.retained()?.request_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(memory.retained()).not.toHaveProperty("provision_request_sha256");
  });

  test("replays the same durable session despite freshly allocated candidate ids", async () => {
    const memory = memoryStore();
    let suffix = 0;
    const services = {
      ownership: { start: () => Effect.succeed(pendingOwnership) },
      store: memory.store,
      ids: {
        session: () => {
          suffix += 1;
          return `root-import-session-${suffix}`;
        },
        provisionJob: () => {
          suffix += 1;
          return `root-provision-job-${suffix}`;
        },
      },
    } as const;
    const first = await Effect.runPromise(startHnsRootImport(input, services));
    const second = await Effect.runPromise(startHnsRootImport(input, services));
    expect(first.root_import_session_id).toBe("root-import-session-1");
    expect(second.root_import_session_id).toBe(first.root_import_session_id);
    expect(second.replayed).toBe(true);
  });

  test("refuses an owner-authoritative challenge for initial import", async () => {
    const memory = memoryStore();
    const result = await Effect.runPromise(
      Effect.flip(
        startHnsRootImport(input, {
          ownership: {
            start: () =>
              Effect.succeed({
                ...pendingOwnership,
                challenge: {
                  ...pendingOwnership.challenge,
                  ownership_source: "owner_authoritative_dns_txt",
                  challenge_name: "_pirate.newroot",
                },
              }),
          },
          store: memory.store,
        }),
      ),
    );
    expect(result).toBeInstanceOf(HnsRootImportRejected);
    expect(result).toMatchObject({ reason: "ownership_source_unsupported" });
    expect(memory.retained()).toBeNull();
  });

  test("loads only the actor-bound session", async () => {
    const memory = memoryStore();
    const started = await Effect.runPromise(
      startHnsRootImport(input, {
        ownership: { start: () => Effect.succeed(pendingOwnership) },
        store: memory.store,
        ids: {
          session: () => "root-import-session-1",
          provisionJob: () => "root-provision-job-1",
        },
      }),
    );
    const loaded = await Effect.runPromise(
      getHnsRootImport(
        {
          actor_id: input.actor_id,
          creation_intent_id: input.creation_intent_id,
          root_import_session_id: started.root_import_session_id,
        },
        { store: memory.store },
      ),
    );
    expect(loaded.root_import_session_id).toBe(started.root_import_session_id);

    const rejected = await Effect.runPromise(
      Effect.flip(
        getHnsRootImport(
          {
            actor_id: "account-2",
            creation_intent_id: input.creation_intent_id,
            root_import_session_id: started.root_import_session_id,
          },
          { store: memory.store },
        ),
      ),
    );
    expect(rejected).toBeInstanceOf(HnsRootImportRejected);
    expect(rejected).toMatchObject({ reason: "not_found" });
  });
});

describe("HNS root import completion", () => {
  test("enqueues provisioning only after verified ownership is retained", async () => {
    let provisioning: Parameters<HnsRootImportStore["beginProvisioning"]>[0] | undefined;
    const awaiting = {
      creation_intent_id: "intent-1",
      ceremony_intent_id: "ceremony-1",
      root_import_session_id: "root-import-session-1",
      namespace_session_id: "namespace-session-1",
      root_label: "newroot",
      revision: 1,
      expires_at: "2099-01-01T00:00:00.000Z",
      replayed: false,
      status: "awaiting_ownership" as const,
      ownership_challenge: {
        ownership_source: "hns_parent_chain_txt" as const,
        record: {
          type: "TXT" as const,
          txt: ["pirate-verification=namespace-session-1"] as const,
        },
      },
      publish_plan: null,
      publish_plan_sha256: null,
      readiness_result_sha256: null,
      retry_after_seconds: 5,
    };
    const queued = {
      creation_intent_id: awaiting.creation_intent_id,
      ceremony_intent_id: awaiting.ceremony_intent_id,
      root_import_session_id: awaiting.root_import_session_id,
      namespace_session_id: awaiting.namespace_session_id,
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
    const result = await Effect.runPromise(
      pollHnsRootImport(
        {
          actor_id: "account-1",
          creation_intent_id: "intent-1",
          root_import_session_id: "root-import-session-1",
          expected_revision: 1,
          idempotency_key: "poll-root-import",
        },
        {
          ownership: { start: () => Effect.die("start not expected") },
          completion: {
            complete: () =>
              Effect.succeed({
                ceremony_intent_id: "ceremony-1",
                session_id: "namespace-session-1",
                revision: 2,
                status: "verified" as const,
                replayed: false,
                result_hash: "b".repeat(64),
                retry_after_seconds: null,
              }),
          },
          community: {} as never,
          store: {
            start: () => Effect.die("start not expected"),
            get: () => Effect.die("get not expected"),
            loadPollAuthority: () =>
              Effect.succeed({
                session: awaiting,
                ownership_expected_revision: 1,
                challenge_txt_value: "pirate-verification=namespace-session-1",
                provision_job_id: "root-provision-job-1",
                ownership_result_sha256: null,
                provision_result_sha256: null,
              }),
            beginProvisioning: (input) => {
              provisioning = input;
              return Effect.succeed({ kind: "provisioning" as const, session: queued });
            },
            beginObservation: () => Effect.die("observation not expected"),
            finishOwnershipTerminal: () => Effect.die("terminal not expected"),
            activate: () => Effect.die("activation not expected"),
          },
          ids: {
            session: () => "unused-session",
            provisionJob: () => "unused-provision-job",
            observationJob: () => "observation-job-1",
          },
        },
      ),
    );
    expect(result).toEqual(queued);
    expect(provisioning).toMatchObject({
      ownership_result_sha256: "b".repeat(64),
      provision_job_id: "root-provision-job-1",
    });
    expect(provisioning?.provision_request_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("refuses activation before readiness and hides sessions from another principal", async () => {
    const awaitingOwner = {
      creation_intent_id: "intent-1",
      ceremony_intent_id: "ceremony-1",
      root_import_session_id: "root-import-session-1",
      namespace_session_id: "namespace-session-1",
      root_label: "newroot",
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
      publish_plan_sha256: "a".repeat(64),
      readiness_result_sha256: null,
      retry_after_seconds: 5,
    };
    const baseServices = {
      ownership: {} as never,
      completion: {} as never,
      community: {} as never,
    } as const;
    const premature = await Effect.runPromise(
      Effect.flip(
        activateHnsRootImport(
          {
            actor_id: "account-1",
            actor_kind: "user",
            creation_intent_id: "intent-1",
            root_import_session_id: "root-import-session-1",
            expected_revision: 3,
            idempotency_key: "activate-too-early",
            publish_plan_sha256: "a".repeat(64),
            readiness_result_sha256: "b".repeat(64),
            acknowledged_complete_resource_replacement: true,
          },
          {
            ...baseServices,
            store: {
              loadPollAuthority: () =>
                Effect.succeed({
                  session: awaitingOwner,
                  ownership_expected_revision: 1,
                  challenge_txt_value: "pirate-verification=namespace-session-1",
                  provision_job_id: "provision-job-1",
                  ownership_result_sha256: "c".repeat(64),
                  provision_result_sha256: "d".repeat(64),
                }),
            } as never,
          },
        ),
      ),
    );
    expect(premature).toMatchObject({ reason: "conflict" });

    const hidden = await Effect.runPromise(
      Effect.flip(
        pollHnsRootImport(
          {
            actor_id: "account-2",
            creation_intent_id: "intent-1",
            root_import_session_id: "root-import-session-1",
            expected_revision: 3,
            idempotency_key: "wrong-principal",
          },
          {
            ...baseServices,
            store: { loadPollAuthority: () => Effect.succeed(null) } as never,
          },
        ),
      ),
    );
    expect(hidden).toMatchObject({ reason: "not_found" });
  });

  test("activates a ready root against its already committed community", async () => {
    const ready = {
      creation_intent_id: "intent-1",
      ceremony_intent_id: "ceremony-1",
      root_import_session_id: "root-import-session-1",
      namespace_session_id: "namespace-session-1",
      root_label: "newroot",
      revision: 4,
      expires_at: "2099-01-01T00:00:00.000Z",
      replayed: false,
      status: "ready" as const,
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
      publish_plan_sha256: "a".repeat(64),
      readiness_result_sha256: "b".repeat(64),
      retry_after_seconds: null,
    };
    let activation: HnsRootImportActivationRecord | undefined;
    const store = {
      loadPollAuthority: () =>
        Effect.succeed({
          session: ready,
          ownership_expected_revision: 1,
          challenge_txt_value: "pirate-verification=namespace-session-1",
          provision_result_sha256: "c".repeat(64),
        }),
      activate: (input: HnsRootImportActivationRecord) => {
        activation = input;
        return Effect.succeed({
          kind: "activated" as const,
          response: {
            creation_intent_id: "intent-1",
            root_import_session_id: "root-import-session-1",
            root_label: "newroot",
            revision: 5,
            status: "activated" as const,
            community_id: "community-1",
            app_host: "app.newroot",
            dns_zone_activation_id: input.dns_zone_activation_id,
            dns_zone_activation_generation: 1 as const,
            app_host_activation_id: input.app_host_activation_id,
            app_host_activation_generation: 1 as const,
            sale_namespace_activation_id: input.sale_namespace_activation_id,
            sale_namespace_activation_generation: 1 as const,
            sale_namespace_activation_sha256: "d".repeat(64),
            handle_issuance_enabled: true as const,
            replayed: false,
          },
        });
      },
    };
    const activated = await Effect.runPromise(
      activateHnsRootImport(
        {
          actor_id: "account-1",
          actor_kind: "user",
          creation_intent_id: "intent-1",
          root_import_session_id: "root-import-session-1",
          expected_revision: 4,
          idempotency_key: "activate-root-import",
          publish_plan_sha256: "a".repeat(64),
          readiness_result_sha256: "b".repeat(64),
          acknowledged_complete_resource_replacement: true,
        },
        {
          ownership: {} as never,
          completion: {} as never,
          community: {
            communityCreationStore: {
              get: () =>
                Effect.succeed({
                  status: "committed",
                  committed_resource: { community_id: "community-1" },
                } as never),
            } as never,
            personaStore: {} as never,
          },
          store: store as never,
          ids: {
            session: () => "unused-session",
            provisionJob: () => "unused-provision-job",
            dnsActivation: () => "dns-activation-1",
            appActivation: () => "app-activation-1",
            saleActivation: () => "sale-activation-1",
            activationOperation: () => "root-activation-operation-1",
          },
        },
      ),
    );
    expect(activated).toMatchObject({ status: "activated", community_id: "community-1" });
    expect(activation).toMatchObject({
      community_id: "community-1",
      dns_zone_activation_id: "dns-activation-1",
      app_host_activation_id: "app-activation-1",
      sale_namespace_activation_id: "sale-activation-1",
    });
  });
});
