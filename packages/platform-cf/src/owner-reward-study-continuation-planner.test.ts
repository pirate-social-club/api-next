import { expect, test } from "bun:test";
import { GuestParticipationStoreRejected } from "@pirate/application";
import { Cause, Effect, Exit, Option } from "effect";
import { makeControlPlaneGuestRewardStudyContinuations } from "./owner-reward-study-continuation.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const input = {
  source: { kind: "guest" as const, ownerId: "owner-original" },
  operation: {
    sourceOwnerId: "owner-original",
    kind: "study_answer" as const,
    idempotencyKey: "answer-original",
    requestHash: "a".repeat(64),
  },
  checkpointId: "checkpoint-original",
};
function fixture(mode = "force_generic_plan", commitFailure = false) {
  const calls: PostgresQueryConfig[] = [];
  let closes = 0;
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {
      closes++;
    },
    query: async (query) => {
      calls.push(query);
      if (query.text === "COMMIT" && commitFailure)
        throw new Error("opaque synthetic COMMIT response loss");
      if (query.text.startsWith("SELECT current_setting"))
        return {
          rows: [
            {
              transaction: "3s",
              lock: "250ms",
              statement: "2s",
              idle: "2s",
              plan_cache_mode: mode,
            },
          ],
          rowCount: 1,
        };
      if (query.text.startsWith("SELECT find_guest_reward_spoken_hold_v1"))
        return {
          rows: [
            { result: { state: "reserved", operationId: "original-admission", result: null } },
          ],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://synthetic.invalid/owned", {
    clientFactory: () => client,
    logger: { info: () => {}, error: () => {} },
    closeTimeoutMs: 100,
  });
  const forbidden = () =>
    Effect.fail(new GuestParticipationStoreRejected({ reason: "resource-policy-unavailable" }));
  const store = makeControlPlaneGuestRewardStudyContinuations(runtime, {
    acknowledgeCapturedSpokenResult: forbidden,
    completeCapturedSpokenAnswer: forbidden,
  });
  return { store, calls, closes: () => closes };
}
async function failure<E>(effect: Effect.Effect<unknown, E>) {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("Typed failure required");
  const error = Cause.findErrorOption(exit.cause);
  if (!Option.isSome(error)) throw new Error("Typed failure channel required");
  return error.value;
}
test("reward continuation applies literal LOCAL generic mode with original bounds before source lookup and owning COMMIT", async () => {
  const f = fixture();
  const answer = await Effect.runPromise(f.store.completeCapturedSpokenAnswer(input));
  expect(answer.state).toBe("pending_confirmation");
  expect(answer.operation).toEqual(input.operation);
  const begin = f.calls.findIndex((q) => q.text === "BEGIN"),
    set = f.calls.findIndex((q) =>
      q.text.includes("set_config('plan_cache_mode','force_generic_plan',true)"),
    ),
    read = f.calls.findIndex((q) =>
      q.text.includes("current_setting('plan_cache_mode') AS plan_cache_mode"),
    ),
    lookup = f.calls.findIndex((q) => q.text.startsWith("SELECT find_guest_reward_spoken_hold_v1")),
    commit = f.calls.findIndex((q) => q.text === "COMMIT");
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(set).toBeGreaterThan(begin);
  expect(read).toBeGreaterThan(set);
  expect(lookup).toBeGreaterThan(read);
  expect(commit).toBeGreaterThan(lookup);
  const statement = f.calls[set];
  if (statement === undefined) throw new Error("Bounded mode statement required");
  for (const literal of [
    "set_config('transaction_timeout','3s',true)",
    "set_config('lock_timeout','250ms',true)",
    "set_config('statement_timeout','2s',true)",
    "set_config('idle_in_transaction_session_timeout','2s',true)",
  ])
    expect(statement.text).toContain(literal);
  expect(f.calls[lookup]?.values).toEqual([
    JSON.stringify(input.source),
    JSON.stringify(input.operation),
    input.checkpointId,
  ]);
  expect(f.closes()).toBe(1);
});
test("wrong planner readback rolls back before private source lookup and preserves typed refusal", async () => {
  const f = fixture("auto");
  expect(await failure(f.store.completeCapturedSpokenAnswer(input))).toMatchObject({
    _tag: "GuestParticipationStoreRejected",
    reason: "resource-policy-unavailable",
  });
  expect(f.calls.some((q) => q.text.includes("find_guest_reward_spoken_hold_v1"))).toBe(false);
  expect(f.calls.some((q) => q.text === "COMMIT")).toBe(false);
  expect(f.calls.some((q) => q.text === "ROLLBACK")).toBe(true);
  expect(f.closes()).toBe(1);
});
test("sent COMMIT response loss remains unknown after original lookup rather than becoming success or known abort", async () => {
  const f = fixture("force_generic_plan", true);
  expect(await failure(f.store.completeCapturedSpokenAnswer(input))).toMatchObject({
    _tag: "ControlPlaneTransactionOutcomeUnknown",
  });
  expect(f.calls.filter((q) => q.text === "COMMIT")).toHaveLength(1);
  expect(
    f.calls.filter((q) => q.text.startsWith("SELECT find_guest_reward_spoken_hold_v1")),
  ).toHaveLength(1);
  expect(f.closes()).toBe(1);
});
