import type {
  MegapotConfirmedPurchase,
  MegapotPreBroadcastCloseReason,
  MegapotPreparedPurchase,
  MegapotPurchaseCandidate,
  MegapotPurchaseFailure,
  MegapotPurchaseProgress,
  MegapotPurchaseStore,
  MegapotReservedPurchase,
} from "@pirate/application";
import { deriveMegapotTicket } from "@pirate/domain";
import { Data, Effect } from "effect";
import { type Hex, hexToBytes, keccak256, toBytes } from "viem";
import {
  encodeMegapotBuyTickets,
  MEGAPOT_REFERRAL_SPLIT_SCALE,
  type MegapotTransactionReceipt,
  type MegapotV2DeploymentAttestation,
  megapotKeccak256,
  validateMegapotPurchaseReceipt,
} from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";

export type MegapotPurchaseCoordinatorReason =
  | "allowance_insufficient"
  | "balance_insufficient"
  | "cutoff_safety_margin"
  | "deployment_attestation_mismatch"
  | "drawing_locked"
  | "drawing_rolled_over"
  | "drawing_state_changed"
  | "gas_floor_insufficient"
  | "invalid_config"
  | "production_disabled"
  | "receipt_evidence_invalid"
  | "signer_mismatch";

export class MegapotPurchaseCoordinatorFailed extends Data.TaggedError(
  "MegapotPurchaseCoordinatorFailed",
)<{
  readonly reason: MegapotPurchaseCoordinatorReason;
  readonly phase: "configuration" | "preflight" | "prepare" | "receipt";
}> {}

export type MegapotPurchaseCoordinatorResult =
  | Readonly<{
      kind: "closed";
      reason: MegapotPreBroadcastCloseReason;
    }>
  | Readonly<{
      kind: "submitted";
      effectId: string;
      transactionHash: string;
    }>
  | Readonly<{
      kind: "reconciliation_required";
      effectId: string;
      transactionHash: string;
    }>
  | Readonly<{
      kind: "confirmed";
      effectId: string;
      transactionHash: string;
      ticketId: bigint;
      blockNumber: bigint;
      blockHash: string;
      confirmations: number;
    }>;

export type MegapotPurchaseCoordinatorOptions = Readonly<{
  requiredConfirmations: number;
  purchaseSafetyMarginSeconds: number;
  gasLimitMultiplierBps: number;
  nativeGasReserveFloorWei: bigint;
  now?: () => number;
}>;

export interface MegapotPurchaseCoordinator {
  readonly purchase: (input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) => Effect.Effect<
    MegapotPurchaseCoordinatorResult,
    MegapotPurchaseCoordinatorFailed | MegapotPurchaseFailure
  >;
  readonly reconcile: (
    effectId: string,
  ) => Effect.Effect<
    MegapotPurchaseCoordinatorResult,
    MegapotPurchaseCoordinatorFailed | MegapotPurchaseFailure
  >;
}

const failed = (
  reason: MegapotPurchaseCoordinatorReason,
  phase: MegapotPurchaseCoordinatorFailed["phase"],
): MegapotPurchaseCoordinatorFailed => new MegapotPurchaseCoordinatorFailed({ reason, phase });

function deployment(candidate: MegapotPurchaseCandidate): MegapotV2DeploymentAttestation {
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

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
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

const sha256Hex = Effect.fn("sha256Hex")(function* (input: Uint8Array) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", input),
    catch: () => failed("invalid_config", "prepare"),
  });
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export function deriveMegapotPurchaseEffectId(poolLegId: string, drawingId: bigint): Hex {
  if (poolLegId.length === 0 || poolLegId !== poolLegId.trim() || drawingId < 0n) {
    throw failed("invalid_config", "configuration");
  }
  return keccak256(
    toBytes(`pirate.megapot.ticket-purchase.v1\u0000${poolLegId}\u0000${drawingId.toString()}`),
  );
}

function confirmedResult(value: MegapotConfirmedPurchase): MegapotPurchaseCoordinatorResult {
  return {
    kind: "confirmed",
    effectId: value.effectId,
    transactionHash: value.transactionHash,
    ticketId: value.ticketId,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    confirmations: value.confirmations,
  };
}

function preparedFrom(
  reservation: MegapotReservedPurchase,
  calldata: Hex,
  calldataHash: string,
  signedTransaction: Hex,
  signedTransactionHash: Hex,
): MegapotPreparedPurchase {
  return {
    ...reservation,
    state: "prepared",
    calldata,
    calldataHash,
    signedTransaction,
    signedTransactionHash,
    transactionHash: null,
  };
}

export function makeMegapotPurchaseCoordinator(input: {
  readonly store: MegapotPurchaseStore;
  readonly rpc: MegapotV2RpcClient;
  readonly signer: MegapotV2TransactionSigner;
  readonly options: MegapotPurchaseCoordinatorOptions;
}): MegapotPurchaseCoordinator {
  const { store, rpc, signer } = input;
  const options = input.options;
  if (
    !Number.isSafeInteger(options.requiredConfirmations) ||
    options.requiredConfirmations < 1 ||
    !Number.isSafeInteger(options.purchaseSafetyMarginSeconds) ||
    options.purchaseSafetyMarginSeconds < 1 ||
    !Number.isSafeInteger(options.gasLimitMultiplierBps) ||
    options.gasLimitMultiplierBps < 10_000 ||
    options.gasLimitMultiplierBps > 20_000 ||
    options.nativeGasReserveFloorWei < 0n
  ) {
    throw failed("invalid_config", "configuration");
  }
  const now = options.now ?? Date.now;

  const rpcEffect = <A>(
    phase: MegapotPurchaseCoordinatorFailed["phase"],
    reason: MegapotPurchaseCoordinatorReason,
    operation: () => Promise<A>,
  ): Effect.Effect<A, MegapotPurchaseCoordinatorFailed> =>
    Effect.tryPromise({ try: operation, catch: () => failed(reason, phase) });

  const assertLivePurchase = Effect.fn("MegapotPurchaseCoordinator.assertLivePurchase")(function* (
    candidate: MegapotPurchaseCandidate,
  ) {
    if (candidate.environment === "production" || candidate.chainId !== 84_532) {
      return yield* failed("production_disabled", "configuration");
    }
    if (!sameAddress(signer.address, candidate.custodyAddress)) {
      return yield* failed("signer_mismatch", "configuration");
    }
    yield* rpcEffect("preflight", "deployment_attestation_mismatch", () => rpc.attestDeployment());
    const live = yield* rpcEffect("preflight", "drawing_state_changed", () =>
      rpc.readCurrentDrawing(),
    );
    if (live.drawingId !== candidate.drawingId) {
      return yield* failed("drawing_rolled_over", "preflight");
    }
    if (live.state.jackpotLock) return yield* failed("drawing_locked", "preflight");
    const nowSeconds = BigInt(Math.floor(now() / 1_000));
    if (live.state.drawingTime <= nowSeconds + BigInt(options.purchaseSafetyMarginSeconds)) {
      return yield* failed("cutoff_safety_margin", "preflight");
    }
    if (
      live.state.ticketPrice !== candidate.ticketPriceAtomic ||
      live.state.ballMax !== candidate.ballMax ||
      live.state.bonusballMax !== candidate.bonusballMax
    ) {
      return yield* failed("drawing_state_changed", "preflight");
    }
  });

  const requireReconciliation = Effect.fn("MegapotPurchaseCoordinator.requireReconciliation")(
    function* (purchase: MegapotPreparedPurchase, reason: string) {
      const transactionHash = purchase.transactionHash ?? purchase.signedTransactionHash;
      yield* store.requireReconciliation({
        effectId: purchase.effectId,
        transactionHash,
        reason,
      });
      return {
        kind: "reconciliation_required",
        effectId: purchase.effectId,
        transactionHash,
      } as const;
    },
  );

  const reconcilePrepared = Effect.fn("MegapotPurchaseCoordinator.reconcilePrepared")(function* (
    purchase: MegapotPreparedPurchase,
  ) {
    const transactionHash = purchase.transactionHash ?? purchase.signedTransactionHash;
    const receiptAttempt = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      rpc.readReceipt(transactionHash),
    ).pipe(
      Effect.map((receipt) => ({ ok: true as const, receipt })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!receiptAttempt.ok || receiptAttempt.receipt === null) {
      return purchase.state === "reconciliation_required"
        ? ({
            kind: "reconciliation_required",
            effectId: purchase.effectId,
            transactionHash,
          } as const)
        : ({ kind: "submitted", effectId: purchase.effectId, transactionHash } as const);
    }
    const receipt = receiptAttempt.receipt;
    if (receipt.status !== "success") {
      return yield* requireReconciliation(purchase, "purchase_receipt_reverted");
    }
    const chainEvidence = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      Promise.all([rpc.readBlock(receipt.blockNumber), rpc.readHead()]),
    ).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!chainEvidence.ok) {
      return yield* requireReconciliation(purchase, "purchase_receipt_block_unavailable");
    }
    const [receiptBlock, head] = chainEvidence.value;
    if (
      receiptBlock.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      head.blockNumber < receipt.blockNumber
    ) {
      return yield* requireReconciliation(purchase, "purchase_receipt_reorg");
    }
    const confirmationsBig = head.blockNumber - receipt.blockNumber + 1n;
    if (confirmationsBig < BigInt(options.requiredConfirmations)) {
      return { kind: "submitted", effectId: purchase.effectId, transactionHash } as const;
    }
    if (confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return yield* requireReconciliation(purchase, "purchase_confirmation_overflow");
    }
    let evidence: ReturnType<typeof validateMegapotPurchaseReceipt>;
    try {
      evidence = validateMegapotPurchaseReceipt({
        deployment: deployment(purchase),
        receipt,
        drawingId: purchase.drawingId,
        source: purchase.sourceTag,
        tickets: [purchase.ticket],
      });
    } catch {
      return yield* requireReconciliation(purchase, "purchase_receipt_evidence_invalid");
    }
    const ticketId = evidence.ticketIds[0];
    const purchaseLogIndex = evidence.purchaseLogIndices[0];
    const mintLogIndex = evidence.mintLogIndices[0];
    if (ticketId === undefined || purchaseLogIndex === undefined || mintLogIndex === undefined) {
      return yield* requireReconciliation(purchase, "purchase_receipt_evidence_incomplete");
    }
    const ownerAttempt = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      rpc.readTicketOwner(ticketId),
    ).pipe(
      Effect.map((owner) => ({ ok: true as const, owner })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!ownerAttempt.ok || !sameAddress(ownerAttempt.owner, purchase.custodyAddress)) {
      return yield* requireReconciliation(purchase, "purchase_ticket_owner_mismatch");
    }
    const receiptHash = yield* sha256Hex(toBytes(canonicalReceipt(receipt)));
    const confirmations = Number(confirmationsBig);
    const confirmedAt = new Date(now()).toISOString();
    yield* store.confirm({
      effectId: purchase.effectId,
      transactionHash,
      ticketId,
      purchaseLogIndex,
      mintLogIndex,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      receiptHash,
      confirmations,
      referralFeesAtomic: evidence.referralFeesAtomic,
      lpEarningsAtomic: evidence.lpEarningsAtomic,
      confirmedAt,
    });
    return {
      kind: "confirmed",
      effectId: purchase.effectId,
      transactionHash,
      ticketId,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      confirmations,
    } as const;
  });

  const submitPrepared = Effect.fn("MegapotPurchaseCoordinator.submitPrepared")(function* (
    purchase: MegapotPreparedPurchase,
  ) {
    if (purchase.state !== "prepared") return yield* reconcilePrepared(purchase);
    yield* assertLivePurchase(purchase);
    const expectedCalldata = encodeMegapotBuyTickets({
      tickets: [purchase.ticket],
      recipient: purchase.custodyAddress,
      referrers: [purchase.referrerAddress],
      referralSplit: [MEGAPOT_REFERRAL_SPLIT_SCALE],
      source: purchase.sourceTag,
    });
    const expectedCalldataHash = yield* sha256Hex(hexToBytes(expectedCalldata));
    if (
      expectedCalldata !== purchase.calldata ||
      expectedCalldataHash !== purchase.calldataHash ||
      keccak256(purchase.signedTransaction as Hex) !== purchase.signedTransactionHash
    ) {
      return yield* failed("receipt_evidence_invalid", "prepare");
    }
    const submission = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      rpc.sendRawTransaction(purchase.signedTransaction as Hex),
    ).pipe(
      Effect.map((hash) => ({ kind: "accepted" as const, hash })),
      Effect.catch(() => Effect.succeed({ kind: "uncertain" as const })),
    );
    if (
      submission.kind === "uncertain" ||
      submission.hash.toLowerCase() !== purchase.signedTransactionHash.toLowerCase()
    ) {
      yield* store.recordSubmission({
        effectId: purchase.effectId,
        transactionHash: purchase.signedTransactionHash,
        submittedAt: new Date(now()).toISOString(),
        outcome: "uncertain",
        failureReason:
          submission.kind === "uncertain"
            ? "broadcast_outcome_unknown"
            : "provider_transaction_hash_mismatch",
      });
      return {
        kind: "reconciliation_required",
        effectId: purchase.effectId,
        transactionHash: purchase.signedTransactionHash,
      } as const;
    }
    yield* store.recordSubmission({
      effectId: purchase.effectId,
      transactionHash: purchase.signedTransactionHash,
      submittedAt: new Date(now()).toISOString(),
      outcome: "accepted",
    });
    return yield* reconcilePrepared({
      ...purchase,
      state: "broadcast_pending",
      transactionHash: purchase.signedTransactionHash,
    });
  });

  const signReserved = Effect.fn("MegapotPurchaseCoordinator.signReserved")(function* (
    reservation: MegapotReservedPurchase,
    calldata: Hex,
    gas: bigint,
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint,
  ) {
    const signed = yield* rpcEffect("prepare", "signer_mismatch", () =>
      signer.sign({
        chainId: reservation.chainId,
        signerAddress: reservation.custodyAddress,
        targetAddress: reservation.jackpotAddress,
        nonce: reservation.nonce,
        data: calldata,
        valueWei: 0n,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
      }),
    );
    const calldataHash = yield* sha256Hex(hexToBytes(calldata));
    yield* store.prepare({
      reservation,
      ticket: reservation.ticket,
      calldata,
      calldataHash,
      signedTransaction: signed.signedTransaction,
      signedTransactionHash: signed.signedTransactionHash,
      preparedAt: new Date(now()).toISOString(),
    });
    return yield* submitPrepared(
      preparedFrom(
        reservation,
        calldata,
        calldataHash,
        signed.signedTransaction,
        signed.signedTransactionHash,
      ),
    );
  });

  const prepareReserved = Effect.fn("MegapotPurchaseCoordinator.prepareReserved")(function* (
    reservation: MegapotReservedPurchase,
  ) {
    yield* assertLivePurchase(reservation);
    const [allowance, usdcBalance] = yield* rpcEffect("preflight", "drawing_state_changed", () =>
      Promise.all([
        rpc.readUsdcAllowance(reservation.custodyAddress, reservation.jackpotAddress),
        rpc.readUsdcBalance(reservation.custodyAddress),
      ]),
    );
    if (allowance < reservation.ticketPriceAtomic) {
      return yield* failed("allowance_insufficient", "preflight");
    }
    if (usdcBalance < reservation.ticketPriceAtomic) {
      return yield* failed("balance_insufficient", "preflight");
    }
    const calldata = encodeMegapotBuyTickets({
      tickets: [reservation.ticket],
      recipient: reservation.custodyAddress,
      referrers: [reservation.referrerAddress],
      referralSplit: [MEGAPOT_REFERRAL_SPLIT_SCALE],
      source: reservation.sourceTag,
    });
    const [estimatedGas, feeQuote, nativeBalance] = yield* rpcEffect(
      "preflight",
      "gas_floor_insufficient",
      () =>
        Promise.all([
          rpc.estimateGas({
            from: reservation.custodyAddress,
            to: reservation.jackpotAddress,
            data: calldata,
            value: 0n,
          }),
          rpc.readFeeQuote(),
          rpc.readNativeBalance(reservation.custodyAddress),
        ]),
    );
    const gas = (estimatedGas * BigInt(options.gasLimitMultiplierBps) + 9_999n) / 10_000n;
    const requiredNative = gas * feeQuote.maxFeePerGas + options.nativeGasReserveFloorWei;
    if (nativeBalance < requiredNative) {
      return yield* failed("gas_floor_insufficient", "preflight");
    }
    return yield* signReserved(
      reservation,
      calldata,
      gas,
      feeQuote.maxFeePerGas,
      feeQuote.maxPriorityFeePerGas,
    );
  });

  const resume = Effect.fn("MegapotPurchaseCoordinator.resume")(function* (
    progress: MegapotPurchaseProgress,
  ) {
    if (progress.state === "confirmed") return confirmedResult(progress);
    if (progress.state === "nonce_reserved") return yield* prepareReserved(progress.reservation);
    return yield* submitPrepared(progress);
  });

  const reconcile = Effect.fn("MegapotPurchaseCoordinator.reconcile")(function* (effectId: string) {
    const progress = yield* store.findProgress(effectId);
    if (progress === null) return yield* failed("invalid_config", "configuration");
    if (progress.state === "nonce_reserved") return yield* prepareReserved(progress.reservation);
    if (progress.state === "prepared") return yield* submitPrepared(progress);
    if (progress.state === "confirmed") return confirmedResult(progress);
    return yield* reconcilePrepared(progress);
  });

  const purchase = Effect.fn("MegapotPurchaseCoordinator.purchase")(function* (command: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) {
    const effectId = deriveMegapotPurchaseEffectId(command.poolLegId, command.drawingId);
    const existing = yield* store.findProgress(effectId);
    if (existing !== null) return yield* resume(existing);
    const candidate = yield* store.loadCandidate(command);
    const preflight = yield* assertLivePurchase(candidate).pipe(
      Effect.as({ ok: true as const }),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );
    if (!preflight.ok) {
      const terminalReasons = new Set<MegapotPreBroadcastCloseReason>([
        "cutoff_safety_margin",
        "drawing_locked",
        "drawing_rolled_over",
      ]);
      if (terminalReasons.has(preflight.error.reason as MegapotPreBroadcastCloseReason)) {
        const reason = preflight.error.reason as MegapotPreBroadcastCloseReason;
        yield* store.closePreBroadcast({
          candidate,
          reason,
          failedAt: new Date(now()).toISOString(),
        });
        return { kind: "closed", reason } as const;
      }
      return yield* preflight.error;
    }
    const ticket = deriveMegapotTicket({
      effectId,
      drawingId: candidate.drawingId,
      ticketIndex: 0,
      ballMax: candidate.ballMax,
      bonusballMax: candidate.bonusballMax,
      keccak256: megapotKeccak256,
    });
    const calldata = encodeMegapotBuyTickets({
      tickets: [ticket],
      recipient: candidate.custodyAddress,
      referrers: [candidate.referrerAddress],
      referralSplit: [MEGAPOT_REFERRAL_SPLIT_SCALE],
      source: candidate.sourceTag,
    });
    const [allowance, usdcBalance, pendingNonce, feeQuote, estimatedGas, nativeBalance] =
      yield* rpcEffect("preflight", "drawing_state_changed", () =>
        Promise.all([
          rpc.readUsdcAllowance(candidate.custodyAddress, candidate.jackpotAddress),
          rpc.readUsdcBalance(candidate.custodyAddress),
          rpc.readPendingNonce(candidate.custodyAddress),
          rpc.readFeeQuote(),
          rpc.estimateGas({
            from: candidate.custodyAddress,
            to: candidate.jackpotAddress,
            data: calldata,
            value: 0n,
          }),
          rpc.readNativeBalance(candidate.custodyAddress),
        ]),
      );
    if (allowance < candidate.ticketPriceAtomic) {
      return yield* failed("allowance_insufficient", "preflight");
    }
    if (usdcBalance < candidate.ticketPriceAtomic) {
      return yield* failed("balance_insufficient", "preflight");
    }
    const gas = (estimatedGas * BigInt(options.gasLimitMultiplierBps) + 9_999n) / 10_000n;
    const requiredNative = gas * feeQuote.maxFeePerGas + options.nativeGasReserveFloorWei;
    if (nativeBalance < requiredNative) {
      return yield* failed("gas_floor_insufficient", "preflight");
    }
    const reservation = yield* store.reserveNonce({
      candidate,
      effectId,
      ticket,
      observedPendingNonce: pendingNonce,
      observedBlockNumber: feeQuote.observedBlockNumber,
      observedBlockHash: feeQuote.observedBlockHash,
      observedAt: new Date(now()).toISOString(),
    });
    return yield* signReserved(
      reservation,
      calldata,
      gas,
      feeQuote.maxFeePerGas,
      feeQuote.maxPriorityFeePerGas,
    );
  });

  return { purchase, reconcile };
}
