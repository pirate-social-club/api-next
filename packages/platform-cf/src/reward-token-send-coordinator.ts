import type {
  RewardConfirmedPayout,
  RewardOperationsPaused,
  RewardPayoutCandidate,
  RewardPayoutStore,
  RewardRunAuthorityUnavailable,
} from "@pirate/application";
import { Effect } from "effect";
import { type Hex, hexToBytes, keccak256, toBytes } from "viem";
import {
  encodeMegapotUsdcTransfer,
  type MegapotTransactionReceipt,
  type MegapotV2DeploymentAttestation,
  validateMegapotUsdcTransferReceipt,
} from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";
import { preparedTransactionLanded, type RewardRunAuthority } from "./reward-operations-control.ts";

type TokenSendCandidate = Omit<
  RewardPayoutCandidate,
  "creditId" | "accountId" | "payoutPersonaId" | "walletAssignmentId"
>;
type TokenSendReservation<C> = C &
  Readonly<{ effectId: string; nonce: bigint; effectVersion: number }>;
type TokenSendPrepared<C> = TokenSendReservation<C> &
  Readonly<{
    state: "prepared" | "broadcast_pending" | "confirming" | "reconciliation_required";
    calldata: string;
    calldataHash: string;
    signedTransaction: string;
    signedTransactionHash: string;
    transactionHash: string | null;
  }>;
type TokenSendConfirmed = Omit<RewardConfirmedPayout, "creditId">;
type TokenSendProgress<C, Confirmed> =
  | Readonly<{ state: "nonce_reserved"; reservation: TokenSendReservation<C> }>
  | TokenSendPrepared<C>
  | Confirmed;
type TokenSendConfirmation = Omit<TokenSendConfirmed, "state"> & Readonly<{ kind: "confirmed" }>;
type TokenSendResult<ConfirmedResult> =
  | Readonly<{
      kind: "submitted" | "reconciliation_required";
      effectId: string;
      transactionHash: string;
    }>
  | ConfirmedResult;
type RewardTokenSendFailureReason =
  | "deployment_attestation_mismatch"
  | "gas_floor_insufficient"
  | "invalid_config"
  | "production_disabled"
  | "receipt_evidence_invalid"
  | "signer_mismatch"
  | "solvency_insufficient";
type RewardTokenSendFailurePhase = "configuration" | "preflight" | "prepare" | "receipt";
interface TokenSendStore<C, Confirmed, Failure> {
  readonly loadCandidate: (id: string) => Effect.Effect<C, Failure>;
  readonly findProgress: (
    effectId: string,
  ) => Effect.Effect<TokenSendProgress<C, Confirmed> | null, Failure>;
  readonly reserveNonce: (
    input: Omit<Parameters<RewardPayoutStore["reserveNonce"]>[0], "candidate"> &
      Readonly<{ candidate: C }>,
  ) => Effect.Effect<TokenSendReservation<C>, Failure>;
  readonly prepare: (
    input: Omit<Parameters<RewardPayoutStore["prepare"]>[0], "reservation"> &
      Readonly<{ reservation: TokenSendReservation<C> }>,
  ) => Effect.Effect<void, Failure>;
  readonly recordSubmission: (
    input: Parameters<RewardPayoutStore["recordSubmission"]>[0],
  ) => Effect.Effect<void, Failure>;
  readonly requireReconciliation: (
    input: Parameters<RewardPayoutStore["requireReconciliation"]>[0],
  ) => Effect.Effect<void, Failure>;
  readonly confirm: (
    input: Parameters<RewardPayoutStore["confirm"]>[0],
  ) => Effect.Effect<void, Failure>;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function deployment(candidate: TokenSendCandidate): MegapotV2DeploymentAttestation {
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

function assetDeployment(candidate: TokenSendCandidate): MegapotV2DeploymentAttestation {
  return { ...deployment(candidate), usdcAddress: candidate.tokenAddress };
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

/** Shared transaction mechanics. Economic candidates, stores and confirmed results stay with each wrapper. */
export function makeRewardTokenSendCoordinator<
  C extends TokenSendCandidate,
  Confirmed extends TokenSendConfirmed,
  StorageFailure,
  CoordinatorFailure,
  ConfirmedResult extends TokenSendConfirmation,
>(input: {
  readonly family: "payout" | "refund";
  readonly store: TokenSendStore<C, Confirmed, StorageFailure>;
  readonly rpc: MegapotV2RpcClient;
  readonly signer: MegapotV2TransactionSigner;
  readonly authority: RewardRunAuthority;
  readonly requiredConfirmations: number;
  readonly gasLimitMultiplierBps: number;
  readonly nativeGasReserveFloorWei: bigint;
  readonly now?: () => number;
  readonly failed: (
    reason: RewardTokenSendFailureReason,
    phase: RewardTokenSendFailurePhase,
  ) => CoordinatorFailure;
  readonly deriveEffectId: (id: string) => Hex;
  readonly confirmedResult: (value: Confirmed) => ConfirmedResult;
  readonly confirmedFromReceipt: (candidate: C, result: TokenSendConfirmation) => ConfirmedResult;
}): {
  readonly send: (
    id: string,
  ) => Effect.Effect<
    TokenSendResult<ConfirmedResult>,
    StorageFailure | CoordinatorFailure | RewardOperationsPaused | RewardRunAuthorityUnavailable
  >;
  readonly reconcile: (
    effectId: string,
  ) => Effect.Effect<
    TokenSendResult<ConfirmedResult>,
    StorageFailure | CoordinatorFailure | RewardOperationsPaused | RewardRunAuthorityUnavailable
  >;
} {
  const failed = input.failed;
  const span = input.family === "payout" ? "RewardPayoutCoordinator" : "RewardRefundCoordinator";
  const sha256Hex = Effect.fn(
    input.family === "payout" ? "rewardPayoutSha256Hex" : "rewardRefundSha256Hex",
  )(function* (bytes: Uint8Array) {
    const digest = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", bytes),
      catch: () => failed("invalid_config", "prepare"),
    });
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });
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
    phase: RewardTokenSendFailurePhase,
    reason: RewardTokenSendFailureReason,
    operation: () => Promise<A>,
  ) => Effect.tryPromise({ try: operation, catch: () => failed(reason, phase) });

  const attest = Effect.fn(`${span}.attest`)(function* (candidate: C) {
    if (candidate.environment === "production" || candidate.chainId !== 84_532) {
      return yield* Effect.fail(failed("production_disabled", "configuration"));
    }
    if (!sameAddress(input.signer.address, candidate.custodyAddress)) {
      return yield* Effect.fail(failed("signer_mismatch", "configuration"));
    }
    if (
      !sameAddress(candidate.tokenAddress, candidate.usdcAddress) &&
      input.rpc.readErc20Balance === undefined
    ) {
      return yield* Effect.fail(failed("invalid_config", "configuration"));
    }
    yield* rpcEffect("preflight", "deployment_attestation_mismatch", () =>
      input.rpc.attestDeployment(),
    );
  });

  const requireReconciliation = Effect.fn(`${span}.requireReconciliation`)(function* (
    sendEffect: TokenSendPrepared<C>,
    reason: string,
  ) {
    const transactionHash = sendEffect.transactionHash ?? sendEffect.signedTransactionHash;
    yield* input.store.requireReconciliation({
      effectId: sendEffect.effectId,
      transactionHash,
      reason,
    });
    return {
      kind: "reconciliation_required",
      effectId: sendEffect.effectId,
      transactionHash,
    } as const;
  });

  const reconcilePrepared = Effect.fn(`${span}.reconcilePrepared`)(function* (
    sendEffect: TokenSendPrepared<C>,
  ) {
    const transactionHash = sendEffect.transactionHash ?? sendEffect.signedTransactionHash;
    const receiptAttempt = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      input.rpc.readReceipt(transactionHash),
    ).pipe(
      Effect.map((receipt) => ({ ok: true as const, receipt })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!receiptAttempt.ok || receiptAttempt.receipt === null) {
      return sendEffect.state === "reconciliation_required"
        ? ({
            kind: "reconciliation_required",
            effectId: sendEffect.effectId,
            transactionHash,
          } as const)
        : ({ kind: "submitted", effectId: sendEffect.effectId, transactionHash } as const);
    }
    const receipt = receiptAttempt.receipt;
    if (receipt.status !== "success") {
      return yield* requireReconciliation(sendEffect, `${input.family}_receipt_reverted`);
    }
    const chain = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      Promise.all([input.rpc.readBlock(receipt.blockNumber), input.rpc.readHead()]),
    ).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!chain.ok)
      return yield* requireReconciliation(sendEffect, `${input.family}_block_unavailable`);
    const [receiptBlock, head] = chain.value;
    if (
      receiptBlock.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      head.blockNumber < receipt.blockNumber
    ) {
      return yield* requireReconciliation(sendEffect, `${input.family}_receipt_reorg`);
    }
    const confirmationsBig = head.blockNumber - receipt.blockNumber + 1n;
    if (confirmationsBig < BigInt(input.requiredConfirmations)) {
      return { kind: "submitted", effectId: sendEffect.effectId, transactionHash } as const;
    }
    if (confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return yield* requireReconciliation(sendEffect, `${input.family}_confirmation_overflow`);
    }
    let evidence: ReturnType<typeof validateMegapotUsdcTransferReceipt>;
    try {
      evidence = validateMegapotUsdcTransferReceipt({
        deployment: assetDeployment(sendEffect),
        receipt,
        recipient: sendEffect.destinationAddress,
        amountAtomic: sendEffect.amountAtomic,
      });
    } catch {
      return yield* requireReconciliation(sendEffect, `${input.family}_receipt_evidence_invalid`);
    }
    const custodyBalanceAfterAtomic = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      input.rpc.readErc20Balance === undefined
        ? input.rpc.readUsdcBalance(sendEffect.custodyAddress, receipt.blockNumber)
        : input.rpc.readErc20Balance(
            sendEffect.tokenAddress,
            sendEffect.custodyAddress,
            receipt.blockNumber,
          ),
    );
    const receiptHash = yield* sha256Hex(toBytes(canonicalReceipt(receipt)));
    const confirmations = Number(confirmationsBig);
    yield* input.store.confirm({
      effectId: sendEffect.effectId,
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
    return input.confirmedFromReceipt(sendEffect, {
      kind: "confirmed",
      effectId: sendEffect.effectId,
      transactionHash,
      destinationAddress: sendEffect.destinationAddress,
      amountAtomic: evidence.amountAtomic,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      confirmations,
    });
  });

  const submitPrepared = Effect.fn(`${span}.submitPrepared`)(function* (
    sendEffect: TokenSendPrepared<C>,
  ) {
    if (sendEffect.state !== "prepared") return yield* reconcilePrepared(sendEffect);
    // A stored signature does not show the transaction was never sent: the send can
    // succeed and the record of it fail. If the chain already holds it, that is
    // recorded and nothing is signed or sent again. This comes before any check
    // that applies only to a fresh send.
    if (yield* preparedTransactionLanded(input.rpc, sendEffect.signedTransactionHash)) {
      yield* input.store.recordSubmission({
        effectId: sendEffect.effectId,
        transactionHash: sendEffect.signedTransactionHash,
        submittedAt: new Date(now()).toISOString(),
        outcome: "accepted",
      });
      return yield* reconcilePrepared({
        ...sendEffect,
        state: "broadcast_pending",
        transactionHash: sendEffect.signedTransactionHash,
      });
    }
    yield* attest(sendEffect);
    const calldata = encodeMegapotUsdcTransfer(
      sendEffect.destinationAddress,
      sendEffect.amountAtomic,
    );
    const calldataHash = yield* sha256Hex(hexToBytes(calldata));
    if (
      calldata !== sendEffect.calldata ||
      calldataHash !== sendEffect.calldataHash ||
      keccak256(sendEffect.signedTransaction as Hex) !== sendEffect.signedTransactionHash
    ) {
      return yield* Effect.fail(failed("receipt_evidence_invalid", "prepare"));
    }
    // Sending needs authority. It is asked outside the handling below, so a refusal
    // is never taken for a broadcast of unknown outcome.
    yield* input.authority.ensure();
    const submission = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      input.rpc.sendRawTransaction(sendEffect.signedTransaction as Hex),
    ).pipe(
      Effect.map((hash) => ({ kind: "accepted" as const, hash })),
      Effect.catch(() => Effect.succeed({ kind: "uncertain" as const })),
    );
    const uncertain =
      submission.kind === "uncertain" ||
      submission.hash.toLowerCase() !== sendEffect.signedTransactionHash.toLowerCase();
    const failureReason =
      submission.kind === "uncertain"
        ? "broadcast_outcome_unknown"
        : uncertain
          ? "provider_transaction_hash_mismatch"
          : null;
    yield* input.store.recordSubmission({
      effectId: sendEffect.effectId,
      transactionHash: sendEffect.signedTransactionHash,
      submittedAt: new Date(now()).toISOString(),
      outcome: uncertain ? "uncertain" : "accepted",
      ...(failureReason === null ? {} : { failureReason }),
    });
    if (uncertain) {
      return {
        kind: "reconciliation_required",
        effectId: sendEffect.effectId,
        transactionHash: sendEffect.signedTransactionHash,
      } as const;
    }
    return yield* reconcilePrepared({
      ...sendEffect,
      state: "broadcast_pending",
      transactionHash: sendEffect.signedTransactionHash,
    });
  });

  const prepareReserved = Effect.fn(`${span}.prepareReserved`)(function* (
    reservation: TokenSendReservation<C>,
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
            to: reservation.tokenAddress,
            data: calldata,
            value: 0n,
          }),
          input.rpc.readFeeQuote(),
          input.rpc.readNativeBalance(reservation.custodyAddress),
        ]),
    );
    const gas = (gasEstimate * BigInt(input.gasLimitMultiplierBps) + 9_999n) / 10_000n;
    if (nativeBalance < gas * feeQuote.maxFeePerGas + input.nativeGasReserveFloorWei) {
      return yield* Effect.fail(failed("gas_floor_insufficient", "preflight"));
    }
    // Signing needs authority, on a resumed reservation as much as a new one.
    yield* input.authority.ensure();
    const signed = yield* rpcEffect("prepare", "signer_mismatch", () =>
      input.signer.sign({
        chainId: reservation.chainId,
        signerAddress: reservation.custodyAddress,
        targetAddress: reservation.tokenAddress,
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

  const resume = Effect.fn(`${span}.resume`)(function* (progress: TokenSendProgress<C, Confirmed>) {
    if (progress.state === "confirmed") return input.confirmedResult(progress);
    if (progress.state === "nonce_reserved") return yield* prepareReserved(progress.reservation);
    return yield* submitPrepared(progress);
  });

  const reconcile = Effect.fn(`${span}.reconcile`)(function* (effectId: string) {
    const progress = yield* input.store.findProgress(effectId);
    if (progress === null) return yield* Effect.fail(failed("invalid_config", "configuration"));
    return yield* resume(progress);
  });

  const send = Effect.fn(`${span}.${input.family}`)(function* (economicId: string) {
    const effectId = input.deriveEffectId(economicId);
    const existing = yield* input.store.findProgress(effectId);
    if (existing !== null) return yield* resume(existing);
    const candidate = yield* input.store.loadCandidate(economicId);
    yield* attest(candidate);
    if (Date.parse(candidate.solvencyExpiresAt) <= now()) {
      return yield* Effect.fail(failed("solvency_insufficient", "preflight"));
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
          input.rpc.readErc20Balance === undefined
            ? input.rpc.readUsdcBalance(candidate.custodyAddress, feeQuote.observedBlockNumber)
            : input.rpc.readErc20Balance(
                candidate.tokenAddress,
                candidate.custodyAddress,
                feeQuote.observedBlockNumber,
              ),
          input.rpc.readPendingNonce(candidate.custodyAddress),
          input.rpc.estimateGas({
            from: candidate.custodyAddress,
            to: candidate.tokenAddress,
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
      return yield* Effect.fail(failed("solvency_insufficient", "preflight"));
    }
    const gas = (gasEstimate * BigInt(input.gasLimitMultiplierBps) + 9_999n) / 10_000n;
    if (nativeBalance < gas * feeQuote.maxFeePerGas + input.nativeGasReserveFloorWei) {
      return yield* Effect.fail(failed("gas_floor_insufficient", "preflight"));
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

  return { send, reconcile };
}
