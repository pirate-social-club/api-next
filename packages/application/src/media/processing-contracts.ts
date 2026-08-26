import type {
  MediaTransformAudioSampleOutcome,
  MediaTransformProbeOutcome,
  MediaTransformService,
} from "../media/transform.ts";
import type {
  MediaIdentificationOutcome,
  MediaIdentificationProviderService,
} from "../media-identification-provider.ts";
import type {
  MediaAsrAdapter,
  MediaAsrResult,
  MediaExplicitnessClassifierAdapter,
  MediaExplicitnessClassifierResult,
  MediaTranscriptArtifact,
} from "../media-provider-contracts.ts";

const identifierPattern = /^\S(?:.*\S)?$/u;

export const isMediaProcessingIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.includes("\u0000") &&
  identifierPattern.test(value);

export type MediaProcessingQueueMessage = Readonly<{ readonly outbox_id: string }>;

/** Queue bodies carry exactly one durable lookup identity and no business data. */
export function decodeMediaProcessingQueueMessage(input: unknown): MediaProcessingQueueMessage {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("media processing queue payload must be an object");
  }
  const value = input as Readonly<Record<string, unknown>>;
  if (
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "outbox_id") ||
    !isMediaProcessingIdentifier(value.outbox_id)
  ) {
    throw new TypeError("media processing queue payload must contain only outbox_id");
  }
  return Object.freeze({ outbox_id: value.outbox_id });
}

export type MediaProcessingWorkflowPayload = Readonly<{
  readonly outboxId: string;
  readonly submissionId: string;
  readonly operationId: string;
  readonly workflowRevision: number;
}>;

/** Workflow parameters are a closed identifier set. Media references and hashes are reloaded. */
export function decodeMediaProcessingWorkflowPayload(
  input: unknown,
): MediaProcessingWorkflowPayload {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("media processing workflow payload must be an object");
  }
  const value = input as Readonly<Record<string, unknown>>;
  if (
    Object.keys(value).sort().join(",") !== "operationId,outboxId,submissionId,workflowRevision" ||
    !isMediaProcessingIdentifier(value.outboxId) ||
    !isMediaProcessingIdentifier(value.submissionId) ||
    !isMediaProcessingIdentifier(value.operationId) ||
    !Number.isSafeInteger(value.workflowRevision) ||
    (value.workflowRevision as number) < 1
  ) {
    throw new TypeError("media processing workflow payload is not a closed identifier payload");
  }
  return Object.freeze({
    outboxId: value.outboxId,
    submissionId: value.submissionId,
    operationId: value.operationId,
    workflowRevision: value.workflowRevision as number,
  });
}

export type MediaProcessingEventType =
  | "analysis_launch"
  | "decision_wakeup"
  | "publication"
  | "alignment"
  | "workflow_replacement";

export type MediaProcessingOutboxRecord = Readonly<{
  readonly outboxId: string;
  readonly eventType: MediaProcessingEventType;
  readonly submissionId: string;
  readonly operationId: string;
  readonly workflowRevision: number;
  readonly workflowInstanceId: string;
  readonly deliveryAttempts: number;
  readonly state: "pending" | "running" | "delivered" | "failed" | "exhausted";
  readonly claimFence: number;
  readonly claimOwner: string | null;
}>;

export type MediaProcessingLyrics = Readonly<{
  readonly lyricsRevision: number;
  readonly audioRevision: number;
  readonly canonicalAudioSha256: string;
  readonly text: string;
  readonly baseTranscriptRevision: number | null;
}>;

export type MediaProcessingAuthority = Readonly<{
  readonly communityId: string;
  readonly actorAccountId: string;
  readonly authorPersonaId: string;
  readonly submissionId: string;
  readonly operationId: string;
  readonly songType: "original" | "remix";
  readonly creationRevision: number;
  readonly audioRevision: number;
  readonly analysisRevision: number;
  readonly decisionRevision: number;
  readonly workflowRevision: number;
  readonly status:
    | "processing"
    | "action_required"
    | "manual_review"
    | "published"
    | "blocked"
    | "processing_failed"
    | "abandoned";
  readonly phase: "analysis" | "decision" | "publish" | null;
  readonly audio: Readonly<{
    readonly immutableRef: string;
    readonly canonicalSha256: string;
    readonly contentType: string;
    readonly sizeBytes: number;
  }> | null;
  readonly termsRevision: number | null;
  readonly lyrics: MediaProcessingLyrics | null;
  readonly transcript: MediaTranscriptArtifact | null;
  readonly analysis: MediaProcessingAnalysis | null;
  readonly decision: MediaProcessingDecision | null;
  readonly boundReferenceAssetId: string | null;
  readonly postId: string | null;
  readonly publishedLyricsRevision: number | null;
}>;

export type MediaProcessingEmbeddedMetadata = Readonly<{
  readonly evidenceRef: string;
  readonly adapterRevision: string;
  readonly trackTitle: string | null;
  readonly cover:
    | Readonly<{
        readonly status: "ready";
        readonly artifactRef: string;
        readonly artifactSha256: string;
        readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
        readonly width: number;
        readonly height: number;
        readonly normalizationRevision: string;
        readonly safetyPolicyRevision: string;
      }>
    | Readonly<{ readonly status: "absent"; readonly reasonCode: "not_embedded" }>
    | Readonly<{
        readonly status: "rejected";
        readonly reasonCode: "invalid" | "unsafe" | "limits_exceeded";
      }>;
}>;

export type MediaProcessingAnalysis = Readonly<{
  readonly audioRevision: number;
  readonly analysisRevision: number;
  readonly canonicalAudioSha256: string;
  readonly probeEvidenceRef: string;
  readonly embeddedMetadata: MediaProcessingEmbeddedMetadata;
  readonly speech:
    | Readonly<{
        readonly status: "ready";
        readonly transcriptRevision: number;
        readonly lyricsRevision: number;
        readonly materialDisagreement: boolean;
        readonly explicitness: "not_explicit" | "explicit" | "uncertain";
        readonly primaryLanguageBcp47: string;
        readonly secondaryLanguageBcp47: string | null;
        readonly evidenceRef: string;
        readonly policyRevision: string;
        readonly adapterRevision: string;
      }>
    | Readonly<{
        readonly status: "no_speech";
        readonly evidenceRef: string;
        readonly policyRevision: string;
        readonly adapterRevision: string;
      }>
    | Readonly<{
        readonly status: "unavailable";
        readonly evidenceRef: string;
        readonly policyRevision: string;
        readonly adapterRevision: string;
      }>;
  readonly acr: Readonly<{
    readonly decision: "allow" | "requires_reference" | "inconclusive" | "skipped";
    readonly evidenceRef: string;
    readonly policyRevision: string;
    readonly adapterRevision: string;
  }>;
  readonly lyricsSafety: "skipped" | "allow" | "review_required" | "blocked";
  readonly mediaSafety: "allow" | "draft" | "review_required" | "blocked";
}>;

export type MediaProcessingDecision = Readonly<{
  readonly decisionRevision: number;
  readonly creationRevision: number;
  readonly audioRevision: number;
  readonly analysisRevision: number;
  readonly lyricsRevision: number | null;
  readonly canonicalAudioSha256: string;
  readonly outcome: "allow" | "manual_review" | "block" | "reference_required";
  readonly evidenceRef: string;
  readonly policyRevision: string;
}>;

export type MediaProcessingAttemptStage =
  | "probe"
  | "sample_primary"
  | "sample_alternate"
  | "acr_primary"
  | "acr_alternate"
  | "metadata"
  | "asr"
  | "classifier"
  | "media_safety"
  | "publication"
  | "alignment";

export type MediaProcessingAttemptResult =
  | Readonly<{ readonly kind: "probe"; readonly value: MediaTransformProbeOutcome }>
  | Readonly<{ readonly kind: "sample"; readonly value: MediaTransformAudioSampleOutcome }>
  | Readonly<{ readonly kind: "acr"; readonly value: MediaIdentificationOutcome }>
  | Readonly<{ readonly kind: "asr"; readonly value: MediaAsrResult }>
  | Readonly<{
      readonly kind: "classifier";
      readonly value: MediaExplicitnessClassifierResult;
    }>
  | Readonly<{ readonly kind: "metadata"; readonly value: MediaProcessingEmbeddedMetadata }>
  | Readonly<{
      readonly kind: "media_safety";
      readonly value: "allow" | "draft" | "review_required" | "blocked";
    }>
  | Readonly<{ readonly kind: "publication"; readonly postId: string }>
  | Readonly<{
      readonly kind: "alignment";
      readonly status: "ready" | "unavailable";
      readonly artifactRef?: string;
    }>;

export type MediaProcessingAttemptLease = Readonly<{
  readonly attemptId: string;
  readonly stage: MediaProcessingAttemptStage;
  readonly claimOwner: string;
  readonly claimFence: number;
}>;

export type MediaProcessingAttemptStart =
  | Readonly<{ readonly kind: "run"; readonly lease: MediaProcessingAttemptLease }>
  | Readonly<{ readonly kind: "replay"; readonly result: MediaProcessingAttemptResult }>
  | Readonly<{ readonly kind: "busy" | "exhausted" }>;

export type MediaProcessingCommit = "committed" | "replay" | "stale";

export interface MediaProcessingStore {
  readonly getOutbox: (outboxId: string) => Promise<MediaProcessingOutboxRecord | null>;
  readonly claimOutbox: (
    outboxId: string,
    workerId: string,
  ) => Promise<MediaProcessingOutboxRecord | null>;
  readonly completeOutbox: (record: MediaProcessingOutboxRecord) => Promise<boolean>;
  readonly failOutbox: (
    record: MediaProcessingOutboxRecord,
    failure: "provider_unavailable" | "provider_timeout" | "provider_invalid",
  ) => Promise<boolean>;
  readonly loadAuthority: (
    submissionId: string,
    operationId: string,
  ) => Promise<MediaProcessingAuthority | null>;
  readonly startAttempt: (input: {
    readonly authority: MediaProcessingAuthority;
    readonly stage: MediaProcessingAttemptStage;
    readonly attemptId: string;
    readonly workerId: string;
    readonly inputRevision: number;
    readonly inputHash: string;
    readonly policyRevision: string;
    readonly adapterRevision: string;
  }) => Promise<MediaProcessingAttemptStart>;
  readonly completeAttempt: (
    lease: MediaProcessingAttemptLease,
    result: MediaProcessingAttemptResult,
  ) => Promise<boolean>;
  readonly failAttempt: (
    lease: MediaProcessingAttemptLease,
    failure: "provider_unavailable" | "provider_timeout" | "provider_invalid",
    retryable: boolean,
  ) => Promise<boolean>;
  readonly commitTranscript: (
    authority: MediaProcessingAuthority,
    transcript: MediaTranscriptArtifact,
  ) => Promise<MediaProcessingCommit>;
  readonly commitAnalysis: (
    authority: MediaProcessingAuthority,
    analysis: MediaProcessingAnalysis,
  ) => Promise<MediaProcessingCommit>;
  readonly commitDecision: (
    authority: MediaProcessingAuthority,
    decision: MediaProcessingDecision,
  ) => Promise<MediaProcessingCommit>;
  readonly commitPublication: (
    authority: MediaProcessingAuthority,
  ) => Promise<MediaProcessingCommit>;
  readonly commitAlignment: (
    authority: MediaProcessingAuthority,
    result: Extract<MediaProcessingAttemptResult, { readonly kind: "alignment" }>,
  ) => Promise<MediaProcessingCommit>;
  readonly commitProcessingFailure: (
    authority: MediaProcessingAuthority,
    reason: "invalid_media" | "probe_failed" | "transform_failed",
  ) => Promise<MediaProcessingCommit>;
  readonly commitProviderUnavailableReview: (
    authority: MediaProcessingAuthority,
    reason: "disabled" | "missing_provider" | "provider_exhausted",
  ) => Promise<MediaProcessingCommit>;
  readonly replaceMissingWorkflow: (
    authority: MediaProcessingAuthority,
  ) => Promise<MediaProcessingCommit>;
  readonly listWorkflowCandidates: () => Promise<readonly MediaProcessingAuthority[]>;
}

export interface MediaProcessingArtifactReader {
  readonly readAudioSample: (
    objectKey: string,
    maximumBytes: number,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
}

export interface MediaProcessingMetadataPort {
  readonly extract: (
    authority: MediaProcessingAuthority,
    signal: AbortSignal,
  ) => Promise<MediaProcessingEmbeddedMetadata>;
}

export interface MediaProcessingSafetyPort {
  readonly reviewAudio: (
    authority: MediaProcessingAuthority,
    signal: AbortSignal,
  ) => Promise<"allow" | "draft" | "review_required" | "blocked">;
}

export interface MediaProcessingAlignmentPort {
  readonly align: (
    input: Readonly<{
      operationId: string;
      postId: string;
      audioRevision: number;
      analysisRevision: number;
      lyricsRevision: number;
      canonicalAudioSha256: string;
      audioArtifactRef: string;
      lyrics: string;
      signal: AbortSignal;
    }>,
  ) => Promise<
    | Readonly<{ readonly status: "ready"; readonly artifactRef: string }>
    | Readonly<{ readonly status: "unavailable" }>
  >;
}

export type MediaProcessingProviders = Readonly<{
  readonly transform: MediaTransformService;
  readonly identification: MediaIdentificationProviderService;
  readonly asr: MediaAsrAdapter;
  readonly classifier: MediaExplicitnessClassifierAdapter;
  readonly artifactReader: MediaProcessingArtifactReader;
  readonly metadata: MediaProcessingMetadataPort;
  readonly safety: MediaProcessingSafetyPort;
  readonly alignment: MediaProcessingAlignmentPort;
}>;

export interface MediaProcessingWorkflowLauncher {
  readonly get: (instanceId: string) => Promise<"present" | "missing">;
  readonly create: (
    instanceId: string,
    payload: MediaProcessingWorkflowPayload,
  ) => Promise<"created" | "already_exists">;
  readonly notify: (
    instanceId: string,
    eventType: MediaProcessingEventType,
    payload: MediaProcessingWorkflowPayload,
  ) => Promise<void>;
}

export type MediaProcessingObservation = Readonly<{
  readonly event:
    | "queue_ack"
    | "queue_retry"
    | "queue_dlq"
    | "workflow_converged"
    | "workflow_waiting"
    | "workflow_terminal"
    | "attempt_started"
    | "attempt_replayed"
    | "attempt_completed"
    | "attempt_failed"
    | "workflow_replaced";
  readonly operationId?: string;
  readonly submissionId?: string;
  readonly outboxId?: string;
  readonly workflowRevision?: number;
  readonly stage?: MediaProcessingAttemptStage;
}>;

export type MediaProcessingObserver = (observation: MediaProcessingObservation) => void;
