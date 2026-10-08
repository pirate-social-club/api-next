import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { fixtureAccounts, readBrowserAccount } from "./browser-accounts.mjs";
import { browserApi } from "./browser-api.mjs";
import { installBrowserWalletDriver } from "./browser-wallet-build.mjs";
import { canonicalFixtureTransaction, fixtureOperator, fixtureToken } from "./fixture-chain.mjs";
import { executeOnce } from "./single-use.mjs";
import { feeCeilings, reserveSpending } from "./spending-ledger.mjs";

/** All credentials and provider state remain in the browser; only fee facts and the public hash return. */
export async function submitPaidCredit(page, role, credit, run, driver, check) {
  const fixture = fixtureAccounts[role];
  if (
    !fixture ||
    credit.account_id !== fixture.accountId ||
    credit.state !== "sent" ||
    credit.paid_atomic !== credit.amount_atomic
  )
    throw Error("Confirmed participant credit required");
  await check();
  const id = `winner-send-${role}`;
  const record = await executeOnce(
    run.directory,
    `${id}-reserve`,
    check,
    () =>
      browserApi(page, `/api/rewards/credits/${credit.credit_id}/send`, {
        method: "POST",
        body: {
          recipient: fixtureOperator,
          amount_atomic: credit.amount_atomic,
          idempotency_key: `${run.runId}-${role}-send`,
        },
      }),
    { recheck: check, deadline: run.deadline },
  );
  if (
    record.recipient?.toLowerCase() !== fixtureOperator ||
    record.token_address?.toLowerCase() !== fixtureToken ||
    record.amount_atomic !== credit.amount_atomic ||
    record.chain_id !== 84532 ||
    !Number.isSafeInteger(Number(record.nonce))
  )
    throw Error("Prepared onward transfer differs");
  const evidencePath = winnerSubmissionPath(run, role);
  let durable;
  try {
    durable = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (durable) {
    assertSubmissionMatches(durable, record, credit, run);
    // Recording the exact known transaction is evidence, even if its earlier
    // attachment response was lost. Never enter the wallet path again.
    await attachWinnerSubmission(page, durable);
    return durable;
  }
  const hashes = record.transaction_hashes;
  if (!Array.isArray(hashes) || hashes.some((hash) => !/^0x[0-9a-f]{64}$/.test(hash)))
    throw Error("Winner transaction evidence unreadable");
  if (hashes.length > 0) {
    return { creditId: credit.credit_id, sendId: record.send_id, hashes, observationOnly: true };
  }
  if (record.status !== "retryable" || record.cancellation_hashes?.length > 0)
    throw Error("Winner send requires observation, not a new signature");
  if (existsSync(resolve(run.ledgerDirectory, `${run.runId}--${id}.json`)))
    throw Error("Winner spending already reserved without recoverable hash; never replay");
  await installBrowserWalletDriver(page, driver);
  const account = await readBrowserAccount(page);
  if (account.status !== 200 || account.accountId !== fixture.accountId)
    throw Error("Winner browser account differs");
  const { personas } = await browserApi(page, "/api/personas");
  const persona = personas.find((item) => item.persona_id === credit.payout_persona_id);
  const wallet = persona?.wallet_set?.evm;
  if (
    persona?.status !== "active" ||
    wallet?.address?.toLowerCase() !== record.sender?.toLowerCase() ||
    !Number.isSafeInteger(wallet?.hd_wallet_index)
  )
    throw Error("Confirmed payout wallet differs");
  const topup = await executeOnce(
    run.directory,
    `${id}-gas`,
    check,
    () =>
      browserApi(page, "/api/rewards/gas-topups", {
        method: "POST",
        body: { credit_id: credit.credit_id, idempotency_key: `${run.runId}-${role}-gas` },
      }),
    { recheck: check, deadline: run.deadline },
  );
  if (topup.status === "pending") {
    let confirmed = false;
    while (Date.now() < run.deadline) {
      await check();
      const state = await browserApi(page, `/api/rewards/gas-topups/${topup.topup_id}`);
      if (state.status === "confirmed") {
        confirmed = true;
        break;
      }
      if (state.status === "released") throw Error("Gas top-up released");
      await Bun.sleep(2000);
    }
    if (!confirmed) throw Error("Gas top-up confirmation timed out");
  } else if (topup.status !== "not_needed") throw Error("Gas top-up cap refused");
  const transfer = {
    sender: record.sender,
    token: record.token_address,
    recipient: record.recipient,
    amountAtomic: record.amount_atomic,
    walletIndex: wallet.hd_wallet_index,
    nonce: Number(record.nonce),
  };
  const email = process.env[`${fixture.credentialPrefix}_EMAIL`],
    code = process.env[`${fixture.credentialPrefix}_OTP`];
  if (!email || !/^\d{6}$/.test(code ?? "")) throw Error("Winner wallet credentials unavailable");
  const fee = await page.evaluate(
    async ({ email, code, transfer }) => {
      try {
        const wallet = await IsolatedRewardsWallet.openWallet();
        window.isolatedRewardsSendWallet = wallet;
        await wallet.sendCode(email);
        await wallet.loginWithCode(email, code);
        await wallet.selectTestnetFor(transfer);
        return await wallet.estimateTransfer(transfer);
      } catch {
        throw Error("Real winner wallet authorization or fee review failed");
      }
    },
    { email, code, transfer },
  );
  if (
    !/^[1-9][0-9]*$/.test(fee.executionFeeAtomic) ||
    BigInt(fee.executionFeeAtomic) > feeCeilings.winnerSendWei
  )
    throw Error("Winner fee bound refused");
  await page.exposeFunction("isolatedRewardsSendRecheck", check);
  const hash = await executeOnce(
    run.directory,
    id,
    async () => {
      await check();
      await reserveSpending(run.ledgerDirectory, {
        authoritySha256: run.authoritySha256,
        chainId: 84532,
        runId: run.runId,
        actionId: id,
        kind: "send",
        usdcAtomic: credit.amount_atomic,
        ethWei: fee.executionFeeAtomic,
      });
    },
    () =>
      page.evaluate(
        async ({ transfer, fee }) => {
          try {
            return await window.isolatedRewardsSendWallet.sendTransfer(transfer, fee, () =>
              window.isolatedRewardsSendRecheck(),
            );
          } catch {
            throw Error("Onward signature or submission failed; never replay");
          } finally {
            window.isolatedRewardsSendWallet?.dispose();
            delete window.isolatedRewardsSendWallet;
          }
        },
        { transfer, fee },
      ),
    { recheck: check, deadline: run.deadline },
  );
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw Error("Onward transaction identity uncertain");
  const submitted = {
    runId: run.runId,
    creditId: credit.credit_id,
    sendId: record.send_id,
    hash,
    hashes: [hash],
    sender: record.sender.toLowerCase(),
    recipient: record.recipient.toLowerCase(),
    token: record.token_address.toLowerCase(),
    amountAtomic: record.amount_atomic,
    nonce: String(record.nonce),
    chainId: record.chain_id,
    walletSource: driver.solidSource,
  };
  // Persist the public hash before waiting for a receipt or recording it in
  // the app. A restart can recover only this hash, never another signature.
  mkdirSync(resolve(evidencePath, ".."), { recursive: true, mode: 0o700 });
  const evidenceFile = openSync(evidencePath, "wx", 0o600);
  try {
    writeSync(evidenceFile, `${JSON.stringify(submitted)}\n`);
    fsyncSync(evidenceFile);
  } finally {
    closeSync(evidenceFile);
  }
  const evidenceDirectory = openSync(resolve(evidencePath, ".."), "r");
  try {
    fsyncSync(evidenceDirectory);
  } finally {
    closeSync(evidenceDirectory);
  }
  await canonicalFixtureTransaction(run.chain, hash, run.deadline);
  await attachWinnerSubmission(page, submitted);
  return submitted;
}

export function winnerSubmissionPath(run, role) {
  if (!/^win-[0-9]+$/.test(run.runId) || !["study", "karaoke"].includes(role))
    throw Error("Winner submission identity differs");
  return resolve(
    run.ledgerDirectory,
    "..",
    "winner-send-submissions",
    `${run.runId}--${role}.json`,
  );
}

export function assertSubmissionMatches(submitted, record, credit, run) {
  if (
    submitted.runId !== run.runId ||
    submitted.creditId !== credit.credit_id ||
    submitted.sendId !== record.send_id ||
    submitted.sender !== record.sender?.toLowerCase() ||
    submitted.recipient !== fixtureOperator ||
    submitted.recipient !== record.recipient?.toLowerCase() ||
    submitted.token !== fixtureToken ||
    submitted.token !== record.token_address?.toLowerCase() ||
    submitted.amountAtomic !== credit.amount_atomic ||
    submitted.amountAtomic !== record.amount_atomic ||
    submitted.chainId !== 84532 ||
    record.chain_id !== 84532 ||
    submitted.nonce !== String(record.nonce) ||
    !/^0x[0-9a-f]{64}$/.test(submitted.hash) ||
    !Array.isArray(submitted.hashes) ||
    submitted.hashes.length !== 1 ||
    submitted.hashes[0] !== submitted.hash
  )
    throw Error("Durable winner submission differs");
}

export async function attachWinnerSubmission(page, submitted) {
  // The endpoint itself validates sender, nonce, calldata and the exact token
  // transfer. One lost response gets one evidence-only retry of the same hash.
  const path = `/api/rewards/winner-sends/${submitted.sendId}/transactions`;
  try {
    return await browserApi(page, path, {
      method: "POST",
      body: { transaction_hash: submitted.hash },
    });
  } catch {
    const read = await browserApi(page, `/api/rewards/winner-sends/${submitted.sendId}`);
    if (read.transaction_hashes?.includes(submitted.hash)) return read;
    return browserApi(page, path, { method: "POST", body: { transaction_hash: submitted.hash } });
  }
}

/** No wallet, gas request, spending reservation or signature is reachable here. */
export async function observePaidCredit(page, credit, submission) {
  const record = await browserApi(page, `/api/rewards/credits/${credit.credit_id}/send`);
  if (
    record.credit_id !== credit.credit_id ||
    record.chain_id !== 84532 ||
    record.recipient?.toLowerCase() !== fixtureOperator ||
    record.token_address?.toLowerCase() !== fixtureToken ||
    record.amount_atomic !== credit.amount_atomic ||
    !Array.isArray(record.transaction_hashes) ||
    record.transaction_hashes.length === 0 ||
    (submission &&
      (record.send_id !== submission.sendId ||
        !submission.hashes.every((hash) => record.transaction_hashes.includes(hash))))
  )
    throw Error("Observed winner send differs");
  if (["reverted", "cancelled", "settled_unverified"].includes(record.status))
    throw Error("Winner send reached a failed terminal outcome");
  return record;
}
