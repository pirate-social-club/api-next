import { expect, test } from "bun:test";
import { Effect, Option, Schema } from "effect";
import {
  CompleteHnsRouteRevalidationInput,
  completeHnsRouteRevalidation,
  type HnsRouteRevalidationCompletionAttemptReservation,
  type HnsRouteRevalidationCompletionFinalizeOutcome,
  type HnsRouteRevalidationCompletionProviderResult,
  type HnsRouteRevalidationCompletionServices,
  type HnsRouteRevalidationCompletionStore,
  HnsRouteRevalidationProviderResponse,
  type HnsRouteRevalidationStoredCompletion,
} from "./completion.ts";
import { hnsRouteRevalidationCompletionHash } from "./hashes.ts";
import { HnsRouteRevalidationProviderFailed, type HnsRouteRevalidationSessionV1 } from "./start.ts";

const input = {
  route_revalidation_id: "revalidation-1",
  revalidation_session_id: "session-1",
  expected_binding_generation: 1,
  idempotency_key: "poll-1",
  channel: "poll_result" as const,
};
const session: HnsRouteRevalidationSessionV1 = {
  authority: {
    version: "pirate-hns-route-revalidation-authority-v1",
    route_revalidation_id: input.route_revalidation_id,
    community_id: "community-1",
    route_binding_id: "binding-1",
    principal_kind: "system",
    principal_id: "route-revalidation-scheduler",
    expected_binding_generation: 1,
    expected_verified_evidence_ref: "evidence-old",
    requirement_hash: "a".repeat(64),
    provider_id: "hns.owner.v1",
    provider_binding_hash: "b".repeat(64),
    provider_configuration_kind: "managed",
    provider_configuration_reference: "hns-owner",
    provider_configuration_version: "1",
    protocol_version: "hns-txt-v1",
    environment: "test",
    family: "hns",
    root_label: "jazleeuw",
    root_label_display: "jazleeuw",
    path_segment: "app.jazleeuw",
  },
  revalidation_session_id: input.revalidation_session_id,
  start_request_hash: "c".repeat(64),
  upstream_session_ref: "upstream-1",
  start_presentation: {
    kind: "embedded_sdk",
    session_id: "upstream-1",
    protocol: "hns-txt-challenge",
    version: "1",
    payload: {
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.jazleeuw",
      challenge_value: "pirate-verification=upstream-1",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  },
  status: "pending",
  started_at: "2026-01-01T00:00:00.000Z",
  expires_at: "2099-01-01T00:00:00.000Z",
  terminal_at: null,
};
const attempt: HnsRouteRevalidationCompletionAttemptReservation = {
  route_revalidation_attempt_id: "attempt-1",
  route_revalidation_id: input.route_revalidation_id,
  revalidation_session_id: input.revalidation_session_id,
  route_binding_id: "binding-1",
  expected_binding_generation: 1,
  expected_verified_evidence_ref: "evidence-old",
  attempt_number: 1,
  idempotency_key: input.idempotency_key,
  completion_request_hash: "0".repeat(64),
  evidence_ref: "evidence-new",
  fence_token: 2,
  lease_expires_at: "2099-01-01T00:00:16.000Z",
};
const attemptRecord = {
  ...attempt,
  state: "leased" as const,
  consumption_kind: null,
  result_hash: null,
};

function stored(overrides: Partial<HnsRouteRevalidationStoredCompletion> = {}) {
  return {
    route_revalidation_id: input.route_revalidation_id,
    revalidation_session_id: input.revalidation_session_id,
    expected_binding_generation: 1,
    database_now: "2026-08-21T08:00:00.000Z",
    session,
    status: "pending" as const,
    terminal: null,
    attempt: null,
    ...overrides,
  } satisfies HnsRouteRevalidationStoredCompletion;
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    ownership_source: "owner_authoritative_dns_txt" as const,
    challenge_name: "_pirate.jazleeuw",
    challenge_value: "pirate-verification=upstream-1",
    root_exists: true as const,
    root_control_verified: true as const,
    expiry_horizon_sufficient: true as const,
    chain_network: "main",
    chain_anchor_height: 100,
    chain_anchor_block_hash: "1".repeat(64),
    chain_anchor_median_time: 90,
    expiry_height: 200,
    observed_at: "2026-08-21T07:00:00.000Z",
    expires_at: "2026-09-21T07:00:00.000Z",
    provider_evidence_ref: "provider-evidence-1",
    ...overrides,
  } as const;
}

function harness(
  provider: HnsRouteRevalidationCompletionProviderResult | HnsRouteRevalidationProviderFailed,
  initial: HnsRouteRevalidationStoredCompletion = stored(),
  verifyOutcome?: HnsRouteRevalidationCompletionFinalizeOutcome,
) {
  const events: string[] = [];
  const calls = { provider: 0, consume: 0, reject: 0, verify: 0 };
  let consumed: Parameters<HnsRouteRevalidationCompletionStore["consume"]>[0] | undefined;
  const store: HnsRouteRevalidationCompletionStore = {
    load: () => {
      events.push("load");
      return Effect.succeed(initial);
    },
    reserve: (value) => {
      events.push("reserve");
      return Effect.succeed({
        kind: "acquired" as const,
        reservation: { ...attempt, completion_request_hash: value.completion_request_hash },
      });
    },
    release: () => {
      events.push("release");
      return Effect.succeed({ kind: "released" as const });
    },
    reject: (value) => {
      calls.reject += 1;
      events.push("reject");
      return Effect.succeed({
        kind: "committed" as const,
        status: value.status,
        result_hash: value.result_hash,
      });
    },
    consume: (value) => {
      calls.consume += 1;
      events.push("consume");
      consumed = value;
      return Effect.succeed({ kind: "consumed_without_terminal" as const });
    },
    verify: (value) => {
      calls.verify += 1;
      events.push("verify");
      return Effect.succeed(
        verifyOutcome ?? {
          kind: "committed" as const,
          status: "verified" as const,
          result_hash: value.result_hash,
        },
      );
    },
  };
  const services = {
    store,
    provider: {
      complete: () => {
        calls.provider += 1;
        events.push("provider");
        return provider instanceof HnsRouteRevalidationProviderFailed
          ? Effect.fail(provider)
          : Effect.succeed(provider);
      },
    },
    ids: {
      attempt: () => attempt.route_revalidation_attempt_id,
      evidence: () => attempt.evidence_ref,
    },
  } satisfies HnsRouteRevalidationCompletionServices;
  return { services, events, calls, consumed: () => consumed };
}

test("accepts exactly five fields and rejects unknown or invalid members", () => {
  const exact = { onExcessProperty: "error" } as const;
  expect(
    Option.isSome(Schema.decodeUnknownOption(CompleteHnsRouteRevalidationInput, exact)(input)),
  ).toBe(true);
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(
        CompleteHnsRouteRevalidationInput,
        exact,
      )({ ...input, payload: {} }),
    ),
  ).toBe(false);
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(
        CompleteHnsRouteRevalidationInput,
        exact,
      )({ ...input, expected_binding_generation: 0 }),
    ),
  ).toBe(false);
});

test("keeps lease fences out of the semantic completion hash", async () => {
  const { fence_token: _fence, ...hashInput } = attempt;
  const withFence = (fence_token: number) =>
    ({ ...hashInput, fence_token }) as Parameters<typeof hnsRouteRevalidationCompletionHash>[0];
  const fenceOne = await hnsRouteRevalidationCompletionHash(withFence(1));
  const fenceTwo = await hnsRouteRevalidationCompletionHash(withFence(2));
  expect(fenceOne).toBe(fenceTwo);
  expect(
    await hnsRouteRevalidationCompletionHash({ ...hashInput, idempotency_key: "poll-2" }),
  ).not.toBe(fenceOne);
});

test("replay resolves before reservation or provider work", async () => {
  const requestHash = await hnsRouteRevalidationCompletionHash({
    route_revalidation_id: input.route_revalidation_id,
    revalidation_session_id: input.revalidation_session_id,
    route_revalidation_attempt_id: attempt.route_revalidation_attempt_id,
    route_binding_id: attempt.route_binding_id,
    expected_binding_generation: 1,
    expected_verified_evidence_ref: attempt.expected_verified_evidence_ref,
    attempt_number: 1,
    idempotency_key: input.idempotency_key,
    evidence_ref: attempt.evidence_ref,
  });
  const h = harness(
    { status: "pending" },
    stored({
      attempt: attemptRecord,
      status: "failed",
      terminal: {
        status: "revoked",
        idempotency_key: input.idempotency_key,
        completion_request_hash: requestHash,
        result_hash: "d".repeat(64),
      },
    }),
  );
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result).toMatchObject({ status: "revoked", replayed: true, result_hash: "d".repeat(64) });
  expect(h.events).toEqual(["load"]);
  expect(h.calls.provider).toBe(0);
});

test("reserves before provider and releases pending", async () => {
  const h = harness({ status: "pending" });
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result).toMatchObject({ status: "pending", result_hash: null, retry_after_seconds: 1 });
  expect(h.events).toEqual(["load", "reserve", "provider", "release"]);
});

for (const reason of [
  "missing_root",
  "control_failed",
  "challenge_mismatch",
  "insufficient_expiry",
  "disputed",
  "revoked",
] as const) {
  test(`commits closed provider rejection: ${reason}`, async () => {
    const h = harness({ status: "rejected", reason_code: reason });
    const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
    expect(result.status).toBe(reason);
    expect(result.result_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.events).toEqual(["load", "reserve", "provider", "reject"]);
  });
}

test("builds evidence with database_now and fenced verification", async () => {
  const h = harness({
    status: "verified",
    observation: observation(),
    raw_response_bytes: new Uint8Array([1, 2, 3]),
  });
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result.status).toBe("verified");
  expect(result.result_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(h.events).toEqual(["load", "reserve", "provider", "verify"]);
});

test("returns typed stale_cas without mutating the completion", async () => {
  const h = harness(
    {
      status: "verified",
      observation: observation(),
      raw_response_bytes: new Uint8Array([1, 2, 3]),
    },
    stored(),
    { kind: "stale_cas" },
  );
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result.status).toBe("stale_cas");
  expect(result.result_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(h.calls.verify).toBe(1);
});

test("maps database-time evidence expiry to a terminal expired result", async () => {
  const h = harness({
    status: "verified",
    observation: observation({ expires_at: "2026-08-21T07:59:00.000Z" }),
    raw_response_bytes: new Uint8Array([1]),
  });
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result).toMatchObject({ status: "database_time_expired", replayed: false });
  expect(result.result_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(h.calls.reject).toBe(1);
  expect(h.calls.consume).toBe(0);
});

test("semantic contradictions consume without terminal result or evidence", async () => {
  const h = harness({
    status: "verified",
    observation: observation({ challenge_value: "wrong" }),
    raw_response_bytes: new Uint8Array([1]),
  });
  const exit = await Effect.runPromiseExit(completeHnsRouteRevalidation(input, h.services));
  expect(exit._tag).toBe("Failure");
  expect(h.calls.consume).toBe(1);
  expect(h.calls.reject).toBe(0);
  expect(h.calls.verify).toBe(0);
  expect(h.consumed()?.consumption_kind).toBe("semantic_contradiction");
});

test("provider outage releases and returns unavailable", async () => {
  const h = harness(new HnsRouteRevalidationProviderFailed({ reason: "unavailable" }));
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result).toMatchObject({
    status: "unavailable",
    result_hash: null,
    retry_after_seconds: 1,
  });
  expect(h.events).toEqual(["load", "reserve", "provider", "release"]);
});

test("provider response union rejects unknown reason and extra fields", () => {
  const exact = { onExcessProperty: "error" } as const;
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(
        HnsRouteRevalidationProviderResponse,
        exact,
      )({ status: "rejected", reason_code: "unknown" }),
    ),
  ).toBe(false);
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(
        HnsRouteRevalidationProviderResponse,
        exact,
      )({ status: "pending", extra: true }),
    ),
  ).toBe(false);
});
