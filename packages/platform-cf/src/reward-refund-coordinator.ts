import type {
  RewardConfirmedRefund,
  RewardPreparedRefund,
  RewardRefundCandidate,
  RewardRefundFailure,
  RewardRefundProgress,
  RewardRefundReservation,
  RewardRefundStore,
} from "@pirate/application";
import { Data, Effect } from "effect";
import { type Hex, hexToBytes, keccak256, toBytes } from "viem";
import {
  encodeMegapotUsdcTransfer,
  type MegapotTransactionReceipt,
  type MegapotV2DeploymentAttestation,
  validateMegapotUsdcTransferReceipt,
} from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";

export class RewardRefundCoordinatorFailed extends Data.TaggedError(
  "RewardRefundCoordinatorFailed",
)<{
  readonly reason:
    | "deployment_attestation_mismatch"
    | "gas_floor_insufficient"
    | "invalid_config"
    | "production_disabled"
    | "receipt_evidence_invalid"
    | "signer_mismatch"
    | "solvency_insufficient";
  readonly phase: "configuration" | "preflight" | "prepare" | "receipt";
}> {}

export type RewardRefundCoordinatorResult =
  | Readonly<{ kind: "submitted"; effectId: string; transactionHash: string }>
  | Readonly<{ kind: "reconciliation_required"; effectId: string; transactionHash: string }>
  | Readonly<{
      kind: "confirmed";
      effectId: string;
      fundingEffectId: string;
      legId: string;
      transactionHash: string;
      destinationAddress: string;
      amountAtomic: bigint;
      blockNumber: bigint;
      blockHash: string;
      confirmations: number;
    }>;

const failed = (
  reason: RewardRefundCoordinatorFailed["reason"],
  phase: RewardRefundCoordinatorFailed["phase"],
) => new RewardRefundCoordinatorFailed({ reason, phase });

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function deployment(candidate: RewardRefundCandidate): MegapotV2DeploymentAttestation {
  return {
    environment: candidate.environment,
    chainId: candidate.chainId,
    jackpotAddress: candidate.jackpotAddress,
    ticketNftAddress: candidate.ticketNftAddress,
    usdcAddress: candidate.usdcAddress,
    custodyAddress: candidate.custodyAddress,
    referrerAddress: candidate.referrerAddress,
    jackpotCodeHash: candidate.jackpotCodeHash,
    ticketNftCodeHash: candidate.ticketNftCodeHash,
    usdcCodeHash: candidate.usdcCodeHash,
    attestationId: candidate.attestationId,
  };
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

const sha256Hex = Effect.fn("rewardRefundSha256Hex")(function* (input: Uint8Array) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", input),
    catch: () => failed("invalid_config", "prepare"),
  });
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export function deriveRewardRefundEffectId(fundingEffectId: string): Hex {
  if (fundingEffectId.length === 0 || fundingEffectId !== fundingEffectId.trim()) {
    throw failed("invalid_config", "configuration");
  }
  return keccak256(toBytes(`pirate.reward-refund.v1\u0000${fundingEffectId}`));
}

function confirmedResult(value: RewardConfirmedRefund): RewardRefundCoordinatorResult {
  return {
    kind: "confirmed",
    effectId: value.effectId,
    fundingEffectId: value.fundingEffectId,
    legId: value.legId,
    transactionHash: value.transactionHash,
    destinationAddress: value.destinationAddress,
    amountAtomic: value.amountAtomic,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    confirmations: value.confirmations,
  };
}

export interface RewardRefundCoordinator {
  readonly refund: (
    fundingEffectId: string,
  ) => Effect.Effect<
    RewardRefundCoordinatorResult,
    RewardRefundCoordinatorFailed | RewardRefundFailure
  >;
  readonly reconcile: (
    effectId: string,
  ) => Effect.Effect<
    RewardRefundCoordinatorResult,
    RewardRefundCoordinatorFailed | RewardRefundFailure
  >;
}

export function makeRewardRefundCoordinator(input: {
  readonly store: RewardRefundStore;
  readonly rpc: MegapotV2RpcClient;
  readonly signer: MegapotV2TransactionSigner;
  readonly requiredConfirmations: number;
  readonly gasLimitMultiplierBps: number;
  readonly nativeGasReserveFloorWei: bigint;
  readonly now?: () => number;
}): RewardRefundCoordinator {
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
    phase: RewardRefundCoordinatorFailed["phase"],
    reason: RewardRefundCoordinatorFailed["reason"],
    operation: () => Promise<A>,
  ) => Effect.tryPromise({ try: operation, catch: () => failed(reason, phase) });

  const attest = Effect.fn("RewardRefundCoordinator.attest")(function* (
    candidate: RewardRefundCandidate,
  ) {
    if (candidate.environment === "production" || candidate.chainId !== 84_532) {
      return yield* failed("production_disabled", "configuration");
    }
    if (!sameAddress(input.signer.address, candidate.custodyAddress)) {
      return yield* failed("signer_mismatch", "configuration");
    }
    yield* rpcEffect("preflight", "deployment_attestation_mismatch", () =>
      input.rpc.attestDeployment(),
    );
  });

  const requireReconciliation = Effect.fn("RewardRefundCoordinator.requireReconciliation")(
    function* (refund: RewardPreparedRefund, reason: string) {
      const transactionHash = refund.transactionHash ?? refund.signedTransactionHash;
      yield* input.store.requireReconciliation({
        effectId: refund.effectId,
        transactionHash,
        reason,
      });
      return {
        kind: "reconciliation_required",
        effectId: refund.effectId,
        transactionHash,
      } as const;
    },
  );

  const reconcilePrepared = Effect.fn("RewardRefundCoordinator.reconcilePrepared")(function* (
    refund: RewardPreparedRefund,
  ) {
    const transactionHash = refund.transactionHash ?? refund.signedTransactionHash;
    const receiptAttempt = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      input.rpc.readReceipt(transactionHash),
    ).pipe(
      Effect.map((receipt) => ({ ok: true as const, receipt })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!receiptAttempt.ok || receiptAttempt.receipt === null) {
      return refund.state === "reconciliation_required"
        ? ({ kind: "reconciliation_required", effectId: refund.effectId, transactionHash } as const)
        : ({ kind: "submitted", effectId: refund.effectId, transactionHash } as const);
    }
    const receipt = receiptAttempt.receipt;
    if (receipt.status !== "success") {
      return yield* requireReconciliation(refund, "refund_receipt_reverted");
    }
    const chain = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      Promise.all([input.rpc.readBlock(receipt.blockNumber), input.rpc.readHead()]),
    ).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!chain.ok) return yield* requireReconciliation(refund, "refund_block_unavailable");
    const [receiptBlock, head] = chain.value;
    if (
      receiptBlock.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      head.blockNumber < receipt.blockNumber
    ) {
      return yield* requireReconciliation(refund, "refund_receipt_reorg");
    }
    const confirmationsBig = head.blockNumber - receipt.blockNumber + 1n;
    if (confirmationsBig < BigInt(input.requiredConfirmations)) {
      return { kind: "submitted", effectId: refund.effectId, transactionHash } as const;
    }
    if (confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return yield* requireReconciliation(refund, "refund_confirmation_overflow");
    }
    let evidence: ReturnType<typeof validateMegapotUsdcTransferReceipt>;
    try {
      evidence = validateMegapotUsdcTransferReceipt({
        deployment: deployment(refund),
        receipt,
        recipient: refund.destinationAddress,
        amountAtomic: refund.amountAtomic,
      });
    } catch {
      return yield* requireReconciliation(refund, "refund_receipt_evidence_invalid");
    }
    const custodyBalanceAfterAtomic = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      input.rpc.readUsdcBalance(refund.custodyAddress, receipt.blockNumber),
    );
    const receiptHash = yield* sha256Hex(toBytes(canonicalReceipt(receipt)));
    const confirmations = Number(confirmationsBig);
    yield* input.store.confirm({
      effectId: refund.effectId,
      transactionHash,
      transferLogIndex: evidence.transferLogIndex,
      amountAtomic: evidence.amountAtomic,
      custodyBalanceAfterAtomic,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      receiptHash,
      confirmations,
      confirmedAt: new Date(now()).toISOString(),
    });
    return {
      kind: "confirmed",
      effectId: refund.effectId,
      fundingEffectId: refund.fundingEffectId,
      legId: refund.legId,
      transactionHash,
      destinationAddress: refund.destinationAddress,
      amountAtomic: evidence.amountAtomic,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      confirmations,
    } as const;
  });

  const submitPrepared = Effect.fn("RewardRefundCoordinator.submitPrepared")(function* (
    refund: RewardPreparedRefund,
  ) {
    if (refund.state !== "prepared") return yield* reconcilePrepared(refund);
    yield* attest(refund);
    const calldata = encodeMegapotUsdcTransfer(refund.destinationAddress, refund.amountAtomic);
    const calldataHash = yield* sha256Hex(hexToBytes(calldata));
    if (
      calldata !== refund.calldata ||
      calldataHash !== refund.calldataHash ||
      keccak256(refund.signedTransaction as Hex) !== refund.signedTransactionHash
    ) {
      return yield* failed("receipt_evidence_invalid", "prepare");
    }
    const submission = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      input.rpc.sendRawTransaction(refund.signedTransaction as Hex),
    ).pipe(
      Effect.map((hash) => ({ kind: "accepted" as const, hash })),
      Effect.catch(() => Effect.succeed({ kind: "uncertain" as const })),
    );
    const uncertain =
      submission.kind === "uncertain" ||
      submission.hash.toLowerCase() !== refund.signedTransactionHash.toLowerCase();
    const failureReason =
      submission.kind === "uncertain"
        ? "broadcast_outcome_unknown"
        : uncertain
          ? "provider_transaction_hash_mismatch"
          : null;
    yield* input.store.recordSubmission({
      effectId: refund.effectId,
      transactionHash: refund.signedTransactionHash,
      submittedAt: new Date(now()).toISOString(),
      outcome: uncertain ? "uncertain" : "accepted",
      ...(failureReason === null ? {} : { failureReason }),
    });
    if (uncertain) {
      return {
        kind: "reconciliation_required",
        effectId: refund.effectId,
        transactionHash: refund.signedTransactionHash,
      } as const;
    }
    return yield* reconcilePrepared({
      ...refund,
      state: "broadcast_pending",
      transactionHash: refund.signedTransactionHash,
    });
  });

  const prepareReserved = Effect.fn("RewardRefundCoordinator.prepareReserved")(function* (
    reservation: RewardRefundReservation,
  ) {
    yield* attest(reservation);
    const calldata = encodeMegapotUsdcTransfer(
      reservation.destinationAddress,
      reservation.amountAtomic,
    );
    const [gasEstimate, feeQuote, nativeBalance] = yield* rpcEffect(
      "preflight",
      "gas_floor_insufficient",
      () =>
        Promise.all([
          input.rpc.estimateGas({
            from: reservation.custodyAddress,
            to: reservation.usdcAddress,
            data: calldata,
            value: 0n,
          }),
          input.rpc.readFeeQuote(),
          input.rpc.readNativeBalance(reservation.custodyAddress),
        ]),
    );
    const gas = (gasEstimate * BigInt(input.gasLimitMultiplierBps) + 9_999n) / 10_000n;
    if (nativeBalance < gas * feeQuote.maxFeePerGas + input.nativeGasReserveFloorWei) {
      return yield* failed("gas_floor_insufficient", "preflight");
    }
    const signed = yield* rpcEffect("prepare", "signer_mismatch", () =>
      input.signer.sign({
        chainId: reservation.chainId,
        signerAddress: reservation.custodyAddress,
        targetAddress: reservation.usdcAddress,
        nonce: reservation.nonce,
        data: calldata,
        valueWei: 0n,
        gas,
        maxFeePerGas: feeQuote.maxFeePerGas,
        maxPriorityFeePerGas: feeQuote.maxPriorityFeePerGas,
      }),
    );
    const calldataHash = yield* sha256Hex(hexToBytes(calldata));
    yield* input.store.prepare({
      reservation,
      calldata,
      calldataHash,
      signedTransaction: signed.signedTransaction,
      signedTransactionHash: signed.signedTransactionHash,
      preparedAt: new Date(now()).toISOString(),
    });
    return yield* submitPrepared({
      ...reservation,
      state: "prepared",
      calldata,
      calldataHash,
      signedTransaction: signed.signedTransaction,
      signedTransactionHash: signed.signedTransactionHash,
      transactionHash: null,
    });
  });

  const resume = Effect.fn("RewardRefundCoordinator.resume")(function* (
    progress: RewardRefundProgress,
  ) {
    if (progress.state === "confirmed") return confirmedResult(progress);
    if (progress.state === "nonce_reserved") return yield* prepareReserved(progress.reservation);
    return yield* submitPrepared(progress);
  });

  const reconcile = Effect.fn("RewardRefundCoordinator.reconcile")(function* (effectId: string) {
    const progress = yield* input.store.findProgress(effectId);
    if (progress === null) return yield* failed("invalid_config", "configuration");
    return yield* resume(progress);
  });

  const refund = Effect.fn("RewardRefundCoordinator.refund")(function* (fundingEffectId: string) {
    const effectId = deriveRewardRefundEffectId(fundingEffectId);
    const existing = yield* input.store.findProgress(effectId);
    if (existing !== null) return yield* resume(existing);
    const candidate = yield* input.store.loadCandidate(fundingEffectId);
    yield* attest(candidate);
    if (Date.parse(candidate.solvencyExpiresAt) <= now()) {
      return yield* failed("solvency_insufficient", "preflight");
    }
    const calldata = encodeMegapotUsdcTransfer(
      candidate.destinationAddress,
      candidate.amountAtomic,
    );
    const feeQuote = yield* rpcEffect("preflight", "solvency_insufficient", () =>
      input.rpc.readFeeQuote(),
    );
    const [block, custodyBalance, pendingNonce, gasEstimate, nativeBalance] = yield* rpcEffect(
      "preflight",
      "solvency_insufficient",
      () =>
        Promise.all([
          input.rpc.readBlock(feeQuote.observedBlockNumber),
          input.rpc.readUsdcBalance(candidate.custodyAddress, feeQuote.observedBlockNumber),
          input.rpc.readPendingNonce(candidate.custodyAddress),
          input.rpc.estimateGas({
            from: candidate.custodyAddress,
            to: candidate.usdcAddress,
            data: calldata,
            value: 0n,
          }),
          input.rpc.readNativeBalance(candidate.custodyAddress),
        ]),
    );
    if (
      block.blockHash.toLowerCase() !== feeQuote.observedBlockHash.toLowerCase() ||
      custodyBalance < candidate.custodyBalanceBeforeAtomic ||
      custodyBalance < candidate.amountAtomic
    ) {
      return yield* failed("solvency_insufficient", "preflight");
    }
    const gas = (gasEstimate * BigInt(input.gasLimitMultiplierBps) + 9_999n) / 10_000n;
    if (nativeBalance < gas * feeQuote.maxFeePerGas + input.nativeGasReserveFloorWei) {
      return yield* failed("gas_floor_insufficient", "preflight");
    }
    const reservation = yield* input.store.reserveNonce({
      candidate,
      effectId,
      observedPendingNonce: pendingNonce,
      observedBlockNumber: feeQuote.observedBlockNumber,
      observedBlockHash: feeQuote.observedBlockHash,
      observedAt: new Date(now()).toISOString(),
    });
    return yield* prepareReserved(reservation);
  });

  return { refund, reconcile };
}
