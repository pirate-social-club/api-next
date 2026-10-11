import { expect, test } from "bun:test";
import { canonicalFixtureTransaction } from "./fixture-chain.mjs";

const hash = `0x${"a".repeat(64)}`;
function chain(options: {
  status?: string;
  blockHashes?: string[];
  head?: bigint;
  failBlockReads?: boolean;
  onRead?: () => void;
}) {
  let blockReads = 0;
  const reads = { receipt: 0, block: 0 };
  return {
    reads,
    publicClient: {
      getTransactionReceipt: async () => {
        reads.receipt++;
        options.onRead?.();
        return { status: options.status ?? "success", blockNumber: 10n, blockHash: "0xgood" };
      },
      getBlock: async () => {
        reads.block++;
        if (options.failBlockReads) throw new Error("rate limited");
        const hashes = options.blockHashes ?? ["0xgood"];
        return { hash: hashes[Math.min(blockReads++, hashes.length - 1)] };
      },
      getBlockNumber: async () => options.head ?? 12n,
    },
  };
}
const clock = () => {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    set: (t: number) => {
      time = t;
    },
  };
};

test("a transient block-hash disagreement is waited through", async () => {
  const c = chain({ blockHashes: ["0xother", "0xother", "0xgood"] });
  const t = clock();
  const receipt = await canonicalFixtureTransaction(c, hash, 60000, t);
  expect(receipt.blockHash).toBe("0xgood");
  expect(c.reads.receipt).toBe(3);
});

test("a persistent block-hash mismatch never passes", async () => {
  const c = chain({ blockHashes: ["0xother"] });
  await expect(canonicalFixtureTransaction(c, hash, 20000, clock())).rejects.toThrow(
    "confirmation uncertain",
  );
});

test("a reverted receipt is rejected at once, even when block reads fail", async () => {
  const c = chain({ status: "reverted", failBlockReads: true });
  await expect(canonicalFixtureTransaction(c, hash, 60000, clock())).rejects.toThrow("reverted");
  expect(c.reads.receipt).toBe(1);
  expect(c.reads.block).toBe(0);
});

test("evidence that arrives after the deadline is not accepted", async () => {
  const t = clock();
  const c = chain({ onRead: () => t.set(101) });
  t.set(99);
  await expect(canonicalFixtureTransaction(c, hash, 100, t)).rejects.toThrow(
    "confirmation uncertain",
  );
});

test("too few confirmations keeps waiting until the deadline", async () => {
  const c = chain({ head: 10n });
  await expect(canonicalFixtureTransaction(c, hash, 10000, clock())).rejects.toThrow(
    "confirmation uncertain",
  );
});
