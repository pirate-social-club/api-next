import type {
  MegapotClaimCandidate,
  MegapotClaimFailure,
  MegapotClaimProgress,
  MegapotClaimStore,
  MegapotConfirmedClaim,
  MegapotPreparedClaim,
  MegapotReservedClaim,
} from "@pirate/application";
import { Data, Effect } from "effect";
import { type Hex, hexToBytes, keccak256, toBytes } from "viem";
import {
  encodeMegapotClaimWinnings,
  type MegapotTransactionReceipt,
  type MegapotV2DeploymentAttestation,
  validateMegapotClaimReceipt,
} from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";

export class MegapotClaimCoordinatorFailed extends Data.TaggedError(
  "MegapotClaimCoordinatorFailed",
)<{
  readonly reason:
    | "deployment_attestation_mismatch"
    | "drawing_not_settled"
    | "gas_floor_insufficient"
    | "invalid_config"
    | "production_disabled"
    | "receipt_evidence_invalid"
    | "signer_mismatch"
    | "ticket_owner_mismatch";
  readonly phase: "configuration" | "preflight" | "prepare" | "receipt";
}> {}

export type MegapotClaimCoordinatorResult =
  | Readonly<{ kind: "submitted"; effectId: string; transactionHash: string }>
  | Readonly<{ kind: "reconciliation_required"; effectId: string; transactionHash: string }>
  | Readonly<{
      kind: "confirmed";
      effectId: string;
      transactionHash: string;
      ticketId: bigint;
      grossWinningsAtomic: bigint;
      referralAccrualAtomic: bigint;
      netWinningsAtomic: bigint;
      blockNumber: bigint;
      blockHash: string;
      confirmations: number;
    }>;

export interface MegapotClaimCoordinator {
  readonly claim: (input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) => Effect.Effect<
    MegapotClaimCoordinatorResult,
    MegapotClaimCoordinatorFailed | MegapotClaimFailure
  >;
  readonly reconcile: (
    effectId: string,
  ) => Effect.Effect<
    MegapotClaimCoordinatorResult,
    MegapotClaimCoordinatorFailed | MegapotClaimFailure
  >;
}

const failed = (
  reason: MegapotClaimCoordinatorFailed["reason"],
  phase: MegapotClaimCoordinatorFailed["phase"],
) => new MegapotClaimCoordinatorFailed({ reason, phase });

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function deployment(candidate: MegapotClaimCandidate): MegapotV2DeploymentAttestation {
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

const sha256Hex = Effect.fn("megapotClaimSha256Hex")(function* (input: Uint8Array) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", input),
    catch: () => failed("invalid_config", "prepare"),
  });
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export function deriveMegapotClaimEffectId(poolLegId: string, drawingId: bigint): Hex {
  if (poolLegId.length === 0 || poolLegId !== poolLegId.trim() || drawingId < 0n) {
    throw failed("invalid_config", "configuration");
  }
  return keccak256(toBytes(`pirate.megapot.winnings-claim.v1\u0000${poolLegId}\u0000${drawingId}`));
}

function confirmedResult(value: MegapotConfirmedClaim): MegapotClaimCoordinatorResult {
  return {
    kind: "confirmed",
    effectId: value.effectId,
    transactionHash: value.transactionHash,
    ticketId: value.ticketId,
    grossWinningsAtomic: value.grossWinningsAtomic,
    referralAccrualAtomic: value.referralAccrualAtomic,
    netWinningsAtomic: value.netWinningsAtomic,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    confirmations: value.confirmations,
  };
}

export function makeMegapotClaimCoordinator(input: {
  readonly store: MegapotClaimStore;
  readonly rpc: MegapotV2RpcClient;
  readonly signer: MegapotV2TransactionSigner;
  readonly requiredConfirmations: number;
  readonly gasLimitMultiplierBps: number;
  readonly nativeGasReserveFloorWei: bigint;
  readonly now?: () => number;
}): MegapotClaimCoordinator {
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
    phase: MegapotClaimCoordinatorFailed["phase"],
    reason: MegapotClaimCoordinatorFailed["reason"],
    operation: () => Promise<A>,
  ) => Effect.tryPromise({ try: operation, catch: () => failed(reason, phase) });

  const attest = Effect.fn("MegapotClaimCoordinator.attest")(function* (
    candidate: MegapotClaimCandidate,
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

  const requireReconciliation = Effect.fn("MegapotClaimCoordinator.requireReconciliation")(
    function* (claim: MegapotPreparedClaim, reason: string) {
      const transactionHash = claim.transactionHash ?? claim.signedTransactionHash;
      yield* input.store.requireReconciliation({
        effectId: claim.effectId,
        transactionHash,
        reason,
      });
      return {
        kind: "reconciliation_required",
        effectId: claim.effectId,
        transactionHash,
      } as const;
    },
  );

  const reconcilePrepared = Effect.fn("MegapotClaimCoordinator.reconcilePrepared")(function* (
    claim: MegapotPreparedClaim,
  ) {
    const transactionHash = claim.transactionHash ?? claim.signedTransactionHash;
    const receiptAttempt = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      input.rpc.readReceipt(transactionHash),
    ).pipe(
      Effect.map((receipt) => ({ ok: true as const, receipt })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!receiptAttempt.ok || receiptAttempt.receipt === null) {
      return claim.state === "reconciliation_required"
        ? ({ kind: "reconciliation_required", effectId: claim.effectId, transactionHash } as const)
        : ({ kind: "submitted", effectId: claim.effectId, transactionHash } as const);
    }
    const receipt = receiptAttempt.receipt;
    if (receipt.status !== "success") {
      return yield* requireReconciliation(claim, "claim_receipt_reverted");
    }
    const chain = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      Promise.all([input.rpc.readBlock(receipt.blockNumber), input.rpc.readHead()]),
    ).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!chain.ok) return yield* requireReconciliation(claim, "claim_block_unavailable");
    const [receiptBlock, head] = chain.value;
    if (
      receiptBlock.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      head.blockNumber < receipt.blockNumber
    ) {
      return yield* requireReconciliation(claim, "claim_receipt_reorg");
    }
    const confirmationsBig = head.blockNumber - receipt.blockNumber + 1n;
    if (confirmationsBig < BigInt(input.requiredConfirmations)) {
      return { kind: "submitted", effectId: claim.effectId, transactionHash } as const;
    }
    if (confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return yield* requireReconciliation(claim, "claim_confirmation_overflow");
    }
    let evidence: ReturnType<typeof validateMegapotClaimReceipt>;
    try {
      evidence = validateMegapotClaimReceipt({
        deployment: deployment(claim),
        receipt,
        drawingId: claim.drawingId,
        ticketIds: [claim.ticketId],
        expectedGrossWinningsAtomic: claim.expectedGrossWinningsAtomic,
        expectedNetWinningsAtomic: claim.expectedNetWinningsAtomic,
        expectedReferralAccrualAtomic: claim.expectedReferralAccrualAtomic,
      });
    } catch {
      return yield* requireReconciliation(claim, "claim_receipt_evidence_invalid");
    }
    const [custodyBalanceAfterAtomic, referralBalanceAfterAtomic] = yield* rpcEffect(
      "receipt",
      "receipt_evidence_invalid",
      () =>
        Promise.all([
          input.rpc.readUsdcBalance(claim.custodyAddress, receipt.blockNumber),
          input.rpc.readReferralFees(claim.referrerAddress, receipt.blockNumber),
        ]),
    );
    if (
      custodyBalanceAfterAtomic !==
        claim.custodyBalanceBeforeAtomic + claim.expectedNetWinningsAtomic ||
      referralBalanceAfterAtomic !==
        claim.referralBalanceBeforeAtomic + claim.expectedReferralAccrualAtomic
    ) {
      return yield* requireReconciliation(claim, "claim_balance_delta_mismatch");
    }
    const claimLogIndex = evidence.claimLogIndices[0];
    const burnLogIndex = evidence.burnLogIndices[0];
    const referralLogIndex = evidence.referralLogIndices[0];
    if (
      claimLogIndex === undefined ||
      burnLogIndex === undefined ||
      referralLogIndex === undefined
    ) {
      return yield* requireReconciliation(claim, "claim_receipt_evidence_incomplete");
    }
    const receiptHash = yield* sha256Hex(toBytes(canonicalReceipt(receipt)));
    const confirmations = Number(confirmationsBig);
    yield* input.store.confirm({
      effectId: claim.effectId,
      transactionHash,
      claimLogIndex,
      burnLogIndex,
      referralLogIndex,
      transferLogIndex: evidence.transferLogIndex,
      grossWinningsAtomic: evidence.grossWinningsAtomic,
      referralAccrualAtomic: evidence.referralAccrualAtomic,
      netWinningsAtomic: evidence.netWinningsAtomic,
      custodyBalanceAfterAtomic,
      referralBalanceAfterAtomic,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      receiptHash,
      confirmations,
      confirmedAt: new Date(now()).toISOString(),
    });
    return {
      kind: "confirmed",
      effectId: claim.effectId,
      transactionHash,
      ticketId: claim.ticketId,
      grossWinningsAtomic: evidence.grossWinningsAtomic,
      referralAccrualAtomic: evidence.referralAccrualAtomic,
      netWinningsAtomic: evidence.netWinningsAtomic,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      confirmations,
    } as const;
  });

  const submitPrepared = Effect.fn("MegapotClaimCoordinator.submitPrepared")(function* (
    claim: MegapotPreparedClaim,
  ) {
    if (claim.state !== "prepared") return yield* reconcilePrepared(claim);
    yield* attest(claim);
    const calldata = encodeMegapotClaimWinnings([claim.ticketId]);
    const calldataHash = yield* sha256Hex(hexToBytes(calldata));
    if (
      calldata !== claim.calldata ||
      calldataHash !== claim.calldataHash ||
      keccak256(claim.signedTransaction as Hex) !== claim.signedTransactionHash
    ) {
      return yield* failed("receipt_evidence_invalid", "prepare");
    }
    const submission = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      input.rpc.sendRawTransaction(claim.signedTransaction as Hex),
    ).pipe(
      Effect.map((hash) => ({ kind: "accepted" as const, hash })),
      Effect.catch(() => Effect.succeed({ kind: "uncertain" as const })),
    );
    if (
      submission.kind === "uncertain" ||
      submission.hash.toLowerCase() !== claim.signedTransactionHash.toLowerCase()
    ) {
      yield* input.store.recordSubmission({
        effectId: claim.effectId,
        transactionHash: claim.signedTransactionHash,
        submittedAt: new Date(now()).toISOString(),
        outcome: "uncertain",
        failureReason:
          submission.kind === "uncertain"
            ? "broadcast_outcome_unknown"
            : "provider_transaction_hash_mismatch",
      });
      return {
        kind: "reconciliation_required",
        effectId: claim.effectId,
        transactionHash: claim.signedTransactionHash,
      } as const;
    }
    yield* input.store.recordSubmission({
      effectId: claim.effectId,
      transactionHash: claim.signedTransactionHash,
      submittedAt: new Date(now()).toISOString(),
      outcome: "accepted",
    });
    return yield* reconcilePrepared({
      ...claim,
      state: "broadcast_pending",
      transactionHash: claim.signedTransactionHash,
    });
  });

  const prepareReserved = Effect.fn("MegapotClaimCoordinator.prepareReserved")(function* (
    reservation: MegapotReservedClaim,
  ) {
    yield* attest(reservation);
    const [currentDrawingId, owner] = yield* rpcEffect("preflight", "drawing_not_settled", () =>
      Promise.all([
        input.rpc.readCurrentDrawingId(reservation.preflightBlockNumber),
        input.rpc.readTicketOwner(reservation.ticketId, reservation.preflightBlockNumber),
      ]),
    );
    if (currentDrawingId <= reservation.drawingId) {
      return yield* failed("drawing_not_settled", "preflight");
    }
    if (!sameAddress(owner, reservation.custodyAddress)) {
      return yield* failed("ticket_owner_mismatch", "preflight");
    }
    const calldata = encodeMegapotClaimWinnings([reservation.ticketId]);
    const [gasEstimate, feeQuote, nativeBalance] = yield* rpcEffect(
      "preflight",
      "gas_floor_insufficient",
      () =>
        Promise.all([
          input.rpc.estimateGas({
            from: reservation.custodyAddress,
            to: reservation.jackpotAddress,
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
        targetAddress: reservation.jackpotAddress,
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

  const resume = Effect.fn("MegapotClaimCoordinator.resume")(function* (
    progress: MegapotClaimProgress,
  ) {
    if (progress.state === "confirmed") return confirmedResult(progress);
    if (progress.state === "nonce_reserved") return yield* prepareReserved(progress.reservation);
    return yield* submitPrepared(progress);
  });

  const reconcile = Effect.fn("MegapotClaimCoordinator.reconcile")(function* (effectId: string) {
    const progress = yield* input.store.findProgress(effectId);
    if (progress === null) return yield* failed("invalid_config", "configuration");
    return yield* resume(progress);
  });

  const claim = Effect.fn("MegapotClaimCoordinator.claim")(function* (command: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) {
    const effectId = deriveMegapotClaimEffectId(command.poolLegId, command.drawingId);
    const existing = yield* input.store.findProgress(effectId);
    if (existing !== null) return yield* resume(existing);
    const candidate = yield* input.store.loadCandidate(command);
    yield* attest(candidate);
    const calldata = encodeMegapotClaimWinnings([candidate.ticketId]);
    const feeQuote = yield* rpcEffect("preflight", "drawing_not_settled", () =>
      input.rpc.readFeeQuote(),
    );
    const [
      block,
      currentDrawingId,
      owner,
      custodyBalance,
      referralBalance,
      pendingNonce,
      gasEstimate,
      nativeBalance,
    ] = yield* rpcEffect("preflight", "drawing_not_settled", () =>
      Promise.all([
        input.rpc.readBlock(feeQuote.observedBlockNumber),
        input.rpc.readCurrentDrawingId(feeQuote.observedBlockNumber),
        input.rpc.readTicketOwner(candidate.ticketId, feeQuote.observedBlockNumber),
        input.rpc.readUsdcBalance(candidate.custodyAddress, feeQuote.observedBlockNumber),
        input.rpc.readReferralFees(candidate.referrerAddress, feeQuote.observedBlockNumber),
        input.rpc.readPendingNonce(candidate.custodyAddress),
        input.rpc.estimateGas({
          from: candidate.custodyAddress,
          to: candidate.jackpotAddress,
          data: calldata,
          value: 0n,
        }),
        input.rpc.readNativeBalance(candidate.custodyAddress),
      ]),
    );
    if (block.blockHash.toLowerCase() !== feeQuote.observedBlockHash.toLowerCase()) {
      return yield* failed("receipt_evidence_invalid", "preflight");
    }
    if (currentDrawingId <= candidate.drawingId) {
      return yield* failed("drawing_not_settled", "preflight");
    }
    if (!sameAddress(owner, candidate.custodyAddress)) {
      return yield* failed("ticket_owner_mismatch", "preflight");
    }
    const gas = (gasEstimate * BigInt(input.gasLimitMultiplierBps) + 9_999n) / 10_000n;
    if (nativeBalance < gas * feeQuote.maxFeePerGas + input.nativeGasReserveFloorWei) {
      return yield* failed("gas_floor_insufficient", "preflight");
    }
    const reservation = yield* input.store.reserveNonce({
      candidate,
      effectId,
      custodyBalanceBeforeAtomic: custodyBalance,
      referralBalanceBeforeAtomic: referralBalance,
      observedPendingNonce: pendingNonce,
      observedBlockNumber: feeQuote.observedBlockNumber,
      observedBlockHash: feeQuote.observedBlockHash,
      observedAt: new Date(now()).toISOString(),
    });
    return yield* prepareReserved(reservation);
  });

  return { claim, reconcile };
}
