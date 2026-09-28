import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  getAddress,
  http,
  TransactionReceiptNotFoundError,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import type { SponsoredSendChain } from "./wallet-sponsored-send-service.ts";

/** Public chain evidence for Wallet sponsorship, independent of rewards. */
export function makeWalletSponsoredChain(
  rpcUrl: string,
  chainId: 8453 | 84532,
): SponsoredSendChain {
  if (!rpcUrl.startsWith("https://")) throw new Error("Wallet RPC must use HTTPS");
  const chain = chainId === 8453 ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const assertChain = async () => {
    if ((await client.getChainId()) !== chainId) throw new Error("Wallet RPC chain changed");
  };
  return {
    readTokenBalance: async (tokenAddress, walletAddress) => {
      await assertChain();
      return client.readContract({
        address: getAddress(tokenAddress),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [getAddress(walletAddress)],
      });
    },
    readHead: async () => {
      await assertChain();
      return client.getBlockNumber();
    },
    readFinalizedHead: async () => {
      await assertChain();
      return (await client.getBlock({ blockTag: "finalized" })).number;
    },
    readReceipt: async (transactionHash) => {
      await assertChain();
      let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
      try {
        receipt = await client.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
      if (!receipt.blockHash || /^0x0{64}$/u.test(receipt.blockHash)) return null;
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      const canonical = block.hash?.toLowerCase() === receipt.blockHash.toLowerCase();
      const transfers: {
        tokenAddress: string;
        from: string;
        to: string;
        amountAtomic: bigint;
      }[] = [];
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: erc20Abi,
            eventName: "Transfer",
            topics: log.topics,
            data: log.data,
          });
          transfers.push({
            tokenAddress: log.address.toLowerCase(),
            from: decoded.args.from.toLowerCase(),
            to: decoded.args.to.toLowerCase(),
            amountAtomic: decoded.args.value,
          });
        } catch {
          /* Other events do not prove a token transfer. */
        }
      }
      return {
        canonical,
        status: receipt.status === "success" ? "success" : "reverted",
        transactionHash: receipt.transactionHash.toLowerCase(),
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash.toLowerCase(),
        transfers,
      };
    },
  };
}
