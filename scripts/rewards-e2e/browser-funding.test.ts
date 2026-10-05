import { expect, test } from "bun:test";
import { checkWalletFundingStatus, verifyTransferReview } from "./browser-funding.mjs";

const expected = {
  chainId: 84532,
  sender: `0x${"a".repeat(40)}`,
  recipient: `0x${"b".repeat(40)}`,
  token: `0x${"c".repeat(40)}`,
  amountAtomic: "1000000",
  maximumExecutionFeeWei: "1000000000000000",
};
const review = {
  network: "Base Sepolia · testnet",
  wallet: expected.sender,
  recipient: expected.recipient,
  token: expected.token,
  amount: "1 USDC",
  confirmations: "3",
  executionFee: "0.0001 ETH",
};
test("rendered isolated wallet transfer matches all exact terms", () => {
  expect(verifyTransferReview(review, expected).amountAtomic).toBe("1000000");
});
test("another wallet, custody, token, chain, amount or confirmation threshold refuses", () => {
  for (const changed of [
    { wallet: `0x${"d".repeat(40)}` },
    { recipient: `0x${"d".repeat(40)}` },
    { token: `0x${"d".repeat(40)}` },
    { network: "Base · mainnet" },
    { amount: "2 USDC" },
    { confirmations: "1" },
  ])
    expect(() => verifyTransferReview({ ...review, ...changed }, expected)).toThrow("differs");
});
test("fee overflow, negative amounts and malformed fee text refuse before transfer", () => {
  for (const executionFee of ["0.002 ETH", "-1 ETH", "1.0 USDC", "1e-4 ETH"])
    expect(() => verifyTransferReview({ ...review, executionFee }, expected)).toThrow("fee");
});
test("the status check presses only a visible, enabled Check status control", async () => {
  const dialog = (visible: boolean, enabled: boolean, clicks: string[]) => ({
    getByRole: (role: string, options: { name: string; exact: boolean }) => ({
      isVisible: async () => visible,
      isEnabled: async () => enabled,
      click: async () => {
        clicks.push(`${role}:${options.name}:${options.exact}`);
      },
    }),
  });
  for (const [visible, enabled, pressed] of [
    [true, true, true],
    [true, false, false],
    [false, true, false],
  ] as const) {
    const clicks: string[] = [];
    expect(await checkWalletFundingStatus(dialog(visible, enabled, clicks))).toBe(pressed);
    expect(clicks).toEqual(pressed ? ["button:Check status:true"] : []);
  }
});
