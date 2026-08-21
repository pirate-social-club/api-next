import { expect, test } from "bun:test";
import { Effect, Option, Schema } from "effect";
import {
  CompleteHnsRouteRevalidationInput,
  completeHnsRouteRevalidation,
  type HnsRouteRevalidationCompletionAllocationOutcome,
  type HnsRouteRevalidationCompletionAttemptReservation,
  type HnsRouteRevalidationCompletionFinalizeOutcome,
  type HnsRouteRevalidationCompletionProviderResult,
  type HnsRouteRevalidationCompletionReleaseOutcome,
  type HnsRouteRevalidationCompletionReservationOutcome,
  type HnsRouteRevalidationCompletionServices,
  type HnsRouteRevalidationCompletionStore,
  HnsRouteRevalidationProviderResponse,
  type HnsRouteRevalidationStoredCompletion,
} from "./completion.ts";
import {
  hnsRouteRevalidationCompletionHash,
  hnsRouteRevalidationRequirementHash,
  hnsRouteRevalidationResultHash,
} from "./hashes.ts";
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
Object.assign(session.authority, {
  requirement_hash: await hnsRouteRevalidationRequirementHash(session.authority),
});
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

function verifiedBytes(value: ReturnType<typeof observation>) {
  return new TextEncoder().encode(JSON.stringify({ status: "verified", observation: value }));
}

function harness(
  provider: HnsRouteRevalidationCompletionProviderResult | HnsRouteRevalidationProviderFailed,
  initial: HnsRouteRevalidationStoredCompletion = stored(),
  verifyOutcome?: HnsRouteRevalidationCompletionFinalizeOutcome,
  consumeOutcome: HnsRouteRevalidationCompletionFinalizeOutcome = {
    kind: "consumed_without_terminal",
  },
  syncThrow = false,
  releaseOutcome: HnsRouteRevalidationCompletionReleaseOutcome = { kind: "released" },
  reservationOutcome?: HnsRouteRevalidationCompletionReservationOutcome,
  allocationOutcome?: HnsRouteRevalidationCompletionAllocationOutcome,
) {
  const events: string[] = [];
  const calls = { provider: 0, consume: 0, reject: 0, verify: 0 };
  let consumed: Parameters<HnsRouteRevalidationCompletionStore["consume"]>[0] | undefined;
  let rejected: Parameters<HnsRouteRevalidationCompletionStore["reject"]>[0] | undefined;
  let reserved: Parameters<HnsRouteRevalidationCompletionStore["reserve"]>[0] | undefined;
  const store: HnsRouteRevalidationCompletionStore = {
    load: () => {
      events.push("load");
      return Effect.succeed(initial);
    },
    allocate: () =>
      Effect.succeed(
        allocationOutcome ?? {
          kind: "acquired" as const,
          allocation: {
            route_revalidation_attempt_id: attempt.route_revalidation_attempt_id,
            evidence_ref: attempt.evidence_ref,
            attempt_number: 1,
          },
        },
      ),
    reserve: (value) => {
      events.push("reserve");
      reserved = value;
      if (reservationOutcome !== undefined) return Effect.succeed(reservationOutcome);
      return Effect.succeed({
        kind: "acquired" as const,
        reservation: {
          ...attempt,
          route_revalidation_attempt_id: value.completion_attempt_id,
          evidence_ref: value.evidence_ref,
          attempt_number: value.attempt_number,
          completion_request_hash: value.completion_request_hash,
        },
      });
    },
    release: () => {
      events.push("release");
      return Effect.succeed(releaseOutcome);
    },
    reject: (value) => {
      calls.reject += 1;
      events.push("reject");
      rejected = value;
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
      return Effect.succeed(consumeOutcome);
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
        if (syncThrow) throw new Error("transport synchronously failed");
        return provider instanceof HnsRouteRevalidationProviderFailed
          ? Effect.fail(provider)
          : Effect.succeed(provider);
      },
    },
  } satisfies HnsRouteRevalidationCompletionServices;
  return {
    services,
    events,
    calls,
    consumed: () => consumed,
    rejected: () => rejected,
    reserved: () => reserved,
  };
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
      session: { ...session, status: "failed", terminal_at: "2026-08-21T07:00:00.000Z" },
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

test("rejects a self-inconsistent loaded session before reservation or provider work", async () => {
  const h = harness(
    {
      status: "verified",
      observation: observation(),
      raw_response_bytes: verifiedBytes(observation()),
    },
    stored({
      session: {
        ...session,
        authority: { ...session.authority, route_revalidation_id: "other-route" },
      },
    }),
  );
  await expect(
    Effect.runPromise(completeHnsRouteRevalidation(input, h.services)),
  ).rejects.toMatchObject({ reason: "invalid" });
  expect(h.events).toEqual(["load"]);
  expect(h.calls.provider).toBe(0);
});

test("reserves before provider and releases pending", async () => {
  const h = harness({ status: "pending" });
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result).toMatchObject({ status: "pending", result_hash: null, retry_after_seconds: 1 });
  expect(h.events).toEqual(["load", "reserve", "provider", "release"]);
});

test("hashes the database-authoritative fresh attempt number and identity", async () => {
  const h = harness(
    { status: "pending" },
    stored(),
    undefined,
    undefined,
    false,
    { kind: "released" },
    undefined,
    {
      kind: "acquired",
      allocation: {
        route_revalidation_attempt_id: "attempt-2",
        evidence_ref: "evidence-2",
        attempt_number: 2,
      },
    },
  );
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result.status).toBe("pending");
  expect(h.reserved()).toMatchObject({
    completion_attempt_id: "attempt-2",
    evidence_ref: "evidence-2",
    attempt_number: 2,
  });
});

for (const [kind, reason] of [
  ["in_flight", "completion_in_progress"],
  ["consumed", "attempt_consumed"],
  ["budget_exhausted", "attempt_budget_exhausted"],
  ["idempotency_conflict", "idempotency_conflict"],
  ["binding_conflict", "binding_conflict"],
] as const) {
  test(`does not call provider for reservation outcome: ${kind}`, async () => {
    const h = harness(
      { status: "pending" },
      stored(),
      undefined,
      undefined,
      false,
      undefined,
      kind === "in_flight" ? { kind, retry_after_seconds: 1 } : { kind },
    );
    await expect(
      Effect.runPromise(completeHnsRouteRevalidation(input, h.services)),
    ).rejects.toMatchObject({ reason });
    expect(h.events).toEqual(["load", "reserve"]);
    expect(h.calls.provider).toBe(0);
  });
}

test("does not call provider when the reservation is already expired", async () => {
  const expiredHash = "e".repeat(64);
  const h = harness({ status: "pending" }, stored(), undefined, undefined, false, undefined, {
    kind: "expired",
    result_hash: expiredHash,
  });
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result).toMatchObject({ status: "session_expired", result_hash: expiredHash });
  expect(h.events).toEqual(["load", "reserve"]);
  expect(h.calls.provider).toBe(0);
});

test("maps a lost release fence to retryable unavailable without fabricating a result", async () => {
  const h = harness({ status: "pending" }, stored(), undefined, undefined, false, {
    kind: "lease_lost",
  });
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result).toMatchObject({
    status: "unavailable",
    result_hash: null,
    retry_after_seconds: 1,
  });
  expect(h.events).toEqual(["load", "reserve", "provider", "release"]);
  expect(h.calls.provider).toBe(1);
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
    const rejection = h.rejected();
    expect(rejection).toBeDefined();
    const authority =
      reason === "missing_root" || reason === "revoked"
        ? { ownership: "revoked", lifecycle: "suspended" }
        : reason === "insufficient_expiry"
          ? { ownership: "expired", lifecycle: "suspended" }
          : { ownership: "disputed", lifecycle: "suspended" };
    expect(rejection?.result_hash).toBe(
      await hnsRouteRevalidationResultHash({
        route_revalidation_id: input.route_revalidation_id,
        revalidation_session_id: input.revalidation_session_id,
        route_revalidation_attempt_id: attempt.route_revalidation_attempt_id,
        route_binding_id: attempt.route_binding_id,
        expected_binding_generation: input.expected_binding_generation,
        idempotency_key: input.idempotency_key,
        completion_request_hash: rejection?.completion_request_hash ?? "",
        outcome_status: reason,
        evidence_ref_or_null: null,
        evidence_digest_or_null: null,
        provider_identity_digest_or_null: null,
        ownership_status_or_null: authority.ownership,
        route_lifecycle_status_or_null: authority.lifecycle,
      }),
    );
  });
}

test("builds evidence with database_now and fenced verification", async () => {
  const h = harness({
    status: "verified",
    observation: observation(),
    raw_response_bytes: verifiedBytes(observation()),
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
      raw_response_bytes: verifiedBytes(observation()),
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
    raw_response_bytes: verifiedBytes(observation({ expires_at: "2026-08-21T07:59:00.000Z" })),
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
    raw_response_bytes: verifiedBytes(observation({ challenge_value: "wrong" })),
  });
  const exit = await Effect.runPromiseExit(completeHnsRouteRevalidation(input, h.services));
  expect(exit._tag).toBe("Failure");
  expect(h.calls.consume).toBe(1);
  expect(h.calls.reject).toBe(0);
  expect(h.calls.verify).toBe(0);
  expect(h.consumed()?.consumption_kind).toBe("challenge_mismatch");
});

test("rejects typed observations that do not correspond to retained response bytes", async () => {
  const h = harness({
    status: "verified",
    observation: observation(),
    raw_response_bytes: verifiedBytes(observation({ provider_evidence_ref: "different" })),
  });
  const exit = await Effect.runPromiseExit(completeHnsRouteRevalidation(input, h.services));
  expect(exit._tag).toBe("Failure");
  expect(h.calls.consume).toBe(1);
  expect(h.calls.verify).toBe(0);
});

test("maps an expired semantic consume to a replayable session_expired result", async () => {
  const expiredHash = "e".repeat(64);
  const h = harness(
    {
      status: "verified",
      observation: observation({ challenge_value: "wrong" }),
      raw_response_bytes: verifiedBytes(observation({ challenge_value: "wrong" })),
    },
    stored(),
    undefined,
    { kind: "expired", result_hash: expiredHash },
  );
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result).toMatchObject({ status: "session_expired", result_hash: expiredHash });
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

test("releases the lease when provider invocation throws synchronously", async () => {
  const h = harness({ status: "pending" }, stored(), undefined, undefined, true);
  const result = await Effect.runPromise(completeHnsRouteRevalidation(input, h.services));
  expect(result).toMatchObject({ status: "unavailable", result_hash: null });
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
