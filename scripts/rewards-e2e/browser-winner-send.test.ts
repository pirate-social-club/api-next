import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fixtureAccounts } from "./browser-accounts.mjs";
import {
  assertSubmissionMatches,
  observePaidCredit,
  submitPaidCredit,
  winnerSubmissionPath,
} from "./browser-winner-send.mjs";
import { fixtureOperator, fixtureToken } from "./fixture-chain.mjs";

const hash = `0x${"a".repeat(64)}`;
const credit = {
  credit_id: "credit-study",
  account_id: fixtureAccounts.study.accountId,
  state: "sent",
  paid_atomic: "500000",
  amount_atomic: "500000",
};
const wire = {
  credit_id: credit.credit_id,
  send_id: "winner-send_1",
  chain_id: 84532,
  sender: `0x${"b".repeat(40)}`,
  recipient: fixtureOperator,
  token_address: fixtureToken,
  amount_atomic: "500000",
  nonce: "15",
  status: "pending",
  transaction_hashes: [hash],
  cancellation_hashes: [],
};
function setup(status = "pending", hashes = [hash]) {
  const directory = mkdtempSync(resolve(tmpdir(), "rewards-send-test-"));
  const run = {
    runId: "win-1",
    directory: resolve(directory, "attempt"),
    ledgerDirectory: resolve(directory, "ledger"),
    deadline: Date.now() + 60000,
  };
  const calls: Array<{ path: string; method: string; body?: { transaction_hash?: string } }> = [];
  const record = { ...wire, status, transaction_hashes: hashes };
  const page = {
    url: () => "https://web-megapot-e2e-staging.pirate.sc/wallet",
    evaluate: async (
      _fn: unknown,
      input: { path: string; method: string; body?: { transaction_hash?: string } },
    ) => {
      if (!input.path) throw Error("Wallet execution must not be reached");
      calls.push(input);
      return record;
    },
  };
  const submitted = {
    runId: run.runId,
    creditId: credit.credit_id,
    sendId: wire.send_id,
    hash,
    hashes: [hash],
    sender: wire.sender,
    recipient: fixtureOperator,
    token: fixtureToken,
    amountAtomic: "500000",
    nonce: "15",
    chainId: 84532,
  };
  return {
    directory,
    run,
    calls,
    record,
    page,
    submitted,
    cleanup: () => rmSync(directory, { recursive: true }),
  };
}

test("accepted pending, confirmed and retryable hashes never reach wallet, gas or spending again", async () => {
  for (const status of ["pending", "confirmed", "retryable"]) {
    const f = setup(status);
    try {
      const result = await submitPaidCredit(f.page, "study", credit, f.run, {}, async () => {});
      expect(result).toMatchObject({ observationOnly: true, hashes: [hash] });
      expect(f.calls.map((call) => call.path)).toEqual([
        `/api/rewards/credits/${credit.credit_id}/send`,
      ]);
      expect(readdirSync(f.directory)).toEqual(["attempt"]);
    } finally {
      f.cleanup();
    }
  }
});

test("a durable hash with a lost attachment reply retries evidence for that exact hash only", async () => {
  const f = setup("retryable", []);
  const path = winnerSubmissionPath(f.run, "study");
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(f.submitted));
  let attachment = 0;
  const evaluate = f.page.evaluate;
  f.page.evaluate = async (fn, input) => {
    const result = await evaluate(fn, input);
    if (input.path.endsWith("/transactions")) {
      attachment++;
      if (attachment === 1) throw Error("Response lost");
      result.transaction_hashes = [hash];
    }
    return result;
  };
  try {
    expect(await submitPaidCredit(f.page, "study", credit, f.run, {}, async () => {})).toEqual(
      f.submitted,
    );
    expect(
      f.calls.filter((call) => call.path.endsWith("/transactions")).map((call) => call.body),
    ).toEqual([{ transaction_hash: hash }, { transaction_hash: hash }]);
    expect(f.calls.some((call) => call.path.includes("gas-topups"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("an uncertain spending reservation without a recoverable hash refuses before wallet or gas", async () => {
  const f = setup("retryable", []);
  mkdirSync(f.run.ledgerDirectory);
  writeFileSync(resolve(f.run.ledgerDirectory, "win-1--winner-send-study.json"), "{}");
  try {
    await expect(
      submitPaidCredit(f.page, "study", credit, f.run, {}, async () => {}),
    ).rejects.toThrow("never replay");
    expect(f.calls.length).toBe(1);
  } finally {
    f.cleanup();
  }
});

test("durable submissions bind the original send, credit, nonce, sender, token, recipient and amount", () => {
  const f = setup();
  try {
    assertSubmissionMatches(f.submitted, wire, credit, f.run);
    for (const change of [
      { nonce: "16" },
      { sendId: "other" },
      { creditId: "other" },
      { sender: fixtureOperator },
      { token: fixtureOperator },
      { recipient: wire.sender },
      { amountAtomic: "1" },
      { chainId: 8453 },
      { hash: "bad" },
      { hashes: [] },
      { hashes: [`0x${"c".repeat(64)}`] },
    ])
      expect(() =>
        assertSubmissionMatches({ ...f.submitted, ...change }, wire, credit, f.run),
      ).toThrow("differs");
  } finally {
    f.cleanup();
  }
});

test("passive observation accepts only the pinned send and known hashes, and rejects terminal failure", async () => {
  const f = setup("confirmed");
  try {
    expect((await observePaidCredit(f.page, credit, f.submitted)).status).toBe("confirmed");
    f.record.transaction_hashes = [`0x${"c".repeat(64)}`];
    await expect(observePaidCredit(f.page, credit, f.submitted)).rejects.toThrow("differs");
    f.record.transaction_hashes = [hash];
    f.record.status = "reverted";
    await expect(observePaidCredit(f.page, credit, f.submitted)).rejects.toThrow("failed terminal");
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  } finally {
    f.cleanup();
  }
});
