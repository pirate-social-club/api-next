import type {
  RewardConfirmedPayout,
  RewardPayoutCandidate,
  RewardPayoutFailure,
  RewardPayoutProgress,
  RewardPayoutReservation,
  RewardPayoutStore,
  RewardPreparedPayout,
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

export class RewardPayoutCoordinatorFailed extends Data.TaggedError(
  "RewardPayoutCoordinatorFailed",
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

export type RewardPayoutCoordinatorResult =
  | Readonly<{ kind: "submitted"; effectId: string; transactionHash: string }>
  | Readonly<{ kind: "reconciliation_required"; effectId: string; transactionHash: string }>
  | Readonly<{
      kind: "confirmed";
      effectId: string;
      creditId: string;
      transactionHash: string;
      destinationAddress: string;
      amountAtomic: bigint;
      blockNumber: bigint;
      blockHash: string;
      confirmations: number;
    }>;

const failed = (
  reason: RewardPayoutCoordinatorFailed["reason"],
  phase: RewardPayoutCoordinatorFailed["phase"],
) => new RewardPayoutCoordinatorFailed({ reason, phase });

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function deployment(candidate: RewardPayoutCandidate): MegapotV2DeploymentAttestation {
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

const sha256Hex = Effect.fn("rewardPayoutSha256Hex")(function* (input: Uint8Array) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", input),
    catch: () => failed("invalid_config", "prepare"),
  });
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export function deriveRewardPayoutEffectId(creditId: string): Hex {
  if (creditId.length === 0 || creditId !== creditId.trim()) {
    throw failed("invalid_config", "configuration");
  }
  return keccak256(toBytes(`pirate.reward-payout.v1\u0000${creditId}`));
}

function confirmedResult(value: RewardConfirmedPayout): RewardPayoutCoordinatorResult {
  return {
    kind: "confirmed",
    effectId: value.effectId,
    creditId: value.creditId,
    transactionHash: value.transactionHash,
    destinationAddress: value.destinationAddress,
    amountAtomic: value.amountAtomic,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    confirmations: value.confirmations,
  };
}

export interface RewardPayoutCoordinator {
  readonly payout: (
    creditId: string,
  ) => Effect.Effect<
    RewardPayoutCoordinatorResult,
    RewardPayoutCoordinatorFailed | RewardPayoutFailure
  >;
  readonly reconcile: (
    effectId: string,
  ) => Effect.Effect<
    RewardPayoutCoordinatorResult,
    RewardPayoutCoordinatorFailed | RewardPayoutFailure
  >;
}

export function makeRewardPayoutCoordinator(input: {
  readonly store: RewardPayoutStore;
  readonly rpc: MegapotV2RpcClient;
  readonly signer: MegapotV2TransactionSigner;
  readonly requiredConfirmations: number;
  readonly gasLimitMultiplierBps: number;
  readonly nativeGasReserveFloorWei: bigint;
  readonly now?: () => number;
}): RewardPayoutCoordinator {
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
    phase: RewardPayoutCoordinatorFailed["phase"],
    reason: RewardPayoutCoordinatorFailed["reason"],
    operation: () => Promise<A>,
  ) => Effect.tryPromise({ try: operation, catch: () => failed(reason, phase) });

  const attest = Effect.fn("RewardPayoutCoordinator.attest")(function* (
    candidate: RewardPayoutCandidate,
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

  const requireReconciliation = Effect.fn("RewardPayoutCoordinator.requireReconciliation")(
    function* (payout: RewardPreparedPayout, reason: string) {
      const transactionHash = payout.transactionHash ?? payout.signedTransactionHash;
      yield* input.store.requireReconciliation({
        effectId: payout.effectId,
        transactionHash,
        reason,
      });
      return {
        kind: "reconciliation_required",
        effectId: payout.effectId,
        transactionHash,
      } as const;
    },
  );

  const reconcilePrepared = Effect.fn("RewardPayoutCoordinator.reconcilePrepared")(function* (
    payout: RewardPreparedPayout,
  ) {
    const transactionHash = payout.transactionHash ?? payout.signedTransactionHash;
    const receiptAttempt = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      input.rpc.readReceipt(transactionHash),
    ).pipe(
      Effect.map((receipt) => ({ ok: true as const, receipt })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!receiptAttempt.ok || receiptAttempt.receipt === null) {
      return payout.state === "reconciliation_required"
        ? ({ kind: "reconciliation_required", effectId: payout.effectId, transactionHash } as const)
        : ({ kind: "submitted", effectId: payout.effectId, transactionHash } as const);
    }
    const receipt = receiptAttempt.receipt;
    if (receipt.status !== "success") {
      return yield* requireReconciliation(payout, "payout_receipt_reverted");
    }
    const chain = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      Promise.all([input.rpc.readBlock(receipt.blockNumber), input.rpc.readHead()]),
    ).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!chain.ok) return yield* requireReconciliation(payout, "payout_block_unavailable");
    const [receiptBlock, head] = chain.value;
    if (
      receiptBlock.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      head.blockNumber < receipt.blockNumber
    ) {
      return yield* requireReconciliation(payout, "payout_receipt_reorg");
    }
    const confirmationsBig = head.blockNumber - receipt.blockNumber + 1n;
    if (confirmationsBig < BigInt(input.requiredConfirmations)) {
      return { kind: "submitted", effectId: payout.effectId, transactionHash } as const;
    }
    if (confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return yield* requireReconciliation(payout, "payout_confirmation_overflow");
    }
    let evidence: ReturnType<typeof validateMegapotUsdcTransferReceipt>;
    try {
      evidence = validateMegapotUsdcTransferReceipt({
        deployment: deployment(payout),
        receipt,
        recipient: payout.destinationAddress,
        amountAtomic: payout.amountAtomic,
      });
    } catch {
      return yield* requireReconciliation(payout, "payout_receipt_evidence_invalid");
    }
    const custodyBalanceAfterAtomic = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      input.rpc.readUsdcBalance(payout.custodyAddress, receipt.blockNumber),
    );
    const receiptHash = yield* sha256Hex(toBytes(canonicalReceipt(receipt)));
    const confirmations = Number(confirmationsBig);
    yield* input.store.confirm({
      effectId: payout.effectId,
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
      effectId: payout.effectId,
      creditId: payout.creditId,
      transactionHash,
      destinationAddress: payout.destinationAddress,
      amountAtomic: evidence.amountAtomic,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      confirmations,
    } as const;
  });

  const submitPrepared = Effect.fn("RewardPayoutCoordinator.submitPrepared")(function* (
    payout: RewardPreparedPayout,
  ) {
    if (payout.state !== "prepared") return yield* reconcilePrepared(payout);
    yield* attest(payout);
    const calldata = encodeMegapotUsdcTransfer(payout.destinationAddress, payout.amountAtomic);
    const calldataHash = yield* sha256Hex(hexToBytes(calldata));
    if (
      calldata !== payout.calldata ||
      calldataHash !== payout.calldataHash ||
      keccak256(payout.signedTransaction as Hex) !== payout.signedTransactionHash
    ) {
      return yield* failed("receipt_evidence_invalid", "prepare");
    }
    const submission = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      input.rpc.sendRawTransaction(payout.signedTransaction as Hex),
    ).pipe(
      Effect.map((hash) => ({ kind: "accepted" as const, hash })),
      Effect.catch(() => Effect.succeed({ kind: "uncertain" as const })),
    );
    const uncertain =
      submission.kind === "uncertain" ||
      submission.hash.toLowerCase() !== payout.signedTransactionHash.toLowerCase();
    const failureReason =
      submission.kind === "uncertain"
        ? "broadcast_outcome_unknown"
        : uncertain
          ? "provider_transaction_hash_mismatch"
          : null;
    yield* input.store.recordSubmission({
      effectId: payout.effectId,
      transactionHash: payout.signedTransactionHash,
      submittedAt: new Date(now()).toISOString(),
      outcome: uncertain ? "uncertain" : "accepted",
      ...(failureReason === null ? {} : { failureReason }),
    });
    if (uncertain) {
      return {
        kind: "reconciliation_required",
        effectId: payout.effectId,
        transactionHash: payout.signedTransactionHash,
      } as const;
    }
    return yield* reconcilePrepared({
      ...payout,
      state: "broadcast_pending",
      transactionHash: payout.signedTransactionHash,
    });
  });

  const prepareReserved = Effect.fn("RewardPayoutCoordinator.prepareReserved")(function* (
    reservation: RewardPayoutReservation,
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

  const resume = Effect.fn("RewardPayoutCoordinator.resume")(function* (
    progress: RewardPayoutProgress,
  ) {
    if (progress.state === "confirmed") return confirmedResult(progress);
    if (progress.state === "nonce_reserved") return yield* prepareReserved(progress.reservation);
    return yield* submitPrepared(progress);
  });

  const reconcile = Effect.fn("RewardPayoutCoordinator.reconcile")(function* (effectId: string) {
    const progress = yield* input.store.findProgress(effectId);
    if (progress === null) return yield* failed("invalid_config", "configuration");
    return yield* resume(progress);
  });

  const payout = Effect.fn("RewardPayoutCoordinator.payout")(function* (creditId: string) {
    const effectId = deriveRewardPayoutEffectId(creditId);
    const existing = yield* input.store.findProgress(effectId);
    if (existing !== null) return yield* resume(existing);
    const candidate = yield* input.store.loadCandidate(creditId);
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

  return { payout, reconcile };
}
