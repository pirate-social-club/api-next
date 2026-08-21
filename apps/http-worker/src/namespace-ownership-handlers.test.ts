import { describe, expect, test } from "bun:test";
import {
  hnsCompletionRequestHash,
  type NamespaceOwnershipCompletionServices,
  NamespaceOwnershipProviderUnavailable,
  type NamespaceOwnershipStoredCompletion,
} from "@pirate/application/use-cases/namespace-ownership-completion";
import {
  hnsNamespaceStartHash,
  type NamespaceOwnershipProviderAdapter,
  type NamespaceOwnershipStartAuthority,
  type NamespaceOwnershipStartServices,
} from "@pirate/application/use-cases/namespace-ownership-start";
import { AuthError, NotFound, RetryableConflict } from "@pirate/contracts";
import { Effect } from "effect";
import { makeNamespaceOwnershipHandlers } from "./namespace-ownership-handlers.ts";
import {
  createHttpWorker,
  type DecodedRequest,
  type EndpointHandlerResult,
  type Principal,
} from "./transport.ts";

const route = {
  family: "hns" as const,
  root_label: "jazleeuw",
  root_label_display: "jazleeuw",
  path_segment: "app.jazleeuw",
  href: "/c/app.jazleeuw",
  app_host: null,
};

const authority: NamespaceOwnershipStartAuthority = {
  actor_id: "actor-1",
  creation_intent_id: "intent-1",
  ceremony_intent_id: "ceremony-1",
  expected_revision: 3,
  requirement_hash: "a".repeat(64),
  generation: 1,
  provider_id: "hns.owner.v1",
  provider_binding_hash: "b".repeat(64),
  provider_configuration: { kind: "managed", reference: "hns-config", version: "1" },
  route,
};

const providerAuthority = {
  actor_id: authority.actor_id,
  creation_intent_id: authority.creation_intent_id,
  ceremony_intent_id: authority.ceremony_intent_id,
  requirement_hash: authority.requirement_hash,
  generation: authority.generation,
  provider_id: authority.provider_id,
  provider_binding_hash: authority.provider_binding_hash,
  provider_configuration: authority.provider_configuration,
  route: authority.route,
};

const manifest = {
  provider_id: "hns.owner.v1",
  manifest_version: "1",
  supported_families: ["hns" as const],
  protocol_versions: ["hns-txt-v1"],
  environments: ["test"],
  submission_channels: ["poll_result" as const],
  operation_deadlines: { plan_ms: 1_000, start_ms: 5_000, complete_ms: 5_000 },
} as const;

function principal(kind: Principal["kind"] = "user"): Principal {
  return { kind, subject: "actor-1" };
}

function request(body: unknown, selectedPrincipal: Principal | null = principal()): DecodedRequest {
  return {
    body,
    params: { intentId: "intent-1" },
    query: undefined,
    principal: selectedPrincipal,
  };
}

function asResult(value: unknown): EndpointHandlerResult {
  return value as EndpointHandlerResult;
}

function provider(
  completion: "pending" | "unavailable" = "pending",
): NamespaceOwnershipProviderAdapter {
  return {
    manifest,
    plan: () =>
      Effect.succeed({
        status: "supported" as const,
        provider_configuration: authority.provider_configuration,
        protocol_version: "hns-txt-v1",
      }),
    start: (input) =>
      Effect.succeed({
        session: {
          ...input,
          provider_id: manifest.provider_id,
          upstream_session_ref: "upstream-1",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
        presentation: {
          kind: "embedded_sdk" as const,
          session_id: "upstream-1",
          protocol: "hns-txt-challenge" as const,
          version: "1" as const,
          payload: {
            ownership_source: "owner_authoritative_dns_txt" as const,
            challenge_name: "_pirate.jazleeuw",
            challenge_value: "pirate-verification=upstream-1",
            expires_at: "2099-01-01T00:00:00.000Z",
          },
        },
      }),
    complete: () =>
      completion === "pending"
        ? Effect.succeed({ status: "pending" as const })
        : Effect.fail(
            new NamespaceOwnershipProviderUnavailable({
              provider_id: manifest.provider_id,
              operation: "complete",
            }),
          ),
  };
}

function registry(completion: "pending" | "unavailable" = "pending") {
  const adapter = provider(completion);
  return {
    list: () => [manifest],
    resolve: () => Effect.succeed(adapter),
  };
}

async function startServices(options: { readonly replayed?: boolean } = {}) {
  const providers = registry();
  let captured: unknown;
  const startResult = await Effect.runPromise(
    provider().start(
      {
        actor_id: authority.actor_id,
        creation_intent_id: authority.creation_intent_id,
        ceremony_intent_id: authority.ceremony_intent_id,
        requirement_hash: authority.requirement_hash,
        generation: authority.generation,
        request_hash: await hnsNamespaceStartHash({
          ...providerAuthority,
          protocol_version: "hns-txt-v1",
          environment: "test",
        }),
        provider_binding_hash: authority.provider_binding_hash,
        provider_configuration: authority.provider_configuration,
        protocol_version: "hns-txt-v1",
        environment: "test",
        route,
      },
      { namespace_session_id: "namespace-session-1" },
    ),
  );
  const services: NamespaceOwnershipStartServices = {
    environment: "test",
    intents: { resolve: () => Effect.succeed(authority) },
    registry: providers,
    store: {
      replay: (input) => {
        captured = input;
        return Effect.succeed(
          options.replayed
            ? {
                kind: "replay" as const,
                namespace_session_id: "namespace-session-1",
                start: startResult,
              }
            : ({ kind: "none" } as const),
        );
      },
      reserve: () =>
        Effect.succeed({
          kind: "acquired" as const,
          reservation: {
            reservation_id: "reservation-1",
            namespace_session_id: "namespace-session-1",
            expected_revision: 3,
            fence_token: 1,
            lease_expires_at: "2098-12-31T23:59:00.000Z",
          },
        }),
      finalize: () =>
        Effect.succeed({
          kind: "created" as const,
          namespace_session_id: "namespace-session-1",
          start: startResult,
        }),
      release: () => Effect.succeed(undefined),
    },
    ids: {
      reservation: () => "reservation-1",
      namespaceSession: () => "namespace-session-1",
    },
  };
  return { services, captured: () => captured };
}

async function storedCompletion(status: "pending" | "verified" | "rejected" | "expired") {
  const requestHash = await hnsNamespaceStartHash({
    ...providerAuthority,
    protocol_version: "hns-txt-v1",
    environment: "test",
  });
  const storedStatus: NamespaceOwnershipStoredCompletion["status"] =
    status === "verified" ? "completed" : status === "rejected" ? "failed" : status;
  return {
    namespace_session_id: "namespace-session-1",
    revision: 3,
    session: {
      ...providerAuthority,
      request_hash: requestHash,
      protocol_version: "hns-txt-v1",
      environment: "test",
      upstream_session_ref: "upstream-1",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
    status: storedStatus,
    terminal: null,
  } satisfies NamespaceOwnershipStoredCompletion;
}

async function completionServices(
  status: "pending" | "unavailable" | "verified" | "rejected" | "expired",
): Promise<NamespaceOwnershipCompletionServices> {
  const providers = registry(status === "unavailable" ? "unavailable" : "pending");
  const baseStored = await storedCompletion(status === "unavailable" ? "pending" : status);
  const pollInput = {
    actor_id: "actor-1",
    creation_intent_id: "intent-1",
    ceremony_intent_id: "ceremony-1",
    session_id: "namespace-session-1",
    expected_revision: 3,
    idempotency_key: "poll-1",
    channel: "poll_result" as const,
  };
  const stored: NamespaceOwnershipStoredCompletion =
    status === "verified" || status === "rejected" || status === "expired"
      ? {
          ...baseStored,
          terminal: {
            status,
            idempotency_key: pollInput.idempotency_key,
            completion_request_hash: await hnsCompletionRequestHash(pollInput),
            result_hash: "d".repeat(64),
          },
        }
      : baseStored;
  return {
    registry: providers,
    store: {
      load: () => Effect.succeed(stored),
      reserve: () =>
        Effect.succeed({
          kind: "acquired" as const,
          reservation: {
            completion_attempt_id: "completion-1",
            namespace_session_id: "namespace-session-1",
            actor_id: "actor-1",
            ceremony_intent_id: "ceremony-1",
            evidence_ref: "evidence-1",
            fence_token: 1,
            lease_expires_at: "2098-12-31T23:59:00.000Z",
          },
        }),
      release: () => Effect.succeed({ kind: "released" as const }),
      reject: () => Effect.die("not used"),
      consume: () => Effect.die("not used"),
      verify: () => Effect.die("not used"),
    },
  };
}

describe("namespace ownership HTTP handlers", () => {
  test("derives start authority from the principal and path and distinguishes fresh replay", async () => {
    for (const replayed of [false, true]) {
      const start = await startServices({ replayed });
      const handlers = makeNamespaceOwnershipHandlers({
        start: start.services,
        completion: await completionServices("pending"),
      });
      const result = asResult(
        await handlers.StartNamespaceOwnership(
          request({
            ceremony_intent_id: "ceremony-1",
            expected_revision: 3,
            idempotency_key: "start-1",
          }),
        ),
      );
      expect(result.status).toBe(replayed ? 200 : 201);
      expect(result.body).toMatchObject({ replayed, creation_intent_id: "intent-1" });
      expect(start.captured()).toEqual({
        actor_id: "actor-1",
        creation_intent_id: "intent-1",
        ceremony_intent_id: "ceremony-1",
        expected_revision: 3,
        client_idempotency_key: "start-1",
      });
    }
  });

  test("maps every poll outcome to its frozen success status", async () => {
    for (const [status, httpStatus] of [
      ["pending", 202],
      ["unavailable", 503],
      ["verified", 200],
      ["rejected", 422],
      ["expired", 422],
    ] as const) {
      const start = await startServices({ replayed: true });
      const handlers = makeNamespaceOwnershipHandlers({
        start: start.services,
        completion: await completionServices(status),
      });
      const result = asResult(
        await handlers.PollNamespaceOwnership(
          request({
            ceremony_intent_id: "ceremony-1",
            session_id: "namespace-session-1",
            expected_revision: 3,
            idempotency_key: "poll-1",
            channel: "poll_result",
          }),
        ),
      );
      expect(result.status).toBe(httpStatus);
      expect(result.body).toMatchObject({ status });
    }
  });

  test("maps missing and in-flight durable state to declared redacted errors", async () => {
    const start = await startServices({ replayed: true });
    const baseCompletion = await completionServices("pending");
    const completion: NamespaceOwnershipCompletionServices = {
      ...baseCompletion,
      store: { ...baseCompletion.store, load: () => Effect.succeed(null) },
    };
    const handlers = makeNamespaceOwnershipHandlers({ start: start.services, completion });
    await expect(
      handlers.PollNamespaceOwnership(
        request({
          ceremony_intent_id: "ceremony-1",
          session_id: "namespace-session-1",
          expected_revision: 3,
          idempotency_key: "poll-1",
          channel: "poll_result",
        }),
      ),
    ).rejects.toBeInstanceOf(NotFound);

    const baseInFlight = await completionServices("pending");
    const inFlight: NamespaceOwnershipCompletionServices = {
      ...baseInFlight,
      store: {
        ...baseInFlight.store,
        reserve: () => Effect.succeed({ kind: "in_flight", retry_after_seconds: 7 } as const),
      },
    };
    const inFlightHandlers = makeNamespaceOwnershipHandlers({
      start: start.services,
      completion: inFlight,
    });
    await expect(
      inFlightHandlers.PollNamespaceOwnership(
        request({
          ceremony_intent_id: "ceremony-1",
          session_id: "namespace-session-1",
          expected_revision: 3,
          idempotency_key: "poll-1",
          channel: "poll_result",
        }),
      ),
    ).rejects.toMatchObject(
      new RetryableConflict({
        message: "Namespace ownership completion is already in progress",
        details: { retry_after_seconds: 7 },
      }),
    );
  });

  test("installs both exact routes and binds the raw path intent into application authority", async () => {
    const start = await startServices();
    const baseCompletion = await completionServices("pending");
    let completionInput: unknown;
    let reservationInput: unknown;
    const worker = createHttpWorker({
      handlers: makeNamespaceOwnershipHandlers({
        start: start.services,
        completion: {
          ...baseCompletion,
          store: {
            ...baseCompletion.store,
            load: (input) => {
              completionInput = input;
              return baseCompletion.store.load(input);
            },
            reserve: (input) => {
              reservationInput = input;
              return baseCompletion.store.reserve(input);
            },
          },
        },
      }),
      authenticate: () => principal(),
      authorize: () => undefined,
    });
    const headers = {
      authorization: "Bearer test",
      "content-type": "application/json",
    };
    const startResponse = await worker.request(
      "http://worker.test/community-creation-intents/intent-1/namespace-ownership/start",
      {
        method: "POST",
        headers,
        body: '{"ceremony_intent_id":"ceremony-1","expected_revision":3,"idempotency_key":"start-1"}',
      },
    );
    expect(startResponse.status).toBe(201);
    expect(await startResponse.json()).toMatchObject({
      creation_intent_id: "intent-1",
      session_id: "namespace-session-1",
      status: "pending",
      challenge: {
        ownership_source: "owner_authoritative_dns_txt",
        challenge_name: "_pirate.jazleeuw",
        challenge_value: "pirate-verification=upstream-1",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    expect(start.captured()).toMatchObject({
      actor_id: "actor-1",
      creation_intent_id: "intent-1",
    });

    const pollResponse = await worker.request(
      "http://worker.test/community-creation-intents/intent-1/namespace-ownership/poll",
      {
        method: "POST",
        headers,
        body: '{"ceremony_intent_id":"ceremony-1","session_id":"namespace-session-1","expected_revision":3,"idempotency_key":"poll-1","channel":"poll_result"}',
      },
    );
    expect(pollResponse.status).toBe(202);
    expect(await pollResponse.json()).toMatchObject({ status: "pending" });
    expect(completionInput).toEqual({
      actor_id: "actor-1",
      creation_intent_id: "intent-1",
      ceremony_intent_id: "ceremony-1",
      session_id: "namespace-session-1",
    });
    expect(reservationInput).toMatchObject({
      actor_id: "actor-1",
      creation_intent_id: "intent-1",
      ceremony_intent_id: "ceremony-1",
      session_id: "namespace-session-1",
      expected_revision: 3,
      idempotency_key: "poll-1",
      completion_request_hash: await hnsCompletionRequestHash({
        creation_intent_id: "intent-1",
        ceremony_intent_id: "ceremony-1",
        session_id: "namespace-session-1",
        expected_revision: 3,
        idempotency_key: "poll-1",
        channel: "poll_result",
      }),
    });

    const encodedAlias = await worker.request(
      "http://worker.test/community-creation-intents/%69ntent-1/namespace-ownership/start",
      {
        method: "POST",
        headers,
        body: '{"ceremony_intent_id":"ceremony-1","expected_revision":3,"idempotency_key":"start-2"}',
      },
    );
    expect(encodedAlias.status).toBe(400);
  });

  test("rejects non-human principals before touching storage", async () => {
    const start = await startServices({ replayed: true });
    const handlers = makeNamespaceOwnershipHandlers({
      start: start.services,
      completion: await completionServices("pending"),
    });
    for (const selectedPrincipal of [null, principal("device"), principal("agent")]) {
      expect(() =>
        handlers.StartNamespaceOwnership(
          request(
            {
              ceremony_intent_id: "ceremony-1",
              expected_revision: 3,
              idempotency_key: "start-1",
            },
            selectedPrincipal,
          ),
        ),
      ).toThrow(AuthError);
    }
  });
});
