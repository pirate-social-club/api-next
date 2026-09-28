import { encodeFunctionData, erc20Abi, getAddress, zeroAddress } from "viem";
import {
  type PreparedPrivySponsoredEvmCall,
  preparePrivySponsoredEvmCall,
} from "./privy-sponsored-transaction.ts";

/** Values loaded from a durable, account-scoped reservation, never from the browser's submit body. */
export type RewardSponsoredSendReservation = Readonly<{
  walletId: string;
  chainId: 8453 | 84532;
  senderAddress: string;
  tokenAddress: string;
  recipientAddress: string;
  amountAtomic: bigint;
  paidAtomic: bigint;
  referenceId: string;
  idempotencyKey: string;
  expiresAtMs: number;
}>;

/** Format the one USDC transfer the winner authorized and the server reserved. */
export function prepareRewardSponsoredSendRequest(
  reservation: RewardSponsoredSendReservation,
  appId: string,
  nowMs: number,
): PreparedPrivySponsoredEvmCall {
  const sender = getAddress(reservation.senderAddress);
  const token = getAddress(reservation.tokenAddress);
  const recipient = getAddress(reservation.recipientAddress);
  if (
    token === zeroAddress ||
    recipient === zeroAddress ||
    recipient === sender ||
    recipient === token ||
    reservation.amountAtomic <= 0n ||
    reservation.amountAtomic > reservation.paidAtomic ||
    reservation.amountAtomic >= 1n << 256n
  ) {
    throw new Error("invalid sponsored reward transfer");
  }
  return preparePrivySponsoredEvmCall(
    {
      appId,
      walletId: reservation.walletId,
      chainId: reservation.chainId,
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipient, reservation.amountAtomic],
      }),
      referenceId: reservation.referenceId,
      idempotencyKey: reservation.idempotencyKey,
      expiresAtMs: reservation.expiresAtMs,
    },
    nowMs,
  );
}
