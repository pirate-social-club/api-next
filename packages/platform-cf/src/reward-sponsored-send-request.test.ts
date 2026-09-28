import { describe, expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi } from "viem";
import {
  prepareRewardSponsoredSendRequest,
  type RewardSponsoredSendReservation,
} from "./reward-sponsored-send-request.ts";

const reservation: RewardSponsoredSendReservation = {
  walletId: "wallet_12345678",
  chainId: 84532,
  senderAddress: "0x1111111111111111111111111111111111111111",
  tokenAddress: "0x2222222222222222222222222222222222222222",
  recipientAddress: "0x3333333333333333333333333333333333333333",
  amountAtomic: 1_000_000n,
  paidAtomic: 1_000_000n,
  referenceId: "reference_1234567890",
  idempotencyKey: "idempotency_1234567890",
  expiresAtMs: 1_800_000,
};

describe("reward sponsored send request", () => {
  test("binds one exact paid USDC transfer without an account identifier", () => {
    const prepared = prepareRewardSponsoredSendRequest(reservation, "app_12345678", 1_700_000);
    expect(prepared.url).toBe("https://api.privy.io/v1/wallets/wallet_12345678/rpc");
    expect(prepared.body.sponsor).toBe(true);
    expect(prepared.body.caip2).toBe("eip155:84532");
    expect(prepared.body.params.transaction.to).toBe(reservation.tokenAddress);
    expect(prepared.body.params.transaction.value).toBe("0x0");
    expect(
      decodeFunctionData({ abi: erc20Abi, data: prepared.body.params.transaction.data }),
    ).toEqual({ functionName: "transfer", args: [reservation.recipientAddress, 1_000_000n] });
    expect(JSON.stringify(prepared.body)).not.toContain(reservation.senderAddress);
  });

  test("refuses an amount above the paid credit and irreversible recipients", () => {
    expect(() =>
      prepareRewardSponsoredSendRequest(
        { ...reservation, amountAtomic: 1_000_001n },
        "app_12345678",
        1_700_000,
      ),
    ).toThrow("invalid sponsored reward transfer");
    for (const recipientAddress of [
      reservation.senderAddress,
      reservation.tokenAddress,
      "0x0000000000000000000000000000000000000000",
    ]) {
      expect(() =>
        prepareRewardSponsoredSendRequest(
          { ...reservation, recipientAddress },
          "app_12345678",
          1_700_000,
        ),
      ).toThrow("invalid sponsored reward transfer");
    }
  });
});
