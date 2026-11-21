import { describe, expect, test } from "bun:test";
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";
import type { MegapotV2Transaction } from "./megapot-v2-rpc.ts";
import { cancellationFixture } from "./song-funding-cancellation.fixture.ts";
import { verifyFundingCancellation } from "./song-funding-cancellation-proof.ts";

const hash = (x: string): `0x${string}` => `0x${x.repeat(64)}`;
function fixture() {
  const original = cancellationFixture,
    i = original.receipt.instruction;
  let tx: MegapotV2Transaction | null = {
    transactionHash: hash("1"),
    chainId: 84532,
    from: i.from,
    to: i.from,
    nonce: BigInt(i.nonce),
    valueWei: 0n,
    input: "0x",
    blockNumber: 101n,
  };
  let receipt: MegapotTransactionReceipt | null = {
    transactionHash: hash("1"),
    chainId: 84532,
    from: i.from,
    to: i.from,
    status: "success",
    blockNumber: 101n,
    blockHash: hash("2"),
    logs: [],
  };
  let finalized = 199n,
    confirmed = 8n,
    reorg = false,
    anchorReorg = false;
  let headAt = 1792334400n;
  const block = { blockNumber: 101n, blockHash: hash("2"), blockTimestamp: 1792333440n };
  const final = () => ({
    blockNumber: finalized,
    blockHash: hash("3"),
    blockTimestamp: 1792334340n,
  });
  const rpc = {
    readTransaction: async () => tx,
    readReceipt: async () => receipt,
    readHead: async () => ({ blockNumber: 200n, blockHash: hash("4"), blockTimestamp: headAt }),
    readFinalizedHead: async () => final(),
    readBlock: async (n: bigint) =>
      n === 100n
        ? {
            blockNumber: n,
            blockHash: anchorReorg ? hash("9") : original.anchorBlockHash,
            blockTimestamp: 1792333200n,
          }
        : n === 101n
          ? { ...block, blockHash: reorg ? hash("9") : block.blockHash }
          : final(),
    readTransactionCount: async () => confirmed,
  };
  const policy = {
    policyHash: "a".repeat(64),
    requiredConfirmations: 3,
    maximumObservationAgeMs: 120_000,
    maximumClockSkewMs: 1000,
  };
  const verify = () =>
    verifyFundingCancellation({
      original,
      rpc,
      transactionHash: hash("1"),
      policy,
      now: () => "2026-10-18T14:40:00.000Z",
    });
  return {
    verify,
    rpc,
    policy,
    original,
    setTx: (v: Partial<MegapotV2Transaction> | null) => {
      if (v === null) tx = null;
      else {
        if (tx === null) throw Error("Fixture transaction missing");
        tx = { ...tx, ...v };
      }
    },
    setReceipt: (v: Partial<MegapotTransactionReceipt> | null) => {
      if (v === null) receipt = null;
      else {
        if (receipt === null) throw Error("Fixture receipt missing");
        receipt = { ...receipt, ...v };
      }
    },
    unfinal: () => {
      finalized = 100n;
    },
    unconsumed: () => {
      confirmed = 7n;
    },
    reorganize: () => {
      reorg = true;
    },
    reorganizeAnchor: () => {
      anchorReorg = true;
    },
    stale: () => {
      headAt -= 121n;
    },
  };
}

describe("exact finalized cancellation evidence", () => {
  test("rejects event-bearing receipts and a changed canonical inclusion after nonce read", async () => {
    const events = fixture();
    events.setReceipt({
      logs: [
        {
          address: events.original.receipt.instruction.to_token,
          topics: [hash("a")],
          data: "0x",
          logIndex: 0,
          transactionHash: hash("1"),
          blockHash: hash("2"),
          blockNumber: 101n,
        },
      ],
    });
    await expect(events.verify()).rejects.toThrow("cancellation_transaction_mismatch");
    const reorg = fixture(),
      read = reorg.rpc.readBlock;
    let calls = 0;
    reorg.rpc.readBlock = async (n) => {
      const b = await read(n);
      if (n === 101n && ++calls === 2) return { ...b, blockHash: hash("9") };
      return b;
    };
    await expect(reorg.verify()).rejects.toThrow("cancellation_canonicality_unproven");
  });

  test("keeps the original nonce and authority when mining is later than dispatch expiry", async () => {
    const f = fixture();
    const proof = await f.verify();
    expect(proof).toMatchObject({
      contributionId: f.original.receipt.contribution_id,
      nonce: "7",
      confirmedNonce: "8",
      blockNumber: "101",
      checkpointBlock: "199",
      transactionHash: hash("1"),
    });
    expect(proof.blockTimestamp > f.original.cancellationHead.dispatch_expires_at).toBe(true);
  });
  test.each([
    null,
    { chainId: 1 },
    { from: hash("a").slice(0, 42) },
    { to: null },
    { nonce: 8n },
    { valueWei: 1n },
    { input: "0x00" as const },
    { blockNumber: null },
  ])("refuses missing or contradictory transaction vector", async (patch) => {
    const f = fixture();
    f.setTx(patch);
    await expect(f.verify()).rejects.toThrow();
  });
  test.each([
    null,
    { status: "reverted" as const },
    { blockHash: hash("9") },
    { to: hash("a").slice(0, 42) },
  ])("refuses missing or contradictory receipt vector", async (patch) => {
    const f = fixture();
    f.setReceipt(patch);
    await expect(f.verify()).rejects.toThrow();
  });
  test("does not close from elapsed time, unfinalized inclusion, nonce equality, reorg or stale observation", async () => {
    for (const change of [
      "unfinal",
      "unconsumed",
      "reorganize",
      "reorganizeAnchor",
      "stale",
    ] as const) {
      const f = fixture();
      f[change]();
      await expect(f.verify()).rejects.toThrow();
    }
  });
  test("refuses a changed preparation or grant before any RPC", async () => {
    const f = fixture();
    let reads = 0;
    f.rpc.readTransaction = async () => {
      reads++;
      return null;
    };
    await expect(
      verifyFundingCancellation({
        original: {
          ...f.original,
          cancellationHead: { ...f.original.cancellationHead, recipient: hash("b").slice(0, 42) },
        },
        rpc: f.rpc,
        policy: f.policy,
        transactionHash: hash("1"),
        now: () => "2026-10-18T14:40:00.000Z",
      }),
    ).rejects.toThrow();
    expect(reads).toBe(0);
  });
});
