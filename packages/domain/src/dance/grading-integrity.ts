export type DanceTimelineFrame = Readonly<{
  timestampMs: number;
  usable: boolean;
}>;

export type DanceTimelinePolicy = Readonly<{
  scoredStartMs: number;
  scoredEndMs: number;
  scoringGridStepMs: number;
  minimumUsableCoverageBps: number;
  maximumMissingGapSlots: number;
}>;

export type DanceTimelineEvidence = Readonly<{
  expectedSlotCount: number;
  decodedFrameCount: number;
  usableSlotCount: number;
  usableCoverageBps: number;
  maximumMissingGapSlots: number;
  missingSlotIndexes: readonly number[];
  accepted: boolean;
}>;

export type DanceIntegrityRejection =
  | "invalid_policy"
  | "malformed_timeline"
  | "timeline_evidence_insufficient"
  | "visibility_cannot_reduce_error"
  | "visibility_cannot_improve_score"
  | "visibility_outcome_invalid"
  | "principal_body_missing"
  | "multiple_people"
  | "ambiguous_subject_continuity"
  | "subject_identity_swap"
  | "fingerprint_policy_mismatch"
  | "fingerprint_key_mismatch"
  | "fingerprint_scope_mismatch"
  | "fingerprint_material_malformed"
  | "fingerprint_claim_not_atomic";

export type DanceIntegrityDecision<T> =
  | Readonly<{ kind: "accepted"; value: T }>
  | Readonly<{ kind: "rejected"; reason: DanceIntegrityRejection }>;

function accepted<T>(value: T): DanceIntegrityDecision<T> {
  return { kind: "accepted", value };
}

function rejected<T>(reason: DanceIntegrityRejection): DanceIntegrityDecision<T> {
  return { kind: "rejected", reason };
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function basisPoints(value: unknown): value is number {
  return nonNegativeInteger(value) && value <= 10_000;
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !value.includes("\u0000")
  );
}

const SHA256 = /^[0-9a-f]{64}$/u;

function hash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

/**
 * Builds the fixed scoring grid from the scored interval. Decoder timestamps
 * select their original slots; omitted timestamps therefore remain gaps.
 */
export function evaluateDanceTimelineEvidence(
  policy: DanceTimelinePolicy,
  decodedFrames: readonly DanceTimelineFrame[],
): DanceIntegrityDecision<DanceTimelineEvidence> {
  if (
    !nonNegativeInteger(policy.scoredStartMs) ||
    !positiveInteger(policy.scoredEndMs) ||
    policy.scoredEndMs <= policy.scoredStartMs ||
    !positiveInteger(policy.scoringGridStepMs) ||
    !basisPoints(policy.minimumUsableCoverageBps) ||
    !nonNegativeInteger(policy.maximumMissingGapSlots)
  ) {
    return rejected("invalid_policy");
  }
  const durationMs = policy.scoredEndMs - policy.scoredStartMs;
  const expectedSlotCount = Math.ceil(durationMs / policy.scoringGridStepMs);
  if (!positiveInteger(expectedSlotCount)) return rejected("invalid_policy");

  const slotUsability = new Map<number, boolean>();
  let previousTimestamp = -1;
  for (const frame of decodedFrames) {
    if (
      !nonNegativeInteger(frame.timestampMs) ||
      frame.timestampMs < policy.scoredStartMs ||
      frame.timestampMs >= policy.scoredEndMs ||
      frame.timestampMs <= previousTimestamp ||
      typeof frame.usable !== "boolean"
    ) {
      return rejected("malformed_timeline");
    }
    const slot = Math.floor((frame.timestampMs - policy.scoredStartMs) / policy.scoringGridStepMs);
    if (slotUsability.has(slot)) return rejected("malformed_timeline");
    slotUsability.set(slot, frame.usable);
    previousTimestamp = frame.timestampMs;
  }

  const missingSlotIndexes: number[] = [];
  let usableSlotCount = 0;
  let currentGap = 0;
  let maximumMissingGapSlots = 0;
  for (let slot = 0; slot < expectedSlotCount; slot += 1) {
    if (slotUsability.get(slot) === true) {
      usableSlotCount += 1;
      currentGap = 0;
      continue;
    }
    missingSlotIndexes.push(slot);
    currentGap += 1;
    maximumMissingGapSlots = Math.max(maximumMissingGapSlots, currentGap);
  }
  const usableCoverageBps = Math.floor((usableSlotCount * 10_000) / expectedSlotCount);
  return accepted({
    expectedSlotCount,
    decodedFrameCount: decodedFrames.length,
    usableSlotCount,
    usableCoverageBps,
    maximumMissingGapSlots,
    missingSlotIndexes,
    accepted:
      usableCoverageBps >= policy.minimumUsableCoverageBps &&
      maximumMissingGapSlots <= policy.maximumMissingGapSlots,
  });
}

export type DanceFeatureEvidenceInput = Readonly<{
  errorUnits: number;
  visibilityBps: number;
  minimumUsableVisibilityBps: number;
}>;

export type DanceFeatureEvidence =
  | Readonly<{ kind: "usable"; errorUnits: number }>
  | Readonly<{ kind: "excluded" }>;

/** Visibility decides usability only; it never scales error toward zero. */
export function reduceDanceFeatureEvidence(
  input: DanceFeatureEvidenceInput,
): DanceIntegrityDecision<DanceFeatureEvidence> {
  if (
    !nonNegativeInteger(input.errorUnits) ||
    !basisPoints(input.visibilityBps) ||
    !basisPoints(input.minimumUsableVisibilityBps)
  ) {
    return rejected("visibility_cannot_reduce_error");
  }
  return accepted(
    input.visibilityBps < input.minimumUsableVisibilityBps
      ? { kind: "excluded" }
      : { kind: "usable", errorUnits: input.errorUnits },
  );
}

export type DanceScoredVisibilityOutcome = Readonly<{
  kind: "scored";
  scoreBps: number;
  usableEvidenceUnits: number;
  confidenceEvidenceBps: number;
}>;

export type DanceVisibilityOutcome =
  | DanceScoredVisibilityOutcome
  | Readonly<{ kind: "rejected"; reason: "insufficient_evidence" }>;

export type DanceVisibilityComparison = Readonly<{
  baseline: DanceScoredVisibilityOutcome;
  reducedVisibility: DanceVisibilityOutcome;
  affectedEvidenceWasAlreadyExcluded: boolean;
}>;

/** Enforces the three allowed outcomes after visibility is reduced. */
export function validateDanceVisibilityMonotonicity(
  comparison: DanceVisibilityComparison,
): DanceIntegrityDecision<DanceVisibilityOutcome> {
  const { baseline, reducedVisibility, affectedEvidenceWasAlreadyExcluded } = comparison;
  if (
    !basisPoints(baseline.scoreBps) ||
    !nonNegativeInteger(baseline.usableEvidenceUnits) ||
    !basisPoints(baseline.confidenceEvidenceBps) ||
    typeof affectedEvidenceWasAlreadyExcluded !== "boolean"
  ) {
    return rejected("visibility_outcome_invalid");
  }
  if (reducedVisibility.kind === "rejected") return accepted(reducedVisibility);
  if (
    !basisPoints(reducedVisibility.scoreBps) ||
    !nonNegativeInteger(reducedVisibility.usableEvidenceUnits) ||
    !basisPoints(reducedVisibility.confidenceEvidenceBps)
  ) {
    return rejected("visibility_outcome_invalid");
  }
  if (reducedVisibility.scoreBps > baseline.scoreBps) {
    return rejected("visibility_cannot_improve_score");
  }
  if (affectedEvidenceWasAlreadyExcluded) {
    return reducedVisibility.scoreBps === baseline.scoreBps &&
      reducedVisibility.usableEvidenceUnits === baseline.usableEvidenceUnits &&
      reducedVisibility.confidenceEvidenceBps === baseline.confidenceEvidenceBps
      ? accepted(reducedVisibility)
      : rejected("visibility_outcome_invalid");
  }
  const evidenceDecreased =
    reducedVisibility.usableEvidenceUnits < baseline.usableEvidenceUnits ||
    reducedVisibility.confidenceEvidenceBps < baseline.confidenceEvidenceBps;
  return evidenceDecreased ? accepted(reducedVisibility) : rejected("visibility_outcome_invalid");
}

export type DanceSubjectFrame = Readonly<{
  principalTrackId: string | null;
  visibleTrackIds: readonly string[];
  continuityAmbiguous: boolean;
}>;

export type DanceStableSubject = Readonly<{
  principalTrackId: string;
  evaluatedFrameCount: number;
}>;

/** Only one unambiguous, stable principal body may reach similarity scoring. */
export function evaluateDanceSubjectContinuity(
  frames: readonly DanceSubjectFrame[],
): DanceIntegrityDecision<DanceStableSubject> {
  if (frames.length === 0) return rejected("principal_body_missing");
  let stableTrackId: string | null = null;
  for (const frame of frames) {
    if (frame.continuityAmbiguous) return rejected("ambiguous_subject_continuity");
    if (frame.visibleTrackIds.length > 1) return rejected("multiple_people");
    if (
      frame.principalTrackId === null ||
      !identifier(frame.principalTrackId) ||
      frame.visibleTrackIds.length !== 1 ||
      frame.visibleTrackIds[0] !== frame.principalTrackId
    ) {
      return rejected("principal_body_missing");
    }
    if (stableTrackId === null) stableTrackId = frame.principalTrackId;
    else if (stableTrackId !== frame.principalTrackId) return rejected("subject_identity_swap");
  }
  if (stableTrackId === null) return rejected("principal_body_missing");
  return accepted({ principalTrackId: stableTrackId, evaluatedFrameCount: frames.length });
}

export type DanceFingerprintPolicy = Readonly<{
  policyVersion: string;
  keyVersion: string;
  matchScope: "same_account" | "platform_wide";
  segmentMatching: "required" | "disabled";
}>;

export type DanceFingerprintClaimEvidence = Readonly<{
  policyVersion: string;
  keyVersion: string;
  matchScope: "same_account" | "platform_wide";
  wholeSequenceFingerprint: string;
  segmentFingerprints: readonly string[];
  claimMethod: "atomic_claimed" | "atomic_matched" | "read_then_insert";
  claimedWithTerminalEvidence: boolean;
}>;

export type DanceFingerprintDecision = Readonly<{
  outcome: "unique" | "duplicate";
  wholeSequenceFingerprint: string;
  segmentFingerprints: readonly string[];
}>;

/** Accepts only a storage-backed atomic fingerprint claim joined to terminal evidence. */
export function decideDanceFingerprintClaim(
  policy: DanceFingerprintPolicy,
  evidence: DanceFingerprintClaimEvidence,
): DanceIntegrityDecision<DanceFingerprintDecision> {
  if (
    !identifier(policy.policyVersion) ||
    !identifier(evidence.policyVersion) ||
    (policy.segmentMatching !== "required" && policy.segmentMatching !== "disabled")
  ) {
    return rejected("fingerprint_policy_mismatch");
  }
  if (policy.policyVersion !== evidence.policyVersion) {
    return rejected("fingerprint_policy_mismatch");
  }
  if (!identifier(policy.keyVersion) || policy.keyVersion !== evidence.keyVersion) {
    return rejected("fingerprint_key_mismatch");
  }
  if (
    (policy.matchScope !== "same_account" && policy.matchScope !== "platform_wide") ||
    (evidence.matchScope !== "same_account" && evidence.matchScope !== "platform_wide") ||
    policy.matchScope !== evidence.matchScope
  ) {
    return rejected("fingerprint_scope_mismatch");
  }
  if (
    !hash(evidence.wholeSequenceFingerprint) ||
    evidence.segmentFingerprints.some((fingerprint) => !hash(fingerprint)) ||
    (policy.segmentMatching === "required" && evidence.segmentFingerprints.length === 0) ||
    (policy.segmentMatching === "disabled" && evidence.segmentFingerprints.length !== 0)
  ) {
    return rejected("fingerprint_material_malformed");
  }
  if (
    (evidence.claimMethod !== "atomic_claimed" &&
      evidence.claimMethod !== "atomic_matched" &&
      evidence.claimMethod !== "read_then_insert") ||
    evidence.claimMethod === "read_then_insert" ||
    !evidence.claimedWithTerminalEvidence
  ) {
    return rejected("fingerprint_claim_not_atomic");
  }
  return accepted({
    outcome: evidence.claimMethod === "atomic_claimed" ? "unique" : "duplicate",
    wholeSequenceFingerprint: evidence.wholeSequenceFingerprint,
    segmentFingerprints: evidence.segmentFingerprints,
  });
}

export type DanceGradingIntegrityInput = Readonly<{
  timelinePolicy: DanceTimelinePolicy;
  decodedFrames: readonly DanceTimelineFrame[];
  visibilityComparisons: readonly DanceVisibilityComparison[];
  subjectFrames: readonly DanceSubjectFrame[];
  fingerprintPolicy: DanceFingerprintPolicy;
  fingerprintClaim: DanceFingerprintClaimEvidence;
}>;

export type DanceGradingIntegrityEvidence = Readonly<{
  timeline: DanceTimelineEvidence;
  subject: DanceStableSubject;
  fingerprint: DanceFingerprintDecision;
  visibilityComparisonCount: number;
}>;

/**
 * Composite attempt gate. Callers provide raw evidence, not adapter-owned pass
 * booleans, so all four integrity decisions are recomputed in the domain.
 */
export function evaluateDanceGradingIntegrity(
  input: DanceGradingIntegrityInput,
): DanceIntegrityDecision<DanceGradingIntegrityEvidence> {
  const timeline = evaluateDanceTimelineEvidence(input.timelinePolicy, input.decodedFrames);
  if (timeline.kind === "rejected") return timeline;
  if (!timeline.value.accepted) return rejected("timeline_evidence_insufficient");
  if (input.visibilityComparisons.length === 0) return rejected("visibility_outcome_invalid");
  for (const comparison of input.visibilityComparisons) {
    const visibility = validateDanceVisibilityMonotonicity(comparison);
    if (visibility.kind === "rejected") return visibility;
  }
  const subject = evaluateDanceSubjectContinuity(input.subjectFrames);
  if (subject.kind === "rejected") return subject;
  const fingerprint = decideDanceFingerprintClaim(input.fingerprintPolicy, input.fingerprintClaim);
  if (fingerprint.kind === "rejected") return fingerprint;
  return accepted({
    timeline: timeline.value,
    subject: subject.value,
    fingerprint: fingerprint.value,
    visibilityComparisonCount: input.visibilityComparisons.length,
  });
}
