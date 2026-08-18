import {
  type CommunityPurchaseFundingChainReader,
  CommunityPurchaseFundingChainReadFailed,
  type CommunityPurchaseFundingChainReadInput,
} from "@pirate/application";
import type { Bytes32, CommunityPurchaseFundingEvidence, EvmAddress } from "@pirate/domain";
import { Effect } from "effect";

export const COMMUNITY_PURCHASE_CHAIN_RPC_TIMEOUT_MS = 5_000;
export const COMMUNITY_PURCHASE_CHAIN_RPC_MAX_RESPONSE_BYTES = 128 * 1024;

const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRANSFER_SELECTOR = "a9059cbb";

export type CommunityPurchaseFundingChainFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type CommunityPurchaseFundingChainReaderOptions = Readonly<{
  readonly rpcUrl: string;
  readonly fetcher?: CommunityPurchaseFundingChainFetcher;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}>;

type JsonObject = Readonly<Record<string, unknown>>;

class ReaderFailure extends Error {
  constructor(
    readonly reason: "unavailable" | "timeout" | "not-found" | "invalid-evidence" | "reorg",
  ) {
    super(reason);
  }
}

function fail(reason: ReaderFailure["reason"]): never {
  throw new ReaderFailure(reason);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid adapter bound");
  return value;
}

function canonicalAddress(value: unknown): EvmAddress {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/iu.test(value)) {
    fail("invalid-evidence");
  }
  return value.toLowerCase() as EvmAddress;
}

function canonicalHash(value: unknown): Bytes32 {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/iu.test(value)) {
    fail("invalid-evidence");
  }
  return value.toLowerCase() as Bytes32;
}

function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) {
    fail("invalid-evidence");
  }
  try {
    return BigInt(value);
  } catch {
    fail("invalid-evidence");
  }
}

function safeQuantity(value: unknown): number {
  const parsed = quantity(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail("invalid-evidence");
  return Number(parsed);
}

function uint256(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/iu.test(value)) {
    fail("invalid-evidence");
  }
  try {
    return BigInt(value);
  } catch {
    fail("invalid-evidence");
  }
}

function hexBytes(value: unknown): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/iu.test(value)) {
    fail("invalid-evidence");
  }
  return value.slice(2).toLowerCase();
}

function rpcResult(value: unknown, id: string): unknown {
  if (!isObject(value) || value.jsonrpc !== "2.0" || value.id !== id || value.error !== undefined) {
    fail("unavailable");
  }
  if (!("result" in value)) fail("unavailable");
  return value.result;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maxBytes) {
      throw new ReaderFailure("invalid-evidence");
    }
  }
  if (response.body === null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new ReaderFailure("invalid-evidence");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ReaderFailure("invalid-evidence");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function errorReason(error: unknown): ReaderFailure["reason"] {
  return error instanceof ReaderFailure ? error.reason : "unavailable";
}

async function sha256Hex(value: string): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function encodeTopicAddress(value: string): string {
  return `0x${"0".repeat(24)}${value.slice(2)}`;
}

function matchingTransferLogs(
  receipt: JsonObject,
  token: string,
  sender: string,
  recipient: string,
  amount: bigint,
  blockNumber: number,
  blockHash: string,
  transactionHash: string,
): readonly { readonly index: number }[] {
  if (!Array.isArray(receipt.logs)) fail("invalid-evidence");
  const matches: { readonly index: number }[] = [];
  for (const candidate of receipt.logs) {
    if (!isObject(candidate)) fail("invalid-evidence");
    if (canonicalAddress(candidate.address) !== token) continue;
    if (!Array.isArray(candidate.topics) || candidate.topics.length !== 3) continue;
    const topics = candidate.topics;
    if (
      typeof topics[0] !== "string" ||
      topics[0].slice(2).toLowerCase() !== TRANSFER_TOPIC ||
      typeof topics[1] !== "string" ||
      typeof topics[2] !== "string" ||
      topics[1].toLowerCase() !== encodeTopicAddress(sender) ||
      topics[2].toLowerCase() !== encodeTopicAddress(recipient) ||
      hexBytes(candidate.data).length !== 64 ||
      uint256(candidate.data) !== amount
    ) {
      continue;
    }
    if (
      candidate.removed !== false ||
      safeQuantity(candidate.blockNumber) !== blockNumber ||
      canonicalHash(candidate.blockHash) !== blockHash ||
      canonicalHash(candidate.transactionHash) !== transactionHash
    ) {
      fail("reorg");
    }
    matches.push({ index: safeQuantity(candidate.logIndex) });
  }
  return matches;
}

function inputTransfer(input: unknown, expectedRecipient: string, expectedAmount: bigint): void {
  const data = hexBytes(input);
  if (
    data.length !== 8 + 64 + 64 ||
    data.slice(0, 8) !== TRANSFER_SELECTOR ||
    `0x${data.slice(8, 72)}`.toLowerCase() !== encodeTopicAddress(expectedRecipient) ||
    uint256(`0x${data.slice(72)}`) !== expectedAmount
  ) {
    fail("invalid-evidence");
  }
}

function jsonObservation(
  input: CommunityPurchaseFundingChainReadInput,
  values: {
    readonly chainId: number;
    readonly tokenContract: string;
    readonly sender: string;
    readonly recipient: string;
    readonly amountAtomic: bigint;
    readonly receiptStatus: "success" | "reverted";
    readonly transactionHash: string;
    readonly blockNumber: number;
    readonly blockHash: string;
    readonly logIndex: number | null;
    readonly observedHeadBlockNumber: number;
    readonly observedHeadBlockHash: string;
  },
): string {
  return JSON.stringify({
    version: 1,
    operationId: input.operationId,
    transactionHash: values.transactionHash,
    chainId: values.chainId,
    tokenContract: values.tokenContract,
    sender: values.sender,
    recipient: values.recipient,
    amountAtomic: values.amountAtomic.toString(),
    receiptStatus: values.receiptStatus,
    blockNumber: values.blockNumber,
    blockHash: values.blockHash,
    logIndex: values.logIndex,
    observedHeadBlockNumber: values.observedHeadBlockNumber,
    observedHeadBlockHash: values.observedHeadBlockHash,
  });
}

export function makeCommunityPurchaseFundingChainReader(
  options: CommunityPurchaseFundingChainReaderOptions,
): CommunityPurchaseFundingChainReader {
  const timeoutMs = validBound(options.timeoutMs, COMMUNITY_PURCHASE_CHAIN_RPC_TIMEOUT_MS);
  const maxResponseBytes = validBound(
    options.maxResponseBytes,
    COMMUNITY_PURCHASE_CHAIN_RPC_MAX_RESPONSE_BYTES,
  );
  const fetcher = options.fetcher ?? fetch;

  const rpc = async (
    method: string,
    params: readonly unknown[],
    deadline: number,
  ): Promise<unknown> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ReaderFailure("timeout");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      let response: Response;
      try {
        response = await fetcher(options.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
          signal: controller.signal,
        });
      } catch {
        throw new ReaderFailure(controller.signal.aborted ? "timeout" : "unavailable");
      }
      if (!response.ok) {
        throw new ReaderFailure(response.status === 404 ? "not-found" : "unavailable");
      }
      let document: unknown;
      try {
        document = JSON.parse(await readBoundedBody(response, maxResponseBytes)) as unknown;
      } catch (error) {
        if (error instanceof ReaderFailure) throw error;
        throw new ReaderFailure("invalid-evidence");
      }
      return rpcResult(document, method);
    } finally {
      clearTimeout(timer);
    }
  };

  const read = (input: CommunityPurchaseFundingChainReadInput) =>
    Effect.tryPromise({
      try: async (): Promise<CommunityPurchaseFundingEvidence> => {
        const deadline = Date.now() + timeoutMs;
        const expected = input.expected;
        const expectedToken = canonicalAddress(expected.tokenContract);
        const expectedSender = canonicalAddress(expected.sender);
        const expectedRecipient = canonicalAddress(expected.recipient);
        if (!/^0x[0-9a-f]{64}$/u.test(input.transactionHash)) fail("invalid-evidence");
        if (!Number.isSafeInteger(expected.chainId) || expected.chainId < 1)
          fail("invalid-evidence");
        if (typeof expected.amountAtomic !== "bigint" || expected.amountAtomic < 1n) {
          fail("invalid-evidence");
        }

        const chainId = safeQuantity(await rpc("eth_chainId", [], deadline));
        if (chainId !== expected.chainId) fail("invalid-evidence");
        const transaction = await rpc(
          "eth_getTransactionByHash",
          [input.transactionHash],
          deadline,
        );
        const receipt = await rpc("eth_getTransactionReceipt", [input.transactionHash], deadline);
        if (!isObject(transaction) || transaction === null || !isObject(receipt)) {
          fail("not-found");
        }

        const transactionHash = canonicalHash(transaction.hash);
        const requestedHash = canonicalHash(input.transactionHash);
        if (
          transactionHash !== requestedHash ||
          canonicalHash(receipt.transactionHash) !== requestedHash
        ) {
          fail("invalid-evidence");
        }
        const txSender = canonicalAddress(transaction.from);
        const txToken = canonicalAddress(transaction.to);
        if (txSender !== expectedSender || txToken !== expectedToken) fail("invalid-evidence");
        if (quantity(transaction.value) !== 0n) fail("invalid-evidence");
        inputTransfer(transaction.input, expectedRecipient, expected.amountAtomic);

        const txBlockNumber = safeQuantity(transaction.blockNumber);
        const txBlockHash = canonicalHash(transaction.blockHash);
        const receiptBlockNumber = safeQuantity(receipt.blockNumber);
        const receiptBlockHash = canonicalHash(receipt.blockHash);
        if (txBlockNumber !== receiptBlockNumber || txBlockHash !== receiptBlockHash) {
          fail("reorg");
        }
        if (
          canonicalAddress(receipt.from) !== expectedSender ||
          canonicalAddress(receipt.to) !== expectedToken
        ) {
          fail("invalid-evidence");
        }
        const canonicalReceiptBlock = await rpc(
          "eth_getBlockByNumber",
          [`0x${receiptBlockNumber.toString(16)}`, false],
          deadline,
        );
        const head = await rpc("eth_getBlockByNumber", ["latest", false], deadline);
        if (!isObject(canonicalReceiptBlock) || !isObject(head)) fail("not-found");
        if (
          safeQuantity(canonicalReceiptBlock.number) !== receiptBlockNumber ||
          canonicalHash(canonicalReceiptBlock.hash) !== receiptBlockHash
        ) {
          fail("reorg");
        }
        const headBlockNumber = safeQuantity(head.number);
        const headBlockHash = canonicalHash(head.hash);
        if (headBlockNumber < receiptBlockNumber) fail("reorg");
        if (headBlockNumber === receiptBlockNumber && headBlockHash !== receiptBlockHash) {
          fail("reorg");
        }

        const status = quantity(receipt.status);
        if (status !== 0n && status !== 1n) fail("invalid-evidence");
        const matches = matchingTransferLogs(
          receipt,
          expectedToken,
          expectedSender,
          expectedRecipient,
          expected.amountAtomic,
          receiptBlockNumber,
          receiptBlockHash,
          transactionHash,
        );
        const receiptStatus = status === 1n ? "success" : "reverted";
        if (receiptStatus === "success" && matches.length !== 1) fail("invalid-evidence");
        if (
          receiptStatus === "reverted" &&
          (!Array.isArray(receipt.logs) || receipt.logs.length !== 0)
        ) {
          fail("invalid-evidence");
        }
        const logIndex = matches[0]?.index ?? null;
        const values = {
          chainId,
          tokenContract: expectedToken,
          sender: expectedSender,
          recipient: expectedRecipient,
          amountAtomic: expected.amountAtomic,
          receiptStatus,
          transactionHash,
          blockNumber: receiptBlockNumber,
          blockHash: receiptBlockHash,
          logIndex,
          observedHeadBlockNumber: headBlockNumber,
          observedHeadBlockHash: headBlockHash,
        } as const;
        return {
          ...values,
          observationId: await sha256Hex(jsonObservation(input, values)),
        };
      },
      catch: (error) => new CommunityPurchaseFundingChainReadFailed({ reason: errorReason(error) }),
    });

  return { read };
}
