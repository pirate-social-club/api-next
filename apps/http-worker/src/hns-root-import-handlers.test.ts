import { describe, expect, test } from "bun:test";
import type {
  HnsRootImportActivationRecord,
  HnsRootImportServices,
  StartHnsRootImportInput,
} from "@pirate/application/namespace-ownership";
import { AuthError, Conflict } from "@pirate/contracts";
import { Effect } from "effect";
import { makeHnsRootImportHandlers } from "./hns-root-import-handlers.ts";
import type { DecodedRequest, EndpointHandlerResult, Principal } from "./transport.ts";

const expiresAt = "2099-01-01T00:00:00.000Z";
const pendingOwnership = {
  creation_intent_id: "intent-root",
  ceremony_intent_id: "ceremony-root",
  requirement_kind: "namespace_ownership" as const,
  generation: 1,
  session_id: "namespace-root",
  channel: "poll_result" as const,
  status: "pending" as const,
  challenge: {
    ownership_source: "hns_parent_chain_txt" as const,
    challenge_name: "newroot",
    challenge_value: "pirate-verification=challenge",
    expires_at: expiresAt,
  },
  expires_at: expiresAt,
  replayed: false,
};

function principal(): Principal {
  return { kind: "user", subject: "actor-root" };
}

function request(
  body: unknown,
  sessionId?: string,
  selectedPrincipal: Principal | null = principal(),
): DecodedRequest {
  return {
    body,
    params: {
      intentId: "intent-root",
      ...(sessionId === undefined ? {} : { sessionId }),
    },
    query: undefined,
    principal: selectedPrincipal,
  };
}

function result(value: unknown): EndpointHandlerResult {
  return value as EndpointHandlerResult;
}

function services(
  options: {
    readonly replayed?: boolean;
    readonly conflict?: boolean;
    readonly ownershipStillPending?: boolean;
  } = {},
): {
  readonly value: HnsRootImportServices;
  readonly ownershipInput: () => StartHnsRootImportInput | undefined;
  readonly getInput: () => unknown;
} {
  let capturedOwnership: StartHnsRootImportInput | undefined;
  let capturedGet: unknown;
  const session = {
    creation_intent_id: "intent-root",
    ceremony_intent_id: "ceremony-root",
    root_import_session_id: "root-import-session",
    namespace_session_id: "namespace-root",
    root_label: "newroot",
    revision: 1,
    expires_at: expiresAt,
    replayed: options.replayed ?? false,
    status: "awaiting_ownership" as const,
    ownership_challenge: {
      ownership_source: "hns_parent_chain_txt" as const,
      record: { type: "TXT" as const, txt: ["pirate-verification=challenge"] as const },
    },
    provisioning_authorization: {
      kind: "hns_name_signature_v1" as const,
      wallet_rpc_method: "signmessagewithname" as const,
      message: '["pirate-hns-root-import-name-proof-v1","fixture"]',
      expires_at: expiresAt,
    },
    publish_plan: null,
    publish_plan_sha256: null,
    readiness_result_sha256: null,
    retry_after_seconds: 5,
  };
  return {
    value: {
      ownership: {
        start: (input) => {
          capturedOwnership = input;
          return Effect.succeed(pendingOwnership);
        },
      },
      completion: {
        complete: () =>
          options.ownershipStillPending
            ? Effect.succeed({
                ceremony_intent_id: "ceremony-root",
                session_id: "namespace-root",
                revision: 1,
                status: "pending" as const,
                replayed: false,
                result_hash: null,
                retry_after_seconds: 5,
              })
            : Effect.die("poll not expected"),
      },
      community: {
        communityCreationStore: {} as never,
        personaStore: {} as never,
      },
      store: {
        start: () =>
          Effect.succeed(
            options.conflict
              ? ({ kind: "conflict" } as const)
              : ({
                  kind: options.replayed ? ("replay" as const) : ("created" as const),
                  session,
                } as const),
          ),
        get: (input) => {
          capturedGet = input;
          return Effect.succeed(session);
        },
        loadPollAuthority: () =>
          options.ownershipStillPending
            ? Effect.succeed({
                session,
                ownership_expected_revision: 1,
                challenge_txt_value: "pirate-verification=challenge",
                provision_job_id: "provision-root-import",
                ownership_result_sha256: null,
                provision_result_sha256: null,
              })
            : Effect.die("poll not expected"),
        beginProvisioning: () => Effect.die("poll not expected"),
        beginObservation: () => Effect.die("poll not expected"),
        finishOwnershipTerminal: () => Effect.die("poll not expected"),
        activate: () => Effect.die("activation not expected"),
      },
      ids: {
        session: () => "root-import-session",
        provisionJob: () => "provision-root-import",
      },
    },
    ownershipInput: () => capturedOwnership,
    getInput: () => capturedGet,
  };
}

describe("HNS root-import HTTP handlers", () => {
  test("starts from authenticated path authority and returns asynchronous status", async () => {
    const dependencies = services();
    const handlers = makeHnsRootImportHandlers(dependencies.value);
    const response = result(
      await handlers.StartHnsRootImport(
        request({
          ceremony_intent_id: "ceremony-root",
          expected_revision: 1,
          idempotency_key: "start-root-import",
        }),
      ),
    );
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "awaiting_ownership", replayed: false });
    expect(dependencies.ownershipInput()).toEqual({
      actor_id: "actor-root",
      creation_intent_id: "intent-root",
      ceremony_intent_id: "ceremony-root",
      expected_revision: 1,
      idempotency_key: "start-root-import",
    });
  });

  test("returns 200 for a durable replay and binds get to actor and path", async () => {
    const dependencies = services({ replayed: true });
    const handlers = makeHnsRootImportHandlers(dependencies.value);
    const replay = result(
      await handlers.StartHnsRootImport(
        request({
          ceremony_intent_id: "ceremony-root",
          expected_revision: 1,
          idempotency_key: "start-root-import",
        }),
      ),
    );
    expect(replay.status).toBe(200);
    await handlers.GetHnsRootImport(request(undefined, "root-import-session"));
    expect(dependencies.getInput()).toEqual({
      actor_id: "actor-root",
      creation_intent_id: "intent-root",
      root_import_session_id: "root-import-session",
    });
  });

  test("keeps a pending ownership poll asynchronous", async () => {
    const handlers = makeHnsRootImportHandlers(services({ ownershipStillPending: true }).value);
    const response = result(
      await handlers.PollHnsRootImport(
        request(
          { expected_revision: 1, idempotency_key: "poll-root-import" },
          "root-import-session",
        ),
      ),
    );
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "awaiting_ownership" });
  });

  test("maps durable conflicts and rejects missing authentication", async () => {
    const handlers = makeHnsRootImportHandlers(services({ conflict: true }).value);
    await expect(
      handlers.StartHnsRootImport(
        request({
          ceremony_intent_id: "ceremony-root",
          expected_revision: 1,
          idempotency_key: "start-root-import",
        }),
      ),
    ).rejects.toBeInstanceOf(Conflict);
    expect(() =>
      handlers.GetHnsRootImport(request(undefined, "root-import-session", null)),
    ).toThrow(AuthError);
  });

  test("keeps activation explicit and preserves the authenticated actor kind", async () => {
    let activation: HnsRootImportActivationRecord | undefined;
    const ready = {
      creation_intent_id: "intent-root",
      ceremony_intent_id: "ceremony-root",
      root_import_session_id: "root-import-session",
      namespace_session_id: "namespace-root",
      root_label: "newroot",
      revision: 4,
      expires_at: expiresAt,
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
    const handlers = makeHnsRootImportHandlers({
      ownership: {} as never,
      completion: {} as never,
      community: {
        communityCreationStore: {
          get: () =>
            Effect.succeed({
              status: "committed",
              committed_resource: { community_id: "community-root" },
            } as never),
        } as never,
        personaStore: {} as never,
      },
      store: {
        loadPollAuthority: () =>
          Effect.succeed({
            session: ready,
            ownership_expected_revision: 1,
            challenge_txt_value: "pirate-verification=challenge",
            provision_result_sha256: "c".repeat(64),
          }),
        activate: (input: HnsRootImportActivationRecord) => {
          activation = input;
          return Effect.succeed({
            kind: "activated" as const,
            response: {
              creation_intent_id: "intent-root",
              root_import_session_id: "root-import-session",
              root_label: "newroot",
              revision: 5,
              status: "activated" as const,
              community_id: "community-root",
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
      } as never,
      ids: {
        session: () => "unused-session",
        provisionJob: () => "unused-provision-job",
        dnsActivation: () => "dns-root",
        appActivation: () => "app-root",
        saleActivation: () => "sale-root",
        activationOperation: () => "operation-root",
      },
    });
    const response = result(
      await handlers.ActivateHnsRootImport(
        request(
          {
            expected_revision: 4,
            idempotency_key: "activate-root",
            publish_plan_sha256: "a".repeat(64),
            readiness_result_sha256: "b".repeat(64),
            acknowledged_complete_resource_replacement: true,
          },
          "root-import-session",
          { kind: "admin", subject: "actor-root" },
        ),
      ),
    );
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: "activated", handle_issuance_enabled: true });
    expect(activation?.input.actor_kind).toBe("admin");
  });
});
