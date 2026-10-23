import { expect, test } from "bun:test";
import { Effect } from "effect";
import { fixedUsdcBonusFundingFixture } from "../../../testing/src/fixed-usdc-bonus-funding-fixture.ts";
import {
  prepareFixedUsdcBonusBudget,
  prepareFixedUsdcBonusCustody,
  prepareFixedUsdcBonusObservation,
} from "./fixed-usdc-bonus-funding.ts";

const f = fixedUsdcBonusFundingFixture(1000000);
const prepare = (value: unknown) => Effect.runPromise(prepareFixedUsdcBonusCustody(value));
test("native Base USDC and its explicit independent custody policy are the only admitted asset shape", async () => {
  const packet = await prepare(f.policy);
  expect(packet.policy).toEqual(f.policy);
  expect(packet.policyHash).toMatch(/^[a-f0-9]{64}$/u);
  for (const change of [
    { chain_id: 84532 },
    { token_address: `0x${"d".repeat(40)}` },
    { token_decimals: 18 },
    { safe_address: f.policy.token_address },
    { safe_address: `0x${"0".repeat(40)}` },
    { asset_policy_version: "plain-erc20" },
    { megapot_attestation_id: "not-a-bonus-authority" },
    { maximum_budget_count: 0 },
    { valid_until_ms: f.policy.valid_from_ms },
  ]) {
    await expect(prepare({ ...f.policy, ...change })).rejects.toMatchObject({
      reason: "invalid-input",
    });
  }
});
test("strict atomic strings reject rounding, overflow and noncanonical alternate forms", async () => {
  for (const value of [
    "01",
    "+1",
    "1.0",
    "1e6",
    "-1",
    " 1",
    "",
    "wrong",
    "0",
    (1n << 256n).toString(),
    1000000,
  ]) {
    await expect(prepare({ ...f.policy, funded_cap_atomic: value })).rejects.toMatchObject({
      reason: "invalid-input",
    });
  }
  const maximum = ((1n << 256n) - 1n).toString();
  expect(
    (await prepare({ ...f.policy, funded_cap_atomic: maximum })).policy.funded_cap_atomic,
  ).toBe(maximum);
});
test("canonical hashing survives object key reordering and changes with any custody authority", async () => {
  const packet = await prepare(f.policy);
  expect(await prepare(Object.fromEntries(Object.entries(f.policy).reverse()))).toEqual(packet);
  for (const change of [
    { safe_binding_hash: "d".repeat(64) },
    { funded_cap_atomic: "10000001" },
    { acceptance_hash: "e".repeat(64) },
    { minimum_confirmations: 3 },
  ]) {
    expect((await prepare({ ...f.policy, ...change })).policyHash).not.toBe(packet.policyHash);
  }
});
test("observations retain exact chain facts; freshness and original replay remain database decisions", async () => {
  const packet = await Effect.runPromise(prepareFixedUsdcBonusObservation(f.observation));
  expect(packet.observation).toEqual(f.observation);
  for (const change of [
    { head_block_number: "99" },
    { observed_at_ms: 0 },
    { block_hash: "missing" },
    { balance_atomic: "-1" },
    { extra: true },
  ]) {
    await expect(
      Effect.runPromise(prepareFixedUsdcBonusObservation({ ...f.observation, ...change })),
    ).rejects.toMatchObject({ reason: "invalid-input" });
  }
  expect(
    (
      await Effect.runPromise(
        prepareFixedUsdcBonusObservation({ ...f.observation, balance_atomic: "0" }),
      )
    ).observation.balance_atomic,
  ).toBe("0");
});
test("budget multiplication remains exact above the JavaScript number range", async () => {
  const command = {
    ...f.command,
    amount_per_account_atomic: "9007199254740993",
    maximum_accounts: 3,
  };
  expect((await Effect.runPromise(prepareFixedUsdcBonusBudget(command))).command).toEqual(command);
  for (const change of [
    { maximum_accounts: 0 },
    { maximum_accounts: 1.5 },
    { amount_per_account_atomic: ((1n << 256n) - 1n).toString(), maximum_accounts: 2 },
    { ends_at_ms: f.command.starts_at_ms },
  ]) {
    await expect(
      Effect.runPromise(prepareFixedUsdcBonusBudget({ ...f.command, ...change })),
    ).rejects.toMatchObject({ reason: "invalid-input" });
  }
});
