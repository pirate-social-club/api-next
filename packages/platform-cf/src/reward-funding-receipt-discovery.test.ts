import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { keccak256 } from "viem";
import type { ContributionState } from "../../application/src/rewards/song-megapot-contributions.ts";
import { digestFundingPreimageV2 } from "../../application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import {
  MegapotV2AttestationMismatch,
  type MegapotV2FullRpcClient,
  MegapotV2RpcFailed,
  makeMegapotV2RpcClient,
} from "./megapot-v2-rpc.ts";
import {
  type FundingRecoverySource,
  makeCurrentFundingRecoveryEvidence,
  makeMegapotFundingHistoricalVerifier,
  makeRewardFundingReceiptDiscovery,
} from "./reward-funding-receipt-discovery.ts";

const sender = `0x${"ab".repeat(20)}`,
  custody = `0x${"cd".repeat(20)}`,
  token = `0x${"ef".repeat(20)}`;
const hash = (b: string) => `0x${b.repeat(32)}`;
const h = "a".repeat(64),
  txHash = hash("12"),
  blockHash = hash("23"),
  anchorHash = hash("34");
const deadline = "2026-10-18T13:00:00.000Z";
const calldata =
  `0xa9059cbb${custody.slice(2).padStart(64, "0")}${2_000_000n.toString(16).padStart(64, "0")}` as `0x${string}`;
// Focused incoming-reader fixture: these are exactly the frozen fields this
// module reads. Full protocol schema/hash decoding is tested at the app/store.
const state = () =>
  ({
    revision: 0,
    nonceFinalized: false,
    anchorBlockHash: anchorHash,
    effectiveDeadline: deadline,
    receipt: {
      contribution_id: "effect-a",
      reservation: { valid_from_block_exclusive: "10" },
      committed_terms: { starts_at: "2026-10-18T12:00:00.000Z", ends_at: deadline },
      instruction: {
        chain_id: 84532,
        from: sender,
        to_token: token,
        recipient_custody: custody,
        nonce: "4",
        amount_atomic: "2000000",
        calldata,
        attestation_id: "attestation",
        attestation_hash: h,
        instruction_hash: h,
        wallet_assignment_id: "wallet",
      },
    },
  }) as unknown as ContributionState;
function fixture() {
  let inclusion = BigInt(Date.parse("2026-10-18T12:59:59.000Z") / 1000);
  let observed = "2026-10-18T13:10:00.000Z";
  let canonical = true,
    attested = true,
    missingTimestamp = false;
  const transaction = {
    transactionHash: txHash,
    chainId: 84532,
    from: sender,
    to: token,
    nonce: 4n,
    valueWei: 0n,
    input: calldata,
    blockNumber: 11n,
  };
  const receipt = {
    chainId: 84532,
    status: "success" as const,
    transactionHash: txHash,
    from: sender,
    to: token,
    blockHash,
    blockNumber: 11n,
    logs: [
      {
        address: token,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          `0x${sender.slice(2).padStart(64, "0")}`,
          `0x${custody.slice(2).padStart(64, "0")}`,
        ] as [`0x${string}`, ...`0x${string}`[]],
        data: `0x${2_000_000n.toString(16).padStart(64, "0")}` as `0x${string}`,
        logIndex: 0,
        transactionHash: txHash,
        blockHash,
        blockNumber: 11n,
      },
    ],
  };
  const policy = {
    policyHash: h,
    requiredConfirmations: 3,
    maximumClockSkewMs: 1_000,
    maximumObservationAgeMs: 60_000,
  };
  const input = {
    policy: policy as typeof policy | null,
    now: () => observed,
    verifyHistoricalAttestation: () => Effect.succeed(attested),
    rpc: {
      readTransaction: async () => transaction,
      readReceipt: async () => receipt,
      readHead: async () => ({
        blockNumber: 13n,
        blockHash: hash("56"),
        blockTimestamp: BigInt(Date.parse(observed) / 1000),
      }),
      readFinalizedHead: async () => ({
        blockNumber: 13n,
        blockHash: hash("56"),
        blockTimestamp: BigInt(Date.parse(observed) / 1000),
      }),
      readBlock: async (n: bigint) => ({
        blockNumber: n,
        blockHash:
          n === 10n ? anchorHash : n === 11n ? (canonical ? blockHash : hash("99")) : hash("56"),
        ...(missingTimestamp
          ? {}
          : { blockTimestamp: n === 11n ? inclusion : BigInt(Date.parse(observed) / 1000) }),
      }),
      readTransactionCount: async () => 5n,
    },
  };
  return {
    input,
    transaction,
    receipt,
    run: (s = state()) => Effect.runPromise(makeRewardFundingReceiptDiscovery(input)(s, txHash)),
    inclusion: (s: string) => {
      inclusion = BigInt(Date.parse(s) / 1000);
    },
    observed: (s: string) => {
      observed = s;
    },
    reorganize: () => {
      canonical = false;
    },
    retire: () => {
      attested = false;
    },
    missingTime: () => {
      missingTimestamp = true;
    },
  };
}
describe("V2 incoming contribution attribution with offline canonical RPC reads", () => {
  test("late observation of predeadline inclusion remains pool principal", async () => {
    const f = fixture();
    const proof = await f.run();
    expect(proof?.category).toBe("pool_principal");
    expect(proof?.evidence.block_timestamp).toBe("2026-10-18T12:59:59.000Z");
    expect(proof?.evidence.first_observed_at).toBe("2026-10-18T13:10:00.000Z");
  });
  test("deadline equality is separate actual late principal", async () => {
    const f = fixture();
    f.inclusion(deadline);
    expect((await f.run())?.category).toBe("late_principal");
  });
  test("repeated equal sender amounts cannot interchange frozen nonces", async () => {
    const f = fixture();
    f.transaction.nonce = 5n;
    await expect(f.run()).rejects.toMatchObject({ code: "receipt_mismatch" });
  });
  test("mismatched actual accepted-asset amount is retained as late, not pool credit", async () => {
    const f = fixture();
    const log = f.receipt.logs[0];
    if (log === undefined) throw new Error("Missing test log");
    log.data = `0x${1_000_000n.toString(16).padStart(64, "0")}`;
    const proof = await f.run();
    expect(proof?.category).toBe("late_principal");
    expect(proof?.evidence.actual_amount_atomic).toBe("1000000");
  });
  test("a self cancellation cannot fabricate Transfer principal", async () => {
    const f = fixture();
    f.transaction.to = sender;
    f.transaction.input = "0x";
    f.receipt.to = sender;
    f.receipt.logs = [];
    await expect(f.run()).rejects.toMatchObject({ code: "receipt_mismatch" });
  });
  test("attributable custody money through a different call stays nonadmitted principal", async () => {
    const f = fixture();
    f.transaction.input = "0x1234";
    expect((await f.run())?.category).toBe("late_principal");
  });
  test("canonicality, original anchor and historical attestation are required", async () => {
    const f = fixture();
    f.reorganize();
    await expect(f.run()).rejects.toMatchObject({ code: "receipt_mismatch" });
    const g = fixture();
    g.retire();
    await expect(g.run()).rejects.toMatchObject({ code: "attestation_unavailable" });
  });
  test("missing selected policy or block time is unavailable", async () => {
    const f = fixture();
    f.input.policy = null;
    await expect(f.run()).rejects.toMatchObject({ code: "policy_unavailable" });
    const g = fixture();
    g.missingTime();
    await expect(g.run()).rejects.toMatchObject({ code: "attestation_unavailable" });
  });
  test("finality below the receipt retains uncertainty without principal", async () => {
    const f = fixture();
    f.input.rpc.readFinalizedHead = async () => ({
      blockNumber: 10n,
      blockHash: anchorHash,
      blockTimestamp: BigInt(Date.parse(deadline) / 1000),
    });
    expect(await f.run()).toBeNull();
  });
});

async function currentFixture() {
  const now = "2026-10-18T12:30:00.000Z";
  const deployment = {
    attestationId: "attestation",
    environment: "test" as const,
    chainId: 84532,
    jackpotAddress: `0x${"12".repeat(20)}`,
    ticketNftAddress: `0x${"34".repeat(20)}`,
    usdcAddress: token,
    custodyAddress: custody,
    referrerAddress: `0x${"56".repeat(20)}`,
    jackpotCodeHash: hash("01"),
    ticketNftCodeHash: hash("02"),
    usdcCodeHash: hash("03"),
  };
  let policy = Schema.decodeUnknownSync(C.CancellationRecoveryPolicyV2)({
    object: "nonce_cancellation_recovery_policy",
    version: "nonce-cancellation-recovery-v1",
    policy_id: "recovery",
    policy_hash: h,
    chain_id: 84532,
    valid_from: "2026-10-18T12:00:00.000Z",
    valid_until: "2026-10-18T14:00:00.000Z",
    dispatch_ttl_seconds: 180,
    max_preparations_per_contribution: 2,
    fee_policy_id: "fee",
    fee_policy_hash: h,
    attestation_contract_version: "megapot-v2-current-recovery-v1",
  });
  policy = {
    ...policy,
    policy_hash: await Effect.runPromise(
      digestFundingPreimageV2(C.cancellationPolicyPreimageV2(policy)),
    ),
  };
  const source: FundingRecoverySource = {
    profileId: "profile",
    profileHash: h,
    validUntil: "2026-10-18T14:00:00.000Z",
    policy,
    noncePolicy: { hash: h, maxAgeMs: 60_000 },
    deployment,
    attestationBlock: "10",
    attestationBlockHash: hash("66"),
  };
  const calls: bigint[] = [];
  const rpc = {
    deployment,
    attestDeploymentAt: async (b: bigint) => {
      calls.push(b);
    },
    readHead: async () => ({
      blockNumber: 20n,
      blockHash: hash("66"),
      blockTimestamp: BigInt(Date.parse(now) / 1000),
    }),
    readBlock: async () => ({ blockNumber: 10n, blockHash: hash("66") }),
    readTransactionCount: async () => 4n,
    readPendingNonce: async () => 5n,
  } as unknown as MegapotV2FullRpcClient;
  return {
    source,
    rpc,
    calls,
    now,
    run: () =>
      Effect.runPromise(makeCurrentFundingRecoveryEvidence(rpc, () => now)(state(), source)),
  };
}
describe("current recovery producer with offline RPC capabilities", () => {
  test("uncached current block proof binds original nonce/identity and explicit validity", async () => {
    const f = await currentFixture();
    const e = await f.run();
    expect(e).toMatchObject({
      confirmedNonce: "4",
      pendingNonce: "5",
      walletAssignmentId: "wallet",
      stateRevision: 0,
      attestationId: "attestation",
      instructionHash: h,
    });
    expect(e.validUntil).toBe("2026-10-18T12:31:00.000Z");
    await f.run();
    expect(f.calls).toEqual([20n, 20n]);
  });
  test("missing/unaccepted policy and missing historical capability stay unavailable", async () => {
    const f = await currentFixture();
    await expect(
      Effect.runPromise(
        makeCurrentFundingRecoveryEvidence(f.rpc, () => f.now)(state(), {
          ...f.source,
          policy: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "cancellation_recovery_unavailable" });
    if (f.source.policy === null) throw new Error("Missing test policy");
    const unsupported = {
      ...f.source.policy,
      attestation_contract_version: "unsupported-recovery-version",
    };
    unsupported.policy_hash = await Effect.runPromise(
      digestFundingPreimageV2(C.cancellationPolicyPreimageV2(unsupported)),
    );
    await expect(
      Effect.runPromise(
        makeCurrentFundingRecoveryEvidence(f.rpc, () => f.now)(state(), {
          ...f.source,
          policy: unsupported,
        }),
      ),
    ).rejects.toMatchObject({ code: "cancellation_recovery_unavailable" });
    Object.assign(f.rpc, { attestDeploymentAt: undefined });
    await expect(f.run()).rejects.toMatchObject({ code: "cancellation_recovery_unavailable" });
    expect(f.calls).toHaveLength(0);
  });
  test("stale clock, consumed nonce, mismatched client deployment and rollover cannot mint authority", async () => {
    for (const change of ["stale", "nonce", "client", "rollover"]) {
      const f = await currentFixture();
      if (change === "stale")
        Object.assign(f.rpc, {
          readHead: async () => ({
            blockNumber: 20n,
            blockHash: hash("66"),
            blockTimestamp: BigInt(Date.parse(f.now) / 1000) - 61n,
          }),
        });
      if (change === "nonce") Object.assign(f.rpc, { readTransactionCount: async () => 5n });
      if (change === "client")
        Object.assign(f.rpc, { deployment: { ...f.source.deployment, custodyAddress: sender } });
      if (change === "rollover") {
        let n = 0;
        Object.assign(f.rpc, {
          readHead: async () => ({
            blockNumber: BigInt(20 + n++),
            blockHash: hash("66"),
            blockTimestamp: BigInt(Date.parse(f.now) / 1000),
          }),
        });
      }
      await expect(f.run()).rejects.toMatchObject({ code: "cancellation_recovery_unavailable" });
    }
  });
  test("provider uncertainty creates no evidence; historical verification uses original fenced block", async () => {
    const f = await currentFixture();
    Object.assign(f.rpc, {
      readPendingNonce: async () => {
        throw new Error("offline unknown response");
      },
    });
    await expect(f.run()).rejects.toMatchObject({ code: "outcome_unknown" });
    const verify = makeMegapotFundingHistoricalVerifier(f.rpc, 10n, hash("66"));
    expect(await Effect.runPromise(verify(state(), 9n))).toBe(false);
    expect(await Effect.runPromise(verify(state(), 11n))).toBe(true);
    expect(f.calls.at(-1)).toBe(11n);
  });
  test("only a known deployment mismatch is unavailable; actual RPC uncertainty remains unknown", async () => {
    for (const error of [
      new MegapotV2AttestationMismatch(),
      new MegapotV2RpcFailed("invalid-response"),
      new MegapotV2RpcFailed("provider-error"),
      new MegapotV2RpcFailed("timeout"),
      new MegapotV2RpcFailed("unavailable"),
      new Error("unknown response outcome"),
    ]) {
      const f = await currentFixture();
      Object.assign(f.rpc, {
        attestDeploymentAt: async () => {
          throw error;
        },
      });
      const code =
        error instanceof MegapotV2AttestationMismatch
          ? "attestation_unavailable"
          : "outcome_unknown";
      await expect(f.run()).rejects.toMatchObject({ code });
      await expect(
        Effect.runPromise(
          makeMegapotFundingHistoricalVerifier(f.rpc, 10n, hash("66"))(state(), 11n),
        ),
      ).rejects.toMatchObject({ code });
    }
  });
  test("actual RPC historical code and bounded log sources use only injected offline fetcher", async () => {
    const f = await currentFixture(),
      code = "0x6000" as const,
      codeHash = keccak256(code),
      seen: { method: string; params: unknown[] }[] = [];
    const d = {
      ...f.source.deployment,
      jackpotCodeHash: codeHash,
      ticketNftCodeHash: codeHash,
      usdcCodeHash: codeHash,
    };
    let logs: unknown[] = [],
      mode = "valid";
    const rpc = makeMegapotV2RpcClient({
      rpcUrl: "https://offline.invalid",
      attestation: d,
      fetcher: async (_url, init) => {
        const q = JSON.parse(String(init?.body));
        seen.push(q);
        if (mode === "transport") throw new Error("offline fetch failure");
        if (mode === "provider")
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: q.id,
              error: { code: -32000, message: "offline unavailable" },
            }),
          );
        const result =
          q.method === "eth_chainId"
            ? mode === "chain" || mode === "chain-empty"
              ? "0x1"
              : "0x14a34"
            : q.method === "eth_getCode"
              ? mode === "code"
                ? "0x6001"
                : mode === "empty" || mode === "chain-empty"
                  ? "0x"
                  : mode === "malformed"
                    ? "invalid"
                    : code
              : q.method === "eth_call"
                ? mode === "empty" || mode === "chain-empty"
                  ? "0x"
                  : `0x${(mode === "configuration" ? d.custodyAddress : seen.filter((x) => x.method === "eth_call").length % 2 === 1 ? d.ticketNftAddress : d.usdcAddress).slice(2).padStart(64, "0")}`
                : logs;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
      },
    });
    const attest = rpc.attestDeploymentAt,
      readLogs = rpc.readFundingTransferLogs;
    if (attest === undefined || readLogs === undefined)
      throw new Error("Missing actual RPC methods");
    await attest(11n);
    await attest(12n);
    expect(seen.filter((q) => q.method === "eth_getCode").map((q) => q.params[1])).toEqual([
      "0xb",
      "0xb",
      "0xb",
      "0xc",
      "0xc",
      "0xc",
    ]);
    expect(
      await readLogs({
        sender,
        custody,
        token,
        fromBlock: 11n,
        toBlock: 12n,
        maximumBlocks: 2,
        maximumLogs: 3,
      }),
    ).toEqual([]);
    const prior = seen.length;
    await expect(
      readLogs({
        sender,
        custody,
        token,
        fromBlock: 11n,
        toBlock: 13n,
        maximumBlocks: 2,
        maximumLogs: 3,
      }),
    ).rejects.toMatchObject({ reason: "invalid-config" });
    expect(seen).toHaveLength(prior);
    const log = {
      address: token,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        `0x${sender.slice(2).padStart(64, "0")}`,
        `0x${custody.slice(2).padStart(64, "0")}`,
      ],
      transactionHash: txHash,
      blockNumber: "0xb",
      blockHash,
      logIndex: "0x0",
      data: "0x",
      removed: false,
    };
    logs = [log];
    const request = {
      sender,
      custody,
      token,
      fromBlock: 11n,
      toBlock: 12n,
      maximumBlocks: 2,
      maximumLogs: 3,
    };
    expect(await readLogs(request)).toEqual([{ transactionHash: txHash, blockNumber: 11n }]);
    logs = [{ ...log, removed: true }];
    await expect(readLogs(request)).rejects.toMatchObject({ reason: "invalid-response" });
    logs = [{ ...log, blockNumber: "0xd" }];
    await expect(readLogs(request)).rejects.toMatchObject({ reason: "invalid-response" });
    for (const mismatch of ["code", "empty", "configuration"]) {
      mode = mismatch;
      await expect(attest(12n)).rejects.toBeInstanceOf(MegapotV2AttestationMismatch);
    }
    for (const [uncertainty, reason] of [
      ["chain", "invalid-response"],
      ["chain-empty", "invalid-response"],
      ["malformed", "invalid-response"],
      ["provider", "provider-error"],
      ["transport", "unavailable"],
    ] as const) {
      mode = uncertainty;
      const error = await attest(12n).then(
        () => null,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(MegapotV2RpcFailed);
      expect(error).not.toBeInstanceOf(MegapotV2AttestationMismatch);
      expect(error).toMatchObject({ reason });
    }
    mode = "valid";
    await expect(attest(11n)).resolves.toMatchObject({ jackpotCodeHash: codeHash });
  });
});
