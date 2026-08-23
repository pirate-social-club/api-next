import { describe, expect, test } from "bun:test";
import {
  buildHnsOwnerRecoveryProviderStart,
  finalizeHnsOwnerRecoveryProviderStart,
  type HnsOwnerRecoveryAuthorityV1,
  type HnsOwnerRecoveryPersistedSessionAuthority,
  type HnsOwnerRecoveryPersistedSessionV1,
  type HnsOwnerRecoveryPollServices,
  HnsOwnerRecoveryPollStorageFailed,
  HnsOwnerRecoveryProviderFailed,
  type HnsOwnerRecoveryStartServices,
  HnsOwnerRecoveryStartStorageFailed,
  type HnsOwnerRecoveryStoredPoll,
  type HnsOwnerRecoveryStoredStart,
  hnsOwnerRecoveryPublicStartHash,
  hnsOwnerRecoveryRequirementHash,
  hnsOwnerRecoveryResultHash,
} from "@pirate/application/use-cases/hns-owner-recovery";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  OwnerRecoveryInProgress,
  ProviderMisconfigured,
  ProviderUnavailable,
  toErrorBody,
} from "@pirate/contracts";
import { Effect } from "effect";
import { makeHnsOwnerRecoveryHandlers } from "./hns-owner-recovery-handlers.ts";
import type { DecodedRequest, EndpointHandlerResult, Principal } from "./transport.ts";

const authority: HnsOwnerRecoveryAuthorityV1 = {
  actor_id: "user-1",
  community_id: "community-1",
  route_binding_id: "route-binding-1",
  expected_binding_generation: 13,
  recovery_authority_kind: "database_time_expiry_transition",
  recovery_authority_reference: "route_lifecycle_transition_01",
  provider_id: "hns.owner.v1",
  provider_binding_hash: "4".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-observer-regtest",
    version: "hns-observer-config-v1",
    digest: "1".repeat(64),
  },
  protocol_version: "hns-owner-recovery-v1",
  environment: "test",
  route: {
    family: "hns",
    root_label: "jazleeuw",
    root_label_display: "jazleeuw",
    path_segment: "app.jazleeuw",
    href: "/c/app.jazleeuw",
    app_host: null,
  },
};
const startInput = {
  actor_id: "user-1",
  community_id: "community-1",
  expected_generation: 13,
  idempotency_key: "recovery-start-01",
} as const;
const pollInput = {
  actor_id: "user-1",
  community_id: "community-1",
  route_recovery_id: "hns_recovery_01",
  session_id: "hns_recovery_session_01",
  expected_generation: 13,
  idempotency_key: "recovery-poll-01",
  channel: "poll_result",
} as const;
const policy = {
  expected_block_interval_seconds: 600,
  minimum_safe_remaining_blocks: 1,
  expiry_safety_blocks: 100,
  evidence_lease_seconds: 2_592_000,
};
const positiveResponse = {
  status: "verified",
  observation_contract_version: "pirate-hns-target-observation-v2",
  provider_evidence_ref:
    "hns-observer-v1:sha256:931744c296210c90f02bcc5b430323100a37075b066002331f3f09e0d99dae60:hns-observer:regtest:recovery-01",
  upstream_session_ref: "nvs_recovery_01",
  ownership_source: "hns_parent_chain_txt",
  challenge_name: "jazleeuw",
  challenge_value: "pirate-verification=nvs_recovery_01",
  expected_txt_value_sha256: "337d887d720d03a117b13d541e40cf3dbcf619974eeb47f874685706040d6b83",
  control_identity_digest: "f8b28365e0b9abe000b78f9196218db0ca7fc037bbc27e6297f2cf8a86f3e17b",
  chain_authority_digest: "6c176a02ca14aedd62328e805389409a1f4b520b97bb90c2e7f90b47d43557d6",
  observer_result_sha256: "931744c296210c90f02bcc5b430323100a37075b066002331f3f09e0d99dae60",
  root_exists: true,
  root_control_verified: true,
  expiry_horizon_sufficient: true,
  chain_network: "regtest",
  chain_anchor_height: 123_550,
  chain_anchor_block_hash: "6".repeat(64),
  chain_anchor_median_time: 1_770_007_100,
  expiry_height: 200_000,
  observed_at: "2026-02-02T04:38:20.000Z",
  expires_at: "2026-03-04T04:38:20.000Z",
} as const;

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function principal(kind: Principal["kind"] = "user"): Principal {
  return { kind, subject: "user-1" };
}

function request(body: unknown, selectedPrincipal: Principal | null = principal()): DecodedRequest {
  return {
    body,
    params: { communityId: "community-1" },
    query: undefined,
    principal: selectedPrincipal,
  };
}

function asResult(value: unknown): EndpointHandlerResult {
  return value as EndpointHandlerResult;
}

function providerStartResponse(expiresAt = "2026-02-02T05:38:20.000Z") {
  return {
    upstream_session_ref: "nvs_recovery_01",
    expires_at: expiresAt,
    presentation: {
      kind: "embedded_sdk",
      session_id: "nvs_recovery_01",
      protocol: "hns-txt-challenge",
      version: "1",
      payload: {
        ownership_source: "hns_parent_chain_txt",
        challenge_name: "jazleeuw",
        challenge_value: "pirate-verification=nvs_recovery_01",
        expires_at: expiresAt,
      },
    },
  } as const;
}

function sessionAuthority(
  session: HnsOwnerRecoveryPersistedSessionV1,
): HnsOwnerRecoveryPersistedSessionAuthority {
  return {
    expected_route_recovery_id: session.route_recovery_id,
    expected_session_id: session.session_id,
    start_idempotency_key: startInput.idempotency_key,
    expected_public_start_hash: session.public_start_hash,
    expected_upstream_session_ref: session.upstream_session_ref,
    expected_ownership_source: session.ownership_source,
    expected_challenge_expires_at: session.challenge_expires_at,
  };
}

async function storedStart(): Promise<HnsOwnerRecoveryStoredStart> {
  const requirementHash = await hnsOwnerRecoveryRequirementHash(authority);
  const publicStartHash = await hnsOwnerRecoveryPublicStartHash({
    actor_id: authority.actor_id,
    community_id: authority.community_id,
    route_binding_id: authority.route_binding_id,
    expected_binding_generation: authority.expected_binding_generation,
    idempotency_key: startInput.idempotency_key,
    requirement_hash: requirementHash,
  });
  const providerStart = await buildHnsOwnerRecoveryProviderStart({
    route_recovery_id: pollInput.route_recovery_id,
    session_id: pollInput.session_id,
    authority,
    database_started_at: "2026-02-02T04:38:20.000Z",
  });
  const finalized = await finalizeHnsOwnerRecoveryProviderStart({
    provider_start: providerStart,
    public_start_hash: publicStartHash,
    start_request: {
      expected_generation: startInput.expected_generation,
      idempotency_key: startInput.idempotency_key,
    },
    started_at: "2026-02-02T04:38:20.000Z",
    provider_response: providerStartResponse(),
  });
  return { session: finalized.session, session_authority: sessionAuthority(finalized.session) };
}

function startServices(
  options: Readonly<{
    readonly replay?: HnsOwnerRecoveryStoredStart;
    readonly replayOutcome?: "conflict" | "in_flight";
    readonly retryAfterSeconds?: number;
    readonly authorityMissing?: boolean;
    readonly authorityFailure?: boolean;
    readonly providerFailure?: "unavailable" | "misconfigured" | "invalid_response";
  }> = {},
) {
  let resolvedInput: unknown;
  let replayInput: unknown;
  const services: HnsOwnerRecoveryStartServices = {
    authority: {
      resolve: (input) => {
        resolvedInput = input;
        if (options.authorityFailure) {
          return Effect.fail(new HnsOwnerRecoveryStartStorageFailed());
        }
        return Effect.succeed(options.authorityMissing ? null : authority);
      },
    },
    store: {
      replay: (input) => {
        replayInput = input;
        if (options.replayOutcome === "conflict") return Effect.succeed({ kind: "conflict" });
        if (options.replayOutcome === "in_flight") {
          return Effect.succeed({
            kind: "in_flight",
            retry_after_seconds: options.retryAfterSeconds ?? 7,
          });
        }
        return Effect.succeed(
          options.replay === undefined
            ? ({ kind: "none" } as const)
            : ({ kind: "replay", stored: options.replay } as const),
        );
      },
      reserve: () =>
        Effect.succeed({
          kind: "acquired",
          reservation: {
            reservation_id: "reservation-1",
            route_recovery_id: pollInput.route_recovery_id,
            session_id: pollInput.session_id,
            fence_token: 1,
            database_started_at: "2026-02-02T04:38:20.000Z",
            lease_expires_at: "2026-02-02T04:39:20.000Z",
            authority,
          },
        }),
      finalize: () => Effect.succeed({ kind: "created" }),
      release: () => Effect.succeed(undefined),
    },
    provider: {
      start: (providerRequest) =>
        options.providerFailure === undefined
          ? Effect.succeed(providerStartResponse(providerRequest.challenge_expires_at))
          : Effect.fail(new HnsOwnerRecoveryProviderFailed({ reason: options.providerFailure })),
    },
    ids: {
      reservation: () => "reservation-1",
      recovery: () => pollInput.route_recovery_id,
      session: () => pollInput.session_id,
    },
  };
  return { services, replayInput: () => replayInput, resolvedInput: () => resolvedInput };
}

function pollServices(
  initial: HnsOwnerRecoveryStoredPoll,
  responseBytes: Uint8Array,
  options: Readonly<{
    readonly databaseNow?: string;
    readonly reservationOutcome?: "in_flight" | "budget_exhausted" | "conflict";
    readonly retryAfterSeconds?: number;
    readonly providerFailure?: "unavailable" | "misconfigured" | "invalid_response";
    readonly loadMissing?: boolean;
    readonly loadFailure?: boolean;
  }> = {},
) {
  let state = initial;
  let loadInput: unknown;
  let reserveInput: unknown;
  const services: HnsOwnerRecoveryPollServices = {
    policy,
    store: {
      load: (input) => {
        loadInput = input;
        if (options.loadFailure) return Effect.fail(new HnsOwnerRecoveryPollStorageFailed());
        return Effect.succeed(options.loadMissing ? null : state);
      },
      reserve: (input) => {
        reserveInput = input;
        if (options.reservationOutcome === "in_flight") {
          return Effect.succeed({
            kind: "in_flight",
            retry_after_seconds: options.retryAfterSeconds ?? 7,
          });
        }
        if (options.reservationOutcome !== undefined) {
          return Effect.succeed({ kind: options.reservationOutcome });
        }
        return Effect.succeed({
          kind: "acquired",
          attempt: {
            recovery_attempt_id: "hns_recovery_attempt_01",
            evidence_ref: "route_evidence_14",
            observation_id: "hns_observation_01",
            fence_token: 1,
            database_now: options.databaseNow ?? "2026-02-02T04:40:00.000Z",
            lease_expires_at:
              options.databaseNow === initial.session.challenge_expires_at
                ? "2026-02-02T05:39:20.000Z"
                : "2026-02-02T04:41:00.000Z",
          },
          stored: state,
        });
      },
      release: () => Effect.succeed({ kind: "released" }),
      finalize: (input) =>
        Effect.tryPromise({
          try: async () => {
            state = {
              ...state,
              terminal: {
                idempotency_key: input.request.idempotency_key,
                poll_hash: input.poll_hash,
                result_hash: await hnsOwnerRecoveryResultHash(input.result),
                result: input.result,
              },
            };
            return { kind: "committed", stored: state } as const;
          },
          catch: () => new HnsOwnerRecoveryPollStorageFailed(),
        }),
    },
    provider: {
      poll: () =>
        options.providerFailure === undefined
          ? Effect.succeed(responseBytes)
          : Effect.fail(new HnsOwnerRecoveryProviderFailed({ reason: options.providerFailure })),
    },
    ids: {
      attempt: () => "hns_recovery_attempt_01",
      evidence: () => "route_evidence_14",
      observation: () => "hns_observation_01",
    },
  };
  return { services, loadInput: () => loadInput, reserveInput: () => reserveInput };
}

function pollBody() {
  return {
    route_recovery_id: pollInput.route_recovery_id,
    session_id: pollInput.session_id,
    expected_generation: pollInput.expected_generation,
    idempotency_key: pollInput.idempotency_key,
    channel: pollInput.channel,
  };
}

describe("HNS owner-recovery HTTP handlers", () => {
  test("derives owner authority from only the user principal, path, and frozen start body", async () => {
    const fresh = startServices();
    const stored = { ...(await storedStart()), terminal: null };
    const handlers = makeHnsOwnerRecoveryHandlers({
      start: fresh.services,
      poll: pollServices(stored, bytes({})).services,
    });
    const response = asResult(
      await handlers.StartHnsOwnerRecovery(
        request({ expected_generation: 13, idempotency_key: "recovery-start-01" }),
      ),
    );
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      route_recovery_id: pollInput.route_recovery_id,
      session_id: pollInput.session_id,
      status: "pending",
      replayed: false,
    });
    expect(fresh.replayInput()).toEqual(startInput);
    expect(fresh.resolvedInput()).toEqual({
      actor_id: "user-1",
      community_id: "community-1",
      expected_generation: 13,
    });
  });

  test("returns 200 for an exact durable start replay", async () => {
    const replay = startServices({ replay: await storedStart() });
    const stored = { ...(await storedStart()), terminal: null };
    const handlers = makeHnsOwnerRecoveryHandlers({
      start: replay.services,
      poll: pollServices(stored, bytes({})).services,
    });
    const response = asResult(
      await handlers.StartHnsOwnerRecovery(
        request({ expected_generation: 13, idempotency_key: "recovery-start-01" }),
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ replayed: true, status: "pending" });
    expect(replay.resolvedInput()).toBeUndefined();
  });

  test("maps every poll union member to its frozen HTTP success status", async () => {
    const observerHash = "a".repeat(64);
    for (const [providerResponse, httpStatus, expectedStatus, databaseNow] of [
      [
        {
          status: "pending",
          observation_contract_version: "pirate-hns-target-observation-v2",
          reason_code: "txt_absent",
          observer_result_sha256: observerHash,
          provider_evidence_ref: `hns-observer-v1:sha256:${observerHash}:pending-1`,
        },
        202,
        "pending",
        undefined,
      ],
      [
        {
          status: "unavailable",
          observation_contract_version: "pirate-hns-target-observation-v2",
          reason_code: "chain_transport_unavailable",
          retry_after_seconds: 17,
          diagnostic_ref: "hns-observer-diagnostic:recovery-unavailable-01",
        },
        503,
        "unavailable",
        undefined,
      ],
      [positiveResponse, 200, "verified", undefined],
      [
        {
          status: "rejected",
          observation_contract_version: "pirate-hns-target-observation-v2",
          reason_code: "root_absent",
          observer_result_sha256: observerHash,
          provider_evidence_ref: `hns-observer-v1:sha256:${observerHash}:negative-1`,
        },
        422,
        "rejected",
        undefined,
      ],
      [{}, 422, "expired", "2026-02-02T05:38:20.000Z"],
    ] as const) {
      const stored = { ...(await storedStart()), terminal: null };
      const poll = pollServices(stored, bytes(providerResponse), {
        ...(databaseNow === undefined ? {} : { databaseNow }),
      });
      const handlers = makeHnsOwnerRecoveryHandlers({
        start: startServices({ replay: stored }).services,
        poll: poll.services,
      });
      const response = asResult(await handlers.PollHnsOwnerRecovery(request(pollBody())));
      expect(response.status).toBe(httpStatus);
      expect(response.body).toMatchObject({ status: expectedStatus });
    }
  });

  test("derives the poll authority without accepting browser provider facts", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const poll = pollServices(
      stored,
      bytes({
        status: "pending",
        observation_contract_version: "pirate-hns-target-observation-v2",
        reason_code: "txt_absent",
        observer_result_sha256: "a".repeat(64),
        provider_evidence_ref: `hns-observer-v1:sha256:${"a".repeat(64)}:pending-1`,
      }),
    );
    const handlers = makeHnsOwnerRecoveryHandlers({
      start: startServices({ replay: stored }).services,
      poll: poll.services,
    });
    await handlers.PollHnsOwnerRecovery(request(pollBody()));
    expect(poll.loadInput()).toEqual({
      actor_id: "user-1",
      community_id: "community-1",
      route_recovery_id: pollInput.route_recovery_id,
      session_id: pollInput.session_id,
    });
    expect(poll.reserveInput()).toMatchObject({ request: pollInput });
  });

  test("maps owner absence, conflict, and exact live-fence metadata", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    for (const [options, expected] of [
      [{ authorityMissing: true }, NotFound],
      [{ replayOutcome: "conflict" }, Conflict],
    ] as const) {
      const handlers = makeHnsOwnerRecoveryHandlers({
        start: startServices(options).services,
        poll: pollServices(stored, bytes({})).services,
      });
      await expect(
        handlers.StartHnsOwnerRecovery(
          request({ expected_generation: 13, idempotency_key: "recovery-start-01" }),
        ),
      ).rejects.toBeInstanceOf(expected);
    }

    const inFlight = makeHnsOwnerRecoveryHandlers({
      start: startServices({ replayOutcome: "in_flight", retryAfterSeconds: 17 }).services,
      poll: pollServices(stored, bytes({})).services,
    });
    let error: unknown;
    try {
      await inFlight.StartHnsOwnerRecovery(
        request({ expected_generation: 13, idempotency_key: "recovery-start-01" }),
      );
    } catch (cause: unknown) {
      error = cause;
    }
    expect(error).toBeInstanceOf(OwnerRecoveryInProgress);
    expect(toErrorBody(error)).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "owner_recovery_in_progress",
          details: { retry_after_seconds: 17 },
        },
      },
      headers: { "Retry-After": "17" },
    });
  });

  test("fails closed instead of clamping invalid live-fence retry metadata", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const handlers = makeHnsOwnerRecoveryHandlers({
      start: startServices({ replayOutcome: "in_flight", retryAfterSeconds: 3_601 }).services,
      poll: pollServices(stored, bytes({})).services,
    });
    await expect(
      handlers.StartHnsOwnerRecovery(
        request({ expected_generation: 13, idempotency_key: "recovery-start-01" }),
      ),
    ).rejects.toBeInstanceOf(InternalError);
  });

  test("maps provider and storage failures to the declared redacted errors", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    for (const [reason, expected] of [
      ["unavailable", ProviderUnavailable],
      ["misconfigured", ProviderMisconfigured],
      ["invalid_response", ProviderMisconfigured],
    ] as const) {
      const handlers = makeHnsOwnerRecoveryHandlers({
        start: startServices({ providerFailure: reason }).services,
        poll: pollServices(stored, bytes({})).services,
      });
      await expect(
        handlers.StartHnsOwnerRecovery(
          request({ expected_generation: 13, idempotency_key: "recovery-start-01" }),
        ),
      ).rejects.toBeInstanceOf(expected);

      const pollHandlers = makeHnsOwnerRecoveryHandlers({
        start: startServices({ replay: stored }).services,
        poll: pollServices(stored, bytes({}), { providerFailure: reason }).services,
      });
      await expect(pollHandlers.PollHnsOwnerRecovery(request(pollBody()))).rejects.toBeInstanceOf(
        expected,
      );
    }
    const storage = makeHnsOwnerRecoveryHandlers({
      start: startServices({ authorityFailure: true }).services,
      poll: pollServices(stored, bytes({})).services,
    });
    await expect(
      storage.StartHnsOwnerRecovery(
        request({ expected_generation: 13, idempotency_key: "recovery-start-01" }),
      ),
    ).rejects.toBeInstanceOf(InternalError);
    const pollStorage = makeHnsOwnerRecoveryHandlers({
      start: startServices({ replay: stored }).services,
      poll: pollServices(stored, bytes({}), { loadFailure: true }).services,
    });
    await expect(pollStorage.PollHnsOwnerRecovery(request(pollBody()))).rejects.toBeInstanceOf(
      InternalError,
    );
  });

  test("maps poll absence, budget exhaustion, and live fences without widening the contract", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    for (const [options, expected] of [
      [{ loadMissing: true }, NotFound],
      [{ reservationOutcome: "budget_exhausted" }, Conflict],
      [{ reservationOutcome: "conflict" }, Conflict],
    ] as const) {
      const handlers = makeHnsOwnerRecoveryHandlers({
        start: startServices({ replay: stored }).services,
        poll: pollServices(stored, bytes({}), options).services,
      });
      await expect(handlers.PollHnsOwnerRecovery(request(pollBody()))).rejects.toBeInstanceOf(
        expected,
      );
    }
    const inFlight = makeHnsOwnerRecoveryHandlers({
      start: startServices({ replay: stored }).services,
      poll: pollServices(stored, bytes({}), {
        reservationOutcome: "in_flight",
        retryAfterSeconds: 11,
      }).services,
    });
    await expect(inFlight.PollHnsOwnerRecovery(request(pollBody()))).rejects.toMatchObject({
      _tag: "OwnerRecoveryInProgress",
      details: { retry_after_seconds: 11 },
    });
  });

  test("rejects invalid bodies and every non-user principal before storage", async () => {
    const stored = { ...(await storedStart()), terminal: null };
    const handlers = makeHnsOwnerRecoveryHandlers({
      start: startServices({ replay: stored }).services,
      poll: pollServices(stored, bytes({})).services,
    });
    await expect(
      handlers.StartHnsOwnerRecovery(
        request({ expected_generation: 0, idempotency_key: "recovery-start-01" }),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
    for (const selectedPrincipal of [
      null,
      principal("admin"),
      principal("device"),
      principal("agent"),
    ]) {
      expect(() =>
        handlers.StartHnsOwnerRecovery(
          request(
            { expected_generation: 13, idempotency_key: "recovery-start-01" },
            selectedPrincipal,
          ),
        ),
      ).toThrow(AuthError);
    }
  });
});
