export const DATA_REGISTRATION_PERSISTENCE_VERSION = "data-registration-persistence-v1" as const;

export type DataRegistrationOperationState =
  | "pending"
  | "waiting_parent"
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
  | "canonical_video"
  | "normalized_artwork"
  | "poster"
  | "ip_metadata"
  | "nft_metadata";

export type DataRegistrationPinRole = "primary" | "independent_gateway";

export type DataRegistrationFailureCode =
  | "pin_verification_failed"
  | "signing_failed"
  | "broadcast_failed"
  | "receipt_reverted"
  | "confirmation_timeout"
  | "chain_reorganization"
  | "invalid_receipt"
  | "configuration_invalid"
  | DataRegistrationParentFailureCode;

/** Spec 008 section 3A: why a derivative cannot register against its parent. */
export type DataRegistrationParentFailureCode =
  /** The parent's own registration failed. */
  | "parent_registration_failed"
  /** The parent's attached terms differ from the license frozen at publication. */
  | "parent_license_mismatch"
  /** The parent's attached terms do not allow derivatives at all. */
  | "parent_derivatives_not_permitted"
  /** The parent confirmed before its attached terms were recorded. */
  | "parent_terms_unrecorded";

export type DataRegistrationAttemptFailureCode = Exclude<
  DataRegistrationFailureCode,
  "pin_verification_failed" | "configuration_invalid" | DataRegistrationParentFailureCode
>;

export type DataLicensePreset = "non-commercial" | "commercial-use" | "commercial-remix";

/**
 * Whether the PIL terms a preset attaches allow derivatives. Commercial-use
 * terms do not, so nothing can register as a derivative against them.
 */
export const dataLicensePresetAllowsDerivatives = (preset: DataLicensePreset): boolean =>
  preset !== "commercial-use";

export type DataReceiptCoordinates = Readonly<{
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  logIndex: number;
}>;

/**
 * The terms a song attached when it registered, as its confirmed row retains
 * them: the template and terms id decoded from the attaching event, and the
 * preset and share those terms were built from.
 */
export type DataAttachedLicense = Readonly<{
  licenseTemplate: string;
  licenseTermsId: string;
  preset: DataLicensePreset;
  /** Present exactly under `commercial-remix`. */
  commercialRevShareBps: number | null;
  attachment: DataReceiptCoordinates;
}>;

/** A derivative's frozen parent, named only by local identity (Spec 008 `DataParentReferenceV1`). */
export type DataParentReference = Readonly<{
  registrationOperationId: string;
  relationship: "references_song";
  parentAssetId: string;
  parentRegistrationOperationId: string;
  expectedLicense: Readonly<{ preset: DataLicensePreset; commercialRevShareBps: number | null }>;
  ownerPolicy: Readonly<{
    revision: bigint;
    hash: string;
    derivativeVideo: "allowed" | "owner_only";
  }>;
}>;

/** Append-only evidence read from the parent's confirmed row (Spec 008 `DataParentResolutionV1`). */
export type DataParentResolution = Readonly<{
  registrationOperationId: string;
  parentRegistrationOperationId: string;
  parentRegistrationRevision: bigint;
  parentIpId: string;
  consumedLicense: Readonly<{
    licenseTemplate: string;
    licenseTermsId: string;
    preset: DataLicensePreset;
    commercialRevShareBps: number | null;
  }>;
  parentRegistration: DataReceiptCoordinates;
  termsAttachment: DataReceiptCoordinates;
  resolvedAt: string;
}>;

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
  mediaKind: "song" | "video";
  rightsBasis: "original" | "derivative";
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
  /** Set only on a registered song confirmed with its attached terms recorded. */
  attachedLicense: DataAttachedLicense | null;
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
  targetAddress: string;
  methodSelector: string;
  calldataHash: string;
  signingDeadline: string;
  valueWei: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
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
  targetAddress: string;
  methodSelector: string;
  calldataHash: string;
  signingDeadline: string;
  valueWei: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
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
  /** Required for a song, whose confirmation includes the terms it attached; null for a video. */
  attachedLicense: DataAttachedLicense | null;
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
  /** The derivative's frozen parent reference, or null for an original. */
  readonly getParentReference: (
    registrationOperationId: string,
  ) => Promise<DataParentReference | null>;
  readonly getParentResolution: (
    registrationOperationId: string,
  ) => Promise<DataParentResolution | null>;
  /** Moves a pending derivative to `waiting_parent`; a waiting one is returned unchanged. */
  readonly awaitParent: (registrationOperationId: string) => Promise<DataRegistrationOperation>;
  /**
   * Records the resolution and returns the derivative to `pending` in one
   * transaction. The resolved time is the database's.
   */
  readonly resolveParent: (
    resolution: Omit<DataParentResolution, "resolvedAt">,
  ) => Promise<Readonly<{ kind: "created" | "replay"; resolution: DataParentResolution }>>;
  /**
   * Spec 008 section 3A: fills the terms a registered song actually attached
   * when its confirmation predates that evidence. The registration is
   * untouched: only a registered song with no recorded terms may be filled,
   * in place, from the transaction that confirmed it. Recorded terms are never
   * rewritten.
   */
  readonly recordAttachedLicenseBackfill: (
    registrationOperationId: string,
    attachedLicense: DataAttachedLicense,
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
