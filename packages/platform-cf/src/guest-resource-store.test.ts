import { expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
  type GuestResourceAdmissionPolicy,
  type GuestResourceAdmissionStore,
  type ParticipationOperationIdentity,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import { makeControlPlaneGuestResourceAdmissionStore } from "./guest-resource-store.ts";

const sourceOwnerId = "owner_00000000-0000-0000-0000-000000000001";
const reservationId = "gr_00000000-0000-0000-0000-000000000001";
const callId = "gpc_00000000-0000-0000-0000-000000000001";
const releaseId = "grr_00000000-0000-0000-0000-000000000001";
const policy: GuestResourceAdmissionPolicy = {
  version: "synthetic-resource-v1",
  costPolicyVersion: "synthetic-cost-v1",
  maximumOwnerActiveSessions: 2,
  maximumOwnerReservedPaidCallsPerRollingDay: 60,
  maximumGlobalActiveSessions: 12,
  maximumGlobalPaidCallsPerRollingDay: 300,
  maximumGlobalCostMicrosPerRollingDay: "90071992547409930",
  maximumOwnerCostMicrosPerRollingDay: "90071992547409930",
  maximumTrustedEdgeSessionsPerWindow: 100,
  trustedEdgeWindowSeconds: 3600,
  maximumProviderCallCostMicros: "9007199254740993",
};
const operation: ParticipationOperationIdentity = {
  sourceOwnerId,
  kind: "study_start",
  idempotencyKey: "original-start",
  requestHash: "a".repeat(64),
};
const start: Parameters<GuestResourceAdmissionStore["reserveSession"]>[0] = {
  sourceOwnerId,
  operation,
  sessionId: "original-session",
  worstCasePaidAttemptUnits: 1,
  worstCaseCostMicros: "9007199254740993",
  trustedEdge: { kind: "trusted_edge", fingerprint: "trusted-private-edge" },
  policy,
};
const answer = { ...operation, kind: "study_answer" as const, idempotencyKey: "original-answer" };
const provider: Parameters<GuestResourceAdmissionStore["reserveProviderCall"]>[0] = {
  sourceOwnerId,
  operation: answer,
  sessionId: "original-session",
  reservationId,
  units: 1,
  maximumCostMicros: "9007199254740993",
  costPolicyVersion: policy.costPolicyVersion,
};
const sessionReply = () => ({
  state: "completed",
  outcome_id: reservationId,
  result: {
    state: "reserved",
    reservationId,
    sourceOwnerId,
    operation,
    remainingUnits: 1,
    policyVersion: policy.version,
    costPolicyVersion: policy.costPolicyVersion,
  },
});
const callReply = (state: "reserved" | "unknown" | "completed") => ({
  state: "completed",
  outcome_id: callId,
  result:
    state === "completed"
      ? { state, callId, checkpointId: "checkpoint-original" }
      : state === "unknown"
        ? { state, callId, reservationId }
        : { state, callId, reservationId, maximumCostMicros: provider.maximumCostMicros },
});

function fixture(reply: unknown, failure?: ControlPlaneStatementFailed, commitUnknown = false) {
  const calls: ControlPlaneStatement[] = [];
  const commitFailure = new ControlPlaneTransactionOutcomeUnknown({
    phase: "commit",
    label: "fixture.commit",
    limitMs: 3000,
    elapsedMs: 3001,
  });
  const execute: ControlPlaneDb["Service"]["execute"] = (statement) => {
    calls.push(statement);
    if (statement.label.endsWith(".limits")) return Effect.succeed({ rows: [], rowCount: 1 });
    if (failure) return Effect.fail(failure);
    return Effect.succeed({ rows: [{ result: reply }], rowCount: 1 }) as never;
  };
  const runtime = Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: (use) =>
      use({ execute }).pipe(
        Effect.flatMap((value) =>
          commitUnknown ? Effect.fail(commitFailure) : Effect.succeed(value),
        ),
      ),
  });
  return { calls, commitFailure, store: makeControlPlaneGuestResourceAdmissionStore(runtime) };
}

test("all four frozen methods preserve operation/receipt identity and exact micros strings", async () => {
  const f = fixture(sessionReply());
  const result = await Effect.runPromise(f.store.reserveSession(start));
  expect(result).toEqual({
    state: "completed",
    outcomeId: reservationId,
    operation,
    result: sessionReply().result,
  });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]?.readonly).toBe(true);
  expect(f.calls[0]?.text).toContain("transaction_timeout");
  expect(f.calls[1]?.readonly).toBe(false);
  expect(f.calls[1]?.values[4]).toBe("9007199254740993");
  expect(JSON.parse(String(f.calls[1]?.values[6])).maximumProviderCallCostMicros).toBe(
    "9007199254740993",
  );
  const reserved = fixture(callReply("reserved"));
  expect((await Effect.runPromise(reserved.store.reserveProviderCall(provider))).state).toBe(
    "completed",
  );
  const completed = fixture({ state: "completed", outcome_id: callId });
  expect(
    await Effect.runPromise(
      completed.store.completeProviderCall({
        sourceOwnerId,
        operation: answer,
        reservationId,
        callId,
        disposition: {
          state: "completed",
          checkpointId: "checkpoint-original",
          costMicros: "9007199254740993",
        },
      }),
    ),
  ).toEqual({ state: "completed", outcomeId: callId, operation: answer, result: undefined });
  expect(completed.calls[1]?.values[6]).toBe("9007199254740993");
  const released = fixture({ state: "completed", outcome_id: releaseId });
  expect(
    await Effect.runPromise(
      released.store.releaseSessionRemainder({
        sourceOwnerId,
        operation,
        sessionId: start.sessionId,
        reservationId,
        authoritativeTerminalState: "expired",
      }),
    ),
  ).toEqual({ state: "completed", outcomeId: releaseId, operation, result: undefined });
});

test("original reservation replay may retain prior policy versions; no caller candidate is substituted", async () => {
  const reply = sessionReply();
  reply.result.policyVersion = "accepted-old-policy";
  reply.result.costPolicyVersion = "accepted-old-cost";
  const f = fixture(reply);
  const result = await Effect.runPromise(
    f.store.reserveSession({ ...start, sessionId: "fresh-server-candidate" }),
  );
  expect(result.state).toBe("completed");
  if (result.state !== "completed" || result.result.state !== "reserved")
    throw new Error("expected original reservation");
  expect(result.result.reservationId).toBe(reservationId);
  expect(result.result.policyVersion).toBe("accepted-old-policy");
});

test("unknown/completed/known-aborted provider replies never become a second reserved dispatch", async () => {
  for (const state of ["unknown", "completed"] as const) {
    const result = await Effect.runPromise(
      fixture(callReply(state)).store.reserveProviderCall(provider),
    );
    if (result.state !== "completed") throw new Error("expected typed completed receipt");
    expect(result.result.state).toBe(state);
  }
  expect(
    await Effect.runPromise(
      fixture({ state: "known_aborted" }).store.reserveProviderCall(provider),
    ),
  ).toEqual({ state: "known_aborted", operation: answer });
});

test("only exact safe SQLSTATEs map; unknown COMMIT cannot return even a valid reserved projection", async () => {
  for (const [code, reason] of [
    ["GP002", "owner-mismatch"],
    ["GP005", "idempotency-conflict"],
    ["GP006", "resource-policy-unavailable"],
  ] as const) {
    const failure = new ControlPlaneStatementFailed({
      label: "fixture",
      sqlState: code,
      constraint: null,
      outcomeCertainty: "aborted",
    });
    const error = await Effect.runPromise(
      Effect.flip(fixture(null, failure).store.reserveProviderCall(provider)),
    );
    expect(error._tag).toBe("GuestParticipationStoreRejected");
    if (error._tag !== "GuestParticipationStoreRejected") throw new Error();
    expect(error.reason).toBe(reason);
  }
  const unexpected = new ControlPlaneStatementFailed({
    label: "fixture",
    sqlState: "23505",
    constraint: "opaque",
    outcomeCertainty: "aborted",
  });
  expect(
    await Effect.runPromise(
      Effect.flip(fixture(null, unexpected).store.reserveProviderCall(provider)),
    ),
  ).toBe(unexpected);
  const f = fixture(callReply("reserved"), undefined, true);
  expect(await Effect.runPromise(Effect.flip(f.store.reserveProviderCall(provider)))).toBe(
    f.commitFailure,
  );
});

test("foreign projection identity, excess fields and malformed costs fail without retained payload", async () => {
  for (const reply of [
    {
      ...sessionReply(),
      result: {
        ...sessionReply().result,
        sourceOwnerId: "owner_00000000-0000-0000-0000-000000000002",
      },
    },
    {
      ...sessionReply(),
      result: {
        ...sessionReply().result,
        operation: { ...operation, requestHash: "b".repeat(64) },
      },
    },
    { ...sessionReply(), secret: "private-opaque-proof" },
  ]) {
    const error = await Effect.runPromise(Effect.flip(fixture(reply).store.reserveSession(start)));
    expect(error._tag).toBe("ControlPlaneStatementFailed");
    expect(JSON.stringify(error)).not.toContain("private-opaque-proof");
  }
  const reply = callReply("reserved");
  const corrupt = {
    ...reply,
    result: { state: "reserved", callId, reservationId, maximumCostMicros: 9007199254740992 },
  };
  expect(
    (await Effect.runPromise(Effect.flip(fixture(corrupt).store.reserveProviderCall(provider))))
      ._tag,
  ).toBe("ControlPlaneStatementFailed");
});

test("bad operation/source, unit, policy or disposition input cannot execute a statement", async () => {
  const f = fixture(sessionReply());
  const error = await Effect.runPromise(
    Effect.flip(f.store.reserveSession({ ...start, policy: undefined as never })),
  );
  expect(error._tag).toBe("GuestParticipationStoreRejected");
  await Effect.runPromise(
    Effect.flip(
      f.store.reserveSession({ ...start, operation: { ...operation, sourceOwnerId: "wrong" } }),
    ),
  );
  await Effect.runPromise(Effect.flip(f.store.reserveProviderCall({ ...provider, units: 2 })));
  await Effect.runPromise(
    Effect.flip(
      f.store.completeProviderCall({
        sourceOwnerId,
        operation: answer,
        reservationId,
        callId,
        disposition: { state: "unknown", costMicros: "private-value" } as never,
      }),
    ),
  );
  expect(f.calls).toEqual([]);
});
