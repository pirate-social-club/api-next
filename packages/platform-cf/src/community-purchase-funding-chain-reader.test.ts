import { describe, expect, test } from "bun:test";
import { CommunityPurchaseFundingChainReadFailed } from "@pirate/application";
import {
  type CommunityPurchaseFundingExpectation,
  communityPurchaseAtomicAmount,
} from "@pirate/domain";
import { Effect } from "effect";
import { makeCommunityPurchaseFundingChainReader } from "./community-purchase-funding-chain-reader";

const HASH = `0x${"11".repeat(32)}` as const;
const BLOCK_HASH = `0x${"22".repeat(32)}` as const;
const HEAD_HASH = `0x${"33".repeat(32)}` as const;
const TOKEN = `0x${"aa".repeat(20)}` as const;
const SENDER = `0x${"bb".repeat(20)}` as const;
const RECIPIENT = `0x${"cc".repeat(20)}` as const;
const AMOUNT = communityPurchaseAtomicAmount(1_250_000n);
const EXPECTED: CommunityPurchaseFundingExpectation = {
  chainId: 8453,
  tokenContract: TOKEN,
  tokenDecimals: 6,
  sender: SENDER,
  recipient: RECIPIENT,
  amountAtomic: AMOUNT,
  requiredConfirmations: 1,
};

const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddress = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;
const amountWord = `0x${AMOUNT.toString(16).padStart(64, "0")}`;
const calldata = `0xa9059cbb${topicAddress(RECIPIENT).slice(2)}${amountWord.slice(2)}`;

function response(method: string, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: method, result }), {
    headers: { "content-type": "application/json" },
  });
}

function fixture(
  overrides: {
    readonly chainId?: unknown;
    readonly transaction?: Record<string, unknown> | null;
    readonly receipt?: Record<string, unknown> | null;
    readonly canonicalBlock?: Record<string, unknown> | null;
    readonly head?: Record<string, unknown> | null;
  } = {},
) {
  const transaction = {
    hash: HASH,
    from: SENDER,
    to: TOKEN,
    input: calldata,
    value: "0x0",
    blockNumber: "0x64",
    blockHash: BLOCK_HASH,
    ...overrides.transaction,
  };
  const receipt = {
    transactionHash: HASH,
    from: SENDER,
    to: TOKEN,
    blockNumber: "0x64",
    blockHash: BLOCK_HASH,
    status: "0x1",
    logs: [
      {
        address: TOKEN,
        topics: [transferTopic, topicAddress(SENDER), topicAddress(RECIPIENT)],
        data: amountWord,
        logIndex: "0x2",
        blockNumber: "0x64",
        blockHash: BLOCK_HASH,
        transactionHash: HASH,
        removed: false,
      },
    ],
    ...overrides.receipt,
  };
  const canonicalBlock = {
    number: "0x64",
    hash: BLOCK_HASH,
    ...overrides.canonicalBlock,
  };
  const head = { number: "0x66", hash: HEAD_HASH, ...overrides.head };
  return {
    eth_chainId: overrides.chainId ?? "0x2105",
    eth_getTransactionByHash: overrides.transaction === null ? null : transaction,
    eth_getTransactionReceipt: overrides.receipt === null ? null : receipt,
    canonicalBlock: overrides.canonicalBlock === null ? null : canonicalBlock,
    eth_getBlockByNumber: overrides.head === null ? null : head,
  } as const;
}

function readerFrom(document: ReturnType<typeof fixture>, calls: string[] = []) {
  return {
    calls,
    reader: makeCommunityPurchaseFundingChainReader({
      rpcUrl: "https://rpc.example.invalid",
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          readonly method: string;
          readonly params: readonly unknown[];
        };
        calls.push(body.method);
        const result =
          body.method === "eth_getBlockByNumber" && body.params[0] !== "latest"
            ? document.canonicalBlock
            : document[body.method as keyof typeof document];
        return response(body.method, result);
      },
    }),
  };
}

async function read(
  document: ReturnType<typeof fixture>,
  options?: { readonly timeoutMs?: number },
) {
  const { reader, calls } = readerFrom(document);
  const result = await Effect.runPromise(
    reader.read({
      operationId: "money:v1:community_purchase:c:q:p:1" as never,
      transactionHash: HASH,
      expected: EXPECTED,
    }),
  );
  return { result, calls, options };
}

describe("community purchase JSON-RPC chain reader", () => {
  test("reads canonical transaction, receipt, block, and head evidence", async () => {
    const first = await read(fixture());
    const second = await read(fixture());
    expect(first.calls).toEqual([
      "eth_chainId",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
      "eth_getBlockByNumber",
      "eth_getBlockByNumber",
    ]);
    expect(first.result).toEqual(second.result);
    expect(first.result).toMatchObject({
      receiptStatus: "success",
      chainId: 8453,
      tokenContract: TOKEN,
      sender: SENDER,
      recipient: RECIPIENT,
      amountAtomic: AMOUNT,
      transactionHash: HASH,
      blockNumber: 100,
      blockHash: BLOCK_HASH,
      logIndex: 2,
      observedHeadBlockNumber: 102,
      observedHeadBlockHash: HEAD_HASH,
    });
    expect(first.result.observationId).toMatch(/^0x[0-9a-f]{64}$/u);
  });

  test.each([
    ["wrong chain", fixture({ chainId: "0x1" }), "invalid-evidence"],
    ["wrong sender", fixture({ transaction: { from: RECIPIENT } }), "invalid-evidence"],
    ["wrong token target", fixture({ transaction: { to: RECIPIENT } }), "invalid-evidence"],
    ["nonzero native value", fixture({ transaction: { value: "0x1" } }), "invalid-evidence"],
    ["wrong receipt sender", fixture({ receipt: { from: RECIPIENT } }), "invalid-evidence"],
    [
      "wrong calldata recipient",
      fixture({ transaction: { input: calldata.replace(RECIPIENT.slice(2), SENDER.slice(2)) } }),
      "invalid-evidence",
    ],
    ["receipt identity mismatch", fixture({ receipt: { blockHash: HEAD_HASH } }), "reorg"],
    ["orphaned receipt block", fixture({ canonicalBlock: { hash: HEAD_HASH } }), "reorg"],
    ["head behind receipt", fixture({ head: { number: "0x63" } }), "reorg"],
    [
      "equal-height canonical hash mismatch",
      fixture({ head: { number: "0x64", hash: HEAD_HASH } }),
      "reorg",
    ],
  ] as const)("fails closed for %s", async (_label, document, reason) => {
    const { reader } = readerFrom(document);
    await expect(
      Effect.runPromise(
        reader.read({
          operationId: "money:v1:community_purchase:c:q:p:1" as never,
          transactionHash: HASH,
          expected: EXPECTED,
        }),
      ),
    ).rejects.toBeInstanceOf(CommunityPurchaseFundingChainReadFailed);
    try {
      await Effect.runPromise(
        reader.read({
          operationId: "money:v1:community_purchase:c:q:p:1" as never,
          transactionHash: HASH,
          expected: EXPECTED,
        }),
      );
    } catch (error) {
      expect(error).toMatchObject({ reason });
    }
  });

  test("requires exactly one matching Transfer log on success", async () => {
    const base = fixture();
    const log = (base.eth_getTransactionReceipt as Record<string, unknown>).logs as unknown[];
    const { reader } = readerFrom(fixture({ receipt: { logs: [...log, ...log] } }));
    await expect(
      Effect.runPromise(
        reader.read({ operationId: "op" as never, transactionHash: HASH, expected: EXPECTED }),
      ),
    ).rejects.toMatchObject({
      _tag: "CommunityPurchaseFundingChainReadFailed",
      reason: "invalid-evidence",
    });
  });

  test("binds the matching Transfer log to the canonical receipt block", async () => {
    const base = fixture();
    const logs = (base.eth_getTransactionReceipt as Record<string, unknown>).logs as Array<
      Record<string, unknown>
    >;
    const { reader } = readerFrom(
      fixture({ receipt: { logs: [{ ...logs[0], blockHash: HEAD_HASH }] } }),
    );
    await expect(
      Effect.runPromise(
        reader.read({ operationId: "op" as never, transactionHash: HASH, expected: EXPECTED }),
      ),
    ).rejects.toMatchObject({ reason: "reorg" });
  });

  test("accepts receipt logs that omit the optional removed marker", async () => {
    const base = fixture();
    const logs = (base.eth_getTransactionReceipt as Record<string, unknown>).logs as Array<
      Record<string, unknown>
    >;
    const { removed: _removed, ...withoutRemoved } = logs[0] ?? {};
    const { reader } = readerFrom(fixture({ receipt: { logs: [withoutRemoved] } }));
    const result = await Effect.runPromise(
      reader.read({ operationId: "op" as never, transactionHash: HASH, expected: EXPECTED }),
    );
    expect(result.receiptStatus).toBe("success");
  });

  test("reports reverted calls without fabricating a log", async () => {
    const { reader } = readerFrom(fixture({ receipt: { status: "0x0", logs: [] } }));
    const result = await Effect.runPromise(
      reader.read({ operationId: "op" as never, transactionHash: HASH, expected: EXPECTED }),
    );
    expect(result.receiptStatus).toBe("reverted");
    expect(result.logIndex).toBeNull();
    const { reader: badReader } = readerFrom(fixture({ receipt: { status: "0x0" } }));
    await expect(
      Effect.runPromise(
        badReader.read({ operationId: "op" as never, transactionHash: HASH, expected: EXPECTED }),
      ),
    ).rejects.toMatchObject({ reason: "invalid-evidence" });
  });

  test("maps null results, oversized bodies, and aborts to redacted typed failures", async () => {
    const { reader: missing } = readerFrom(fixture({ receipt: null }));
    await expect(
      Effect.runPromise(
        missing.read({ operationId: "op" as never, transactionHash: HASH, expected: EXPECTED }),
      ),
    ).rejects.toMatchObject({ reason: "not-found" });

    const oversized = makeCommunityPurchaseFundingChainReader({
      rpcUrl: "https://rpc.example.invalid",
      maxResponseBytes: 8,
      fetcher: async () => new Response(JSON.stringify({ jsonrpc: "2.0", result: "0x2105" })),
    });
    await expect(
      Effect.runPromise(
        oversized.read({ operationId: "op" as never, transactionHash: HASH, expected: EXPECTED }),
      ),
    ).rejects.toMatchObject({ reason: "invalid-evidence" });

    const timed = makeCommunityPurchaseFundingChainReader({
      rpcUrl: "https://rpc.example.invalid",
      timeoutMs: 5,
      fetcher: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    await expect(
      Effect.runPromise(
        timed.read({ operationId: "op" as never, transactionHash: HASH, expected: EXPECTED }),
      ),
    ).rejects.toMatchObject({ reason: "timeout" });
  });
});
