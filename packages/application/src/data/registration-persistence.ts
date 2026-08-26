export const DATA_REGISTRATION_PERSISTENCE_VERSION = "data-registration-persistence-v1" as const;

export type DataRegistrationOperationState =
  | "pending"
  | "signing"
  | "broadcast"
  | "confirming"
  | "registered"
  | "failed"
  | "reconciliation_required";

export type DataRegistrationAttemptState =
  | "signing_intent"
  | "nonce_reserved"
  | "prepared"
  | "broadcast"
  | "mined"
  | "confirmed"
  | "replaced"
  | "reverted"
  | "failed"
  | "reconciliation_required";

export type DataRegistrationArtifactKind =
  | "canonical_audio"
  | "normalized_artwork"
  | "ip_metadata"
  | "nft_metadata";

export type DataRegistrationPinRole = "primary" | "redundant" | "independent_gateway";

export type DataRegistrationFailureCode =
  | "pin_verification_failed"
  | "signing_failed"
  | "broadcast_failed"
  | "receipt_reverted"
  | "confirmation_timeout"
  | "chain_reorganization"
  | "invalid_receipt"
  | "configuration_invalid";

export type DataRegistrationAttemptFailureCode = Exclude<
  DataRegistrationFailureCode,
  "pin_verification_failed" | "configuration_invalid"
>;

export type DataRegistrationOperation = Readonly<{
  registrationOperationId: string;
  communityId: string;
  actorUserId: string;
  submissionId: string;
  mediaOperationId: string;
  postId: string;
  assetId: string;
  chainId: bigint;
  registrationRevision: bigint;
  publicationCreationRevision: bigint;
  publicationAudioRevision: bigint;
  publicationAnalysisRevision: bigint;
  publicationDecisionRevision: bigint;
  canonicalAudioSha256: string;
  state: DataRegistrationOperationState;
  workflowRevision: bigint;
  workflowInstanceId: string;
  currentAttemptId: string | null;
  registeredIpId: string | null;
  confirmedTransactionHash: string | null;
  confirmedBlockNumber: bigint | null;
  confirmedBlockHash: string | null;
  confirmedLogIndex: number | null;
  confirmedAt: string | null;
  failureCode: DataRegistrationFailureCode | null;
  failureEvidenceRef: string | null;
}>;

export type DataRegistrationArtifact = Readonly<{
  artifactId: string;
  registrationOperationId: string;
  artifactKind: DataRegistrationArtifactKind;
  sourceRef: string;
  mediaType: string;
  byteLength: bigint;
  canonicalSha256: string;
  canonicalizationRevision: "rfc8785-jcs-v1" | null;
}>;

export type DataRegistrationPinVerification = Readonly<{
  pinVerificationId: string;
  registrationOperationId: string;
  artifactId: string;
  artifactKind: DataRegistrationArtifactKind;
  role: DataRegistrationPinRole;
  providerId: string;
  attemptNumber: number;
  outcome: "verified" | "failed";
  cid: string | null;
  canonicalSha256: string | null;
  byteLength: bigint | null;
  evidenceRef: string;
  verifiedAt: string | null;
}>;

export type DataRegistrationSigningAttempt = Readonly<{
  submissionAttemptId: string;
  registrationOperationId: string;
  chainId: bigint;
  attemptNumber: number;
  signerNamespace: string;
  signerAddress: string;
  signingIntentId: string;
  calldataHash: string;
  nonce: bigint | null;
  signedTransaction: Uint8Array | null;
  signedTransactionHash: string | null;
  transactionHash: string | null;
  supersedesSubmissionAttemptId: string | null;
  state: DataRegistrationAttemptState;
  failureCode: DataRegistrationAttemptFailureCode | null;
  failureEvidenceRef: string | null;
}>;

export type DataRegistrationReceiptObservation = Readonly<{
  receiptObservationId: string;
  registrationOperationId: string;
  submissionAttemptId: string;
  observationSequence: bigint;
  transactionHash: string;
  outcome: "pending" | "mined" | "confirmed" | "reverted" | "orphaned";
  blockNumber: bigint | null;
  blockHash: string | null;
  logIndex: number | null;
  confirmations: number;
  registeredIpId: string | null;
  ipMetadataUri: string | null;
  ipMetadataHash: string | null;
  nftMetadataUri: string | null;
  nftMetadataHash: string | null;
  evidenceRef: string;
  observedAt: string;
}>;

export type DataRegistrationOutbox = Readonly<{
  outboxId: string;
  registrationOperationId: string;
  workflowRevision: bigint;
  workflowInstanceId: string;
  eventType: "registration_launch" | "workflow_replacement";
  effectIdentity: string;
  state: "pending" | "running" | "delivered" | "failed" | "exhausted";
  deliveryAttempts: number;
  claimOwner: string | null;
  claimFence: bigint;
  leaseExpiresAt: string | null;
  nextEligibleAt: string | null;
  failureCode: "queue_unavailable" | "workflow_unavailable" | "invalid_binding" | null;
}>;

export type CreateDataRegistrationOperationInput = Readonly<{
  registrationOperationId: string;
  communityId: string;
  actorUserId: string;
  submissionId: string;
  mediaOperationId: string;
  postId: string;
  assetId: string;
  chainId: bigint;
  registrationRevision: bigint;
  publicationCreationRevision: bigint;
  publicationAudioRevision: bigint;
  publicationAnalysisRevision: bigint;
  publicationDecisionRevision: bigint;
  canonicalAudioSha256: string;
  workflowRevision: bigint;
  workflowInstanceId: string;
  outboxId: string;
  outboxEffectIdentity: string;
  endpointTemplate: string;
  idempotencyKey: string;
  requestHash: string;
  responseSnapshotBytes: Uint8Array;
  responseSnapshotSha256: string;
}>;

export type ReserveDataRegistrationAttemptInput = Readonly<{
  registrationOperationId: string;
  submissionAttemptId: string;
  chainId: bigint;
  attemptNumber: number;
  signerNamespace: string;
  signerAddress: string;
  signingIntentId: string;
  calldataHash: string;
  supersedesSubmissionAttemptId: string | null;
  evidenceRef: string;
}>;

export type DataRegistrationReceiptInput = Omit<
  DataRegistrationReceiptObservation,
  "receiptObservationId"
> &
  Readonly<{ receiptObservationId: string }>;

export type ConfirmDataRegistrationInput = Readonly<{
  receiptObservationId: string;
  registrationOperationId: string;
  submissionAttemptId: string;
  observationSequence: bigint;
  transactionHash: string;
  outcome: "confirmed";
  blockNumber: bigint;
  blockHash: string;
  logIndex: number;
  confirmations: number;
  registeredIpId: string;
  ipMetadataUri: string;
  ipMetadataHash: string;
  nftMetadataUri: string;
  nftMetadataHash: string;
  evidenceRef: string;
  observedAt: string;
}>;

export interface DataRegistrationStore {
  readonly createOperation: (
    input: CreateDataRegistrationOperationInput,
  ) => Promise<Readonly<{ kind: "created" | "replay"; operation: DataRegistrationOperation }>>;
  readonly getOperation: (
    registrationOperationId: string,
  ) => Promise<DataRegistrationOperation | null>;
  readonly recordArtifact: (artifact: DataRegistrationArtifact) => Promise<"created" | "replay">;
  readonly recordPinVerification: (
    verification: DataRegistrationPinVerification,
  ) => Promise<"created" | "replay">;
  readonly pinsReady: (registrationOperationId: string) => Promise<boolean>;
  readonly reserveSigningAttempt: (
    input: ReserveDataRegistrationAttemptInput,
  ) => Promise<Readonly<{ kind: "created" | "replay"; attempt: DataRegistrationSigningAttempt }>>;
  readonly reserveNonce: (
    submissionAttemptId: string,
    nonce: bigint,
    evidenceRef: string,
  ) => Promise<DataRegistrationSigningAttempt>;
  readonly persistPreparedTransaction: (
    submissionAttemptId: string,
    signedTransaction: Uint8Array,
    signedTransactionHash: string,
    evidenceRef: string,
  ) => Promise<DataRegistrationSigningAttempt>;
  readonly markBroadcast: (
    submissionAttemptId: string,
    transactionHash: string,
    evidenceRef: string,
  ) => Promise<DataRegistrationSigningAttempt>;
  readonly markReplaced: (
    supersededSubmissionAttemptId: string,
    replacementSubmissionAttemptId: string,
    evidenceRef: string,
  ) => Promise<DataRegistrationSigningAttempt>;
  readonly recordReceipt: (
    observation: DataRegistrationReceiptInput,
  ) => Promise<"created" | "replay">;
  readonly markMined: (
    submissionAttemptId: string,
    evidenceRef: string,
  ) => Promise<DataRegistrationSigningAttempt>;
  readonly confirmRegistration: (
    observation: ConfirmDataRegistrationInput,
  ) => Promise<DataRegistrationOperation>;
  readonly failRegistration: (
    input: Readonly<{
      registrationOperationId: string;
      submissionAttemptId: string | null;
      operationState: "failed" | "reconciliation_required";
      operationFailureCode: DataRegistrationFailureCode;
      attemptFailureCode: DataRegistrationAttemptFailureCode | null;
      evidenceRef: string;
    }>,
  ) => Promise<DataRegistrationOperation>;
  readonly replaceMissingWorkflow: (
    registrationOperationId: string,
    expectedWorkflowRevision: bigint,
  ) => Promise<Readonly<{ operation: DataRegistrationOperation; outbox: DataRegistrationOutbox }>>;
  readonly getOutbox: (outboxId: string) => Promise<DataRegistrationOutbox | null>;
  readonly listEligibleOutbox: (limit: number) => Promise<readonly DataRegistrationOutbox[]>;
  readonly claimOutbox: (
    outboxId: string,
    workerId: string,
    leaseSeconds: number,
  ) => Promise<DataRegistrationOutbox | null>;
  readonly completeOutbox: (
    outboxId: string,
    workerId: string,
    claimFence: bigint,
  ) => Promise<boolean>;
  readonly failOutbox: (
    input: Readonly<{
      outboxId: string;
      workerId: string;
      claimFence: bigint;
      failureCode: "queue_unavailable" | "workflow_unavailable" | "invalid_binding";
      nextEligibleAt: string | null;
    }>,
  ) => Promise<boolean>;
}

export const deterministicDataRegistrationOperationId = (
  chainId: bigint,
  assetId: string,
  registrationRevision: bigint,
): string => `data-registration:${chainId}:${assetId}:${registrationRevision}`;

export const deterministicDataRegistrationWorkflowId = (
  operationId: string,
  workflowRevision: bigint,
): string => `data-registration-workflow:${operationId}:r${workflowRevision}`;

export const deterministicDataRegistrationOutboxId = (
  operationId: string,
  workflowRevision: bigint,
): string => `${operationId}:outbox:r${workflowRevision}`;

export const deterministicDataRegistrationArtifactId = (
  operationId: string,
  artifactKind: DataRegistrationArtifactKind,
): string => `${operationId}:artifact:${artifactKind}`;

export const deterministicDataRegistrationAttemptId = (
  operationId: string,
  attemptNumber: number,
): string => `${operationId}:attempt:${attemptNumber}`;

export const deterministicDataRegistrationSigningIntentId = (attemptId: string): string =>
  `${attemptId}:signing-intent`;

export const deterministicDataRegistrationTransitionId = (
  attemptId: string,
  sequence: bigint,
): string => `${attemptId}:transition:${sequence}`;

export const deterministicDataRegistrationReceiptId = (
  attemptId: string,
  sequence: bigint,
): string => `${attemptId}:receipt:${sequence}`;
