export type DanceAttemptSessionState =
  | "created"
  | "consented"
  | "awaiting_upload"
  | "uploaded"
  | "grading_pending"
  | "completed"
  | "rejected"
  | "processing_failed"
  | "expired"
  | "abandoned";

export type DanceAttemptDecisionRejection =
  | "invalid_state"
  | "invalid_command"
  | "version_conflict"
  | "transition_not_allowed"
  | "consent_binding_conflict"
  | "upload_identity_conflict"
  | "sealed_digest_conflict"
  | "attempt_identity_conflict"
  | "terminal_result_conflict"
  | "shadow_boundary_violation";

export type DanceAttemptDecision<T> =
  | Readonly<{ kind: "accepted"; value: T; replayed: boolean }>
  | Readonly<{ kind: "rejected"; reason: DanceAttemptDecisionRejection }>;

export type DanceShadowPolicySnapshot = Readonly<{
  qualificationPolicyVersionId: string;
  calibrationVersionId: string;
  calibrationChecksum: string;
  capturedAdmissionState: "shadow";
  platformFloorBps: number;
  poseModelVersion: string;
  featureSchemaVersion: string;
  scorerContractVersion: string;
  mirrorPolicyVersion: string;
  cuePolicyVersion: string;
  fingerprintPolicyVersion: string;
  integrityPolicyVersion: string;
  graderAdapterVersion: string;
}>;

export type DanceStartCue = Readonly<{
  kind: "hands_on_head" | "arms_t" | "hands_on_hips";
  holdMs: number;
  observationStartMs: number;
  observationEndMs: number;
}>;

export type DanceSessionConsent = Readonly<{
  personaId: string;
  sessionTermsHash: string;
  consentPolicyVersionId: string;
  retentionDisclosureVersion: string;
  source: "camera" | "file_upload";
  consentedAt: string;
}>;

export type DanceUploadReservation = Readonly<{
  reservationId: string;
  privateObjectKey: string;
  expectedContentType: "video/mp4" | "video/quicktime" | "video/webm";
  expectedSizeBytes: number;
  expectedDurationMs: number;
  expectedSha256: string | null;
  expiresAt: string;
}>;

export type DanceSealedUpload = Readonly<{
  reservationId: string;
  privateObjectKey: string;
  contentType: "video/mp4" | "video/quicktime" | "video/webm";
  sizeBytes: number;
  durationMs: number;
  serverSha256: string;
  sealedAt: string;
}>;

export type DanceShadowTerminalResult = Readonly<{
  attemptId: string;
  gradeOutcome: "scored" | "rejected" | "failed";
  qualificationOutcome: "suppressed_shadow";
  scoreBps: number | null;
  rejectionCode: string | null;
  scoredWindowStartMs: number;
  scoredWindowEndMs: number;
  scoredDurationMs: number;
  evidenceDigest: string;
  completedAt: string;
}>;

export type DanceAttemptSession = Readonly<{
  sessionId: string;
  accountId: string;
  personaId: string;
  communityId: string;
  songPostId: string;
  audioRevision: number;
  segmentId: string;
  choreographyId: string;
  choreographyRevision: number;
  rewardMode: "practice";
  objectiveSnapshot: readonly never[];
  expectedScoredDurationMs: number;
  cue: DanceStartCue;
  policy: DanceShadowPolicySnapshot;
  sessionTermsHash: string;
  state: DanceAttemptSessionState;
  consent: DanceSessionConsent | null;
  uploadReservation: DanceUploadReservation | null;
  sealedUpload: DanceSealedUpload | null;
  attemptId: string | null;
  terminalResult: DanceShadowTerminalResult | null;
  cleanupState: "not_scheduled" | "pending" | "completed";
  version: number;
  createdAt: string;
  expiresAt: string;
}>;

export type CreateDanceAttemptSession = Omit<
  DanceAttemptSession,
  | "state"
  | "consent"
  | "uploadReservation"
  | "sealedUpload"
  | "attemptId"
  | "terminalResult"
  | "cleanupState"
  | "version"
>;

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

function basisPoints(value: unknown): value is number {
  return nonNegativeInteger(value) && value <= 10_000;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function instant(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function accepted<T>(value: T, replayed = false): DanceAttemptDecision<T> {
  return { kind: "accepted", value, replayed };
}

function rejected<T>(reason: DanceAttemptDecisionRejection): DanceAttemptDecision<T> {
  return { kind: "rejected", reason };
}

function policyInvariant(policy: DanceShadowPolicySnapshot): boolean {
  return (
    policy.capturedAdmissionState === "shadow" &&
    basisPoints(policy.platformFloorBps) &&
    hash(policy.calibrationChecksum) &&
    [
      policy.qualificationPolicyVersionId,
      policy.calibrationVersionId,
      policy.poseModelVersion,
      policy.featureSchemaVersion,
      policy.scorerContractVersion,
      policy.mirrorPolicyVersion,
      policy.cuePolicyVersion,
      policy.fingerprintPolicyVersion,
      policy.integrityPolicyVersion,
      policy.graderAdapterVersion,
    ].every(identifier)
  );
}

function sameConsent(left: DanceSessionConsent, right: DanceSessionConsent): boolean {
  return (
    left.personaId === right.personaId &&
    left.sessionTermsHash === right.sessionTermsHash &&
    left.consentPolicyVersionId === right.consentPolicyVersionId &&
    left.retentionDisclosureVersion === right.retentionDisclosureVersion &&
    left.source === right.source &&
    left.consentedAt === right.consentedAt
  );
}

function sameReservation(left: DanceUploadReservation, right: DanceUploadReservation): boolean {
  return (
    left.reservationId === right.reservationId &&
    left.privateObjectKey === right.privateObjectKey &&
    left.expectedContentType === right.expectedContentType &&
    left.expectedSizeBytes === right.expectedSizeBytes &&
    left.expectedDurationMs === right.expectedDurationMs &&
    left.expectedSha256 === right.expectedSha256 &&
    left.expiresAt === right.expiresAt
  );
}

function sameSealedUpload(left: DanceSealedUpload, right: DanceSealedUpload): boolean {
  return (
    left.reservationId === right.reservationId &&
    left.privateObjectKey === right.privateObjectKey &&
    left.contentType === right.contentType &&
    left.sizeBytes === right.sizeBytes &&
    left.durationMs === right.durationMs &&
    left.serverSha256 === right.serverSha256 &&
    left.sealedAt === right.sealedAt
  );
}

function sameTerminalResult(
  left: DanceShadowTerminalResult,
  right: DanceShadowTerminalResult,
): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.gradeOutcome === right.gradeOutcome &&
    left.qualificationOutcome === right.qualificationOutcome &&
    left.scoreBps === right.scoreBps &&
    left.rejectionCode === right.rejectionCode &&
    left.scoredWindowStartMs === right.scoredWindowStartMs &&
    left.scoredWindowEndMs === right.scoredWindowEndMs &&
    left.scoredDurationMs === right.scoredDurationMs &&
    left.evidenceDigest === right.evidenceDigest &&
    left.completedAt === right.completedAt
  );
}

function cueInvariant(cue: DanceStartCue): boolean {
  return (
    ["hands_on_head", "arms_t", "hands_on_hips"].includes(cue.kind) &&
    positiveInteger(cue.holdMs) &&
    nonNegativeInteger(cue.observationStartMs) &&
    positiveInteger(cue.observationEndMs) &&
    cue.observationEndMs > cue.observationStartMs &&
    cue.holdMs <= cue.observationEndMs - cue.observationStartMs
  );
}

function terminalInvariant(
  session: DanceAttemptSession,
  result: DanceShadowTerminalResult,
): boolean {
  if (
    result.qualificationOutcome !== "suppressed_shadow" ||
    !identifier(result.attemptId) ||
    result.attemptId !== session.attemptId ||
    !hash(result.evidenceDigest) ||
    !instant(result.completedAt) ||
    !nonNegativeInteger(result.scoredWindowStartMs) ||
    !positiveInteger(result.scoredWindowEndMs) ||
    result.scoredWindowEndMs <= result.scoredWindowStartMs ||
    result.scoredDurationMs !== result.scoredWindowEndMs - result.scoredWindowStartMs ||
    result.scoredDurationMs !== session.expectedScoredDurationMs ||
    result.scoredWindowStartMs < session.cue.observationEndMs
  ) {
    return false;
  }
  if (result.gradeOutcome === "scored") {
    return basisPoints(result.scoreBps) && result.rejectionCode === null;
  }
  return (
    (result.gradeOutcome === "rejected" || result.gradeOutcome === "failed") &&
    result.scoreBps === null &&
    identifier(result.rejectionCode)
  );
}

function consentInvariant(session: DanceAttemptSession, consent: DanceSessionConsent): boolean {
  return (
    consent.personaId === session.personaId &&
    consent.sessionTermsHash === session.sessionTermsHash &&
    identifier(consent.consentPolicyVersionId) &&
    identifier(consent.retentionDisclosureVersion) &&
    (consent.source === "camera" || consent.source === "file_upload") &&
    instant(consent.consentedAt) &&
    Date.parse(consent.consentedAt) >= Date.parse(session.createdAt) &&
    Date.parse(consent.consentedAt) < Date.parse(session.expiresAt)
  );
}

function reservationInvariant(
  session: DanceAttemptSession,
  reservation: DanceUploadReservation,
): boolean {
  return (
    identifier(reservation.reservationId) &&
    identifier(reservation.privateObjectKey) &&
    ["video/mp4", "video/quicktime", "video/webm"].includes(reservation.expectedContentType) &&
    positiveInteger(reservation.expectedSizeBytes) &&
    positiveInteger(reservation.expectedDurationMs) &&
    (reservation.expectedSha256 === null || hash(reservation.expectedSha256)) &&
    instant(reservation.expiresAt) &&
    Date.parse(reservation.expiresAt) > Date.parse(session.createdAt) &&
    Date.parse(reservation.expiresAt) <= Date.parse(session.expiresAt)
  );
}

function sealedUploadInvariant(
  session: DanceAttemptSession,
  reservation: DanceUploadReservation,
  sealed: DanceSealedUpload,
): boolean {
  return (
    sealed.reservationId === reservation.reservationId &&
    sealed.privateObjectKey === reservation.privateObjectKey &&
    sealed.contentType === reservation.expectedContentType &&
    sealed.sizeBytes === reservation.expectedSizeBytes &&
    sealed.durationMs === reservation.expectedDurationMs &&
    hash(sealed.serverSha256) &&
    (reservation.expectedSha256 === null || reservation.expectedSha256 === sealed.serverSha256) &&
    instant(sealed.sealedAt) &&
    Date.parse(sealed.sealedAt) < Date.parse(reservation.expiresAt) &&
    sealed.durationMs >= session.cue.observationEndMs + session.expectedScoredDurationMs
  );
}

export function danceAttemptSessionInvariant(session: DanceAttemptSession): string | null {
  if (
    ![
      session.sessionId,
      session.accountId,
      session.personaId,
      session.communityId,
      session.songPostId,
      session.segmentId,
      session.choreographyId,
    ].every(identifier) ||
    !positiveInteger(session.audioRevision) ||
    !positiveInteger(session.choreographyRevision) ||
    session.rewardMode !== "practice" ||
    session.objectiveSnapshot.length !== 0 ||
    !positiveInteger(session.version) ||
    !hash(session.sessionTermsHash) ||
    !policyInvariant(session.policy) ||
    !cueInvariant(session.cue) ||
    !positiveInteger(session.expectedScoredDurationMs) ||
    session.expectedScoredDurationMs < 6_000 ||
    session.expectedScoredDurationMs > 30_000 ||
    !instant(session.createdAt) ||
    !instant(session.expiresAt) ||
    Date.parse(session.expiresAt) <= Date.parse(session.createdAt)
  ) {
    return "terms";
  }
  if (session.state === "created" && session.consent !== null) return "created_consent";
  if (!["created", "expired", "abandoned"].includes(session.state) && session.consent === null) {
    return "consent";
  }
  if (session.consent !== null && !consentInvariant(session, session.consent)) return "consent";
  if (session.uploadReservation !== null) {
    if (session.consent === null || !reservationInvariant(session, session.uploadReservation)) {
      return "upload_reservation";
    }
  }
  if (session.state === "awaiting_upload" && session.uploadReservation === null) {
    return "upload_reservation";
  }
  if (
    (session.state === "created" || session.state === "consented") &&
    session.uploadReservation !== null
  ) {
    return "upload_reservation";
  }
  if (session.sealedUpload !== null) {
    if (
      session.uploadReservation === null ||
      !sealedUploadInvariant(session, session.uploadReservation, session.sealedUpload)
    ) {
      return "upload";
    }
  }
  if (
    ["uploaded", "grading_pending", "completed", "rejected", "processing_failed"].includes(
      session.state,
    ) &&
    session.sealedUpload === null
  ) {
    return "sealed_upload";
  }
  if (
    ["grading_pending", "completed", "rejected", "processing_failed"].includes(session.state) &&
    session.attemptId === null
  ) {
    return "attempt";
  }
  if (
    !["grading_pending", "completed", "rejected", "processing_failed"].includes(session.state) &&
    session.attemptId !== null
  ) {
    return "attempt";
  }
  const terminal = ["completed", "rejected", "processing_failed"].includes(session.state);
  if (terminal !== (session.terminalResult !== null)) return "terminal";
  if (session.terminalResult !== null && !terminalInvariant(session, session.terminalResult)) {
    return "terminal_result";
  }
  if (terminal && session.cleanupState === "not_scheduled") return "cleanup";
  return null;
}

export function createDanceAttemptSession(
  command: CreateDanceAttemptSession,
): DanceAttemptDecision<DanceAttemptSession> {
  const candidate: DanceAttemptSession = {
    ...command,
    state: "created",
    consent: null,
    uploadReservation: null,
    sealedUpload: null,
    attemptId: null,
    terminalResult: null,
    cleanupState: "not_scheduled",
    version: 1,
  };
  return danceAttemptSessionInvariant(candidate) === null
    ? accepted(candidate)
    : rejected("shadow_boundary_violation");
}

export function recordDanceSessionConsent(
  current: DanceAttemptSession,
  expectedVersion: number,
  consent: DanceSessionConsent,
): DanceAttemptDecision<DanceAttemptSession> {
  if (danceAttemptSessionInvariant(current) !== null) return rejected("invalid_state");
  if (current.consent !== null) {
    return sameConsent(current.consent, consent)
      ? accepted(current, true)
      : rejected("consent_binding_conflict");
  }
  if (expectedVersion !== current.version) return rejected("version_conflict");
  if (current.state !== "created") return rejected("transition_not_allowed");
  if (
    consent.personaId !== current.personaId ||
    consent.sessionTermsHash !== current.sessionTermsHash ||
    !identifier(consent.consentPolicyVersionId) ||
    !identifier(consent.retentionDisclosureVersion) ||
    (consent.source !== "camera" && consent.source !== "file_upload") ||
    !instant(consent.consentedAt) ||
    Date.parse(consent.consentedAt) < Date.parse(current.createdAt) ||
    Date.parse(consent.consentedAt) >= Date.parse(current.expiresAt)
  ) {
    return rejected("consent_binding_conflict");
  }
  return accepted({ ...current, state: "consented", consent, version: current.version + 1 });
}

export function reserveDanceSessionUpload(
  current: DanceAttemptSession,
  expectedVersion: number,
  reservation: DanceUploadReservation,
): DanceAttemptDecision<DanceAttemptSession> {
  if (danceAttemptSessionInvariant(current) !== null) return rejected("invalid_state");
  if (current.uploadReservation !== null) {
    return sameReservation(current.uploadReservation, reservation)
      ? accepted(current, true)
      : rejected("upload_identity_conflict");
  }
  if (expectedVersion !== current.version) return rejected("version_conflict");
  if (current.state !== "consented") return rejected("transition_not_allowed");
  if (
    !identifier(reservation.reservationId) ||
    !identifier(reservation.privateObjectKey) ||
    !positiveInteger(reservation.expectedSizeBytes) ||
    !positiveInteger(reservation.expectedDurationMs) ||
    (reservation.expectedSha256 !== null && !hash(reservation.expectedSha256)) ||
    !instant(reservation.expiresAt) ||
    Date.parse(reservation.expiresAt) > Date.parse(current.expiresAt) ||
    Date.parse(reservation.expiresAt) <= Date.parse(current.createdAt)
  ) {
    return rejected("invalid_command");
  }
  return accepted({
    ...current,
    state: "awaiting_upload",
    uploadReservation: reservation,
    version: current.version + 1,
  });
}

export function sealDanceSessionUpload(
  current: DanceAttemptSession,
  expectedVersion: number,
  sealed: DanceSealedUpload,
): DanceAttemptDecision<DanceAttemptSession> {
  if (danceAttemptSessionInvariant(current) !== null) return rejected("invalid_state");
  if (current.sealedUpload !== null) {
    return sameSealedUpload(current.sealedUpload, sealed)
      ? accepted(current, true)
      : rejected("sealed_digest_conflict");
  }
  if (expectedVersion !== current.version) return rejected("version_conflict");
  const reservation = current.uploadReservation;
  if (current.state !== "awaiting_upload" || reservation === null) {
    return rejected("transition_not_allowed");
  }
  if (
    sealed.reservationId !== reservation.reservationId ||
    sealed.privateObjectKey !== reservation.privateObjectKey ||
    sealed.contentType !== reservation.expectedContentType ||
    sealed.sizeBytes !== reservation.expectedSizeBytes ||
    sealed.durationMs !== reservation.expectedDurationMs ||
    !hash(sealed.serverSha256) ||
    (reservation.expectedSha256 !== null && reservation.expectedSha256 !== sealed.serverSha256) ||
    !instant(sealed.sealedAt) ||
    Date.parse(sealed.sealedAt) >= Date.parse(reservation.expiresAt) ||
    sealed.durationMs < current.cue.observationEndMs + current.expectedScoredDurationMs
  ) {
    return rejected("sealed_digest_conflict");
  }
  return accepted({
    ...current,
    state: "uploaded",
    sealedUpload: sealed,
    version: current.version + 1,
  });
}

export function submitDanceSessionForGrading(
  current: DanceAttemptSession,
  expectedVersion: number,
  attemptId: string,
): DanceAttemptDecision<DanceAttemptSession> {
  if (danceAttemptSessionInvariant(current) !== null) return rejected("invalid_state");
  if (current.attemptId !== null) {
    return current.attemptId === attemptId
      ? accepted(current, true)
      : rejected("attempt_identity_conflict");
  }
  if (expectedVersion !== current.version) return rejected("version_conflict");
  if (current.state !== "uploaded") return rejected("transition_not_allowed");
  if (!identifier(attemptId)) return rejected("invalid_command");
  return accepted({
    ...current,
    state: "grading_pending",
    attemptId,
    version: current.version + 1,
  });
}

export function finalizeDanceShadowAttempt(
  current: DanceAttemptSession,
  expectedVersion: number,
  result: DanceShadowTerminalResult,
): DanceAttemptDecision<DanceAttemptSession> {
  if (danceAttemptSessionInvariant(current) !== null) return rejected("invalid_state");
  if (current.terminalResult !== null) {
    return sameTerminalResult(current.terminalResult, result)
      ? accepted(current, true)
      : rejected("terminal_result_conflict");
  }
  if (expectedVersion !== current.version) return rejected("version_conflict");
  if (current.state !== "grading_pending") return rejected("transition_not_allowed");
  if (result.qualificationOutcome !== "suppressed_shadow") {
    return rejected("shadow_boundary_violation");
  }
  if (!terminalInvariant(current, result)) return rejected("invalid_command");
  const state =
    result.gradeOutcome === "scored"
      ? "completed"
      : result.gradeOutcome === "rejected"
        ? "rejected"
        : "processing_failed";
  return accepted({
    ...current,
    state,
    terminalResult: result,
    cleanupState: "pending",
    version: current.version + 1,
  });
}
