import type {
  MegapotApprovalCandidate,
  MegapotApprovalFailure,
  MegapotApprovalProgress,
  MegapotApprovalStore,
  MegapotConfirmedApproval,
  MegapotPreparedApproval,
  MegapotReservedApproval,
} from "@pirate/application";
import { Data, Effect } from "effect";
import { type Hex, hexToBytes, keccak256, toBytes } from "viem";
import {
  encodeMegapotUsdcApproval,
  type MegapotTransactionReceipt,
  type MegapotV2DeploymentAttestation,
  validateMegapotUsdcApprovalReceipt,
} from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";

export class MegapotApprovalCoordinatorFailed extends Data.TaggedError(
  "MegapotApprovalCoordinatorFailed",
)<{
  readonly reason:
    | "allowance_observation_invalid"
    | "deployment_attestation_mismatch"
    | "gas_floor_insufficient"
    | "invalid_config"
    | "production_disabled"
    | "receipt_evidence_invalid"
    | "signer_mismatch";
  readonly phase: "configuration" | "preflight" | "prepare" | "receipt";
}> {}

export type MegapotApprovalCoordinatorResult =
  | Readonly<{
      kind: "not_required";
      attestationId: string;
      allowanceAtomic: bigint;
    }>
  | Readonly<{ kind: "submitted"; effectId: string; transactionHash: string }>
  | Readonly<{ kind: "reconciliation_required"; effectId: string; transactionHash: string }>
  | Readonly<{
      kind: "confirmed";
      effectId: string;
      transactionHash: string;
      approvedAmountAtomic: bigint;
      allowanceAfterAtomic: bigint;
      blockNumber: bigint;
      blockHash: string;
      confirmations: number;
    }>;

export interface MegapotApprovalCoordinator {
  readonly approve: (input: {
    readonly attestationId: string;
    readonly minimumAllowanceAtomic: bigint;
    readonly approvedAmountAtomic: bigint;
  }) => Effect.Effect<
    MegapotApprovalCoordinatorResult,
    MegapotApprovalCoordinatorFailed | MegapotApprovalFailure
  >;
  readonly reconcile: (
    effectId: string,
  ) => Effect.Effect<
    MegapotApprovalCoordinatorResult,
    MegapotApprovalCoordinatorFailed | MegapotApprovalFailure
  >;
}

const failed = (
  reason: MegapotApprovalCoordinatorFailed["reason"],
  phase: MegapotApprovalCoordinatorFailed["phase"],
): MegapotApprovalCoordinatorFailed => new MegapotApprovalCoordinatorFailed({ reason, phase });

function deployment(candidate: MegapotApprovalCandidate): MegapotV2DeploymentAttestation {
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

const sha256Hex = Effect.fn("megapotApprovalSha256Hex")(function* (input: Uint8Array) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", input),
    catch: () => failed("invalid_config", "prepare"),
  });
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export function deriveMegapotApprovalEffectId(
  attestationId: string,
  approvedAmountAtomic: bigint,
): Hex {
  if (
    attestationId.length === 0 ||
    attestationId !== attestationId.trim() ||
    approvedAmountAtomic < 1n
  ) {
    throw failed("invalid_config", "configuration");
  }
  return keccak256(
    toBytes(
      `pirate.megapot.usdc-approval.v1\u0000${attestationId}\u0000${approvedAmountAtomic.toString()}`,
    ),
  );
}

function confirmedResult(value: MegapotConfirmedApproval): MegapotApprovalCoordinatorResult {
  return {
    kind: "confirmed",
    effectId: value.effectId,
    transactionHash: value.transactionHash,
    approvedAmountAtomic: value.approvedAmountAtomic,
    allowanceAfterAtomic: value.allowanceAfterAtomic,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    confirmations: value.confirmations,
  };
}

export function makeMegapotApprovalCoordinator(input: {
  readonly store: MegapotApprovalStore;
  readonly rpc: MegapotV2RpcClient;
  readonly signer: MegapotV2TransactionSigner;
  readonly requiredConfirmations: number;
  readonly gasLimitMultiplierBps: number;
  readonly nativeGasReserveFloorWei: bigint;
  readonly now?: () => number;
}): MegapotApprovalCoordinator {
  const { store, rpc, signer } = input;
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
    phase: MegapotApprovalCoordinatorFailed["phase"],
    reason: MegapotApprovalCoordinatorFailed["reason"],
    operation: () => Promise<A>,
  ): Effect.Effect<A, MegapotApprovalCoordinatorFailed> =>
    Effect.tryPromise({ try: operation, catch: () => failed(reason, phase) });

  const attest = Effect.fn("MegapotApprovalCoordinator.attest")(function* (
    candidate: MegapotApprovalCandidate,
  ) {
    if (candidate.environment === "production" || candidate.chainId !== 84_532) {
      return yield* failed("production_disabled", "configuration");
    }
    if (signer.address.toLowerCase() !== candidate.custodyAddress.toLowerCase()) {
      return yield* failed("signer_mismatch", "configuration");
    }
    yield* rpcEffect("preflight", "deployment_attestation_mismatch", () => rpc.attestDeployment());
  });

  const requireReconciliation = Effect.fn("MegapotApprovalCoordinator.requireReconciliation")(
    function* (approval: MegapotPreparedApproval, reason: string) {
      const transactionHash = approval.transactionHash ?? approval.signedTransactionHash;
      yield* store.requireReconciliation({ effectId: approval.effectId, transactionHash, reason });
      return {
        kind: "reconciliation_required",
        effectId: approval.effectId,
        transactionHash,
      } as const;
    },
  );

  const reconcilePrepared = Effect.fn("MegapotApprovalCoordinator.reconcilePrepared")(function* (
    approval: MegapotPreparedApproval,
  ) {
    const transactionHash = approval.transactionHash ?? approval.signedTransactionHash;
    const receiptAttempt = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      rpc.readReceipt(transactionHash),
    ).pipe(
      Effect.map((receipt) => ({ ok: true as const, receipt })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!receiptAttempt.ok || receiptAttempt.receipt === null) {
      return approval.state === "reconciliation_required"
        ? ({
            kind: "reconciliation_required",
            effectId: approval.effectId,
            transactionHash,
          } as const)
        : ({ kind: "submitted", effectId: approval.effectId, transactionHash } as const);
    }
    const receipt = receiptAttempt.receipt;
    if (receipt.status !== "success") {
      return yield* requireReconciliation(approval, "approval_receipt_reverted");
    }
    const chain = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      Promise.all([rpc.readBlock(receipt.blockNumber), rpc.readHead()]),
    ).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!chain.ok) return yield* requireReconciliation(approval, "approval_block_unavailable");
    const [receiptBlock, head] = chain.value;
    if (
      receiptBlock.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      head.blockNumber < receipt.blockNumber
    ) {
      return yield* requireReconciliation(approval, "approval_receipt_reorg");
    }
    const confirmationsBig = head.blockNumber - receipt.blockNumber + 1n;
    if (confirmationsBig < BigInt(input.requiredConfirmations)) {
      return { kind: "submitted", effectId: approval.effectId, transactionHash } as const;
    }
    if (confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return yield* requireReconciliation(approval, "approval_confirmation_overflow");
    }
    let evidence: ReturnType<typeof validateMegapotUsdcApprovalReceipt>;
    try {
      evidence = validateMegapotUsdcApprovalReceipt({
        deployment: deployment(approval),
        receipt,
        approvedAmountAtomic: approval.approvedAmountAtomic,
      });
    } catch {
      return yield* requireReconciliation(approval, "approval_receipt_evidence_invalid");
    }
    const allowanceAfterAtomic = yield* rpcEffect("receipt", "allowance_observation_invalid", () =>
      rpc.readUsdcAllowance(approval.custodyAddress, approval.jackpotAddress),
    );
    if (
      allowanceAfterAtomic < approval.minimumAllowanceAtomic ||
      allowanceAfterAtomic < approval.approvedAmountAtomic
    ) {
      return yield* requireReconciliation(approval, "approval_allowance_mismatch");
    }
    const receiptHash = yield* sha256Hex(toBytes(canonicalReceipt(receipt)));
    const confirmations = Number(confirmationsBig);
    yield* store.confirm({
      effectId: approval.effectId,
      transactionHash,
      approvalLogIndex: evidence.approvalLogIndex,
      approvedAmountAtomic: evidence.approvedAmountAtomic,
      allowanceAfterAtomic,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      receiptHash,
      confirmations,
      confirmedAt: new Date(now()).toISOString(),
    });
    return {
      kind: "confirmed",
      effectId: approval.effectId,
      transactionHash,
      approvedAmountAtomic: evidence.approvedAmountAtomic,
      allowanceAfterAtomic,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      confirmations,
    } as const;
  });

  const submitPrepared = Effect.fn("MegapotApprovalCoordinator.submitPrepared")(function* (
    approval: MegapotPreparedApproval,
  ) {
    if (approval.state !== "prepared") return yield* reconcilePrepared(approval);
    yield* attest(approval);
    const expectedCalldata = encodeMegapotUsdcApproval(
      approval.jackpotAddress,
      approval.approvedAmountAtomic,
    );
    const expectedCalldataHash = yield* sha256Hex(hexToBytes(expectedCalldata));
    if (
      expectedCalldata !== approval.calldata ||
      expectedCalldataHash !== approval.calldataHash ||
      keccak256(approval.signedTransaction as Hex) !== approval.signedTransactionHash
    ) {
      return yield* failed("receipt_evidence_invalid", "prepare");
    }
    const submission = yield* rpcEffect("receipt", "receipt_evidence_invalid", () =>
      rpc.sendRawTransaction(approval.signedTransaction as Hex),
    ).pipe(
      Effect.map((transactionHash) => ({ kind: "accepted" as const, transactionHash })),
      Effect.catch(() => Effect.succeed({ kind: "uncertain" as const })),
    );
    if (
      submission.kind === "uncertain" ||
      submission.transactionHash.toLowerCase() !== approval.signedTransactionHash.toLowerCase()
    ) {
      yield* store.recordSubmission({
        effectId: approval.effectId,
        transactionHash: approval.signedTransactionHash,
        submittedAt: new Date(now()).toISOString(),
        outcome: "uncertain",
        failureReason:
          submission.kind === "uncertain"
            ? "broadcast_outcome_unknown"
            : "provider_transaction_hash_mismatch",
      });
      return {
        kind: "reconciliation_required",
        effectId: approval.effectId,
        transactionHash: approval.signedTransactionHash,
      } as const;
    }
    yield* store.recordSubmission({
      effectId: approval.effectId,
      transactionHash: approval.signedTransactionHash,
      submittedAt: new Date(now()).toISOString(),
      outcome: "accepted",
    });
    return yield* reconcilePrepared({
      ...approval,
      state: "broadcast_pending",
      transactionHash: approval.signedTransactionHash,
    });
  });

  const prepareReserved = Effect.fn("MegapotApprovalCoordinator.prepareReserved")(function* (
    reservation: MegapotReservedApproval,
  ) {
    yield* attest(reservation);
    const calldata = encodeMegapotUsdcApproval(
      reservation.jackpotAddress,
      reservation.approvedAmountAtomic,
    );
    const [estimatedGas, feeQuote, nativeBalance] = yield* rpcEffect(
      "preflight",
      "gas_floor_insufficient",
      () =>
        Promise.all([
          rpc.estimateGas({
            from: reservation.custodyAddress,
            to: reservation.usdcAddress,
            data: calldata,
            value: 0n,
          }),
          rpc.readFeeQuote(),
          rpc.readNativeBalance(reservation.custodyAddress),
        ]),
    );
    const gas = (estimatedGas * BigInt(input.gasLimitMultiplierBps) + 9_999n) / 10_000n;
    if (nativeBalance < gas * feeQuote.maxFeePerGas + input.nativeGasReserveFloorWei) {
      return yield* failed("gas_floor_insufficient", "preflight");
    }
    const signed = yield* rpcEffect("prepare", "signer_mismatch", () =>
      signer.sign({
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
    yield* store.prepare({
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

  const resume = Effect.fn("MegapotApprovalCoordinator.resume")(function* (
    progress: MegapotApprovalProgress,
  ) {
    if (progress.state === "confirmed") return confirmedResult(progress);
    if (progress.state === "nonce_reserved") return yield* prepareReserved(progress.reservation);
    return yield* submitPrepared(progress);
  });

  const reconcile = Effect.fn("MegapotApprovalCoordinator.reconcile")(function* (effectId: string) {
    const progress = yield* store.findProgress(effectId);
    if (progress === null) return yield* failed("invalid_config", "configuration");
    return yield* resume(progress);
  });

  const approve = Effect.fn("MegapotApprovalCoordinator.approve")(function* (command: {
    readonly attestationId: string;
    readonly minimumAllowanceAtomic: bigint;
    readonly approvedAmountAtomic: bigint;
  }) {
    if (
      command.minimumAllowanceAtomic < 1n ||
      command.approvedAmountAtomic < command.minimumAllowanceAtomic
    ) {
      return yield* failed("invalid_config", "configuration");
    }
    const effectId = deriveMegapotApprovalEffectId(
      command.attestationId,
      command.approvedAmountAtomic,
    );
    const existing = yield* store.findProgress(effectId);
    if (existing !== null) return yield* resume(existing);
    const candidate = yield* store.loadCandidate(command.attestationId);
    yield* attest(candidate);
    const allowanceBeforeAtomic = yield* rpcEffect(
      "preflight",
      "allowance_observation_invalid",
      () => rpc.readUsdcAllowance(candidate.custodyAddress, candidate.jackpotAddress),
    );
    if (allowanceBeforeAtomic >= command.minimumAllowanceAtomic) {
      return {
        kind: "not_required",
        attestationId: candidate.attestationId,
        allowanceAtomic: allowanceBeforeAtomic,
      } as const;
    }
    const calldata = encodeMegapotUsdcApproval(
      candidate.jackpotAddress,
      command.approvedAmountAtomic,
    );
    const [nonce, feeQuote, estimatedGas, nativeBalance] = yield* rpcEffect(
      "preflight",
      "gas_floor_insufficient",
      () =>
        Promise.all([
          rpc.readPendingNonce(candidate.custodyAddress),
          rpc.readFeeQuote(),
          rpc.estimateGas({
            from: candidate.custodyAddress,
            to: candidate.usdcAddress,
            data: calldata,
            value: 0n,
          }),
          rpc.readNativeBalance(candidate.custodyAddress),
        ]),
    );
    const gas = (estimatedGas * BigInt(input.gasLimitMultiplierBps) + 9_999n) / 10_000n;
    if (nativeBalance < gas * feeQuote.maxFeePerGas + input.nativeGasReserveFloorWei) {
      return yield* failed("gas_floor_insufficient", "preflight");
    }
    const reservation = yield* store.reserveNonce({
      candidate,
      effectId,
      allowanceBeforeAtomic,
      minimumAllowanceAtomic: command.minimumAllowanceAtomic,
      approvedAmountAtomic: command.approvedAmountAtomic,
      observedPendingNonce: nonce,
      observedBlockNumber: feeQuote.observedBlockNumber,
      observedBlockHash: feeQuote.observedBlockHash,
      observedAt: new Date(now()).toISOString(),
    });
    const signed = yield* rpcEffect("prepare", "signer_mismatch", () =>
      signer.sign({
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
    yield* store.prepare({
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

  return { approve, reconcile };
}
