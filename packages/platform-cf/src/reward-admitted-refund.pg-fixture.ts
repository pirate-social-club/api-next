import type { RewardRefundReservation, RewardRefundStore } from "@pirate/application";
import { Effect } from "effect";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from "viem";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import { makeRewardRefundCoordinator } from "./reward-refund-coordinator.ts";

/** Runs the production retry entrypoint against a real store and isolated chain evidence. */
export async function finishAdmittedRefund(input: {
  store: RewardRefundStore;
  reservation: RewardRefundReservation;
  blockNumber: bigint;
  blockHash: string;
  balanceAfterAtomic: bigint;
  signedTransaction: Hex;
}) {
  const { reservation } = input;
  const transactionHash = keccak256(input.signedTransaction);
  let receiptReads = 0;
  let sends = 0;
  let signatures = 0;
  const unexpected = async (): Promise<never> => {
    throw Error("Unexpected chain operation in admitted refund fixture");
  };
  const transfer = parseAbi([
    "event Transfer(address indexed from, address indexed to, uint256 amount)",
  ]);
  const topics = encodeEventTopics({
    abi: transfer,
    eventName: "Transfer",
    args: {
      from: reservation.custodyAddress as Hex,
      to: reservation.destinationAddress as Hex,
    },
  });
  if (topics.some((topic) => typeof topic !== "string")) throw Error("Invalid transfer topics");
  const rpc: MegapotV2RpcClient = {
    attestDeployment: async () => ({
      jackpotCodeHash: reservation.jackpotCodeHash,
      usdcCodeHash: reservation.usdcCodeHash,
      ticketNftCodeHash: reservation.ticketNftCodeHash,
    }),
    readCurrentDrawing: unexpected,
    readTicketPurchasesAllowed: unexpected,
    readCurrentDrawingId: unexpected,
    readDrawing: unexpected,
    readDrawingTierPayouts: unexpected,
    readTicketTierIds: unexpected,
    readReferralFees: unexpected,
    readUsdcAllowance: unexpected,
    readTicketOwner: unexpected,
    readPendingNonce: unexpected,
    readUsdcBalance: async () => input.balanceAfterAtomic,
    readErc20Balance: async () => input.balanceAfterAtomic,
    readNativeBalance: async () => 1_000_000n,
    estimateGas: async () => 50_000n,
    readFeeQuote: async () => ({
      baseFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 2n,
      observedBlockNumber: input.blockNumber - 1n,
      observedBlockHash: input.blockHash,
    }),
    sendRawTransaction: async () => {
      sends++;
      return transactionHash;
    },
    readReceipt: async () => {
      receiptReads++;
      return {
        chainId: reservation.chainId,
        status: "success",
        transactionHash,
        from: reservation.custodyAddress,
        to: reservation.tokenAddress,
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
        logs: [
          {
            address: reservation.tokenAddress,
            topics: topics as [Hex, ...Hex[]],
            data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [
              reservation.amountAtomic,
            ]),
            logIndex: Number(input.blockNumber),
            transactionHash,
            blockNumber: input.blockNumber,
            blockHash: input.blockHash,
          },
        ],
      };
    },
    readHead: async () => ({ blockNumber: input.blockNumber + 2n, blockHash: input.blockHash }),
    readBlock: async (blockNumber) => ({ blockNumber, blockHash: input.blockHash }),
  };
  const coordinator = makeRewardRefundCoordinator({
    store: input.store,
    rpc,
    requiredConfirmations: 3,
    gasLimitMultiplierBps: 12_000,
    nativeGasReserveFloorWei: 0n,
    signer: {
      address: reservation.custodyAddress,
      sign: async () => {
        signatures++;
        return {
          signedTransaction: input.signedTransaction,
          signedTransactionHash: transactionHash,
        };
      },
    },
  });
  const outcome = await Effect.runPromise(coordinator.reconcile(reservation.effectId));
  return { outcome, transactionHash, receiptReads, sends, signatures };
}
