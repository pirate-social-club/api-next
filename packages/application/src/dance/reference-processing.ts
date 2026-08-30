import { Data, Effect, Schema } from "effect";

const Identifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
      ? undefined
      : "Expected a bounded canonical identifier",
  ),
);
const ObjectKey = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 2_048 &&
    value.trim() === value &&
    !value.includes("\u0000") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !value.startsWith("http://") &&
    !value.startsWith("https://")
      ? undefined
      : "Expected a private server-owned object reference",
  ),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const NonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const SignedInteger = Schema.Int.check(
  Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);
const BasisPoints = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }));
const AttemptNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }));
const FailureCode = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 256 && value.trim() === value && !value.includes("\u0000")
      ? undefined
      : "Expected a bounded failure code",
  ),
);

const CanonicalAudio = Schema.Struct({
  objectKey: ObjectKey,
  sha256: Sha256,
  durationMs: PositiveInteger,
  audioRevision: PositiveInteger,
});
const ReferenceVideo = Schema.Struct({
  postId: Identifier,
  objectKey: ObjectKey,
  sha256: Sha256,
  durationMs: PositiveInteger,
});
const SegmentProfile = Schema.Struct({
  sampleRateHz: Schema.Int.check(Schema.isBetween({ minimum: 8_000, maximum: 192_000 })),
  channels: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
  codec: Schema.Literals(["flac", "pcm_s16le", "pcm_s24le", "wav"]),
});
const AlignmentLimits = Schema.Struct({
  maximumAbsoluteOffsetMs: NonNegativeInteger,
  maximumAbsoluteDriftMs: NonNegativeInteger,
  maximumAbsoluteSlopeDeltaPpm: NonNegativeInteger,
  minimumOverallConfidenceBps: BasisPoints,
  minimumCoverageBps: BasisPoints,
  minimumSoundtrackMatchBps: BasisPoints,
});

/** Exact request material persisted before any reference-provider effect. */
export const FrozenDanceReferenceInput = Schema.Struct({
  version: Schema.Literal("frozen-dance-reference-input-v1"),
  effectIdentity: Identifier,
  choreographyId: Identifier,
  choreographyRevision: PositiveInteger,
  revisionTermsHash: Sha256,
  canonicalAudio: CanonicalAudio,
  referenceVideo: ReferenceVideo,
  requestedStartMs: NonNegativeInteger,
  requestedEndMs: PositiveInteger,
  segmentTermsHash: Sha256,
  mirrorPolicy: Schema.Literals(["strict", "allowed"]),
  outputs: Schema.Struct({
    segmentId: Identifier,
    segmentObjectKey: ObjectKey,
    artifactId: Identifier,
    artifactObjectKey: ObjectKey,
    evidenceObjectKey: ObjectKey,
  }),
  extraction: Schema.Struct({
    policyVersion: Identifier,
    outputProfile: SegmentProfile,
  }),
  alignment: Schema.Struct({
    policyVersion: Identifier,
    adapterId: Identifier,
    adapterRevision: Identifier,
    limits: AlignmentLimits,
  }),
  pose: Schema.Struct({
    modelVersion: Identifier,
    runtimeVersion: Identifier,
    featureSchemaVersion: Identifier,
    scorerContractVersion: Identifier,
    fingerprintPolicyVersion: Identifier,
    integrityPolicyVersion: Identifier,
  }),
  qualityLimits: Schema.Struct({
    minimumUsableCoverageBps: BasisPoints,
    maximumMissingGapSlots: NonNegativeInteger,
    minimumBodyCoverageBps: BasisPoints,
    minimumVisibilityCoverageBps: BasisPoints,
    minimumMotionEnergyBps: BasisPoints,
    minimumSpatialExtentBps: BasisPoints,
  }),
  ownerPolicy: Schema.Struct({ revision: PositiveInteger, hash: Sha256 }),
}).check(
  Schema.makeFilter(({ canonicalAudio, requestedStartMs, requestedEndMs }) => {
    const durationMs = requestedEndMs - requestedStartMs;
    return requestedEndMs <= canonicalAudio.durationMs &&
      durationMs >= 6_000 &&
      durationMs <= 30_000
      ? undefined
      : "Expected a valid half-open Dance reference interval";
  }),
);
export type FrozenDanceReferenceInput = Schema.Schema.Type<typeof FrozenDanceReferenceInput>;

export const DanceReferenceProcessingBinding = Schema.Struct({
  version: Schema.Literal("dance-reference-processing-binding-v1"),
  effectIdentity: Identifier,
  requestId: Identifier,
  choreographyId: Identifier,
  choreographyRevision: PositiveInteger,
  attemptNumber: AttemptNumber,
  inputDigest: Sha256,
  adapterId: Identifier,
  adapterRevision: Identifier,
});
export type DanceReferenceProcessingBinding = Schema.Schema.Type<
  typeof DanceReferenceProcessingBinding
>;

export const PreparedDanceReferenceOperation = Schema.Struct({
  version: Schema.Literal("prepared-dance-reference-operation-v1"),
  binding: DanceReferenceProcessingBinding,
  providerOperationId: Identifier,
});
export type PreparedDanceReferenceOperation = Schema.Schema.Type<
  typeof PreparedDanceReferenceOperation
>;

const SegmentArtifact = Schema.Struct({
  segmentId: Identifier,
  objectKey: ObjectKey,
  sha256: Sha256,
  sourceSha256: Sha256,
  startMs: NonNegativeInteger,
  endMs: PositiveInteger,
  durationMs: PositiveInteger,
  extractionPolicyVersion: Identifier,
  segmentTermsHash: Sha256,
});
const AlignmentEvidence = Schema.Struct({
  videoSha256: Sha256,
  songAudioSha256: Sha256,
  requestedStartMs: NonNegativeInteger,
  requestedEndMs: PositiveInteger,
  referenceVideoScoredStartMs: NonNegativeInteger,
  referenceVideoScoredEndMs: PositiveInteger,
  detectedSongOffsetMs: SignedInteger,
  alignmentPolicyVersion: Identifier,
  alignmentRevision: Identifier,
  driftMetrics: Schema.Struct({
    maximumAbsoluteDriftMs: NonNegativeInteger,
    p95AbsoluteDriftMs: NonNegativeInteger,
    slopeDeltaPpm: SignedInteger,
  }),
  confidenceMetrics: Schema.Struct({
    overallBps: BasisPoints,
    coverageBps: BasisPoints,
    soundtrackMatchBps: BasisPoints,
  }),
  continuousMapping: Schema.Literal(true),
  timeStretchDetected: Schema.Literal(false),
});
const ReferenceArtifact = Schema.Struct({
  artifactId: Identifier,
  privateArtifactRef: ObjectKey,
  artifactSha256: Sha256,
  poseModelVersion: Identifier,
  poseRuntimeVersion: Identifier,
  featureSchemaVersion: Identifier,
  scorerContractVersion: Identifier,
  integrityPolicyVersion: Identifier,
  referenceDurationMs: PositiveInteger,
  width: PositiveInteger,
  height: PositiveInteger,
  frameRateNumerator: PositiveInteger,
  frameRateDenominator: PositiveInteger,
  usableFrameSummary: Schema.Struct({
    totalTimelineSlots: PositiveInteger,
    usableTimelineSlots: PositiveInteger,
    coverageBps: BasisPoints,
    maximumMissingGapSlots: NonNegativeInteger,
    bodyCoverageBps: BasisPoints,
    visibilityCoverageBps: BasisPoints,
    stablePrincipalTrackCount: Schema.Literal(1),
    subjectContinuityAmbiguous: Schema.Literal(false),
    motionEnergyBps: BasisPoints,
    spatialExtentBps: BasisPoints,
  }),
});
const TerminalEvidence = Schema.Struct({
  evidenceRef: ObjectKey,
  evidenceDigest: Sha256,
  resultDigest: Sha256,
  bodyCoverageAccepted: Schema.Literal(true),
  timelineEvidenceAccepted: Schema.Literal(true),
  visibilityEvidenceAccepted: Schema.Literal(true),
  subjectContinuityAccepted: Schema.Literal(true),
  meaningfulMotionAccepted: Schema.Literal(true),
});

export const DanceReferenceOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending"),
    binding: DanceReferenceProcessingBinding,
  }),
  Schema.Struct({
    status: Schema.Literal("retryable_failure"),
    binding: DanceReferenceProcessingBinding,
    reason: FailureCode,
    evidenceRef: ObjectKey,
    resultDigest: Sha256,
    retryAfterMs: Schema.optional(PositiveInteger),
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    binding: DanceReferenceProcessingBinding,
    reason: FailureCode,
    evidenceRef: ObjectKey,
    evidenceDigest: Sha256,
    resultDigest: Sha256,
  }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    binding: DanceReferenceProcessingBinding,
    segment: SegmentArtifact,
    alignment: AlignmentEvidence,
    artifact: ReferenceArtifact,
    evidence: TerminalEvidence,
  }),
]);
export type DanceReferenceOutcome = Schema.Schema.Type<typeof DanceReferenceOutcome>;

export class DanceReferenceProcessingInvalid extends Data.TaggedError(
  "DanceReferenceProcessingInvalid",
)<{
  readonly phase: "input" | "prepared" | "outcome";
  readonly reason: string;
}> {}

export interface DanceReferenceProcessorService {
  readonly prepareReference: (
    input: FrozenDanceReferenceInput,
    binding: DanceReferenceProcessingBinding,
  ) => Effect.Effect<PreparedDanceReferenceOperation, DanceReferenceProcessingInvalid>;
  readonly observeReference: (
    operation: PreparedDanceReferenceOperation,
  ) => Effect.Effect<DanceReferenceOutcome, DanceReferenceProcessingInvalid>;
}

export type DanceReferenceProcessingClaim = Readonly<{
  readonly frozenInput: FrozenDanceReferenceInput;
  readonly canonicalRequest: string;
  readonly inputDigest: string;
  readonly binding: DanceReferenceProcessingBinding;
  readonly claimOwner: string;
  readonly claimFence: number;
  readonly preparedOperation: PreparedDanceReferenceOperation | null;
}>;

export type DanceReferenceProcessingClaimResult =
  | Readonly<{ readonly kind: "claimed"; readonly claim: DanceReferenceProcessingClaim }>
  | Readonly<{ readonly kind: "busy" }>
  | Readonly<{ readonly kind: "terminal"; readonly status: "ready" | "processing_failed" }>;

export interface DanceReferenceProcessingStore {
  readonly claim: (input: {
    readonly choreographyId: string;
    readonly choreographyRevision: number;
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly adapterId: string;
    readonly adapterRevision: string;
    readonly request?: Readonly<{
      readonly frozenInput: FrozenDanceReferenceInput;
      readonly canonicalRequest: string;
      readonly inputDigest: string;
    }>;
  }) => Promise<DanceReferenceProcessingClaimResult>;
  readonly recordPrepared: (
    claim: DanceReferenceProcessingClaim,
    operation: PreparedDanceReferenceOperation,
  ) => Promise<boolean>;
  readonly complete: (
    claim: DanceReferenceProcessingClaim,
    outcome: Exclude<DanceReferenceOutcome, { readonly status: "pending" }>,
  ) => Promise<"committed" | "replayed" | "stale">;
}

export type RunDanceReferenceProcessingInput = Readonly<{
  readonly choreographyId: string;
  readonly choreographyRevision: number;
  readonly workerId: string;
  readonly leaseSeconds: number;
  readonly adapterId: string;
  readonly adapterRevision: string;
  /** Present on initial dispatch; recovery deliberately omits it. */
  readonly frozenInput?: unknown;
}>;

export type DanceReferenceProcessingDisposition =
  | Readonly<{ readonly kind: "busy" | "pending" | "stale" }>
  | Readonly<{ readonly kind: "terminal"; readonly status: "ready" | "processing_failed" }>
  | Readonly<{ readonly kind: "committed" | "replayed"; readonly status: "ready" | "failed" }>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function freezeDanceReferenceInput(input: unknown): Promise<
  Readonly<{
    readonly frozenInput: FrozenDanceReferenceInput;
    readonly canonicalRequest: string;
    readonly inputDigest: string;
  }>
> {
  let frozenInput: FrozenDanceReferenceInput;
  try {
    frozenInput = Schema.decodeUnknownSync(FrozenDanceReferenceInput, {
      onExcessProperty: "error",
    })(input);
  } catch {
    throw new DanceReferenceProcessingInvalid({ phase: "input", reason: "invalid_request" });
  }
  const canonicalRequest = canonicalJson(frozenInput);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest));
  return Object.freeze({
    frozenInput: Object.freeze(frozenInput),
    canonicalRequest,
    inputDigest: hex(new Uint8Array(digest)),
  });
}

export async function freezePreparedDanceReferenceOperation(input: unknown): Promise<
  Readonly<{
    readonly operation: PreparedDanceReferenceOperation;
    readonly canonicalOperation: string;
    readonly operationDigest: string;
  }>
> {
  let operation: PreparedDanceReferenceOperation;
  try {
    operation = Schema.decodeUnknownSync(PreparedDanceReferenceOperation, {
      onExcessProperty: "error",
    })(input);
  } catch {
    throw new DanceReferenceProcessingInvalid({
      phase: "prepared",
      reason: "invalid_prepared_operation",
    });
  }
  const canonicalOperation = canonicalJson(operation);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalOperation),
  );
  return Object.freeze({
    operation: Object.freeze(operation),
    canonicalOperation,
    operationDigest: hex(new Uint8Array(digest)),
  });
}

function sameBinding(
  left: DanceReferenceProcessingBinding,
  right: DanceReferenceProcessingBinding,
): boolean {
  return (
    left.version === right.version &&
    left.effectIdentity === right.effectIdentity &&
    left.requestId === right.requestId &&
    left.choreographyId === right.choreographyId &&
    left.choreographyRevision === right.choreographyRevision &&
    left.attemptNumber === right.attemptNumber &&
    left.inputDigest === right.inputDigest &&
    left.adapterId === right.adapterId &&
    left.adapterRevision === right.adapterRevision
  );
}

function decodePrepared(
  claim: DanceReferenceProcessingClaim,
  value: unknown,
): PreparedDanceReferenceOperation {
  try {
    const decoded = Schema.decodeUnknownSync(PreparedDanceReferenceOperation, {
      onExcessProperty: "error",
    })(value);
    if (!sameBinding(claim.binding, decoded.binding)) throw new Error("binding");
    return decoded;
  } catch {
    throw new DanceReferenceProcessingInvalid({
      phase: "prepared",
      reason: "prepared_operation_mismatch",
    });
  }
}

function decodeOutcome(
  claim: DanceReferenceProcessingClaim,
  value: unknown,
): DanceReferenceOutcome {
  let decoded: DanceReferenceOutcome;
  try {
    decoded = Schema.decodeUnknownSync(DanceReferenceOutcome, { onExcessProperty: "error" })(value);
  } catch {
    throw new DanceReferenceProcessingInvalid({ phase: "outcome", reason: "invalid_shape" });
  }
  if (!sameBinding(claim.binding, decoded.binding)) {
    throw new DanceReferenceProcessingInvalid({ phase: "outcome", reason: "binding_mismatch" });
  }
  if (decoded.status !== "ready") return decoded;
  const input = claim.frozenInput;
  const durationMs = input.requestedEndMs - input.requestedStartMs;
  const alignment = decoded.alignment;
  const segment = decoded.segment;
  const artifact = decoded.artifact;
  const summary = artifact.usableFrameSummary;
  const quality = input.qualityLimits;
  if (
    segment.sourceSha256 !== input.canonicalAudio.sha256 ||
    segment.startMs !== input.requestedStartMs ||
    segment.endMs !== input.requestedEndMs ||
    segment.durationMs !== durationMs ||
    segment.extractionPolicyVersion !== input.extraction.policyVersion ||
    segment.segmentTermsHash !== input.segmentTermsHash ||
    segment.segmentId !== input.outputs.segmentId ||
    segment.objectKey !== input.outputs.segmentObjectKey ||
    alignment.videoSha256 !== input.referenceVideo.sha256 ||
    alignment.songAudioSha256 !== input.canonicalAudio.sha256 ||
    alignment.requestedStartMs !== input.requestedStartMs ||
    alignment.requestedEndMs !== input.requestedEndMs ||
    alignment.referenceVideoScoredEndMs - alignment.referenceVideoScoredStartMs !== durationMs ||
    alignment.referenceVideoScoredEndMs > input.referenceVideo.durationMs ||
    alignment.referenceVideoScoredStartMs - input.requestedStartMs !==
      alignment.detectedSongOffsetMs ||
    alignment.alignmentPolicyVersion !== input.alignment.policyVersion ||
    alignment.alignmentRevision !== input.alignment.adapterRevision ||
    Math.abs(alignment.detectedSongOffsetMs) > input.alignment.limits.maximumAbsoluteOffsetMs ||
    alignment.driftMetrics.maximumAbsoluteDriftMs > input.alignment.limits.maximumAbsoluteDriftMs ||
    alignment.driftMetrics.p95AbsoluteDriftMs > alignment.driftMetrics.maximumAbsoluteDriftMs ||
    Math.abs(alignment.driftMetrics.slopeDeltaPpm) >
      input.alignment.limits.maximumAbsoluteSlopeDeltaPpm ||
    alignment.confidenceMetrics.overallBps < input.alignment.limits.minimumOverallConfidenceBps ||
    alignment.confidenceMetrics.coverageBps < input.alignment.limits.minimumCoverageBps ||
    alignment.confidenceMetrics.soundtrackMatchBps <
      input.alignment.limits.minimumSoundtrackMatchBps ||
    artifact.referenceDurationMs !== durationMs ||
    artifact.artifactId !== input.outputs.artifactId ||
    artifact.privateArtifactRef !== input.outputs.artifactObjectKey ||
    decoded.evidence.evidenceRef !== input.outputs.evidenceObjectKey ||
    artifact.poseModelVersion !== input.pose.modelVersion ||
    artifact.poseRuntimeVersion !== input.pose.runtimeVersion ||
    artifact.featureSchemaVersion !== input.pose.featureSchemaVersion ||
    artifact.scorerContractVersion !== input.pose.scorerContractVersion ||
    artifact.integrityPolicyVersion !== input.pose.integrityPolicyVersion ||
    summary.usableTimelineSlots > summary.totalTimelineSlots ||
    summary.coverageBps !==
      Math.floor((summary.usableTimelineSlots * 10_000) / summary.totalTimelineSlots) ||
    summary.coverageBps < quality.minimumUsableCoverageBps ||
    summary.maximumMissingGapSlots > quality.maximumMissingGapSlots ||
    summary.bodyCoverageBps < quality.minimumBodyCoverageBps ||
    summary.visibilityCoverageBps < quality.minimumVisibilityCoverageBps ||
    summary.motionEnergyBps < quality.minimumMotionEnergyBps ||
    summary.spatialExtentBps < quality.minimumSpatialExtentBps
  ) {
    throw new DanceReferenceProcessingInvalid({
      phase: "outcome",
      reason: "terminal_evidence_mismatch",
    });
  }
  return decoded;
}

/**
 * One interpreter is used by initial dispatch and recovery. The store persists
 * exact request bytes before claim; every provider call happens after claim
 * returns and therefore outside the store transaction.
 */
export async function runDanceReferenceProcessing(
  input: RunDanceReferenceProcessingInput,
  dependencies: Readonly<{
    readonly store: DanceReferenceProcessingStore;
    readonly processor: DanceReferenceProcessorService;
  }>,
): Promise<DanceReferenceProcessingDisposition> {
  const request =
    input.frozenInput === undefined
      ? undefined
      : await freezeDanceReferenceInput(input.frozenInput);
  if (
    request !== undefined &&
    (request.frozenInput.choreographyId !== input.choreographyId ||
      request.frozenInput.choreographyRevision !== input.choreographyRevision)
  ) {
    throw new DanceReferenceProcessingInvalid({
      phase: "input",
      reason: "authority_mismatch",
    });
  }
  const claimed = await dependencies.store.claim({
    choreographyId: input.choreographyId,
    choreographyRevision: input.choreographyRevision,
    workerId: input.workerId,
    leaseSeconds: input.leaseSeconds,
    adapterId: input.adapterId,
    adapterRevision: input.adapterRevision,
    ...(request === undefined ? {} : { request }),
  });
  if (claimed.kind !== "claimed") return claimed;
  const claim = claimed.claim;
  let prepared = claim.preparedOperation;
  if (prepared === null) {
    prepared = decodePrepared(
      claim,
      await Effect.runPromise(
        dependencies.processor.prepareReference(claim.frozenInput, claim.binding),
      ),
    );
    if (!(await dependencies.store.recordPrepared(claim, prepared))) return { kind: "stale" };
  } else {
    prepared = decodePrepared(claim, prepared);
  }
  const outcome = decodeOutcome(
    claim,
    await Effect.runPromise(
      dependencies.processor.observeReference(prepared as PreparedDanceReferenceOperation),
    ),
  );
  if (outcome.status === "pending") return { kind: "pending" };
  const completed = await dependencies.store.complete(claim, outcome);
  if (completed === "stale") return { kind: "stale" };
  return {
    kind: completed,
    status: outcome.status === "ready" ? "ready" : "failed",
  };
}
