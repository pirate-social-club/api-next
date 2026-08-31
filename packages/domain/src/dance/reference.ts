export type DanceMirrorPolicy = "strict" | "allowed";
export type DanceChoreographyStatus = "draft" | "processing" | "ready" | "disabled" | "retired";
export type DanceRevisionStatus =
  | "processing"
  | "ready"
  | "processing_failed"
  | "disabled"
  | "retired";

export type DanceDecisionRejection =
  | "invalid_state"
  | "invalid_command"
  | "version_conflict"
  | "segment_identity_conflict"
  | "revision_identity_conflict"
  | "terminal_result_conflict"
  | "transition_not_allowed"
  | "creator_required"
  | "song_owner_required"
  | "target_not_selectable";

export type DanceDecision<T> =
  | Readonly<{ kind: "accepted"; value: T; replayed: boolean }>
  | Readonly<{ kind: "rejected"; reason: DanceDecisionRejection }>;

export type DanceSongSegment = Readonly<{
  segmentId: string;
  songPostId: string;
  audioRevision: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  canonicalAudioDurationMs: number;
  canonicalSegmentSha256: string;
  extractionPolicyVersion: string;
  sourceMediaSha256: string;
  segmentTermsHash: string;
}>;

export type CreateDanceSongSegment = Omit<DanceSongSegment, "durationMs">;

export type DanceReferenceTerms = Readonly<{
  revision: number;
  audioRevision: number;
  referenceVideoPostId: string;
  referenceVideoSha256: string;
  startMs: number;
  endMs: number;
  mirrorPolicy: DanceMirrorPolicy;
  alignmentPolicyVersion: string;
  poseModelVersion: string;
  featureSchemaVersion: string;
  scorerContractVersion: string;
  fingerprintPolicyVersion: string;
  integrityPolicyVersion: string;
  ownerPolicyRevision: number;
  ownerPolicyHash: string;
  revisionTermsHash: string;
}>;

export type DanceReferenceReadyEvidence = Readonly<{
  outcome: "ready";
  evidenceDigest: string;
  segment: DanceSongSegment;
  referenceVideoScoredStartMs: number;
  referenceVideoScoredEndMs: number;
  referenceArtifactSha256: string;
  alignmentAccepted: boolean;
  timeStretchDetected: boolean;
  bodyCoverageAccepted: boolean;
  timelineEvidenceAccepted: boolean;
  visibilityEvidenceAccepted: boolean;
  subjectContinuityAccepted: boolean;
  meaningfulMotionAccepted: boolean;
  terminalAt: string;
}>;

export type DanceReferenceFailedEvidence = Readonly<{
  outcome: "processing_failed";
  evidenceDigest: string;
  failureCode: string;
  terminalAt: string;
}>;

export type DanceReferenceTerminalEvidence =
  | DanceReferenceReadyEvidence
  | DanceReferenceFailedEvidence;

export type DanceRevision = Readonly<{
  terms: DanceReferenceTerms;
  status: DanceRevisionStatus;
  terminalEvidence: DanceReferenceTerminalEvidence | null;
}>;

export type DanceChoreography = Readonly<{
  choreographyId: string;
  songPostId: string;
  creatorAccountId: string;
  creatorPersonaId: string;
  version: number;
  status: DanceChoreographyStatus;
  activeRevision: number | null;
  revisions: readonly DanceRevision[];
  disabledReason: "rights" | "safety" | null;
  disabledAt: string | null;
  retiredAt: string | null;
}>;

export type CreateDanceChoreography = Readonly<{
  choreographyId: string;
  songPostId: string;
  creatorAccountId: string;
  creatorPersonaId: string;
  terms: DanceReferenceTerms;
}>;

export type AppendDanceRevision = Readonly<{
  expectedVersion: number;
  actorAccountId: string;
  terms: DanceReferenceTerms;
}>;

export type CompleteDanceReference = Readonly<{
  expectedVersion: number;
  revision: number;
  evidence: DanceReferenceTerminalEvidence;
}>;

export type DanceSongPresentation = Readonly<{
  songPostId: string;
  audioRevision: number;
  presentationRevision: number;
  featured: Readonly<{
    choreographyId: string;
    choreographyRevision: number;
  }> | null;
  updatedAt: string;
}>;

export type SetDanceSongPresentation = Readonly<{
  expectedPresentationRevision: number;
  actorAccountId: string;
  songOwnerAccountId: string;
  songPostId: string;
  audioRevision: number;
  choreography: DanceChoreography;
  choreographyRevision: number;
  updatedAt: string;
}>;

export type ClearDanceSongPresentation = Readonly<{
  expectedPresentationRevision: number;
  actorAccountId: string;
  songOwnerAccountId: string;
  songPostId: string;
  audioRevision: number;
  updatedAt: string;
}>;

const SHA256 = /^[0-9a-f]{64}$/u;
const CANONICAL_INSTANT =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !value.includes("\u0000")
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function instant(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function accepted<T>(value: T, replayed = false): DanceDecision<T> {
  return { kind: "accepted", value, replayed };
}

function rejected<T>(reason: DanceDecisionRejection): DanceDecision<T> {
  return { kind: "rejected", reason };
}

function sameSegment(left: DanceSongSegment, right: DanceSongSegment): boolean {
  return (
    left.segmentId === right.segmentId &&
    left.songPostId === right.songPostId &&
    left.audioRevision === right.audioRevision &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.durationMs === right.durationMs &&
    left.canonicalAudioDurationMs === right.canonicalAudioDurationMs &&
    left.canonicalSegmentSha256 === right.canonicalSegmentSha256 &&
    left.extractionPolicyVersion === right.extractionPolicyVersion &&
    left.sourceMediaSha256 === right.sourceMediaSha256 &&
    left.segmentTermsHash === right.segmentTermsHash
  );
}

function sameReferenceTerms(left: DanceReferenceTerms, right: DanceReferenceTerms): boolean {
  return (
    left.revision === right.revision &&
    left.audioRevision === right.audioRevision &&
    left.referenceVideoPostId === right.referenceVideoPostId &&
    left.referenceVideoSha256 === right.referenceVideoSha256 &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.mirrorPolicy === right.mirrorPolicy &&
    left.alignmentPolicyVersion === right.alignmentPolicyVersion &&
    left.poseModelVersion === right.poseModelVersion &&
    left.featureSchemaVersion === right.featureSchemaVersion &&
    left.scorerContractVersion === right.scorerContractVersion &&
    left.fingerprintPolicyVersion === right.fingerprintPolicyVersion &&
    left.integrityPolicyVersion === right.integrityPolicyVersion &&
    left.ownerPolicyRevision === right.ownerPolicyRevision &&
    left.ownerPolicyHash === right.ownerPolicyHash &&
    left.revisionTermsHash === right.revisionTermsHash
  );
}

function sameTerminalEvidence(
  left: DanceReferenceTerminalEvidence,
  right: DanceReferenceTerminalEvidence,
): boolean {
  if (left.outcome !== right.outcome) return false;
  if (left.outcome === "processing_failed" && right.outcome === "processing_failed") {
    return (
      left.evidenceDigest === right.evidenceDigest &&
      left.failureCode === right.failureCode &&
      left.terminalAt === right.terminalAt
    );
  }
  if (left.outcome !== "ready" || right.outcome !== "ready") return false;
  return (
    left.evidenceDigest === right.evidenceDigest &&
    sameSegment(left.segment, right.segment) &&
    left.referenceVideoScoredStartMs === right.referenceVideoScoredStartMs &&
    left.referenceVideoScoredEndMs === right.referenceVideoScoredEndMs &&
    left.referenceArtifactSha256 === right.referenceArtifactSha256 &&
    left.alignmentAccepted === right.alignmentAccepted &&
    left.timeStretchDetected === right.timeStretchDetected &&
    left.bodyCoverageAccepted === right.bodyCoverageAccepted &&
    left.timelineEvidenceAccepted === right.timelineEvidenceAccepted &&
    left.visibilityEvidenceAccepted === right.visibilityEvidenceAccepted &&
    left.subjectContinuityAccepted === right.subjectContinuityAccepted &&
    left.meaningfulMotionAccepted === right.meaningfulMotionAccepted &&
    left.terminalAt === right.terminalAt
  );
}

export function danceSongSegmentInvariant(segment: DanceSongSegment): string | null {
  if (!identifier(segment.segmentId)) return "segment_id";
  if (!identifier(segment.songPostId)) return "song_post_id";
  if (!positiveInteger(segment.audioRevision)) return "audio_revision";
  if (!nonNegativeInteger(segment.startMs) || !positiveInteger(segment.endMs)) return "bounds";
  if (!positiveInteger(segment.canonicalAudioDurationMs)) return "canonical_audio_duration_ms";
  const duration = segment.endMs - segment.startMs;
  if (
    segment.endMs <= segment.startMs ||
    segment.endMs > segment.canonicalAudioDurationMs ||
    duration < 6_000 ||
    duration > 30_000 ||
    segment.durationMs !== duration
  ) {
    return "half_open_interval";
  }
  if (!hash(segment.canonicalSegmentSha256)) return "canonical_segment_sha256";
  if (!identifier(segment.extractionPolicyVersion)) return "extraction_policy_version";
  if (!hash(segment.sourceMediaSha256)) return "source_media_sha256";
  if (!hash(segment.segmentTermsHash)) return "segment_terms_hash";
  return null;
}

/** Storage supplies the row found by the server-derived segment identity. */
export function decideDanceSongSegmentCreation(
  existing: DanceSongSegment | null,
  command: CreateDanceSongSegment,
): DanceDecision<DanceSongSegment> {
  const candidate: DanceSongSegment = {
    ...command,
    durationMs: command.endMs - command.startMs,
  };
  if (danceSongSegmentInvariant(candidate) !== null) return rejected("invalid_command");
  if (existing === null) return accepted(candidate);
  if (danceSongSegmentInvariant(existing) !== null) return rejected("invalid_state");
  return sameSegment(existing, candidate)
    ? accepted(existing, true)
    : rejected("segment_identity_conflict");
}

export function danceReferenceTermsInvariant(terms: DanceReferenceTerms): string | null {
  if (!positiveInteger(terms.revision) || !positiveInteger(terms.audioRevision)) return "revision";
  if (!identifier(terms.referenceVideoPostId)) return "reference_video_post_id";
  if (!hash(terms.referenceVideoSha256)) return "reference_video_sha256";
  if (!nonNegativeInteger(terms.startMs) || !positiveInteger(terms.endMs)) return "bounds";
  const duration = terms.endMs - terms.startMs;
  if (duration < 6_000 || duration > 30_000) return "half_open_interval";
  if (terms.mirrorPolicy !== "strict" && terms.mirrorPolicy !== "allowed") return "mirror_policy";
  for (const version of [
    terms.alignmentPolicyVersion,
    terms.poseModelVersion,
    terms.featureSchemaVersion,
    terms.scorerContractVersion,
    terms.fingerprintPolicyVersion,
    terms.integrityPolicyVersion,
  ]) {
    if (!identifier(version)) return "version";
  }
  if (!positiveInteger(terms.ownerPolicyRevision)) return "owner_policy_revision";
  if (!hash(terms.ownerPolicyHash) || !hash(terms.revisionTermsHash)) return "terms_hash";
  return null;
}

function revisionInvariant(revision: DanceRevision): string | null {
  if (danceReferenceTermsInvariant(revision.terms) !== null) return "revision_terms";
  if (revision.status === "processing") {
    return revision.terminalEvidence === null ? null : "processing_terminal_evidence";
  }
  if (revision.terminalEvidence === null) return "terminal_evidence";
  if (revision.status === "processing_failed") {
    return revision.terminalEvidence.outcome === "processing_failed" ? null : "failed_evidence";
  }
  return revision.terminalEvidence.outcome === "ready" ? null : "ready_evidence";
}

export function danceChoreographyInvariant(choreography: DanceChoreography): string | null {
  if (
    !identifier(choreography.choreographyId) ||
    !identifier(choreography.songPostId) ||
    !identifier(choreography.creatorAccountId) ||
    !identifier(choreography.creatorPersonaId)
  ) {
    return "identity";
  }
  if (!positiveInteger(choreography.version)) return "version";
  for (let index = 0; index < choreography.revisions.length; index += 1) {
    const revision = choreography.revisions[index];
    if (revision === undefined || revision.terms.revision !== index + 1) return "revision_sequence";
    if (revisionInvariant(revision) !== null) return "revision";
  }
  const readyRevisions = choreography.revisions.filter((item) => item.status === "ready");
  if (choreography.status === "draft" && choreography.revisions.length !== 0) return "draft_shape";
  if (choreography.status === "processing" && readyRevisions.length > 0) return "processing_shape";
  if (choreography.status === "ready") {
    if (readyRevisions.length === 0 || choreography.activeRevision === null) return "ready_shape";
    if (!readyRevisions.some((item) => item.terms.revision === choreography.activeRevision)) {
      return "active_revision";
    }
  } else if (
    (choreography.status === "draft" || choreography.status === "processing") &&
    choreography.activeRevision !== null
  ) {
    return "active_revision";
  }
  if (choreography.status === "disabled") {
    if (
      (choreography.disabledReason !== "rights" && choreography.disabledReason !== "safety") ||
      !instant(choreography.disabledAt) ||
      choreography.retiredAt !== null
    )
      return "disabled_shape";
  } else if (choreography.status === "retired") {
    if (!instant(choreography.retiredAt)) return "retired_shape";
  } else if (
    choreography.disabledReason !== null ||
    choreography.disabledAt !== null ||
    choreography.retiredAt !== null
  ) {
    return "active_terminal_instant";
  }
  return null;
}

export function createDanceChoreography(
  command: CreateDanceChoreography,
): DanceDecision<DanceChoreography> {
  if (
    !identifier(command.choreographyId) ||
    !identifier(command.songPostId) ||
    !identifier(command.creatorAccountId) ||
    !identifier(command.creatorPersonaId) ||
    command.terms.revision !== 1 ||
    danceReferenceTermsInvariant(command.terms) !== null
  ) {
    return rejected("invalid_command");
  }
  return accepted({
    choreographyId: command.choreographyId,
    songPostId: command.songPostId,
    creatorAccountId: command.creatorAccountId,
    creatorPersonaId: command.creatorPersonaId,
    version: 1,
    status: "processing",
    activeRevision: null,
    revisions: [{ terms: command.terms, status: "processing", terminalEvidence: null }],
    disabledReason: null,
    disabledAt: null,
    retiredAt: null,
  });
}

export function appendDanceChoreographyRevision(
  current: DanceChoreography,
  command: AppendDanceRevision,
): DanceDecision<DanceChoreography> {
  if (danceChoreographyInvariant(current) !== null) return rejected("invalid_state");
  if (!identifier(command.actorAccountId) || danceReferenceTermsInvariant(command.terms) !== null) {
    return rejected("invalid_command");
  }
  if (command.actorAccountId !== current.creatorAccountId) return rejected("creator_required");
  const existing = current.revisions.find(
    (revision) => revision.terms.revision === command.terms.revision,
  );
  if (existing !== undefined) {
    return sameReferenceTerms(existing.terms, command.terms)
      ? accepted(current, true)
      : rejected("revision_identity_conflict");
  }
  if (command.expectedVersion !== current.version) return rejected("version_conflict");
  if (current.status === "disabled" || current.status === "retired") {
    return rejected("transition_not_allowed");
  }
  if (command.terms.revision !== current.revisions.length + 1) {
    return rejected("revision_identity_conflict");
  }
  const next: DanceChoreography = {
    ...current,
    version: current.version + 1,
    status: current.status === "draft" ? "processing" : current.status,
    revisions: [
      ...current.revisions,
      { terms: command.terms, status: "processing", terminalEvidence: null },
    ],
  };
  return danceChoreographyInvariant(next) === null ? accepted(next) : rejected("invalid_state");
}

function readyEvidenceInvariant(
  choreography: DanceChoreography,
  revision: DanceRevision,
  evidence: DanceReferenceReadyEvidence,
): string | null {
  if (!hash(evidence.evidenceDigest) || !hash(evidence.referenceArtifactSha256)) return "digest";
  if (!instant(evidence.terminalAt)) return "terminal_at";
  if (danceSongSegmentInvariant(evidence.segment) !== null) return "segment";
  if (
    evidence.segment.songPostId !== choreography.songPostId ||
    evidence.segment.audioRevision !== revision.terms.audioRevision ||
    evidence.segment.startMs !== revision.terms.startMs ||
    evidence.segment.endMs !== revision.terms.endMs
  ) {
    return "segment_binding";
  }
  if (
    !nonNegativeInteger(evidence.referenceVideoScoredStartMs) ||
    !positiveInteger(evidence.referenceVideoScoredEndMs) ||
    evidence.referenceVideoScoredEndMs - evidence.referenceVideoScoredStartMs !==
      evidence.segment.durationMs
  ) {
    return "reference_window";
  }
  if (
    !evidence.alignmentAccepted ||
    evidence.timeStretchDetected ||
    !evidence.bodyCoverageAccepted ||
    !evidence.timelineEvidenceAccepted ||
    !evidence.visibilityEvidenceAccepted ||
    !evidence.subjectContinuityAccepted ||
    !evidence.meaningfulMotionAccepted
  ) {
    return "readiness_gate";
  }
  return null;
}

export function completeDanceReferenceProcessing(
  current: DanceChoreography,
  command: CompleteDanceReference,
): DanceDecision<DanceChoreography> {
  if (danceChoreographyInvariant(current) !== null) return rejected("invalid_state");
  const revision = current.revisions.find((item) => item.terms.revision === command.revision);
  if (revision === undefined) return rejected("invalid_command");
  if (revision.terminalEvidence !== null) {
    return sameTerminalEvidence(revision.terminalEvidence, command.evidence)
      ? accepted(current, true)
      : rejected("terminal_result_conflict");
  }
  if (command.expectedVersion !== current.version) return rejected("version_conflict");
  if (current.status === "disabled" || current.status === "retired") {
    return rejected("transition_not_allowed");
  }
  if (revision.status !== "processing") return rejected("transition_not_allowed");
  if (command.evidence.outcome === "ready") {
    if (readyEvidenceInvariant(current, revision, command.evidence) !== null) {
      return rejected("invalid_command");
    }
  } else if (
    !hash(command.evidence.evidenceDigest) ||
    !identifier(command.evidence.failureCode) ||
    !instant(command.evidence.terminalAt)
  ) {
    return rejected("invalid_command");
  }
  const revisions = current.revisions.map((item) =>
    item.terms.revision === command.revision
      ? {
          ...item,
          status: command.evidence.outcome,
          terminalEvidence: command.evidence,
        }
      : item,
  );
  const next: DanceChoreography = {
    ...current,
    version: current.version + 1,
    status: command.evidence.outcome === "ready" ? "ready" : current.status,
    activeRevision:
      command.evidence.outcome === "ready" && current.activeRevision === null
        ? command.revision
        : current.activeRevision,
    revisions,
  };
  return danceChoreographyInvariant(next) === null ? accepted(next) : rejected("invalid_state");
}

export function selectActiveDanceRevision(
  current: DanceChoreography,
  expectedVersion: number,
  actorAccountId: string,
  revision: number,
): DanceDecision<DanceChoreography> {
  if (danceChoreographyInvariant(current) !== null) return rejected("invalid_state");
  if (!identifier(actorAccountId)) return rejected("invalid_command");
  if (actorAccountId !== current.creatorAccountId) return rejected("creator_required");
  if (current.status !== "ready") return rejected("transition_not_allowed");
  if (
    !current.revisions.some((item) => item.terms.revision === revision && item.status === "ready")
  ) {
    return rejected("target_not_selectable");
  }
  if (current.activeRevision === revision) return accepted(current, true);
  if (expectedVersion !== current.version) return rejected("version_conflict");
  return accepted({ ...current, version: current.version + 1, activeRevision: revision });
}

export function disableDanceChoreography(
  current: DanceChoreography,
  expectedVersion: number,
  cutoffAt: string,
  reason: "rights" | "safety",
): DanceDecision<DanceChoreography> {
  if (danceChoreographyInvariant(current) !== null) return rejected("invalid_state");
  if (!instant(cutoffAt) || (reason !== "rights" && reason !== "safety")) {
    return rejected("invalid_command");
  }
  if (current.status === "disabled") {
    return current.disabledAt === cutoffAt && current.disabledReason === reason
      ? accepted(current, true)
      : rejected("terminal_result_conflict");
  }
  if (current.status === "retired") return rejected("transition_not_allowed");
  if (expectedVersion !== current.version) return rejected("version_conflict");
  return accepted({
    ...current,
    version: current.version + 1,
    status: "disabled",
    disabledReason: reason,
    disabledAt: cutoffAt,
  });
}

export function retireDanceChoreography(
  current: DanceChoreography,
  expectedVersion: number,
  retiredAt: string,
): DanceDecision<DanceChoreography> {
  if (danceChoreographyInvariant(current) !== null) return rejected("invalid_state");
  if (!instant(retiredAt)) return rejected("invalid_command");
  if (current.status === "retired") {
    return current.retiredAt === retiredAt
      ? accepted(current, true)
      : rejected("terminal_result_conflict");
  }
  if (current.status === "ready") return rejected("transition_not_allowed");
  if (expectedVersion !== current.version) return rejected("version_conflict");
  return accepted({
    ...current,
    version: current.version + 1,
    status: "retired",
    retiredAt,
  });
}

function presentationIdentityMatches(
  current: DanceSongPresentation | null,
  songPostId: string,
  audioRevision: number,
): boolean {
  return (
    current === null ||
    (current.songPostId === songPostId && current.audioRevision === audioRevision)
  );
}

export function setDanceSongPresentation(
  current: DanceSongPresentation | null,
  command: SetDanceSongPresentation,
): DanceDecision<DanceSongPresentation> {
  if (
    !identifier(command.actorAccountId) ||
    !identifier(command.songOwnerAccountId) ||
    !identifier(command.songPostId) ||
    !positiveInteger(command.audioRevision) ||
    !positiveInteger(command.choreographyRevision) ||
    !instant(command.updatedAt)
  ) {
    return rejected("invalid_command");
  }
  if (!presentationIdentityMatches(current, command.songPostId, command.audioRevision)) {
    return rejected("invalid_state");
  }
  if (command.actorAccountId !== command.songOwnerAccountId) {
    return rejected("song_owner_required");
  }
  if (danceChoreographyInvariant(command.choreography) !== null) return rejected("invalid_command");
  const target = command.choreography.revisions.find(
    (item) => item.terms.revision === command.choreographyRevision,
  );
  if (
    command.choreography.status !== "ready" ||
    command.choreography.songPostId !== command.songPostId ||
    target?.status !== "ready" ||
    target.terms.audioRevision !== command.audioRevision
  ) {
    return rejected("target_not_selectable");
  }
  const desired = {
    choreographyId: command.choreography.choreographyId,
    choreographyRevision: command.choreographyRevision,
  };
  if (
    current?.featured?.choreographyId === desired.choreographyId &&
    current.featured.choreographyRevision === desired.choreographyRevision
  ) {
    return accepted(current, true);
  }
  const currentRevision = current?.presentationRevision ?? 0;
  if (command.expectedPresentationRevision !== currentRevision) return rejected("version_conflict");
  return accepted({
    songPostId: command.songPostId,
    audioRevision: command.audioRevision,
    presentationRevision: currentRevision + 1,
    featured: desired,
    updatedAt: command.updatedAt,
  });
}

export function clearDanceSongPresentation(
  current: DanceSongPresentation | null,
  command: ClearDanceSongPresentation,
): DanceDecision<DanceSongPresentation> {
  if (
    !identifier(command.actorAccountId) ||
    !identifier(command.songOwnerAccountId) ||
    !identifier(command.songPostId) ||
    !positiveInteger(command.audioRevision) ||
    !instant(command.updatedAt)
  ) {
    return rejected("invalid_command");
  }
  if (!presentationIdentityMatches(current, command.songPostId, command.audioRevision)) {
    return rejected("invalid_state");
  }
  if (command.actorAccountId !== command.songOwnerAccountId) {
    return rejected("song_owner_required");
  }
  if (current?.featured === null) return accepted(current, true);
  const currentRevision = current?.presentationRevision ?? 0;
  if (command.expectedPresentationRevision !== currentRevision) return rejected("version_conflict");
  return accepted({
    songPostId: command.songPostId,
    audioRevision: command.audioRevision,
    presentationRevision: currentRevision + 1,
    featured: null,
    updatedAt: command.updatedAt,
  });
}

export type DanceCutoffDecision =
  | Readonly<{ kind: "reject_new_session" }>
  | Readonly<{ kind: "abandon"; reason: "reference_disabled_before_upload" }>
  | Readonly<{ kind: "reject_new_attempt" }>
  | Readonly<{ kind: "finalize_frozen_attempt" }>;

export type DanceCutoffEvidence = Readonly<{
  cutoffAt: string;
  operation: "create_session" | "continue_existing";
  uploadSealedAt: string | null;
  gradingDispatchDurablyPendingAt: string | null;
  terminalResultDurablyPendingAt: string | null;
}>;

function strictlyBefore(candidate: string | null, cutoffAt: string): boolean {
  return candidate !== null && instant(candidate) && candidate < cutoffAt;
}

export function decideDanceRightsSafetyCutoff(
  evidence: DanceCutoffEvidence,
): DanceCutoffDecision | null {
  if (!instant(evidence.cutoffAt)) return null;
  for (const candidate of [
    evidence.uploadSealedAt,
    evidence.gradingDispatchDurablyPendingAt,
    evidence.terminalResultDurablyPendingAt,
  ]) {
    if (candidate !== null && !instant(candidate)) return null;
  }
  if (evidence.operation === "create_session") return { kind: "reject_new_session" };
  if (evidence.uploadSealedAt === null) {
    return { kind: "abandon", reason: "reference_disabled_before_upload" };
  }
  if (
    strictlyBefore(evidence.terminalResultDurablyPendingAt, evidence.cutoffAt) ||
    (strictlyBefore(evidence.uploadSealedAt, evidence.cutoffAt) &&
      strictlyBefore(evidence.gradingDispatchDurablyPendingAt, evidence.cutoffAt))
  ) {
    return { kind: "finalize_frozen_attempt" };
  }
  return { kind: "reject_new_attempt" };
}
