import {
  type RewardWinnerSendChain,
  RewardWinnerSendChainUnavailable,
  type RewardWinnerSendReceiptRead,
  type RewardWinnerSendTransferLog,
} from "@pirate/application";
import { Effect } from "effect";
import type { MegapotReceiptLog } from "./megapot-v2.ts";
import { type MegapotV2RpcClient, MegapotV2RpcFailed } from "./megapot-v2-rpc.ts";

/** keccak256("Transfer(address,address,uint256)") */
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type RewardWinnerSendRpc = Pick<
  MegapotV2RpcClient,
  "readPendingNonce" | "readReceipt" | "readHead" | "readBlock"
> &
  Required<
    Pick<MegapotV2RpcClient, "readTransaction" | "readTransactionCount" | "readFinalizedHead">
  >;

const unavailable = () => new RewardWinnerSendChainUnavailable({ reason: "rpc-unavailable" });

const call = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: unavailable });

function topicAddress(topic: string): string | null {
  return /^0x0{24}[0-9a-f]{40}$/u.test(topic) ? `0x${topic.slice(26)}` : null;
}

/** Decodes standard ERC-20 Transfer logs; anything else is ignored. */
export function rewardWinnerSendTransfers(
  logs: readonly MegapotReceiptLog[],
): readonly RewardWinnerSendTransferLog[] {
  const transfers: RewardWinnerSendTransferLog[] = [];
  for (const log of logs) {
    const [topic, fromTopic, toTopic] = log.topics.map((value) => value.toLowerCase());
    if (log.topics.length !== 3 || topic !== ERC20_TRANSFER_TOPIC) continue;
    const from = fromTopic === undefined ? null : topicAddress(fromTopic);
    const to = toTopic === undefined ? null : topicAddress(toTopic);
    if (from === null || to === null || !/^0x[0-9a-f]{64}$/u.test(log.data.toLowerCase())) continue;
    transfers.push({
      tokenAddress: log.address.toLowerCase(),
      from,
      to,
      amountAtomic: BigInt(log.data),
    });
  }
  return transfers;
}

/**
 * Chain reads for winner sends through the attested Megapot RPC client. A
 * receipt counts only while its block is canonical: one whose block hash no
 * longer matches, whose block is past the head, or whose logs were removed
 * reads as not canonical, which never settles a send.
 */
export function makeRewardWinnerSendChain(rpc: RewardWinnerSendRpc): RewardWinnerSendChain {
  const readReceipt = (transactionHash: string) =>
    Effect.tryPromise({
      try: async (): Promise<RewardWinnerSendReceiptRead> => {
        const reorganized = { canonical: false, transactionHash } as const;
        let receipt: Awaited<ReturnType<MegapotV2RpcClient["readReceipt"]>>;
        try {
          receipt = await rpc.readReceipt(transactionHash);
        } catch (error) {
          if (error instanceof MegapotV2RpcFailed && error.reason === "reorg") return reorganized;
          throw error;
        }
        if (receipt === null) return null;
        const head = await rpc.readHead();
        if (receipt.blockNumber > head.blockNumber) return reorganized;
        const block = await rpc.readBlock(receipt.blockNumber);
        if (block.blockHash !== receipt.blockHash.toLowerCase()) return reorganized;
        return {
          canonical: true,
          transactionHash: receipt.transactionHash.toLowerCase(),
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash.toLowerCase(),
          transfers: rewardWinnerSendTransfers(receipt.logs),
        };
      },
      catch: unavailable,
    });
  return {
    readPendingNonce: (address) => call(() => rpc.readPendingNonce(address)),
    readTransaction: (transactionHash) => call(() => rpc.readTransaction(transactionHash)),
    readHead: () => call(async () => (await rpc.readHead()).blockNumber),
    readFinalizedHead: () => call(async () => (await rpc.readFinalizedHead()).blockNumber),
    readTransactionCount: (address, blockNumber) =>
      call(() => rpc.readTransactionCount(address, blockNumber)),
    readReceipt,
  };
}
