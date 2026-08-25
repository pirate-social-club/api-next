import { type Hex, keccak256 } from "viem";
import {
  decodeMegapotCurrentDrawingId,
  decodeMegapotDrawingState,
  decodeMegapotTicketOwner,
  decodeMegapotUsdcAllowance,
  decodeMegapotUsdcBalance,
  encodeMegapotCurrentDrawingId,
  encodeMegapotDrawingState,
  encodeMegapotTicketOwner,
  encodeMegapotUsdcAllowance,
  encodeMegapotUsdcBalance,
  type MegapotTransactionReceipt,
  type MegapotV2DeploymentAttestation,
  type MegapotV2DrawingState,
  validateMegapotV2DeploymentAttestation,
} from "./megapot-v2.ts";

export const MEGAPOT_V2_RPC_TIMEOUT_MS = 8_000;
export const MEGAPOT_V2_RPC_MAX_RESPONSE_BYTES = 512 * 1024;

type JsonObject = Readonly<Record<string, unknown>>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class MegapotV2RpcFailed extends Error {
  readonly _tag = "MegapotV2RpcFailed";

  constructor(
    readonly reason:
      | "invalid-config"
      | "invalid-response"
      | "not-found"
      | "provider-error"
      | "reorg"
      | "timeout"
      | "unavailable",
  ) {
    super(reason);
  }
}

export type MegapotV2RpcClientOptions = Readonly<{
  rpcUrl: string;
  attestation: MegapotV2DeploymentAttestation;
  fetcher?: Fetcher;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

export type MegapotV2FeeQuote = Readonly<{
  baseFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  observedBlockNumber: bigint;
  observedBlockHash: string;
}>;

export interface MegapotV2RpcClient {
  readonly attestDeployment: () => Promise<{
    readonly jackpotCodeHash: string;
    readonly ticketNftCodeHash: string;
    readonly usdcCodeHash: string;
  }>;
  readonly readCurrentDrawing: () => Promise<{
    readonly drawingId: bigint;
    readonly state: MegapotV2DrawingState;
  }>;
  readonly readUsdcBalance: (account: string) => Promise<bigint>;
  readonly readNativeBalance: (account: string) => Promise<bigint>;
  readonly readUsdcAllowance: (owner: string, spender: string) => Promise<bigint>;
  readonly readTicketOwner: (ticketId: bigint) => Promise<string>;
  readonly readPendingNonce: (account: string) => Promise<bigint>;
  readonly estimateGas: (input: {
    readonly from: string;
    readonly to: string;
    readonly data: Hex;
    readonly value?: bigint;
  }) => Promise<bigint>;
  readonly readFeeQuote: () => Promise<MegapotV2FeeQuote>;
  readonly sendRawTransaction: (signedTransaction: Hex) => Promise<string>;
  readonly readReceipt: (transactionHash: string) => Promise<MegapotTransactionReceipt | null>;
  readonly readHead: () => Promise<{
    readonly blockNumber: bigint;
    readonly blockHash: string;
  }>;
  readonly readBlock: (blockNumber: bigint) => Promise<{
    readonly blockNumber: bigint;
    readonly blockHash: string;
  }>;
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MegapotV2RpcFailed("invalid-response");
  }
  return value as JsonObject;
}

function canonicalAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/iu.test(value)) {
    throw new MegapotV2RpcFailed("invalid-response");
  }
  return value.toLowerCase();
}

function canonicalHash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/iu.test(value)) {
    throw new MegapotV2RpcFailed("invalid-response");
  }
  return value.toLowerCase();
}

function hexData(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/iu.test(value)) {
    throw new MegapotV2RpcFailed("invalid-response");
  }
  return value.toLowerCase() as Hex;
}

function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) {
    throw new MegapotV2RpcFailed("invalid-response");
  }
  try {
    return BigInt(value);
  } catch {
    throw new MegapotV2RpcFailed("invalid-response");
  }
}

function quantityHex(value: bigint): Hex {
  if (value < 0n) throw new MegapotV2RpcFailed("invalid-config");
  return `0x${value.toString(16)}`;
}

function positiveBound(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new MegapotV2RpcFailed("invalid-config");
  }
  return candidate;
}

async function boundedBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maxBytes)
  ) {
    throw new MegapotV2RpcFailed("invalid-response");
  }
  if (response.body === null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new MegapotV2RpcFailed("invalid-response");
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
        throw new MegapotV2RpcFailed("invalid-response");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function blockIdentity(value: unknown): {
  readonly blockNumber: bigint;
  readonly blockHash: string;
} {
  const block = object(value);
  return {
    blockNumber: quantity(block.number),
    blockHash: canonicalHash(block.hash),
  };
}

export function makeMegapotV2RpcClient(options: MegapotV2RpcClientOptions): MegapotV2RpcClient {
  if (options.rpcUrl.trim().length === 0) throw new MegapotV2RpcFailed("invalid-config");
  const attestation = validateMegapotV2DeploymentAttestation(options.attestation);
  const timeoutMs = positiveBound(options.timeoutMs, MEGAPOT_V2_RPC_TIMEOUT_MS);
  const maxResponseBytes = positiveBound(
    options.maxResponseBytes,
    MEGAPOT_V2_RPC_MAX_RESPONSE_BYTES,
  );
  const fetcher = options.fetcher ?? fetch;
  let requestSequence = 0;

  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    requestSequence += 1;
    const id = `megapot:${requestSequence}:${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetcher(options.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: controller.signal,
        });
      } catch {
        throw new MegapotV2RpcFailed(controller.signal.aborted ? "timeout" : "unavailable");
      }
      if (!response.ok) {
        throw new MegapotV2RpcFailed(response.status === 404 ? "not-found" : "unavailable");
      }
      let document: unknown;
      try {
        document = JSON.parse(await boundedBody(response, maxResponseBytes)) as unknown;
      } catch (error) {
        if (error instanceof MegapotV2RpcFailed) throw error;
        throw new MegapotV2RpcFailed("invalid-response");
      }
      const envelope = object(document);
      if (envelope.jsonrpc !== "2.0" || envelope.id !== id) {
        throw new MegapotV2RpcFailed("invalid-response");
      }
      if (envelope.error !== undefined) throw new MegapotV2RpcFailed("provider-error");
      if (!("result" in envelope)) throw new MegapotV2RpcFailed("invalid-response");
      return envelope.result;
    } finally {
      clearTimeout(timer);
    }
  };

  const ethCall = async (to: string, data: Hex): Promise<Hex> =>
    hexData(await rpc("eth_call", [{ to: canonicalAddress(to), data: hexData(data) }, "latest"]));

  const readCodeHash = async (contract: string): Promise<string> => {
    const code = hexData(await rpc("eth_getCode", [canonicalAddress(contract), "latest"]));
    if (code === "0x") throw new MegapotV2RpcFailed("invalid-response");
    return keccak256(code).toLowerCase();
  };

  const readHead = async () => blockIdentity(await rpc("eth_getBlockByNumber", ["latest", false]));

  return {
    attestDeployment: async () => {
      const [jackpotCodeHash, ticketNftCodeHash, usdcCodeHash] = await Promise.all([
        readCodeHash(attestation.jackpotAddress),
        readCodeHash(attestation.ticketNftAddress),
        readCodeHash(attestation.usdcAddress),
      ]);
      if (
        jackpotCodeHash !== attestation.jackpotCodeHash ||
        ticketNftCodeHash !== attestation.ticketNftCodeHash ||
        usdcCodeHash !== attestation.usdcCodeHash
      ) {
        throw new MegapotV2RpcFailed("invalid-response");
      }
      return { jackpotCodeHash, ticketNftCodeHash, usdcCodeHash };
    },
    readCurrentDrawing: async () => {
      const drawingId = decodeMegapotCurrentDrawingId(
        await ethCall(attestation.jackpotAddress, encodeMegapotCurrentDrawingId()),
      );
      const state = decodeMegapotDrawingState(
        await ethCall(attestation.jackpotAddress, encodeMegapotDrawingState(drawingId)),
      );
      return { drawingId, state };
    },
    readUsdcBalance: async (account) =>
      decodeMegapotUsdcBalance(
        await ethCall(attestation.usdcAddress, encodeMegapotUsdcBalance(account)),
      ),
    readNativeBalance: async (account) =>
      quantity(await rpc("eth_getBalance", [canonicalAddress(account), "latest"])),
    readUsdcAllowance: async (owner, spender) =>
      decodeMegapotUsdcAllowance(
        await ethCall(attestation.usdcAddress, encodeMegapotUsdcAllowance(owner, spender)),
      ),
    readTicketOwner: async (ticketId) =>
      decodeMegapotTicketOwner(
        await ethCall(attestation.ticketNftAddress, encodeMegapotTicketOwner(ticketId)),
      ),
    readPendingNonce: async (account) =>
      quantity(await rpc("eth_getTransactionCount", [canonicalAddress(account), "pending"])),
    estimateGas: async (input) =>
      quantity(
        await rpc("eth_estimateGas", [
          {
            from: canonicalAddress(input.from),
            to: canonicalAddress(input.to),
            data: hexData(input.data),
            ...(input.value === undefined ? {} : { value: quantityHex(input.value) }),
          },
        ]),
      ),
    readFeeQuote: async () => {
      const [priorityResult, blockResult] = await Promise.all([
        rpc("eth_maxPriorityFeePerGas", []),
        rpc("eth_getBlockByNumber", ["latest", false]),
      ]);
      const block = object(blockResult);
      const baseFeePerGas = quantity(block.baseFeePerGas);
      const maxPriorityFeePerGas = quantity(priorityResult);
      const identity = blockIdentity(block);
      return {
        baseFeePerGas,
        maxPriorityFeePerGas,
        maxFeePerGas: baseFeePerGas * 2n + maxPriorityFeePerGas,
        observedBlockNumber: identity.blockNumber,
        observedBlockHash: identity.blockHash,
      };
    },
    sendRawTransaction: async (signedTransaction) =>
      canonicalHash(await rpc("eth_sendRawTransaction", [hexData(signedTransaction)])),
    readReceipt: async (transactionHash) => {
      const result = await rpc("eth_getTransactionReceipt", [canonicalHash(transactionHash)]);
      if (result === null) return null;
      const receipt = object(result);
      const receiptTransactionHash = canonicalHash(receipt.transactionHash);
      const blockHash = canonicalHash(receipt.blockHash);
      const blockNumber = quantity(receipt.blockNumber);
      if (
        receiptTransactionHash !== transactionHash.toLowerCase() ||
        !Array.isArray(receipt.logs)
      ) {
        throw new MegapotV2RpcFailed("invalid-response");
      }
      const logs = receipt.logs.map((value) => {
        const log = object(value);
        if (log.removed === true) throw new MegapotV2RpcFailed("reorg");
        const topics = Array.isArray(log.topics) ? log.topics.map(hexData) : [];
        if (topics.length === 0) throw new MegapotV2RpcFailed("invalid-response");
        return {
          address: canonicalAddress(log.address),
          topics: topics as [Hex, ...Hex[]],
          data: hexData(log.data),
          logIndex: Number(quantity(log.logIndex)),
          transactionHash: canonicalHash(log.transactionHash),
          blockHash: canonicalHash(log.blockHash),
          blockNumber: quantity(log.blockNumber),
          ...(log.removed === undefined ? {} : { removed: log.removed === true }),
        };
      });
      if (logs.some((log) => !Number.isSafeInteger(log.logIndex))) {
        throw new MegapotV2RpcFailed("invalid-response");
      }
      return {
        chainId: attestation.chainId,
        status: quantity(receipt.status) === 1n ? "success" : "reverted",
        transactionHash: receiptTransactionHash,
        from: canonicalAddress(receipt.from),
        to: receipt.to === null ? null : canonicalAddress(receipt.to),
        blockHash,
        blockNumber,
        logs,
      };
    },
    readHead,
    readBlock: async (blockNumber) => {
      if (blockNumber < 0n) throw new MegapotV2RpcFailed("invalid-config");
      const identity = blockIdentity(
        await rpc("eth_getBlockByNumber", [quantityHex(blockNumber), false]),
      );
      if (identity.blockNumber !== blockNumber) throw new MegapotV2RpcFailed("invalid-response");
      return identity;
    },
  };
}
