import { parseUnits } from "viem";
import { fixtureAccounts, readBrowserAccount } from "./browser-accounts.mjs";

const address = /^0x[0-9a-f]{40}$/i;
/** Verify the actual rendered transfer, including details hidden by disclosure. */
export function verifyTransferReview(review, expected) {
  if (
    !address.test(expected.sender ?? "") ||
    !address.test(expected.recipient ?? "") ||
    !address.test(expected.token ?? "") ||
    expected.chainId !== 84532 ||
    expected.amountAtomic !== "1000000" ||
    !/^[1-9][0-9]*$/.test(expected.maximumExecutionFeeWei ?? "")
  )
    throw new Error("Funding transfer plan is invalid");
  if (
    review.network !== "Base Sepolia · testnet" ||
    review.amount !== "1 USDC" ||
    review.wallet?.toLowerCase() !== expected.sender.toLowerCase() ||
    review.recipient?.toLowerCase() !== expected.recipient.toLowerCase() ||
    review.token?.toLowerCase() !== expected.token.toLowerCase() ||
    review.confirmations !== "3"
  )
    throw new Error("Rendered funding transfer differs from the isolated plan");
  if (
    !/^(0|[1-9][0-9]*)(\.[0-9]{1,18})? ETH$/.test(review.executionFee ?? "") ||
    parseUnits(review.executionFee.slice(0, -4), 18) > BigInt(expected.maximumExecutionFeeWei)
  )
    throw new Error("Rendered funding fee exceeds the bound");
  return {
    sender: expected.sender,
    recipient: expected.recipient,
    token: expected.token,
    chainId: 84532,
    amountAtomic: "1000000",
  };
}

export async function reviewWalletFunding(page, dialog, expected, credentials = process.env) {
  const fixture = fixtureAccounts.sponsor;
  const account = await readBrowserAccount(page);
  if (account.status !== 200 || account.accountId !== fixture.accountId)
    throw new Error("Funding sponsor account differs");
  const email = credentials[`${fixture.credentialPrefix}_EMAIL`];
  const code = credentials[`${fixture.credentialPrefix}_OTP`];
  if (typeof email !== "string" || !email.includes("@") || !/^[0-9]{6}$/.test(code ?? ""))
    throw new Error("Wallet credentials unavailable; values suppressed");
  try {
    await dialog.getByRole("textbox", { name: "Email for your wallet", exact: true }).fill(email);
    await dialog.getByRole("button", { name: "Send code", exact: true }).click();
    const field = dialog.getByRole("textbox", { name: "Code", exact: true });
    await field.waitFor({ timeout: 15000 });
    await field.fill(code);
    await dialog.getByRole("button", { name: "Review transfer", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Confirm transfer", exact: true })
      .waitFor({ timeout: 30000 });
    const details = dialog
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "Transfer details" }) });
    if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
    const value = async (label) =>
      (
        await dialog
          .locator("dt")
          .filter({ hasText: new RegExp(`^${label}$`) })
          .locator("xpath=following-sibling::dd[1]")
          .innerText()
      ).trim();
    const review = {
      wallet: await value("Wallet"),
      network: await value("Network"),
      amount: await value("Amount"),
      executionFee: await value("Estimated execution fee"),
      token: await value("Token contract"),
      recipient: await value("Recipient"),
      confirmations: await value("Confirmations required"),
    };
    verifyTransferReview(review, expected);
    return review;
  } catch {
    throw new Error("Wallet authorization or transfer review refused; credentials suppressed");
  }
}

/** Caller rechecks funding identity, reserves cumulative spend, then consumes once. */
export async function confirmWalletFunding(page, dialog, consumeTransfer) {
  if (typeof consumeTransfer !== "function")
    throw new Error("Funding consumption callback missing");
  const submit = dialog.getByRole("button", { name: "Confirm transfer", exact: true });
  if (!(await submit.isVisible()) || !(await submit.isEnabled()))
    throw new Error("Funding review is not ready");
  await consumeTransfer(
    async () => {
      const account = await readBrowserAccount(page);
      if (account.status !== 200 || account.accountId !== fixtureAccounts.sponsor.accountId)
        throw new Error("Funding sponsor changed before submission");
    },
    async () => {
      await submit.click();
    },
  );
}

/**
 * The app observes a submitted transfer once and then waits for the sponsor to ask again.
 * The control only re-reads the bound hash; it cannot sign or send another transfer.
 */
export async function checkWalletFundingStatus(dialog) {
  const button = dialog.getByRole("button", { name: "Check status", exact: true });
  if (!(await button.isVisible()) || !(await button.isEnabled())) return false;
  await button.click();
  return true;
}
