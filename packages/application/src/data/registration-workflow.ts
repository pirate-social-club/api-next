import type {
  ConfirmDataRegistrationInput,
  DataRegistrationArtifact,
  DataRegistrationArtifactKind,
  DataRegistrationOperation,
  DataRegistrationPinVerification,
  DataRegistrationReceiptInput,
  DataRegistrationSigningAttempt,
  DataRegistrationStore,
  ReserveDataRegistrationAttemptInput,
} from "./registration-persistence";
import {
  deterministicDataRegistrationAttemptId,
  deterministicDataRegistrationReceiptId,
  deterministicDataRegistrationSigningIntentId,
  deterministicDataRegistrationWorkflowId,
} from "./registration-persistence";
import type {
  DataRegistrationSigningCoordinatorInput,
  DataRegistrationSigningCoordinatorResult,
} from "./signing-coordinator";

const HASH = /^[0-9a-f]{64}$/u;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/u;
const metadataArtifacts = ["ip_metadata", "nft_metadata"] as const;

export type DataRegistrationWorkflowPayload = Readonly<{
  outboxId: string;
  registrationOperationId: string;
  workflowRevision: bigint;
}>;

export type DataRegistrationPreparedArtifact = Readonly<{
  artifact: DataRegistrationArtifact;
  filename: string;
  contentType: string;
  open: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
}>;

export type DataRegistrationPinResult =
  | Readonly<{
      status: "verified";
      cid: string;
      byteLength: bigint;
      canonicalSha256: string;
      primaryEvidenceRef: string;
      gatewayEvidenceRef: string;
      verifiedAt: string;
    }>
  | Readonly<{
      status: "primary_verified";
      cid: string;
      byteLength: bigint;
      canonicalSha256: string;
      primaryEvidenceRef: string;
      gatewayEvidenceRef: string;
      verifiedAt: string;
      gatewayRetryable: boolean;
    }>
  | Readonly<{ status: "retryable" }>
  | Readonly<{ status: "failed"; evidenceRef: string }>;

export interface DataRegistrationArtifactPipeline {
  readonly prepare: (
    operation: DataRegistrationOperation,
  ) => Promise<readonly DataRegistrationPreparedArtifact[]>;
  readonly pinAndVerify: (
    operation: DataRegistrationOperation,
    artifact: DataRegistrationPreparedArtifact,
  ) => Promise<DataRegistrationPinResult>;
}

export type DataRegistrationTransactionPlan = Readonly<{
  reservation: ReserveDataRegistrationAttemptInput;
  calldata: Uint8Array;
}>;

export type DataRegistrationBroadcastResult =
  | Readonly<{ status: "broadcast"; transactionHash: string; evidenceRef: string }>
  | Readonly<{ status: "retryable" }>
  | Readonly<{ status: "rejected"; evidenceRef: string }>;

export type DataRegistrationReceiptResult =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "retryable" }>
  | Readonly<{ status: "mined"; observation: DataRegistrationReceiptInput }>
  | Readonly<{
      status: "confirmed";
      observation: ConfirmDataRegistrationInput;
    }>
  | Readonly<{
      status: "reverted" | "orphaned";
      observation: DataRegistrationReceiptInput;
    }>;

export interface DataRegistrationChainPipeline {
  readonly plan: (
    operation: DataRegistrationOperation,
    attemptNumber: number,
  ) => Promise<DataRegistrationTransactionPlan>;
  readonly readNonce: (
    operation: DataRegistrationOperation,
    attempt: DataRegistrationSigningAttempt,
  ) => Promise<Readonly<{ nonce: bigint; evidenceRef: string }>>;
  readonly broadcast: (
    operation: DataRegistrationOperation,
    attempt: DataRegistrationSigningAttempt,
  ) => Promise<DataRegistrationBroadcastResult>;
  readonly observeReceipt: (
    operation: DataRegistrationOperation,
    attempt: DataRegistrationSigningAttempt,
  ) => Promise<DataRegistrationReceiptResult>;
}

export interface DataRegistrationSigningService {
  readonly sign: (
    input: DataRegistrationSigningCoordinatorInput,
  ) => Promise<DataRegistrationSigningCoordinatorResult>;
}

export interface DataRegistrationWorkflowPinReader {
  readonly listPinVerifications: (
    registrationOperationId: string,
  ) => Promise<readonly DataRegistrationPinVerification[]>;
}

export interface DataRegistrationWorkflowSigningReader {
  readonly getSigningAttempt: (
    submissionAttemptId: string,
  ) => Promise<DataRegistrationSigningAttempt | null>;
}

export type DataRegistrationWorkflowDependencies = Readonly<{
  store: DataRegistrationStore;
  signingReader: DataRegistrationWorkflowSigningReader;
  pinReader: DataRegistrationWorkflowPinReader;
  artifacts: DataRegistrationArtifactPipeline;
  chain: DataRegistrationChainPipeline;
  signer: DataRegistrationSigningService;
  options: Readonly<{ enabled: boolean }>;
}>;

export type DataRegistrationWorkflowResult = Readonly<{
  outcome: "inert" | "progress" | "waiting" | "registered" | "failed";
}>;

const validPayload = (payload: DataRegistrationWorkflowPayload): boolean =>
  payload.outboxId.length > 0 &&
  payload.outboxId.length <= 512 &&
  payload.outboxId === payload.outboxId.trim() &&
  payload.registrationOperationId.length > 0 &&
  payload.registrationOperationId.length <= 512 &&
  payload.registrationOperationId === payload.registrationOperationId.trim() &&
  payload.workflowRevision > 0n;

const artifactsAreValidStage = (
  operation: DataRegistrationOperation,
  artifacts: readonly DataRegistrationPreparedArtifact[],
): boolean => {
  const kinds = new Set(artifacts.map(({ artifact }) => artifact.artifactKind));
  const mediaArtifacts: readonly DataRegistrationArtifactKind[] =
    operation.mediaKind === "video" ? ["canonical_video", "poster"] : ["canonical_audio"];
  const expected = new Set<DataRegistrationArtifactKind>([...mediaArtifacts, ...metadataArtifacts]);
  return (
    artifacts.length === kinds.size &&
    mediaArtifacts.every((kind) => kinds.has(kind)) &&
    ([...expected].every((kind) => kinds.has(kind)) || kinds.size === mediaArtifacts.length) &&
    artifacts.every(
      ({ artifact }) =>
        artifact.byteLength > 0n &&
        HASH.test(artifact.canonicalSha256) &&
        artifact.registrationOperationId.length > 0,
    )
  );
};

const planMatchesAttempt = (
  plan: DataRegistrationTransactionPlan,
  attempt: DataRegistrationSigningAttempt,
): boolean => {
  const reservation = plan.reservation;
  return (
    reservation.submissionAttemptId === attempt.submissionAttemptId &&
    reservation.registrationOperationId === attempt.registrationOperationId &&
    reservation.chainId === attempt.chainId &&
    reservation.attemptNumber === attempt.attemptNumber &&
    reservation.signerNamespace === attempt.signerNamespace &&
    reservation.signerAddress.toLowerCase() === attempt.signerAddress.toLowerCase() &&
    reservation.signingIntentId === attempt.signingIntentId &&
    reservation.targetAddress.toLowerCase() === attempt.targetAddress.toLowerCase() &&
    reservation.methodSelector === attempt.methodSelector &&
    reservation.calldataHash === attempt.calldataHash &&
    reservation.signingDeadline === attempt.signingDeadline &&
    reservation.valueWei === attempt.valueWei &&
    reservation.gasLimit === attempt.gasLimit &&
    reservation.maxFeePerGas === attempt.maxFeePerGas &&
    reservation.maxPriorityFeePerGas === attempt.maxPriorityFeePerGas
  );
};

const failOperation = async (
  dependencies: DataRegistrationWorkflowDependencies,
  operation: DataRegistrationOperation,
  attempt: DataRegistrationSigningAttempt | null,
  state: "failed" | "reconciliation_required",
  failureCode:
    | "pin_verification_failed"
    | "signing_failed"
    | "broadcast_failed"
    | "receipt_reverted"
    | "chain_reorganization"
    | "invalid_receipt"
    | "configuration_invalid",
  evidenceRef: string,
): Promise<DataRegistrationWorkflowResult> => {
  await dependencies.store.failRegistration({
    registrationOperationId: operation.registrationOperationId,
    submissionAttemptId: attempt?.submissionAttemptId ?? null,
    operationState: state,
    operationFailureCode: failureCode,
    attemptFailureCode:
      attempt === null ||
      failureCode === "pin_verification_failed" ||
      failureCode === "configuration_invalid"
        ? null
        : failureCode,
    evidenceRef,
  });
  return { outcome: "failed" };
};

const recordPins = async (
  dependencies: DataRegistrationWorkflowDependencies,
  operation: DataRegistrationOperation,
  prepared: DataRegistrationPreparedArtifact,
  result: Extract<DataRegistrationPinResult, { status: "verified" | "primary_verified" }>,
  existing: readonly DataRegistrationPinVerification[],
): Promise<void> => {
  const common = {
    registrationOperationId: operation.registrationOperationId,
    artifactId: prepared.artifact.artifactId,
    artifactKind: prepared.artifact.artifactKind,
    outcome: "verified" as const,
    cid: result.cid,
    canonicalSha256: result.canonicalSha256,
    byteLength: result.byteLength,
    verifiedAt: result.verifiedAt,
  };
  const verified = existing.filter((pin) => pin.outcome === "verified");
  const primary = verified.find((pin) => pin.role === "primary");
  const gateway = verified.find((pin) => pin.role === "independent_gateway");
  for (const pin of verified) {
    if (
      (pin.role === "primary" && pin.providerId !== "filebase") ||
      (pin.role === "independent_gateway" && pin.providerId !== "ipfs.io") ||
      pin.cid !== result.cid ||
      pin.canonicalSha256 !== result.canonicalSha256 ||
      pin.byteLength !== result.byteLength
    ) {
      throw new Error("persisted pin identity mismatch");
    }
  }
  const nextAttempt = (role: DataRegistrationPinVerification["role"], providerId: string) => {
    const attemptNumber =
      Math.max(
        0,
        ...existing
          .filter((pin) => pin.role === role && pin.providerId === providerId)
          .map((pin) => pin.attemptNumber),
      ) + 1;
    if (attemptNumber > 10) throw new Error("pin attempt budget exhausted");
    return attemptNumber;
  };
  if (primary === undefined) {
    const attemptNumber = nextAttempt("primary", "filebase");
    await dependencies.store.recordPinVerification({
      ...common,
      pinVerificationId: `${prepared.artifact.artifactId}:pin:filebase:${attemptNumber}`,
      role: "primary",
      providerId: "filebase",
      attemptNumber,
      evidenceRef: result.primaryEvidenceRef,
    });
  }
  if (gateway === undefined) {
    const attemptNumber = nextAttempt("independent_gateway", "ipfs.io");
    await dependencies.store.recordPinVerification({
      ...(result.status === "verified"
        ? common
        : {
            registrationOperationId: operation.registrationOperationId,
            artifactId: prepared.artifact.artifactId,
            artifactKind: prepared.artifact.artifactKind,
            outcome: "failed" as const,
            cid: null,
            canonicalSha256: null,
            byteLength: null,
            verifiedAt: null,
          }),
      pinVerificationId: `${prepared.artifact.artifactId}:gateway:ipfs.io:${attemptNumber}`,
      role: "independent_gateway",
      providerId: "ipfs.io",
      attemptNumber,
      evidenceRef: result.gatewayEvidenceRef,
    });
  }
};

/** Advances exactly one durable state-machine edge after reloading PostgreSQL authority. */
export async function advanceDataRegistrationWorkflow(
  payload: DataRegistrationWorkflowPayload,
  dependencies: DataRegistrationWorkflowDependencies,
): Promise<DataRegistrationWorkflowResult> {
  if (!dependencies.options.enabled) return { outcome: "inert" };
  if (!validPayload(payload)) return { outcome: "failed" };
  const operation = await dependencies.store.getOperation(payload.registrationOperationId);
  const outbox = await dependencies.store.getOutbox(payload.outboxId);
  const expectedWorkflowId = deterministicDataRegistrationWorkflowId(
    payload.registrationOperationId,
    payload.workflowRevision,
  );
  if (
    operation === null ||
    outbox === null ||
    operation.workflowRevision !== payload.workflowRevision ||
    operation.workflowInstanceId !== expectedWorkflowId ||
    outbox.registrationOperationId !== payload.registrationOperationId ||
    outbox.workflowRevision !== payload.workflowRevision ||
    outbox.workflowInstanceId !== expectedWorkflowId ||
    (outbox.state !== "running" && outbox.state !== "delivered")
  ) {
    return { outcome: "failed" };
  }
  if (operation.state === "registered") return { outcome: "registered" };
  if (operation.state === "failed" || operation.state === "reconciliation_required") {
    return { outcome: "failed" };
  }

  if (!(await dependencies.store.pinsReady(operation.registrationOperationId))) {
    const artifacts = await dependencies.artifacts.prepare(operation);
    const persistedPins = await dependencies.pinReader.listPinVerifications(
      operation.registrationOperationId,
    );
    if (!artifactsAreValidStage(operation, artifacts)) {
      return failOperation(
        dependencies,
        operation,
        null,
        "failed",
        "configuration_invalid",
        "data-registration://artifact-shape-invalid",
      );
    }
    for (const prepared of artifacts) {
      if (prepared.artifact.registrationOperationId !== operation.registrationOperationId) {
        return failOperation(
          dependencies,
          operation,
          null,
          "failed",
          "configuration_invalid",
          "data-registration://artifact-operation-mismatch",
        );
      }
      await dependencies.store.recordArtifact(prepared.artifact);
      const artifactPins = persistedPins.filter(
        (pin) =>
          pin.artifactId === prepared.artifact.artifactId &&
          ((pin.role === "primary" && pin.providerId === "filebase") ||
            (pin.role === "independent_gateway" && pin.providerId === "ipfs.io")),
      );
      if (
        artifactPins.some((pin) => pin.role === "primary" && pin.outcome === "verified") &&
        artifactPins.some((pin) => pin.role === "independent_gateway" && pin.outcome === "verified")
      ) {
        continue;
      }
      const pinned = await dependencies.artifacts.pinAndVerify(operation, prepared);
      if (pinned.status === "retryable") return { outcome: "waiting" };
      if (pinned.status === "failed") {
        return failOperation(
          dependencies,
          operation,
          null,
          "failed",
          "pin_verification_failed",
          pinned.evidenceRef,
        );
      }
      if (
        pinned.byteLength !== prepared.artifact.byteLength ||
        pinned.canonicalSha256 !== prepared.artifact.canonicalSha256
      ) {
        return failOperation(
          dependencies,
          operation,
          null,
          "failed",
          "pin_verification_failed",
          "data-registration://pin-integrity-mismatch",
        );
      }
      try {
        await recordPins(dependencies, operation, prepared, pinned, artifactPins);
      } catch {
        return failOperation(
          dependencies,
          operation,
          null,
          "reconciliation_required",
          "pin_verification_failed",
          "data-registration://persisted-pin-mismatch",
        );
      }
      if (pinned.status === "primary_verified") {
        if (pinned.gatewayRetryable) return { outcome: "waiting" };
        return failOperation(
          dependencies,
          operation,
          null,
          "failed",
          "pin_verification_failed",
          pinned.gatewayEvidenceRef,
        );
      }
    }
    if (await dependencies.store.pinsReady(operation.registrationOperationId)) {
      return { outcome: "progress" };
    }
    // The first durable pass intentionally contains only the sealed media and
    // any required image. Their verified CIDs are inputs to both canonical
    // metadata documents, which are prepared and pinned by the next step.
    const firstStageComplete =
      operation.mediaKind === "video"
        ? artifacts.length === 2 &&
          artifacts.some(({ artifact }) => artifact.artifactKind === "canonical_video") &&
          artifacts.some(({ artifact }) => artifact.artifactKind === "poster")
        : artifacts.length === 1 && artifacts[0]?.artifact.artifactKind === "canonical_audio";
    if (firstStageComplete) {
      return { outcome: "progress" };
    }
    return failOperation(
      dependencies,
      operation,
      null,
      "failed",
      "pin_verification_failed",
      "data-registration://pin-fence-not-ready",
    );
  }

  const attempt =
    operation.currentAttemptId === null
      ? null
      : await dependencies.signingReader.getSigningAttempt(operation.currentAttemptId);
  if (operation.currentAttemptId !== null && attempt === null) {
    return failOperation(
      dependencies,
      operation,
      null,
      "reconciliation_required",
      "invalid_receipt",
      "data-registration://missing-current-attempt",
    );
  }
  if (attempt === null) {
    const plan = await dependencies.chain.plan(operation, 1);
    const expectedAttemptId = deterministicDataRegistrationAttemptId(
      operation.registrationOperationId,
      1,
    );
    if (
      plan.reservation.registrationOperationId !== operation.registrationOperationId ||
      plan.reservation.submissionAttemptId !== expectedAttemptId ||
      plan.reservation.signingIntentId !==
        deterministicDataRegistrationSigningIntentId(expectedAttemptId)
    ) {
      return failOperation(
        dependencies,
        operation,
        null,
        "failed",
        "configuration_invalid",
        "data-registration://plan-identity-invalid",
      );
    }
    await dependencies.store.reserveSigningAttempt(plan.reservation);
    return { outcome: "progress" };
  }

  const plan = await dependencies.chain.plan(operation, attempt.attemptNumber);
  if (!planMatchesAttempt(plan, attempt)) {
    return failOperation(
      dependencies,
      operation,
      attempt,
      "reconciliation_required",
      "signing_failed",
      "data-registration://persisted-plan-mismatch",
    );
  }
  if (attempt.state === "signing_intent") {
    const nonce = await dependencies.chain.readNonce(operation, attempt);
    await dependencies.store.reserveNonce(
      attempt.submissionAttemptId,
      nonce.nonce,
      nonce.evidenceRef,
    );
    return { outcome: "progress" };
  }
  if (attempt.state === "nonce_reserved") {
    await dependencies.signer.sign({
      submissionAttemptId: attempt.submissionAttemptId,
      calldata: plan.calldata,
      evidenceRef: `data-registration://sign/${attempt.signingIntentId}`,
    });
    return { outcome: "progress" };
  }
  if (attempt.state === "prepared") {
    if (
      attempt.signedTransaction === null ||
      attempt.signedTransactionHash === null ||
      !TRANSACTION_HASH.test(attempt.signedTransactionHash)
    ) {
      return failOperation(
        dependencies,
        operation,
        attempt,
        "reconciliation_required",
        "signing_failed",
        "data-registration://prepared-bytes-invalid",
      );
    }
    const broadcast = await dependencies.chain.broadcast(operation, attempt);
    if (broadcast.status === "retryable") return { outcome: "waiting" };
    if (broadcast.status === "rejected") {
      return failOperation(
        dependencies,
        operation,
        attempt,
        "failed",
        "broadcast_failed",
        broadcast.evidenceRef,
      );
    }
    if (broadcast.transactionHash !== attempt.signedTransactionHash) {
      return failOperation(
        dependencies,
        operation,
        attempt,
        "reconciliation_required",
        "broadcast_failed",
        "data-registration://broadcast-hash-mismatch",
      );
    }
    await dependencies.store.markBroadcast(
      attempt.submissionAttemptId,
      broadcast.transactionHash,
      broadcast.evidenceRef,
    );
    return { outcome: "progress" };
  }
  if (attempt.state === "broadcast" || attempt.state === "mined") {
    const receipt = await dependencies.chain.observeReceipt(operation, attempt);
    if (receipt.status === "pending" || receipt.status === "retryable") {
      return { outcome: "waiting" };
    }
    await dependencies.store.recordReceipt(receipt.observation);
    if (receipt.status === "mined") {
      await dependencies.store.markMined(
        attempt.submissionAttemptId,
        receipt.observation.evidenceRef,
      );
      return { outcome: "waiting" };
    }
    if (receipt.status === "confirmed") {
      if (attempt.state === "broadcast") {
        await dependencies.store.markMined(
          attempt.submissionAttemptId,
          receipt.observation.evidenceRef,
        );
      }
      await dependencies.store.confirmRegistration(receipt.observation);
      return { outcome: "registered" };
    }
    return failOperation(
      dependencies,
      operation,
      attempt,
      receipt.status === "orphaned" ? "reconciliation_required" : "failed",
      receipt.status === "orphaned" ? "chain_reorganization" : "receipt_reverted",
      receipt.observation.evidenceRef,
    );
  }
  if (attempt.state === "confirmed") {
    return failOperation(
      dependencies,
      operation,
      attempt,
      "reconciliation_required",
      "invalid_receipt",
      "data-registration://attempt-confirmed-operation-not-registered",
    );
  }
  return { outcome: "failed" };
}

export const nextDataRegistrationReceiptId = (
  attempt: DataRegistrationSigningAttempt,
  sequence: bigint,
): string => deterministicDataRegistrationReceiptId(attempt.submissionAttemptId, sequence);
