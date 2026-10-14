import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { makeControlPlaneOwnerMegapotSettlementStore } from "./owner-megapot-settlement-store.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

// Decoder boundary tests only. The trap returns no fabricated SQL row/result.
function fixture() {
  let databaseCalls = 0;
  const original = new ControlPlaneStatementFailed({
    label: "actual-db-trap",
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });
  const refuse = () =>
    Effect.sync(() => {
      databaseCalls++;
    }).pipe(Effect.andThen(Effect.fail(original)));
  const runtime = Layer.succeed(ControlPlaneDb, { execute: refuse, withTransaction: refuse });
  return {
    store: makeControlPlaneOwnerMegapotSettlementStore(runtime),
    calls: () => databaseCalls,
    original,
  };
}
const ids = [
  "a b",
  "a\tb",
  "a\u0001b",
  "a\u007fb",
  "a\u00a0b",
  "a\ufeffb",
  "x".repeat(129),
  "😀".repeat(65),
  "a\ud800b",
  "a\udc00b",
];
const hash = "03".repeat(32);

describe("owner settlement exact identifier boundary", () => {
  test("all supplied source/effect/snapshot identifiers reject invalid original UTF16 before database work", async () => {
    const f = fixture();
    for (const id of ids) {
      const attempts: readonly Effect.Effect<unknown, ControlPlaneError>[] = [
        f.store.freeze({ poolLegId: id, drawingId: "7" }, null),
        f.store.readCommitment({ poolLegId: id, drawingId: "7" }),
        f.store.allocate({ poolLegId: id, drawingId: "7" }),
        f.store.prepareCommitment({
          poolLegId: "pool_fixture",
          drawingId: "7",
          snapshotId: id,
          payload: "{}",
          payloadHash: hash,
          signingKeyId: "key",
          signature: "signature",
        }),
        f.store.confirmPublished({
          poolLegId: "pool_fixture",
          drawingId: "7",
          commitmentEffectId: id,
          payloadHash: hash,
          publicReference: "https://commitment.invalid",
          publishedAt: "2026-10-13T00:00:00.000Z",
        }),
      ];
      for (const effect of attempts) {
        const rejected = await Effect.runPromise(Effect.flip(effect));
        expect(rejected).toMatchObject({ _tag: "ControlPlaneStatementFailed" });
        expect(rejected).not.toBe(f.original);
      }
    }
    expect(f.calls()).toBe(0);
  });
  test("128UTF16/64astral and permitted NEL reach the original database trap without invented success", async () => {
    const f = fixture();
    for (const id of ["x".repeat(128), "😀".repeat(64), "a\u0085b"])
      expect(
        await Effect.runPromise(
          Effect.flip(f.store.freeze({ poolLegId: id, drawingId: "7" }, null)),
        ),
      ).toBe(f.original);
    expect(f.calls()).toBe(3);
  });
});

// Typed driver boundary only; synthetic rows do not establish native settlement.
function allocationPlannerFixture(mode = "force_generic_plan", commitFailure = false) {
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
        throw new Error("opaque synthetic owning COMMIT response loss");
      if (query.text.includes("current_setting('plan_cache_mode')"))
        return {
          rows: [
            {
              plan_cache_mode: mode,
              transaction: "3s",
              lock: "250ms",
              statement: "2s",
              idle: "2s",
              readonly: "off",
              isolation: "read committed",
            },
          ],
          rowCount: 1,
        };
      if (query.text.includes("current_setting('transaction_isolation')"))
        return { rows: [{ isolation: "read committed" }], rowCount: 1 };
      if (query.text.includes("current_setting('transaction_timeout')"))
        return {
          rows: [{ transaction: "3s", lock: "250ms", statement: "2s", idle: "2s" }],
          rowCount: 1,
        };
      if (query.text.startsWith("SELECT allocate_owner_megapot_winnings_private_v1"))
        return {
          rows: [{ result: { allocationBatchId: "owner_allocation_fixture", state: "credited" } }],
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
  return {
    store: makeControlPlaneOwnerMegapotSettlementStore(runtime),
    calls,
    closes: () => closes,
  };
}
async function typedAllocationFailure<E>(effect: Effect.Effect<unknown, E>) {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("Typed failure required");
  const error = Cause.findErrorOption(exit.cause);
  if (!Option.isSome(error)) throw new Error("Typed failure channel required");
  return error.value;
}
test("wrong allocation planner readback rolls back before native allocation without altering original bounds", async () => {
  const f = allocationPlannerFixture("auto");
  expect(
    await typedAllocationFailure(f.store.allocate({ poolLegId: "pool_fixture", drawingId: "7" })),
  ).toMatchObject({
    _tag: "ControlPlaneStatementFailed",
    label: "owner-settlement.allocation.planner.verify",
    outcomeCertainty: "completed",
  });
  expect(f.calls.some((q) => q.text.includes("allocate_owner_megapot_winnings_private_v1"))).toBe(
    false,
  );
  expect(f.calls.some((q) => q.text === "COMMIT")).toBe(false);
  expect(f.calls.some((q) => q.text === "ROLLBACK")).toBe(true);
  expect(
    f.calls.filter((q) =>
      q.text.includes("set_config('plan_cache_mode','force_generic_plan',true)"),
    ),
  ).toHaveLength(1);
  expect(f.closes()).toBe(1);
});
test("allocation planner readback precedes original query and sent COMMIT response loss remains unknown", async () => {
  const f = allocationPlannerFixture("force_generic_plan", true);
  expect(
    await typedAllocationFailure(f.store.allocate({ poolLegId: "pool_fixture", drawingId: "7" })),
  ).toMatchObject({ _tag: "ControlPlaneTransactionOutcomeUnknown" });
  const set = f.calls.findIndex((q) =>
    q.text.includes("set_config('plan_cache_mode','force_generic_plan',true)"),
  );
  const verify = f.calls.findIndex((q) => q.text.includes("current_setting('plan_cache_mode')"));
  const allocation = f.calls.findIndex((q) =>
    q.text.startsWith("SELECT allocate_owner_megapot_winnings_private_v1"),
  );
  const commit = f.calls.findIndex((q) => q.text === "COMMIT");
  expect(set).toBeGreaterThan(f.calls.findIndex((q) => q.text === "BEGIN"));
  expect(verify).toBeGreaterThan(set);
  expect(allocation).toBeGreaterThan(verify);
  expect(commit).toBeGreaterThan(allocation);
  expect(f.calls[allocation]?.values).toEqual(["pool_fixture", "7"]);
  expect(f.calls.filter((q) => q.text === "COMMIT")).toHaveLength(1);
  expect(
    f.calls.filter((q) => q.text.startsWith("SELECT allocate_owner_megapot_winnings_private_v1")),
  ).toHaveLength(1);
  expect(
    f.calls.some(
      (q) =>
        q.text.includes("set_config('transaction_timeout','3s',true)") &&
        q.text.includes("set_config('statement_timeout','2s',true)") &&
        q.text.includes("set_config('lock_timeout','250ms',true)") &&
        q.text.includes("set_config('idle_in_transaction_session_timeout','2s',true)"),
    ),
  ).toBe(true);
  expect(f.closes()).toBe(1);
});
