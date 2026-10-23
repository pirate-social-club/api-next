import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  prepareFixedUsdcBonusBudget,
  prepareFixedUsdcBonusCustody,
} from "../../application/src/rewards/fixed-usdc-bonus-funding.ts";
import { fixedUsdcBonusFundingFixture } from "../../testing/src/fixed-usdc-bonus-funding-fixture.ts";
import { makeFixedUsdcBonusFundingStore } from "./fixed-usdc-bonus-funding-repository.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

function fixture(receipt: unknown, commitUnknown = false) {
  const queries: PostgresQueryConfig[] = [];
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      if (query.text === "COMMIT" && commitUnknown) throw new Error("commit response lost");
      if (query.text.startsWith("SELECT current_setting"))
        return {
          rows: [{ transaction: "3s", lock: "250ms", statement: "2s", idle: "2s" }],
          rowCount: 1,
        };
      if (
        /SELECT (admit_fixed_usdc_bonus_custody|allocate_fixed_usdc_bonus_budget)_v1/u.test(
          query.text,
        )
      )
        return { rows: [{ receipt }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return {
    queries,
    store: makeFixedUsdcBonusFundingStore(
      makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/fixed-bonus", {
        clientFactory: () => client,
        logger: { info: () => {}, error: () => {} },
      }),
    ),
  };
}
const facts = fixedUsdcBonusFundingFixture(1000000);
test("private custody responses must bind the original identity and exact policy hash", async () => {
  const packet = await Effect.runPromise(prepareFixedUsdcBonusCustody(facts.policy));
  const valid = {
    version: "fixed-usdc-bonus-custody-receipt-v1",
    custody_id: packet.policy.custody_id,
    policy_hash: packet.policyHash,
    admitted_at_ms: 1000000,
  };
  for (const change of [
    { custody_id: "foreign" },
    { policy_hash: "0".repeat(64) },
    { extra: true },
  ]) {
    const f = fixture({ ...valid, ...change });
    await expect(Effect.runPromise(f.store.admitCustody(packet))).rejects.toMatchObject({
      reason: "invalid-row",
    });
    expect(f.queries.filter((q) => q.text.includes("SELECT admit_fixed"))).toHaveLength(1);
    expect(f.queries.some((q) => q.text === "COMMIT")).toBe(false);
  }
});
test("a budget decoder rejects foreign terms, bad totals and a backdated participation start", async () => {
  const packet = await Effect.runPromise(prepareFixedUsdcBonusBudget(facts.command));
  const valid = {
    version: "fixed-usdc-bonus-budget-receipt-v1" as const,
    custody_id: facts.command.custody_id,
    budget_id: facts.command.budget_id,
    request_hash: packet.requestHash,
    amount_per_account_atomic: "2000000",
    maximum_accounts: 2,
    total_atomic: "4000000",
    funded_at_ms: 1000000,
    participation_starts_at_ms: facts.command.starts_at_ms,
    ends_at_ms: facts.command.ends_at_ms,
  };
  for (const change of [
    { budget_id: "foreign" },
    { request_hash: "0".repeat(64) },
    { total_atomic: "4000001" },
    { amount_per_account_atomic: "1000000", total_atomic: "2000000" },
    { ends_at_ms: facts.command.ends_at_ms + 1 },
    { participation_starts_at_ms: 999999 },
    { extra: true },
  ]) {
    const f = fixture({ ...valid, ...change });
    await expect(Effect.runPromise(f.store.allocateBudget(packet))).rejects.toMatchObject({
      reason: "invalid-row",
    });
    expect(f.queries.filter((q) => q.text.includes("SELECT allocate_fixed"))).toHaveLength(1);
  }
  expect(await Effect.runPromise(fixture(valid).store.allocateBudget(packet))).toEqual(valid);
});
test("a lost commit acknowledgement is unknown and never silently dispatches a second command", async () => {
  const packet = await Effect.runPromise(prepareFixedUsdcBonusCustody(facts.policy));
  const valid = {
    version: "fixed-usdc-bonus-custody-receipt-v1",
    custody_id: packet.policy.custody_id,
    policy_hash: packet.policyHash,
    admitted_at_ms: 1000000,
  };
  const f = fixture(valid, true);
  await expect(Effect.runPromise(f.store.admitCustody(packet))).rejects.toMatchObject({
    reason: "outcome-unknown",
  });
  expect(f.queries.filter((q) => q.text.includes("SELECT admit_fixed"))).toHaveLength(1);
  expect(f.queries.filter((q) => q.text === "COMMIT")).toHaveLength(1);
});
