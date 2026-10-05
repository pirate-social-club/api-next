import { fixtureAccounts, readBrowserAccount } from "./browser-accounts.mjs";
import { browserApi } from "./browser-api.mjs";
import { installBrowserWalletDriver } from "./browser-wallet-build.mjs";
import { canonicalFixtureTransaction, fixtureOperator, fixtureToken } from "./fixture-chain.mjs";
import { waitForEvidence } from "./run-evidence.mjs";
import { executeOnce } from "./single-use.mjs";
import { reserveSpending } from "./spending-ledger.mjs";

/** All credentials and provider state remain in the browser; only fee facts and the public hash return. */
export async function sendPaidCredit(page, role, credit, run, driver, check) {
  const fixture = fixtureAccounts[role];
  if (
    !fixture ||
    credit.account_id !== fixture.accountId ||
    credit.state !== "sent" ||
    credit.paid_atomic !== credit.amount_atomic
  )
    throw Error("Confirmed participant credit required");
  await check();
  await installBrowserWalletDriver(page, driver);
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
    BigInt(fee.executionFeeAtomic) > 5000000000000000n
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
  await canonicalFixtureTransaction(run.chain, hash, run.deadline);
  const attached = await browserApi(
    page,
    `/api/rewards/winner-sends/${record.send_id}/transactions`,
    { method: "POST", body: { transaction_hash: hash } },
  );
  const confirmed = await waitForEvidence(
    "Onward send chain readback",
    run.deadline,
    () => browserApi(page, `/api/rewards/winner-sends/${record.send_id}`),
    (result) => result.status === "confirmed" && result.transaction_hashes.includes(hash),
    check,
  );
  return {
    sendId: record.send_id,
    hash,
    record: confirmed,
    attachedStatus: attached.status,
    walletSource: driver.solidSource,
  };
}
