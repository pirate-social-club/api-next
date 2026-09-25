import { describe, expect, test } from "bun:test";
import type {
  RewardGasTopupCandidate,
  RewardGasTopupPreparedEffect,
  RewardGasTopupProgress,
  RewardGasTopupSendStore,
} from "@pirate/application";
import { Effect } from "effect";
import { type Hex, keccak256, parseTransaction } from "viem";
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";
import {
  deriveBaseSepoliaMegapotAddress,
  makeBaseSepoliaMegapotV2PrivateKeySigner,
} from "./megapot-v2-signer.ts";
import {
  deriveRewardGasTopupEffectId,
  makeRewardGasTopupCoordinator,
  type RewardGasTopupRpc,
} from "./reward-gas-topup-coordinator.ts";

const KEY = `0x${"22".repeat(32)}`;
const SIGNER = deriveBaseSepoliaMegapotAddress(KEY);
const RECIPIENT = `0x${"a1".repeat(20)}`;
const hashOf = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

const candidate: RewardGasTopupCandidate = {
  topupId: "gas-topup_1",
  accountId: "winner",
  creditId: "credit-1",
  recipientAddress: RECIPIENT,
  chainId: 84_532,
  amountWei: 30_000n,
  targetBalanceWei: 50_000n,
  signerAddress: SIGNER,
};

function fixture(
  overrides: Partial<RewardGasTopupRpc> = {},
  candidateOverrides: Partial<RewardGasTopupCandidate> = {},
) {
  const calls: string[] = [];
  let progress: RewardGasTopupProgress | null = null;
  const current = { ...candidate, ...candidateOverrides };
  const store: RewardGasTopupSendStore = {
    loadActiveSigner: () => Effect.succeed(SIGNER),
    listOpen: () => Effect.succeed([current.topupId]),
    loadCandidate: () => Effect.succeed(current),
    findProgress: () => Effect.succeed(progress),
    releaseUnsent: ({ reason }) => Effect.sync(() => void calls.push(`release:${reason}`)),
    reserveNonce: (input) =>
      Effect.sync(() => {
        calls.push(`reserve:${input.observedPendingNonce}`);
        const reservation = {
          ...input.candidate,
          effectId: input.effectId,
          nonce: input.observedPendingNonce,
          effectVersion: 2,
        };
        progress = { state: "nonce_reserved", reservation };
        return reservation;
      }),
    prepare: (input) =>
      Effect.sync(() => {
        calls.push("prepare");
        progress = {
          ...input.reservation,
          state: "prepared",
          signedTransaction: input.signedTransaction,
          signedTransactionHash: input.signedTransactionHash,
          transactionHash: null,
        };
      }),
    recordSubmission: (input) =>
      Effect.sync(() => {
        calls.push(`submission:${input.outcome}:${input.failureReason ?? "-"}`);
        const prepared = progress as RewardGasTopupPreparedEffect;
        progress = {
          ...prepared,
          state: input.outcome === "accepted" ? "broadcast_pending" : "reconciliation_required",
          transactionHash: input.transactionHash,
        };
      }),
    requireReconciliation: (input) =>
      Effect.sync(() => void calls.push(`reconcile:${input.reason}`)),
    confirm: (input) => Effect.sync(() => void calls.push(`confirm:${input.confirmations}`)),
    recordReverted: () => Effect.sync(() => void calls.push("reverted")),
  };
  const sent: Hex[] = [];
  let receipt: MegapotTransactionReceipt | null = null;
  const rpc: RewardGasTopupRpc = {
    readFeeQuote: async () => ({
      baseFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 3n,
      observedBlockNumber: 100n,
      observedBlockHash: hashOf(100n),
    }),
    readBlock: async (blockNumber) => ({ blockNumber, blockHash: hashOf(blockNumber) }),
    readHead: async () => ({ blockNumber: 110n, blockHash: hashOf(110n) }),
    readNativeBalance: async (account) => (account === SIGNER ? 10n ** 18n : 0n),
    readPendingNonce: async () => 4n,
    estimateGas: async () => 21_000n,
    sendRawTransaction: async (signed) => {
      sent.push(signed);
      return keccak256(signed);
    },
    readReceipt: async () => receipt,
    ...overrides,
  };
  const coordinator = makeRewardGasTopupCoordinator({
    store,
    rpc,
    signer: makeBaseSepoliaMegapotV2PrivateKeySigner({ privateKey: KEY, expectedAddress: SIGNER }),
    requiredConfirmations: 3,
    gasLimitMultiplierBps: 12_000,
    nativeGasReserveFloorWei: 1_000n,
    now: () => Date.parse("2026-09-25T12:00:00.000Z"),
  });
  const setReceipt = (value: Partial<MegapotTransactionReceipt>) => {
    const hash = keccak256(sent[0] as Hex);
    receipt = {
      chainId: 84_532,
      status: "success",
      transactionHash: hash,
      from: SIGNER,
      to: RECIPIENT,
      blockHash: hashOf(105n),
      blockNumber: 105n,
      logs: [],
      ...value,
    };
  };
  return { calls, coordinator, sent, setReceipt, send: () => coordinator.send(current.topupId) };
}

describe("reward gas top-up coordinator", () => {
  test("derives a stable effect id per top-up", () => {
    expect(deriveRewardGasTopupEffectId("gas-topup_1")).toBe(
      deriveRewardGasTopupEffectId("gas-topup_1"),
    );
    expect(deriveRewardGasTopupEffectId("gas-topup_1")).not.toBe(
      deriveRewardGasTopupEffectId("gas-topup_2"),
    );
  });

  test("signs a plain value transfer and confirms it at depth", async () => {
    const run = fixture();
    expect((await Effect.runPromise(run.send())).kind).toBe("submitted");
    const parsed = parseTransaction(run.sent[0] as Hex);
    expect(parsed).toMatchObject({ chainId: 84_532, nonce: 4, value: 30_000n });
    expect(parsed.to?.toLowerCase()).toBe(RECIPIENT);
    expect(parsed.data ?? "0x").toBe("0x");
    run.setReceipt({});
    expect(await Effect.runPromise(run.send())).toMatchObject({ kind: "confirmed" });
    expect(run.calls).toEqual(["reserve:4", "prepare", "submission:accepted:-", "confirm:6"]);
  });

  test("releases without a nonce when the recipient was funded since the request", async () => {
    const run = fixture({ readNativeBalance: async () => 50_000n });
    expect(await Effect.runPromise(run.send())).toEqual({
      kind: "released",
      topupId: "gas-topup_1",
      reason: "recipient_funded",
    });
    expect(run.calls).toEqual(["release:recipient_funded"]);
  });

  test("refuses when the gas wallet cannot cover value, gas and the reserve floor", async () => {
    const run = fixture({
      readNativeBalance: async (account) => (account === SIGNER ? 30_000n + 75_600n : 0n),
    });
    expect(await Effect.runPromise(Effect.flip(run.send()))).toMatchObject({
      reason: "gas_floor_insufficient",
      phase: "preflight",
    });
    expect(run.calls).toEqual([]);
  });

  test("refuses a signer that is not the active gas wallet and any non-testnet chain", async () => {
    expect(
      await Effect.runPromise(
        Effect.flip(fixture({}, { signerAddress: `0x${"cc".repeat(20)}` }).send()),
      ),
    ).toMatchObject({ reason: "signer_mismatch" });
    expect(
      await Effect.runPromise(Effect.flip(fixture({}, { chainId: 8_453 }).send())),
    ).toMatchObject({ reason: "production_disabled" });
  });

  test("records an unknown broadcast outcome as uncertain", async () => {
    const run = fixture({
      sendRawTransaction: async () => {
        throw new Error("provider timeout");
      },
    });
    expect((await Effect.runPromise(run.send())).kind).toBe("reconciliation_required");
    expect(run.calls).toContain("submission:uncertain:broadcast_outcome_unknown");
  });

  test("requires reconciliation for a mismatched sender or a reorged receipt", async () => {
    const wrongSender = fixture();
    await Effect.runPromise(wrongSender.send());
    wrongSender.setReceipt({ from: `0x${"dd".repeat(20)}` });
    expect((await Effect.runPromise(wrongSender.send())).kind).toBe("reconciliation_required");
    expect(wrongSender.calls).toContain("reconcile:gas_topup_receipt_identity_mismatch");

    const reorged = fixture();
    await Effect.runPromise(reorged.send());
    reorged.setReceipt({ blockHash: hashOf(999n) });
    expect((await Effect.runPromise(reorged.send())).kind).toBe("reconciliation_required");
    expect(reorged.calls).toContain("reconcile:gas_topup_receipt_reorg");
  });

  test("a confirmed reverted receipt is recorded as terminal", async () => {
    const run = fixture();
    await Effect.runPromise(run.send());
    run.setReceipt({ status: "reverted" });
    expect((await Effect.runPromise(run.send())).kind).toBe("reverted");
    expect(run.calls).toContain("reverted");
  });
});
