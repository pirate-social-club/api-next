import type {
  RewardGasTopupCandidate,
  RewardGasTopupFailure,
  RewardGasTopupPreparedEffect,
  RewardGasTopupProgress,
  RewardGasTopupReservedEffect,
  RewardGasTopupSendStore,
} from "@pirate/application";
import { Data, Effect } from "effect";
import { type Hex, keccak256, parseTransaction, toBytes } from "viem";
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";

export class RewardGasTopupCoordinatorFailed extends Data.TaggedError(
  "RewardGasTopupCoordinatorFailed",
)<{
  readonly reason:
    | "gas_floor_insufficient"
    | "invalid_config"
    | "preflight_unavailable"
    | "production_disabled"
    | "receipt_evidence_invalid"
    | "signer_mismatch";
  readonly phase: "configuration" | "preflight" | "prepare" | "receipt";
}> {}

/** The chain reads and writes a plain value transfer needs; the Megapot RPC client satisfies it. */
export type RewardGasTopupRpc = Pick<
  MegapotV2RpcClient,
  | "estimateGas"
  | "readBlock"
  | "readFeeQuote"
  | "readHead"
  | "readNativeBalance"
  | "readPendingNonce"
  | "readReceipt"
  | "sendRawTransaction"
>;

export type RewardGasTopupCoordinatorResult =
  | Readonly<{ kind: "released"; topupId: string; reason: string }>
  | Readonly<{ kind: "submitted"; effectId: string; transactionHash: string }>
  | Readonly<{ kind: "reconciliation_required"; effectId: string; transactionHash: string }>
  | Readonly<{ kind: "reverted"; effectId: string; transactionHash: string }>
  | Readonly<{
      kind: "confirmed";
      effectId: string;
      topupId: string;
      transactionHash: string | null;
    }>;

const failed = (
  reason: RewardGasTopupCoordinatorFailed["reason"],
  phase: RewardGasTopupCoordinatorFailed["phase"],
) => new RewardGasTopupCoordinatorFailed({ reason, phase });

const BASE_SEPOLIA_CHAIN_ID = 84_532;
const EMPTY_CALLDATA = "0x" as const;
/** SHA-256 of zero bytes: the calldata hash of a plain value transfer. */
export const EMPTY_CALLDATA_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sameAddress(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

function canonicalReceipt(receipt: MegapotTransactionReceipt): string {
  return JSON.stringify({
    chainId: receipt.chainId,
    status: receipt.status,
    transactionHash: receipt.transactionHash,
    from: receipt.from,
    to: receipt.to,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    logs: receipt.logs.map((log) => ({
      address: log.address,
      topics: [...log.topics],
      data: log.data,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      blockHash: log.blockHash,
      blockNumber: log.blockNumber.toString(),
      removed: log.removed ?? false,
    })),
  });
}

const sha256Hex = Effect.fn("rewardGasTopupSha256Hex")(function* (input: Uint8Array) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", input),
    catch: () => failed("invalid_config", "receipt"),
  });
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export function deriveRewardGasTopupEffectId(topupId: string): Hex {
  if (topupId.length === 0 || topupId !== topupId.trim()) {
    throw failed("invalid_config", "configuration");
  }
  return keccak256(toBytes(`pirate.reward-gas-topup.v1\u0000${topupId}`));
}

/** The signed bytes must be exactly the reserved plain transfer. */
function signedTransferMatches(effect: RewardGasTopupPreparedEffect): boolean {
  try {
    if (keccak256(effect.signedTransaction as Hex) !== effect.signedTransactionHash) return false;
    const parsed = parseTransaction(effect.signedTransaction as Hex);
    return (
      parsed.type === "eip1559" &&
      parsed.chainId === effect.chainId &&
      sameAddress(parsed.to ?? null, effect.recipientAddress) &&
      parsed.value === effect.amountWei &&
      parsed.nonce === Number(effect.nonce) &&
      (parsed.data === undefined || parsed.data === EMPTY_CALLDATA)
    );
  } catch {
    return false;
  }
}

export interface RewardGasTopupCoordinator {
  readonly send: (
    topupId: string,
  ) => Effect.Effect<
    RewardGasTopupCoordinatorResult,
    RewardGasTopupCoordinatorFailed | RewardGasTopupFailure
  >;
}

/**
 * Sends requested top-ups from the platform gas wallet with the same fence as
 * reward payouts: a derived effect id, a reserved nonce, immutable prepared
 * bytes, an accepted or uncertain submission, and confirmation only after the
 * configured depth with a reorg check.
 */
export function makeRewardGasTopupCoordinator(input: {
  readonly store: RewardGasTopupSendStore;
  readonly rpc: RewardGasTopupRpc;
  readonly signer: MegapotV2TransactionSigner;
  readonly requiredConfirmations: number;
  readonly gasLimitMultiplierBps: number;
  readonly nativeGasReserveFloorWei: bigint;
  readonly now?: () => number;
}): RewardGasTopupCoordinator {
  if (
    !Number.isSafeInteger(input.requiredConfirmations) ||
    input.requiredConfirmations < 1 ||
    !Number.isSafeInteger(input.gasLimitMultiplierBps) ||
    input.gasLimitMultiplierBps < 10_000 ||
    input.gasLimitMultiplierBps > 20_000 ||
    input.nativeGasReserveFloorWei < 0n
  ) {
    throw failed("invalid_config", "configuration");
  }
  const now = input.now ?? Date.now;
  const rpcEffect = <A>(
    phase: RewardGasTopupCoordinatorFailed["phase"],
    reason: RewardGasTopupCoordinatorFailed["reason"],
    operation: () => Promise<A>,
  ) => Effect.tryPromise({ try: operation, catch: () => failed(reason, phase) });
  const attempt = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: () => null }).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );

  const attest = Effect.fn("RewardGasTopupCoordinator.attest")(function* (
    candidate: RewardGasTopupCandidate,
  ) {
    if (candidate.chainId !== BASE_SEPOLIA_CHAIN_ID) {
      return yield* failed("production_disabled", "configuration");
    }
    if (!sameAddress(input.signer.address, candidate.signerAddress)) {
      return yield* failed("signer_mismatch", "configuration");
    }
  });

  const gasFor = (estimate: bigint) =>
    (estimate * BigInt(input.gasLimitMultiplierBps) + 9_999n) / 10_000n;

  const requireReconciliation = Effect.fn("RewardGasTopupCoordinator.requireReconciliation")(
    function* (effect: RewardGasTopupPreparedEffect, reason: string) {
      const transactionHash = effect.transactionHash ?? effect.signedTransactionHash;
      yield* input.store.requireReconciliation({
        effectId: effect.effectId,
        transactionHash,
        reason,
      });
      return {
        kind: "reconciliation_required",
        effectId: effect.effectId,
        transactionHash,
      } as const;
    },
  );

  const reconcilePrepared = Effect.fn("RewardGasTopupCoordinator.reconcilePrepared")(function* (
    effect: RewardGasTopupPreparedEffect,
  ) {
    const transactionHash = effect.transactionHash ?? effect.signedTransactionHash;
    const receiptAttempt = yield* attempt(() => input.rpc.readReceipt(transactionHash));
    if (!receiptAttempt.ok || receiptAttempt.value === null) {
      return effect.state === "reconciliation_required"
        ? ({ kind: "reconciliation_required", effectId: effect.effectId, transactionHash } as const)
        : ({ kind: "submitted", effectId: effect.effectId, transactionHash } as const);
    }
    const receipt = receiptAttempt.value;
    if (
      receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      !sameAddress(receipt.from, effect.signerAddress) ||
      !sameAddress(receipt.to, effect.recipientAddress)
    ) {
      return yield* requireReconciliation(effect, "gas_topup_receipt_identity_mismatch");
    }
    const chain = yield* attempt(() =>
      Promise.all([input.rpc.readBlock(receipt.blockNumber), input.rpc.readHead()]),
    );
    if (!chain.ok) return yield* requireReconciliation(effect, "gas_topup_block_unavailable");
    const [receiptBlock, head] = chain.value;
    if (
      receiptBlock.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      head.blockNumber < receipt.blockNumber
    ) {
      return yield* requireReconciliation(effect, "gas_topup_receipt_reorg");
    }
    const confirmationsBig = head.blockNumber - receipt.blockNumber + 1n;
    if (confirmationsBig < BigInt(input.requiredConfirmations)) {
      return { kind: "submitted", effectId: effect.effectId, transactionHash } as const;
    }
    if (confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return yield* requireReconciliation(effect, "gas_topup_confirmation_overflow");
    }
    const receiptHash = yield* sha256Hex(toBytes(canonicalReceipt(receipt)));
    const settlement = {
      effectId: effect.effectId,
      transactionHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase(),
      receiptHash,
      confirmations: Number(confirmationsBig),
      confirmedAt: new Date(now()).toISOString(),
    };
    if (receipt.status !== "success") {
      // A confirmed revert is terminal: the top-up is released and its budget returned.
      yield* input.store.recordReverted(settlement);
      return { kind: "reverted", effectId: effect.effectId, transactionHash } as const;
    }
    yield* input.store.confirm(settlement);
    return {
      kind: "confirmed",
      effectId: effect.effectId,
      topupId: effect.topupId,
      transactionHash,
    } as const;
  });

  const submitPrepared = Effect.fn("RewardGasTopupCoordinator.submitPrepared")(function* (
    effect: RewardGasTopupPreparedEffect,
  ) {
    if (effect.state !== "prepared") return yield* reconcilePrepared(effect);
    yield* attest(effect);
    if (!signedTransferMatches(effect)) {
      return yield* failed("receipt_evidence_invalid", "prepare");
    }
    const submission = yield* attempt(() =>
      input.rpc.sendRawTransaction(effect.signedTransaction as Hex),
    );
    const uncertain =
      !submission.ok ||
      submission.value.toLowerCase() !== effect.signedTransactionHash.toLowerCase();
    const failureReason = !submission.ok
      ? "broadcast_outcome_unknown"
      : uncertain
        ? "provider_transaction_hash_mismatch"
        : null;
    yield* input.store.recordSubmission({
      effectId: effect.effectId,
      transactionHash: effect.signedTransactionHash,
      submittedAt: new Date(now()).toISOString(),
      outcome: uncertain ? "uncertain" : "accepted",
      ...(failureReason === null ? {} : { failureReason }),
    });
    if (uncertain) {
      return {
        kind: "reconciliation_required",
        effectId: effect.effectId,
        transactionHash: effect.signedTransactionHash,
      } as const;
    }
    return yield* reconcilePrepared({
      ...effect,
      state: "broadcast_pending",
      transactionHash: effect.signedTransactionHash,
    });
  });

  const prepareReserved = Effect.fn("RewardGasTopupCoordinator.prepareReserved")(function* (
    reservation: RewardGasTopupReservedEffect,
  ) {
    yield* attest(reservation);
    const [gasEstimate, feeQuote, walletBalance] = yield* rpcEffect(
      "preflight",
      "preflight_unavailable",
      () =>
        Promise.all([
          input.rpc.estimateGas({
            from: reservation.signerAddress,
            to: reservation.recipientAddress,
            data: EMPTY_CALLDATA,
            value: reservation.amountWei,
          }),
          input.rpc.readFeeQuote(),
          input.rpc.readNativeBalance(reservation.signerAddress),
        ]),
    );
    const gas = gasFor(gasEstimate);
    if (
      walletBalance <
      reservation.amountWei + gas * feeQuote.maxFeePerGas + input.nativeGasReserveFloorWei
    ) {
      return yield* failed("gas_floor_insufficient", "preflight");
    }
    const signed = yield* rpcEffect("prepare", "signer_mismatch", () =>
      input.signer.sign({
        chainId: reservation.chainId,
        signerAddress: reservation.signerAddress,
        targetAddress: reservation.recipientAddress,
        nonce: reservation.nonce,
        data: EMPTY_CALLDATA,
        valueWei: reservation.amountWei,
        gas,
        maxFeePerGas: feeQuote.maxFeePerGas,
        maxPriorityFeePerGas: feeQuote.maxPriorityFeePerGas,
      }),
    );
    yield* input.store.prepare({
      reservation,
      calldataHash: EMPTY_CALLDATA_SHA256,
      signedTransaction: signed.signedTransaction,
      signedTransactionHash: signed.signedTransactionHash,
      preparedAt: new Date(now()).toISOString(),
    });
    return yield* submitPrepared({
      ...reservation,
      state: "prepared",
      signedTransaction: signed.signedTransaction,
      signedTransactionHash: signed.signedTransactionHash,
      transactionHash: null,
    });
  });

  const resume = Effect.fn("RewardGasTopupCoordinator.resume")(function* (
    progress: RewardGasTopupProgress,
  ) {
    if (progress.state === "confirmed") {
      return {
        kind: "confirmed",
        effectId: progress.effectId,
        topupId: progress.topupId,
        transactionHash: progress.transactionHash,
      } as const;
    }
    if (progress.state === "released") {
      return { kind: "released", topupId: progress.topupId, reason: "effect_terminal" } as const;
    }
    if (progress.state === "nonce_reserved") return yield* prepareReserved(progress.reservation);
    return yield* submitPrepared(progress);
  });

  const send = Effect.fn("RewardGasTopupCoordinator.send")(function* (topupId: string) {
    const effectId = deriveRewardGasTopupEffectId(topupId);
    const existing = yield* input.store.findProgress(effectId);
    if (existing !== null) return yield* resume(existing);
    const loaded = yield* input.store.loadCandidate(topupId);
    const { payoutRecipientConfirmed, ...candidate } = loaded;
    yield* attest(candidate);
    // Guard: the recipient must still be the credit's confirmed payout wallet.
    if (!payoutRecipientConfirmed) {
      yield* input.store.releaseUnsent({ topupId, reason: "recipient_changed" });
      return { kind: "released", topupId, reason: "recipient_changed" } as const;
    }
    const feeQuote = yield* rpcEffect("preflight", "preflight_unavailable", () =>
      input.rpc.readFeeQuote(),
    );
    const [block, recipientBalance, walletBalance, pendingNonce, gasEstimate] = yield* rpcEffect(
      "preflight",
      "preflight_unavailable",
      () =>
        Promise.all([
          input.rpc.readBlock(feeQuote.observedBlockNumber),
          input.rpc.readNativeBalance(candidate.recipientAddress),
          input.rpc.readNativeBalance(candidate.signerAddress),
          input.rpc.readPendingNonce(candidate.signerAddress),
          input.rpc.estimateGas({
            from: candidate.signerAddress,
            to: candidate.recipientAddress,
            data: EMPTY_CALLDATA,
            value: candidate.amountWei,
          }),
        ]),
    );
    if (block.blockHash.toLowerCase() !== feeQuote.observedBlockHash.toLowerCase()) {
      return yield* failed("preflight_unavailable", "preflight");
    }
    // Never overshoot the target: send at most the current shortfall, and
    // nothing when the winner was funded since the request.
    const shortfall = candidate.targetBalanceWei - recipientBalance;
    if (shortfall <= 0n) {
      yield* input.store.releaseUnsent({ topupId, reason: "recipient_funded" });
      return { kind: "released", topupId, reason: "recipient_funded" } as const;
    }
    const amountWei = shortfall < candidate.amountWei ? shortfall : candidate.amountWei;
    const gas = gasFor(gasEstimate);
    if (walletBalance < amountWei + gas * feeQuote.maxFeePerGas + input.nativeGasReserveFloorWei) {
      return yield* failed("gas_floor_insufficient", "preflight");
    }
    const reservation = yield* input.store.reserveNonce({
      candidate,
      amountWei,
      effectId,
      observedPendingNonce: pendingNonce,
      observedBlockNumber: feeQuote.observedBlockNumber,
      observedBlockHash: feeQuote.observedBlockHash.toLowerCase(),
      observedAt: new Date(now()).toISOString(),
    });
    return yield* prepareReserved(reservation);
  });

  return { send };
}
