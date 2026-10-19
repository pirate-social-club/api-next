import { describe, expect, test } from "bun:test";
import { digestFundingPreimageV2, SongContributionFailure } from "@pirate/application";
import type { SongFundingWork } from "@pirate/platform-cf";
import {
  MegapotV2AttestationMismatch,
  type MegapotV2FullRpcClient,
  MegapotV2RpcFailed,
} from "@pirate/platform-cf/megapot-v2-rpc";
import { Effect } from "effect";
import { cancellationPolicyPreimageV2 } from "../../../packages/contracts/src/rewards-song-contributions-v2.ts";
import { makeSongMegapotFundingRecovery } from "./song-megapot-funding-recovery.ts";

async function fixture() {
  const h = "a".repeat(64),
    bh = `0x${h}`,
    sender = `0x${"11".repeat(20)}`,
    token = `0x${"22".repeat(20)}`,
    custody = `0x${"33".repeat(20)}`;
  const now = "2026-10-18T12:00:00.000Z";
  const policy = {
    object: "nonce_cancellation_recovery_policy" as const,
    version: "nonce-cancellation-recovery-v1" as const,
    policy_id: "recovery",
    policy_hash: h,
    chain_id: 84532 as const,
    valid_from: "2026-10-18T11:00:00.000Z",
    valid_until: "2026-10-18T14:00:00.000Z",
    dispatch_ttl_seconds: 180,
    max_preparations_per_contribution: 2,
    fee_policy_id: "fees",
    fee_policy_hash: h,
    attestation_contract_version: "megapot-v2-current-recovery-v1",
  };
  policy.policy_hash = await Effect.runPromise(
    digestFundingPreimageV2(cancellationPolicyPreimageV2(policy)),
  );
  const deployment = {
    attestationId: "attestation",
    environment: "test" as const,
    chainId: 84532,
    jackpotAddress: `0x${"44".repeat(20)}`,
    ticketNftAddress: `0x${"55".repeat(20)}`,
    referrerAddress: `0x${"66".repeat(20)}`,
    usdcAddress: token,
    custodyAddress: custody,
    jackpotCodeHash: bh,
    ticketNftCodeHash: bh,
    usdcCodeHash: bh,
  };
  const work = {
    workId: "work",
    token: "lease",
    identity: {},
    hint: null,
    nextBlock: null,
    source: {
      profileId: "profile",
      profileHash: h,
      validUntil: policy.valid_until,
      policy,
      noncePolicy: { hash: h, maxAgeMs: 60_000 },
      deployment,
      attestationBlock: "1",
      attestationBlockHash: bh,
    },
    workPolicy: {
      maxAttempts: 2,
      leaseMs: 60_000,
      maximumBlocks: 10,
      maximumLogs: 2,
      receipt: {
        policyHash: h,
        requiredConfirmations: 1,
        maximumClockSkewMs: 0,
        maximumObservationAgeMs: 60_000,
      },
    },
    state: {
      revision: 0,
      nonceFinalized: false,
      fundingGrant: null,
      cancellationGrant: null,
      cancellationHead: null,
      anchorBlockHash: bh,
      effectiveDeadline: "2026-10-18T13:00:00.000Z",
      receipt: {
        contribution_id: "contribution",
        reservation: { valid_from_block_exclusive: "1" },
        committed_terms: {
          starts_at: "2026-10-18T11:00:00.000Z",
          ends_at: "2026-10-18T13:00:00.000Z",
        },
        instruction: {
          chain_id: 84532,
          from: sender,
          nonce: "4",
          to_token: token,
          recipient_custody: custody,
          attestation_id: "attestation",
          attestation_hash: h,
          instruction_hash: h,
          wallet_assignment_id: "wallet",
          calldata: "0x",
          amount_atomic: "2000000",
        },
      },
    },
  } as unknown as SongFundingWork;
  const calls: string[] = [],
    results: unknown[] = [],
    accepted: unknown[] = [],
    invalidations: string[] = [];
  let claimed = false,
    failRecord = false,
    currentAuthority = true,
    workCharges = 0;
  const store: Parameters<typeof makeSongMegapotFundingRecovery>[0]["store"] = {
    invalidate: (_work, reason) =>
      Effect.sync(() => {
        calls.push("invalidate");
        invalidations.push(reason);
        currentAuthority = false;
      }),
    list: () =>
      Effect.sync(() => {
        calls.push("list");
        return ["work"];
      }),
    claim: () =>
      Effect.sync(() => {
        calls.push("claim");
        if (claimed) return null;
        claimed = true;
        workCharges += 1;
        return work;
      }),
    record: () => {
      calls.push("record");
      return failRecord
        ? Effect.fail(new SongContributionFailure({ code: "lifecycle_changed" }))
        : Effect.succeed(undefined);
    },
    accept: (_work, proof) =>
      Effect.sync(() => {
        calls.push("accept");
        accepted.push(proof);
        return { rows: [], rowCount: 0 };
      }),
    finish: (_w, r) =>
      Effect.sync(() => {
        calls.push("finish");
        results.push(r);
      }),
  };
  const rpc = {
    deployment,
    attestDeploymentAt: async () => {
      calls.push("attest");
    },
    readHead: async () => ({
      blockNumber: 10n,
      blockHash: bh,
      blockTimestamp: BigInt(Date.parse(now) / 1000),
    }),
    readBlock: async (n: bigint) => ({
      blockNumber: n,
      blockHash: bh,
      blockTimestamp: BigInt(Date.parse(now) / 1000),
    }),
    readPendingNonce: async () => 4n,
    readTransactionCount: async () => 4n,
    readFinalizedHead: async () => ({
      blockNumber: 10n,
      blockHash: bh,
      blockTimestamp: BigInt(Date.parse(now) / 1000),
    }),
    readFundingTransferLogs: async () => {
      calls.push("logs");
      return [];
    },
    readTransaction: async () => null,
  } as unknown as MegapotV2FullRpcClient;
  const run = () =>
    Effect.runPromise(
      makeSongMegapotFundingRecovery({ store, rpcFor: () => rpc, now: () => now }).run({
        enabled: true,
        limit: 2,
        ensure: () => Effect.void,
      }),
    );
  return {
    run,
    store,
    rpc,
    calls,
    results,
    accepted,
    invalidations,
    currentAuthority: () => currentAuthority,
    workCharges: () => workCharges,
    work,
    now,
    failRecord: () => {
      failRecord = true;
    },
  };
}
describe("actual V2 Jobs recovery consumer with offline ports", () => {
  test("disabled declaration has no provider, work or database interaction", async () => {
    const f = await fixture();
    await Effect.runPromise(
      makeSongMegapotFundingRecovery({
        store: f.store,
        rpcFor: () => {
          throw new Error("must not construct RPC");
        },
        now: () => f.now,
      }).run({
        enabled: false,
        limit: 2,
        ensure: () => {
          throw new Error("must not request authority");
        },
      }),
    );
    expect(f.calls).toEqual([]);
  });
  test("current witness persisted before bounded discovery; no receipt/nonce invented from absence", async () => {
    const f = await fixture();
    await f.run();
    expect(f.calls).toEqual(["list", "claim", "attest", "record", "logs", "finish"]);
    expect(f.results).toEqual([{ complete: false, nextBlock: "2", error: null }]);
    expect(f.work.state.nonceFinalized).toBe(false);
  });
  test("concurrent workers respect the durable claim and issue no second charge/observation", async () => {
    const f = await fixture();
    await Promise.all([f.run(), f.run()]);
    expect(f.calls.filter((x) => x === "record")).toHaveLength(1);
    expect(f.calls.filter((x) => x === "logs")).toHaveLength(1);
    expect(f.results).toHaveLength(1);
  });
  test("retired/missing cancellation authority does not prevent historical incoming observation", async () => {
    const f = await fixture();
    Object.assign(f.work.source, { policy: null });
    const i = f.work.state.receipt.instruction,
      hash = `0x${"77".repeat(32)}`,
      block = `0x${"a".repeat(64)}`;
    Object.assign(f.rpc, {
      readFundingTransferLogs: async () => [{ transactionHash: hash, blockNumber: 2n }],
      readTransaction: async () => ({
        transactionHash: hash,
        chainId: i.chain_id,
        from: i.from,
        to: i.to_token,
        nonce: 4n,
        valueWei: 0n,
        input: i.calldata,
        blockNumber: 2n,
      }),
      readTransactionCount: async () => 5n,
      readReceipt: async () => ({
        chainId: i.chain_id,
        status: "success",
        transactionHash: hash,
        from: i.from,
        to: i.to_token,
        blockHash: block,
        blockNumber: 2n,
        logs: [
          {
            address: i.to_token,
            topics: [
              "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
              `0x${i.from.slice(2).padStart(64, "0")}`,
              `0x${i.recipient_custody.slice(2).padStart(64, "0")}`,
            ],
            data: `0x${2_000_000n.toString(16).padStart(64, "0")}`,
            logIndex: 0,
            transactionHash: hash,
            blockHash: block,
            blockNumber: 2n,
          },
        ],
      }),
    });
    await f.run();
    expect(f.calls).not.toContain("record");
    expect(f.calls.filter((x) => x === "accept")).toHaveLength(1);
    expect(f.results).toEqual([{ complete: true, nextBlock: null, error: null }]);
  });
  test("current code/config mismatch invalidates cancellation while independently valid historical principal is accepted once", async () => {
    const f = await fixture();
    const i = f.work.state.receipt.instruction,
      hash = `0x${"77".repeat(32)}`,
      block = `0x${"a".repeat(64)}`,
      attested: bigint[] = [];
    const originalState = structuredClone(f.work.state);
    expect(f.work.source.policy).not.toBeNull();
    Object.assign(f.rpc, {
      attestDeploymentAt: async (at: bigint) => {
        attested.push(at);
        if (at === 10n) throw new MegapotV2AttestationMismatch();
        if (at !== 2n) throw new Error("Unexpected historical attestation block");
      },
      readFundingTransferLogs: async () => [{ transactionHash: hash, blockNumber: 2n }],
      readTransaction: async () => ({
        transactionHash: hash,
        chainId: i.chain_id,
        from: i.from,
        to: i.to_token,
        nonce: 4n,
        valueWei: 0n,
        input: i.calldata,
        blockNumber: 2n,
      }),
      readTransactionCount: async () => 5n,
      readReceipt: async () => ({
        chainId: i.chain_id,
        status: "success",
        transactionHash: hash,
        from: i.from,
        to: i.to_token,
        blockHash: block,
        blockNumber: 2n,
        logs: [
          {
            address: i.to_token,
            topics: [
              "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
              `0x${i.from.slice(2).padStart(64, "0")}`,
              `0x${i.recipient_custody.slice(2).padStart(64, "0")}`,
            ],
            data: `0x${2_000_000n.toString(16).padStart(64, "0")}`,
            logIndex: 0,
            transactionHash: hash,
            blockHash: block,
            blockNumber: 2n,
          },
        ],
      }),
    });
    await f.run();
    await f.run();
    expect(attested).toEqual([10n, 2n]);
    expect(f.invalidations).toEqual(["attestation_unavailable"]);
    expect(f.currentAuthority()).toBe(false);
    expect(f.calls).not.toContain("record");
    expect(f.calls.filter((x) => x === "accept")).toHaveLength(1);
    expect(f.calls.indexOf("invalidate")).toBeLessThan(f.calls.indexOf("accept"));
    expect(f.accepted).toMatchObject([
      {
        receiptId: `incoming-v2:${i.chain_id}:${hash}:0`,
        contributionId: f.work.state.receipt.contribution_id,
        category: "pool_principal",
        instructionHash: i.instruction_hash,
        exactInstruction: true,
        evidence: { transaction_hash: hash, sender_nonce: "4", actual_amount_atomic: "2000000" },
      },
    ]);
    expect(f.results).toEqual([{ complete: true, nextBlock: null, error: null }]);
    expect(f.workCharges()).toBe(1);
    expect(f.work.state).toEqual(originalState);
    expect(f.work.state.cancellationGrant).toBeNull();
    expect(f.work.state.fundingGrant).toBeNull();
  });
  test("uncertain current attestation never falls through to historical acceptance or a new grant", async () => {
    for (const error of [
      new MegapotV2RpcFailed("invalid-response"),
      new MegapotV2RpcFailed("provider-error"),
      new MegapotV2RpcFailed("timeout"),
      new MegapotV2RpcFailed("unavailable"),
    ]) {
      const f = await fixture();
      const originalState = structuredClone(f.work.state);
      Object.assign(f.rpc, {
        attestDeploymentAt: async () => {
          throw error;
        },
      });
      await f.run();
      expect(f.invalidations).toEqual(["outcome_unknown"]);
      expect(f.currentAuthority()).toBe(false);
      expect(f.calls).not.toContain("record");
      expect(f.calls).not.toContain("logs");
      expect(f.accepted).toEqual([]);
      expect(f.results).toEqual([{ complete: false, nextBlock: null, error: "outcome_unknown" }]);
      expect(f.workCharges()).toBe(1);
      expect(f.work.state).toEqual(originalState);
      expect(f.work.state.cancellationGrant).toBeNull();
    }
  });
  test("CAS failure and provider unknown retain work, principal and authority", async () => {
    const f = await fixture();
    f.failRecord();
    await f.run();
    expect(f.calls).not.toContain("logs");
    expect(f.calls).not.toContain("accept");
    expect(f.results).toMatchObject([{ complete: false, error: "lifecycle_changed" }]);
    const g = await fixture();
    Object.assign(g.rpc, {
      readPendingNonce: async () => {
        throw new Error("offline timeout after request");
      },
    });
    await g.run();
    expect(g.calls).not.toContain("record");
    expect(g.calls).not.toContain("accept");
    expect(g.results).toMatchObject([{ complete: false, error: "outcome_unknown" }]);
  });
});
