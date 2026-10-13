import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeControlPlaneAccountOriginalAdmissionReconciliation } from "./account-original-admission-reconciliation.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientLike, type PostgresQueryConfig } from "./postgres.ts";

const first = { mainOperationId: "account_reward_first", sourceOwnerId: "owner_00000000-0000-4000-8000-000000000001", attemptNumber: 1, attemptFence: "a".repeat(64) };
const second = { ...first, mainOperationId: "account_reward_second", attemptFence: "b".repeat(64) };
function fixture(options: { candidates?: unknown; reply?: unknown; loseCommit?: boolean } = {}) {
  const queries: PostgresQueryConfig[] = [];
  const logs: unknown[] = [];
  let commits = 0;
  const client: PostgresClientLike = {
    connect: async () => {}, end: async () => {},
    query: async query => {
      queries.push(query);
      if (query.text === "COMMIT" && ++commits === 2 && options.loseCommit) throw new Error("opaque original fixture failure");
      if (query.text.startsWith("SELECT current_setting")) return { rows: [{ transaction: "3s", lock: "250ms", statement: "2s", idle: "2s" }], rowCount: 1 };
      if (query.text.startsWith("SELECT list_account_owner")) return { rows: [{ result: options.candidates ?? [first] }], rowCount: 1 };
      if (query.text.startsWith("SELECT reconcile_account_owner")) return { rows: [{ result: options.reply ?? { ...first, state: "reconciled_no_commit", participation: { state: "entry_closed" }, changed: true } }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/original-admission", {
    clientFactory: () => client,
    logger: { info: (event, fields) => logs.push({ event, fields }), error: (event, fields) => logs.push({ event, fields }) },
  });
  return { queries, logs, recovery: makeControlPlaneAccountOriginalAdmissionReconciliation(runtime) };
}
test("acknowledged original tuple is listed then reconciled in separate bounded COMMITs with no grade or new attempt", async () => {
  const f = fixture();
  expect(await Effect.runPromise(f.recovery.recover(8))).toEqual({ examined: 1, completed: 0, reconciled: 1, stale: 0 });
  expect(f.queries.filter(q => q.text === "COMMIT")).toHaveLength(2);
  expect(f.queries.find(q => q.text.startsWith("SELECT reconcile_account_owner"))?.values).toEqual([first.mainOperationId, first.sourceOwnerId, first.attemptFence, 1]);
  expect(f.queries.some(q => /prepare_account|start_account|complete_account|admit_megapot|INSERT/u.test(q.text))).toBe(false);
});
test("lost reconcile COMMIT acknowledgment remains typed unknown and stops before a second candidate", async () => {
  const f = fixture({ candidates: [first, second], loseCommit: true });
  const result = await Effect.runPromise(Effect.result(f.recovery.recover(8)));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure._tag).toBe("ControlPlaneTransactionOutcomeUnknown");
  expect(f.queries.filter(q => q.text.startsWith("SELECT reconcile_account_owner"))).toHaveLength(1);
  expect(JSON.stringify(f.logs)).not.toContain("opaque original fixture failure");
});
test("excess or duplicate due records rollback before list COMMIT and no reconcile starts", async () => {
  for (const candidates of [[{ ...first, proof: "private" }], [first, first]]) {
    const f = fixture({ candidates });
    const result = await Effect.runPromise(Effect.result(f.recovery.recover(8)));
    expect(result._tag).toBe("Failure");
    expect(f.queries.some(q => q.text === "ROLLBACK")).toBe(true);
    expect(f.queries.some(q => q.text === "COMMIT")).toBe(false);
    expect(f.queries.some(q => q.text.startsWith("SELECT reconcile_account_owner"))).toBe(false);
  }
});
test("a foreign coherent receipt is rejected inside the owning reconcile transaction", async () => {
  const f = fixture({ reply: { ...second, state: "completed" } });
  const result = await Effect.runPromise(Effect.result(f.recovery.recover(8)));
  expect(result._tag).toBe("Failure");
  expect(f.queries.filter(q => q.text === "COMMIT")).toHaveLength(1);
  expect(f.queries.some(q => q.text === "ROLLBACK")).toBe(true);
});
test("known completed and stale original receipts stay read-only summaries and invalid bounds issue no SQL", async () => {
  for (const state of ["completed", "stale"] as const) {
    const f = fixture({ reply: { ...first, state } });
    const result = await Effect.runPromise(f.recovery.recover(1));
    expect(result.examined).toBe(1);
    expect(result.reconciled).toBe(0);
    expect(result[state]).toBe(1);
  }
  const f = fixture();
  expect((await Effect.runPromise(Effect.result(f.recovery.recover(9))))._tag).toBe("Failure");
  expect(f.queries).toHaveLength(0);
});
