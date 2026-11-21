/** Pure moderated family. No media, clock, storage or funding I/O. */
export const MODERATED_DANCE_REPLAY_RETIRED = "keyed-replay-retired-v1";
export type ReviewPolicy = Readonly<{
  version: "moderator-review-policy-v1" | "moderator-review-policy-v2";
  hash: string;
  qualificationVersion: string;
  qualificationHash: string;
  rubricVersion: string;
  rubricHash: string;
  disclosureVersion: string;
  consentVersion: string;
  consentHash: string;
  normalizationVersion: string;
  normalizationHash: string;
  safetyHash: string;
  retentionHash: string;
  reviewWindowMs: number;
  admission: "shadow" | "streak_admitted" | "money_admitted";
  admissionVersion: string;
  admissionHash: string;
  producerId: string;
}>;
export type FrozenObjective = Readonly<{
  id: string;
  version: string;
  termsHash: string;
  fundingPolicyHash: string;
  gradingMode: "moderator_verdict";
}>;
export type SealedReviewCapture = Readonly<{
  reviewId: string;
  sessionId: string;
  attemptId: string;
  accountId: string;
  personaId: string;
  communityId: string;
  songPostId: string;
  audioRevision: number;
  choreographyId: string;
  choreographyRevision: number;
  segmentId: string;
  termsHash: string;
  policy: ReviewPolicy;
  accountFenceRevision: number;
  uploadId: string;
  sourceDigest: string;
  normalizedDigest: string;
  analysisRevision: number;
  firstStoredAtMs: number;
  uploadedAtMs: number;
  captureExpiresAtMs: number;
  bodyStartMs: number;
  bodyEndMs: number;
  cueId: string;
  cueStartMs: number;
  cueEndMs: number;
  cueHoldMs: number;
  timezone: string;
  timezoneVersion: string;
  rewardMode: "practice" | "reward_eligible";
  objectives: readonly FrozenObjective[];
  consent: Readonly<{
    receiptId: string;
    uploadId: string;
    recordedAtMs: number;
    accountId: string;
    personaId: string;
    termsHash: string;
    version: string;
    policyHash: string;
  }>;
}>;
export type SubmitReceipt = Readonly<{
  id: string;
  showPublicly: boolean;
  disclosureVersion: string;
  submittedAtMs: number;
  uploadId: string;
  sourceDigest: string;
}>;
export type OwnerAttestation = Readonly<{
  version: "dance-owner-verdict-attestation-v1" | "dance-owner-verdict-attestation-v2";
  producer: "owner_verdict_attestation";
  cue: "affirmed" | "not_attested" | "not_required";
  reviewerAccountId: string;
  assignmentId: string;
  assignmentRevision: number;
  sourceDigest: string;
  rubricVersion: string;
  rubricHash: string;
  termsHash: string;
  cueId: string;
  choreographyId: string;
  choreographyRevision: number;
  bodyStartMs: number;
  bodyEndMs: number;
  committedAtMs: number;
}>;
export type ReviewState =
  | "uploaded"
  | "screening"
  | "awaiting_review"
  | "reviewed"
  | "review_expired"
  | "withdrawn"
  | "held"
  | "expired"
  | "abandoned"
  | "processing_failed";
export type ModeratorReview = Readonly<{
  capture: SealedReviewCapture;
  revision: number;
  state: ReviewState;
  reviewDeadlineMs: number;
  initialSubmit: SubmitReceipt | null;
  submittedAtMs: number | null;
  submissionDay: Readonly<{ day: string; timezone: string; timezoneVersion: string }> | null;
  showPublicly: boolean | null;
  choiceRevision: number;
  generation: number;
  publication: "none" | "staged" | "cancelled" | "pending" | "failed" | "transferred";
  publicationRevision: number;
  transferDeadlineMs: number | null;
  terminalAtMs: number | null;
  verdict: "passed" | "not_passed" | null;
  attestation: OwnerAttestation | null;
  qualificationRef: string | null;
}>;
export type ReviewActor = Readonly<{ kind: "account" | "worker"; accountId: string }>;
export type DispositionAuthority = Readonly<{
  accepted: boolean;
  version: string;
  hash: string;
  validUntilMs: number;
  cleanupWithinMs: number;
  temporaryCleanupWithinMs: number;
  transferWithinMs: number;
  hold: Readonly<{
    accepted: boolean;
    authorityRef: string;
    policyHash: string;
    disposeByMs: number;
  }> | null;
}>;
export type ReviewFacts = Readonly<{
  accountActive: boolean;
  accountFenceRevision: number;
  workerAuthorized: boolean;
  ownedPersona: Readonly<{
    active: boolean;
    accountId: string;
    personaId: string;
    communityId: string;
  }> | null;
  owner: Readonly<{
    accountId: string;
    communityId: string;
    assignmentId: string;
    revision: number;
    canInspect: boolean;
  }> | null;
  referenceCutoffAtMs: number | null;
  media: Readonly<{
    accepted: boolean;
    sourceDigest: string;
    normalizedDigest: string;
    normalizationVersion: string;
    normalizationHash: string;
  }> | null;
  safety: Readonly<{
    status: "accepted" | "flagged" | "failed" | "unknown";
    persisted: boolean;
    sourceDigest: string;
    analysisRevision: number;
    policyHash: string;
    frameDigests: readonly [string, string, string];
  }> | null;
  integrity: Readonly<{
    status: "unique" | "blocked" | "unknown";
    persisted: boolean;
    sourceDigest: string;
    normalizedDigest: string;
    policyHash: string;
  }> | null;
  disposition: DispositionAuthority | null;
  submissionDay: Readonly<{
    atMs: number;
    day: string;
    timezone: string;
    timezoneVersion: string;
  }> | null;
  qualification: Readonly<{
    admitted: boolean;
    producerId: string;
    policyVersion: string;
    policyHash: string;
    admissionVersion: string;
    admissionHash: string;
  }> | null;
}>;
export type ReviewEvent =
  | Readonly<{
      kind: "submit";
      showPublicly: boolean;
      disclosureVersion: string;
      receiptId: string;
    }>
  | Readonly<{ kind: "visibility"; showPublicly: boolean; disclosureVersion: string }>
  | Readonly<{
      kind: "verdict";
      verdict: "passed" | "not_passed";
      version: "dance-owner-verdict-attestation-v1" | "dance-owner-verdict-attestation-v2";
    }>
  | Readonly<{ kind: "withdraw" | "screen" | "expire" | "erase" }>
  | Readonly<{ kind: "publication_failed"; generation: number }>;
// Reducer-owned reasons remain part of the public ReviewTransition shape.
type ReviewRejection =
  | "invalid_state"
  | "policy_unavailable"
  | "evidence_unavailable"
  | "disposition_unavailable"
  | "not_authorized"
  | "self_review"
  | "lifecycle_changed"
  | "revision_conflict"
  | "reference_cutoff"
  | "review_deadline_reached"
  | "capture_expired"
  | "publication_choice_closed"
  | "review_closed"
  | "disclosure_mismatch"
  | "stale_generation";
export type QualificationIntent = Readonly<{
  id: string;
  accountId: string;
  communityId: string;
  songPostId: string;
  audioRevision: number;
  grading_mode: "moderator_verdict";
  verdict: "passed";
  score_bps: null;
  calibration: null;
  floor: null;
  qualifiedAtMs: number;
  submissionDay: string;
  timezone: string;
  timezoneVersion: string;
  producerId: string;
  policyVersion: string;
  policyHash: string;
  admissionVersion: string;
  admissionHash: string;
  rewardMode: "practice" | "reward_eligible";
  objectives: readonly FrozenObjective[];
}>;
export type ReviewIntent = Readonly<{
  key: string;
  kind:
    | "result"
    | "cleanup_review"
    | "cleanup_temporary"
    | "hold_review"
    | "handoff_prepare"
    | "handoff_cancel"
    | "handoff_release"
    | "qualification";
  reviewId: string;
  generation: number;
  deadlineMs: number | null;
  holdAuthorityRef: string | null;
  qualification: QualificationIntent | null;
}>;
export type ReviewTransition = Readonly<{
  state: ModeratorReview;
  intents: readonly ReviewIntent[];
  refusal: ReviewRejection | null;
}>;
const id = (s: string) =>
  typeof s === "string" &&
  s.length > 0 &&
  s.length <= 128 &&
  s === s.trim() &&
  ![...s].some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return n < 32 || (n >= 127 && n <= 159);
  });
const hash = (s: string) => typeof s === "string" && /^[a-f0-9]{64}$/u.test(s);
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
const time = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 8_640_000_000_000_000;
const pending = (s: ModeratorReview) => s.state === "screening" || s.state === "awaiting_review";
const terminal = (s: ModeratorReview) => s.state !== "uploaded" && !pending(s);
const denied = (state: ModeratorReview, refusal: ReviewRejection): ReviewTransition => ({
  state,
  intents: [],
  refusal,
});
const intent = (
  s: ModeratorReview,
  kind: ReviewIntent["kind"],
  generation: number,
  deadlineMs: number | null,
  qualification: QualificationIntent | null = null,
  holdAuthorityRef: string | null = null,
): ReviewIntent => ({
  key: JSON.stringify(["dance-review-intent-v1", s.capture.reviewId, kind, generation]),
  kind,
  reviewId: s.capture.reviewId,
  generation,
  deadlineMs,
  qualification,
  holdAuthorityRef,
});

function validCapture(c: SealedReviewCapture, retainedTerminal = false): boolean {
  const p = c.policy;
  return (
    !!p &&
    (p.version === "moderator-review-policy-v1" || p.version === "moderator-review-policy-v2") &&
    [
      c.reviewId,
      c.sessionId,
      c.attemptId,
      c.accountId,
      c.personaId,
      c.communityId,
      c.songPostId,
      c.choreographyId,
      c.segmentId,
      c.uploadId,
      c.cueId,
      c.timezone,
      c.timezoneVersion,
      p.qualificationVersion,
      p.rubricVersion,
      p.disclosureVersion,
      p.consentVersion,
      p.normalizationVersion,
      p.admissionVersion,
      p.producerId,
    ].every(id) &&
    [
      c.termsHash,
      c.sourceDigest,
      p.hash,
      p.qualificationHash,
      p.rubricHash,
      p.consentHash,
      p.normalizationHash,
      p.safetyHash,
      p.retentionHash,
      p.admissionHash,
    ].every(hash) &&
    (hash(c.normalizedDigest) ||
      (retainedTerminal && c.normalizedDigest === MODERATED_DANCE_REPLAY_RETIRED)) &&
    [c.audioRevision, c.choreographyRevision, c.analysisRevision, c.accountFenceRevision].every(
      positive,
    ) &&
    time(c.firstStoredAtMs) &&
    time(c.uploadedAtMs) &&
    time(c.captureExpiresAtMs) &&
    c.firstStoredAtMs <= c.uploadedAtMs &&
    c.uploadedAtMs < c.captureExpiresAtMs &&
    // Settled seven-day review rule, supplied explicitly, not a selected TTL.
    p.reviewWindowMs === 7 * 24 * 60 * 60 * 1000 &&
    time(c.uploadedAtMs + p.reviewWindowMs) &&
    time(c.bodyStartMs) &&
    time(c.bodyEndMs) &&
    c.bodyEndMs - c.bodyStartMs >= 6000 &&
    c.bodyEndMs - c.bodyStartMs <= 30000 &&
    (p.version === "moderator-review-policy-v2"
      ? c.cueId === "none" &&
        c.cueStartMs === 0 &&
        c.cueEndMs === 0 &&
        c.cueHoldMs === 0 &&
        c.bodyStartMs === 0
      : time(c.cueStartMs) &&
        time(c.cueEndMs) &&
        c.cueStartMs < c.cueEndMs &&
        c.cueEndMs <= c.bodyStartMs &&
        positive(c.cueHoldMs) &&
        c.cueHoldMs <= c.cueEndMs - c.cueStartMs) &&
    ["shadow", "streak_admitted", "money_admitted"].includes(p.admission) &&
    ["practice", "reward_eligible"].includes(c.rewardMode) &&
    Array.isArray(c.objectives) &&
    (c.rewardMode === "practice"
      ? c.objectives.length === 0
      : p.admission === "money_admitted" && c.objectives.length > 0) &&
    c.objectives.every(
      (o) =>
        id(o.id) &&
        id(o.version) &&
        hash(o.termsHash) &&
        hash(o.fundingPolicyHash) &&
        o.gradingMode === "moderator_verdict",
    ) &&
    new Set(c.objectives.map((o) => o.id)).size === c.objectives.length &&
    !!c.consent &&
    id(c.consent.receiptId) &&
    c.consent.uploadId === c.uploadId &&
    time(c.consent.recordedAtMs) &&
    c.consent.recordedAtMs < c.firstStoredAtMs &&
    c.consent.accountId === c.accountId &&
    c.consent.personaId === c.personaId &&
    c.consent.termsHash === c.termsHash &&
    c.consent.version === p.consentVersion &&
    c.consent.policyHash === p.consentHash
  );
}
function disposition(
  c: SealedReviewCapture,
  f: ReviewFacts,
  now: number,
): DispositionAuthority | null {
  const d = f.disposition;
  return d?.accepted &&
    id(d.version) &&
    hash(d.hash) &&
    d.hash === c.policy.retentionHash &&
    time(d.validUntilMs) &&
    now < d.validUntilMs &&
    [d.cleanupWithinMs, d.temporaryCleanupWithinMs, d.transferWithinMs].every(positive) &&
    d.transferWithinMs <= d.cleanupWithinMs &&
    [d.cleanupWithinMs, d.temporaryCleanupWithinMs, d.transferWithinMs].every((n) => time(now + n))
    ? d
    : null;
}
function boundMedia(c: SealedReviewCapture, f: ReviewFacts): boolean {
  const m = f.media;
  return (
    m?.accepted === true &&
    m.sourceDigest === c.sourceDigest &&
    m.normalizedDigest === c.normalizedDigest &&
    m.normalizationVersion === c.policy.normalizationVersion &&
    m.normalizationHash === c.policy.normalizationHash
  );
}
function boundSafety(c: SealedReviewCapture, f: ReviewFacts): boolean {
  const s = f.safety;
  return (
    s?.persisted === true &&
    s.sourceDigest === c.sourceDigest &&
    s.analysisRevision === c.analysisRevision &&
    s.policyHash === c.policy.safetyHash &&
    s.frameDigests.length === 3 &&
    // Three captured positions remain evidence when two images have identical pixels.
    s.frameDigests.every(hash)
  );
}
function unique(c: SealedReviewCapture, f: ReviewFacts): boolean {
  const i = f.integrity;
  return (
    i?.persisted === true &&
    i.status === "unique" &&
    i.sourceDigest === c.sourceDigest &&
    i.normalizedDigest === c.normalizedDigest &&
    i.policyHash === c.policy.normalizationHash
  );
}
export function initializeModeratorReview(
  capture: SealedReviewCapture,
  facts: ReviewFacts,
  now: number,
): ModeratorReview | null {
  const persona = facts.ownedPersona,
    owner = facts.owner;
  if (
    !time(now) ||
    !validCapture(capture) ||
    !disposition(capture, facts, now) ||
    !boundMedia(capture, facts) ||
    !facts.accountActive ||
    facts.accountFenceRevision !== capture.accountFenceRevision ||
    !persona?.active ||
    persona.accountId !== capture.accountId ||
    persona.personaId !== capture.personaId ||
    persona.communityId !== capture.communityId ||
    !owner ||
    owner.communityId !== capture.communityId ||
    !id(owner.accountId) ||
    !id(owner.assignmentId) ||
    !positive(owner.revision) ||
    owner.accountId === capture.accountId ||
    now < capture.uploadedAtMs ||
    now >= capture.captureExpiresAtMs ||
    (facts.referenceCutoffAtMs !== null &&
      (!time(facts.referenceCutoffAtMs) || now >= facts.referenceCutoffAtMs))
  )
    return null;
  return {
    capture,
    revision: 1,
    state: "uploaded",
    reviewDeadlineMs: capture.uploadedAtMs + capture.policy.reviewWindowMs,
    initialSubmit: null,
    submittedAtMs: null,
    submissionDay: null,
    showPublicly: null,
    choiceRevision: 0,
    generation: 0,
    publication: "none",
    publicationRevision: 0,
    transferDeadlineMs: null,
    terminalAtMs: null,
    verdict: null,
    attestation: null,
    qualificationRef: null,
  };
}

function finish(
  s: ModeratorReview,
  state: ReviewState,
  now: number,
  d: DispositionAuthority,
  hold: DispositionAuthority["hold"] = null,
): ReviewTransition {
  const next: ModeratorReview = {
    ...s,
    state,
    revision: s.revision + 1,
    terminalAtMs: now,
    publication: s.generation > 0 ? "cancelled" : "none",
    publicationRevision: s.publicationRevision + 1,
  };
  const intents = [
    intent(next, "result", 0, null),
    hold
      ? intent(next, "hold_review", 0, hold.disposeByMs, null, hold.authorityRef)
      : intent(next, "cleanup_review", 0, now + d.cleanupWithinMs),
  ];
  if (s.generation > 0)
    intents.push(
      intent(next, "handoff_cancel", s.generation, now),
      intent(next, "cleanup_temporary", s.generation, now + d.temporaryCleanupWithinMs),
    );
  return { state: next, intents, refusal: null };
}

/** Cancels only the pending private handoff, never a separately owned Post.
 * Its committed transfer deadline remains an absolute upper bound even when
 * reconciliation runs late or the current admission/retention policy is gone.
 * An overdue cleanup obligation stays overdue; retry cannot renew its budget.
 */
function cancelPassedHandoff(
  s: ModeratorReview,
  publication: "cancelled" | "failed",
  expectedRevision: number,
  now: number,
): ReviewTransition {
  if (s.state !== "reviewed" || s.verdict !== "passed") return denied(s, "review_closed");
  if (expectedRevision !== s.revision) return denied(s, "revision_conflict");
  if (publication === "cancelled" && (s.publication === "cancelled" || s.publication === "failed"))
    return { state: s, intents: [], refusal: null };
  if (s.publication !== "pending") return denied(s, "stale_generation");
  const deadline = s.transferDeadlineMs;
  if (
    deadline === null ||
    !time(deadline) ||
    s.terminalAtMs === null ||
    !time(s.terminalAtMs) ||
    deadline <= s.terminalAtMs ||
    now < s.terminalAtMs
  )
    return denied(s, "invalid_state");
  return {
    state: { ...s, publication, publicationRevision: s.publicationRevision + 1 },
    intents: [
      intent(s, "handoff_cancel", s.generation, Math.min(now, deadline)),
      intent(s, "cleanup_temporary", s.generation, deadline),
    ],
    refusal: null,
  };
}

export function transitionModeratorReview(
  s: ModeratorReview,
  event: ReviewEvent,
  actor: ReviewActor,
  expectedRevision: number,
  now: number,
  f: ReviewFacts,
): ReviewTransition {
  const c = s.capture;
  if (
    !time(now) ||
    !validCapture(c, terminal(s) && s.publication !== "pending") ||
    !positive(s.revision) ||
    s.reviewDeadlineMs !== c.uploadedAtMs + c.policy.reviewWindowMs ||
    now < c.uploadedAtMs
  )
    return denied(s, "invalid_state");
  const worker = actor.kind === "worker" && f.workerAuthorized;
  const dancer = actor.kind === "account" && actor.accountId === c.accountId;
  if (
    event.kind === "screen" ||
    event.kind === "expire" ||
    event.kind === "erase" ||
    event.kind === "publication_failed"
  ) {
    if (!worker) return denied(s, "not_authorized");
  } else if (event.kind !== "verdict" && !dancer) return denied(s, "not_authorized");
  // Trusted workers must be able to drain an already authorized handoff after
  // erasure invalidates its release fence. This grants no new review, result,
  // qualification or publication effect and does not reopen private access.
  if (event.kind === "publication_failed") {
    if (event.generation !== s.generation) return denied(s, "stale_generation");
    return cancelPassedHandoff(s, "failed", expectedRevision, now);
  }
  if (
    terminal(s) &&
    event.kind === "erase" &&
    (!f.accountActive || f.accountFenceRevision !== c.accountFenceRevision)
  )
    return cancelPassedHandoff(s, "cancelled", expectedRevision, now);
  if (terminal(s))
    return denied(s, event.kind === "visibility" ? "publication_choice_closed" : "review_closed");
  const d = disposition(c, f, now);
  if (!d) return denied(s, "disposition_unavailable");
  if (event.kind === "erase") return finish(s, "abandoned", now, d);
  if (!f.accountActive || f.accountFenceRevision !== c.accountFenceRevision)
    return denied(s, "lifecycle_changed");
  if (pending(s) && now >= s.reviewDeadlineMs) {
    const expired = finish(s, "review_expired", now, d);
    return { ...expired, refusal: "review_deadline_reached" };
  }
  if (s.state === "uploaded" && (now >= c.captureExpiresAtMs || now >= s.reviewDeadlineMs)) {
    const expired = finish(s, "expired", now, d);
    return { ...expired, refusal: "capture_expired" };
  }
  if (
    f.referenceCutoffAtMs !== null &&
    (!time(f.referenceCutoffAtMs) || (s.submittedAtMs === null && now >= f.referenceCutoffAtMs))
  ) {
    const closed = finish(s, "abandoned", now, d);
    return { ...closed, refusal: "reference_cutoff" };
  }
  if (expectedRevision !== s.revision) return denied(s, "revision_conflict");
  if (event.kind === "expire") return denied(s, "invalid_state");
  if (event.kind === "submit") {
    if (s.state !== "uploaded") return denied(s, "review_closed");
    const owner = f.owner,
      persona = f.ownedPersona,
      day = f.submissionDay;
    if (
      !owner ||
      owner.communityId !== c.communityId ||
      !id(owner.accountId) ||
      !persona?.active ||
      persona.accountId !== c.accountId ||
      persona.personaId !== c.personaId ||
      persona.communityId !== c.communityId
    )
      return denied(s, "not_authorized");
    if (owner.accountId === c.accountId) return denied(s, "self_review");
    if (event.disclosureVersion !== c.policy.disclosureVersion)
      return denied(s, "disclosure_mismatch");
    if (
      !id(event.receiptId) ||
      !boundMedia(c, f) ||
      !day ||
      day.atMs !== now ||
      day.timezone !== c.timezone ||
      day.timezoneVersion !== c.timezoneVersion ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(day.day)
    )
      return denied(s, "evidence_unavailable");
    const next: ModeratorReview = {
      ...s,
      revision: s.revision + 1,
      state: "screening",
      submittedAtMs: now,
      submissionDay: { day: day.day, timezone: day.timezone, timezoneVersion: day.timezoneVersion },
      initialSubmit: {
        id: event.receiptId,
        showPublicly: event.showPublicly,
        disclosureVersion: event.disclosureVersion,
        submittedAtMs: now,
        uploadId: c.uploadId,
        sourceDigest: c.sourceDigest,
      },
      showPublicly: event.showPublicly,
      choiceRevision: 1,
      generation: event.showPublicly ? 1 : 0,
      publication: event.showPublicly ? "staged" : "none",
      publicationRevision: s.publicationRevision + 1,
    };
    return {
      state: next,
      intents: event.showPublicly ? [intent(next, "handoff_prepare", 1, s.reviewDeadlineMs)] : [],
      refusal: null,
    };
  }
  if (event.kind === "visibility") {
    if (!pending(s)) return denied(s, "publication_choice_closed");
    if (event.disclosureVersion !== c.policy.disclosureVersion)
      return denied(s, "disclosure_mismatch");
    if (event.showPublicly === s.showPublicly) return { state: s, intents: [], refusal: null };
    const generation = s.generation + 1;
    const next: ModeratorReview = {
      ...s,
      revision: s.revision + 1,
      choiceRevision: s.choiceRevision + 1,
      showPublicly: event.showPublicly,
      generation,
      publication: event.showPublicly ? "staged" : "cancelled",
      publicationRevision: s.publicationRevision + 1,
    };
    const intents: ReviewIntent[] = s.showPublicly
      ? [
          intent(next, "handoff_cancel", s.generation, now),
          intent(next, "cleanup_temporary", s.generation, now + d.temporaryCleanupWithinMs),
        ]
      : [];
    if (event.showPublicly)
      intents.push(intent(next, "handoff_prepare", generation, s.reviewDeadlineMs));
    return { state: next, intents, refusal: null };
  }
  if (event.kind === "withdraw") return finish(s, "withdrawn", now, d);
  if (event.kind === "screen") {
    if (s.state !== "screening") return denied(s, "invalid_state");
    if (!boundMedia(c, f) || !boundSafety(c, f) || f.safety?.status === "unknown")
      return denied(s, "evidence_unavailable");
    if (f.safety?.status === "flagged") {
      const hold = d.hold;
      if (
        !hold?.accepted ||
        !id(hold.authorityRef) ||
        !hash(hold.policyHash) ||
        !time(hold.disposeByMs) ||
        hold.disposeByMs <= now
      )
        return denied(s, "disposition_unavailable");
      return finish(s, "held", now, d, hold);
    }
    if (f.safety?.status === "failed" || f.integrity?.status === "blocked")
      return finish(s, "processing_failed", now, d);
    if (f.safety?.status !== "accepted" || !unique(c, f)) return denied(s, "evidence_unavailable");
    return {
      state: { ...s, state: "awaiting_review", revision: s.revision + 1 },
      intents: [],
      refusal: null,
    };
  }
  if (event.kind === "verdict") {
    if (s.state !== "awaiting_review") return denied(s, "review_closed");
    const owner = f.owner;
    if (
      actor.kind !== "account" ||
      !owner ||
      owner.accountId !== actor.accountId ||
      owner.communityId !== c.communityId ||
      !owner.canInspect ||
      !id(owner.assignmentId) ||
      !positive(owner.revision)
    )
      return denied(s, "not_authorized");
    if (owner.accountId === c.accountId) return denied(s, "self_review");
    if (
      event.version !==
        (c.policy.version === "moderator-review-policy-v2"
          ? "dance-owner-verdict-attestation-v2"
          : "dance-owner-verdict-attestation-v1") ||
      !boundMedia(c, f) ||
      !boundSafety(c, f) ||
      f.safety?.status !== "accepted" ||
      !unique(c, f)
    )
      return denied(s, "evidence_unavailable");
    const terminal = finish(s, "reviewed", now, d);
    const q = f.qualification,
      p = c.policy;
    const admitted =
      event.verdict === "passed" &&
      p.admission !== "shadow" &&
      q?.admitted === true &&
      q.producerId === p.producerId &&
      q.policyVersion === p.qualificationVersion &&
      q.policyHash === p.qualificationHash &&
      q.admissionVersion === p.admissionVersion &&
      q.admissionHash === p.admissionHash;
    const next: ModeratorReview = {
      ...terminal.state,
      verdict: event.verdict,
      attestation: {
        version: event.version,
        producer: "owner_verdict_attestation",
        cue:
          p.version === "moderator-review-policy-v2"
            ? "not_required"
            : event.verdict === "passed"
              ? "affirmed"
              : "not_attested",
        reviewerAccountId: actor.accountId,
        assignmentId: owner.assignmentId,
        assignmentRevision: owner.revision,
        sourceDigest: c.sourceDigest,
        rubricVersion: p.rubricVersion,
        rubricHash: p.rubricHash,
        termsHash: c.termsHash,
        cueId: c.cueId,
        choreographyId: c.choreographyId,
        choreographyRevision: c.choreographyRevision,
        bodyStartMs: c.bodyStartMs,
        bodyEndMs: c.bodyEndMs,
        committedAtMs: now,
      },
      qualificationRef: admitted ? c.reviewId : null,
      publication:
        event.verdict === "passed" && s.showPublicly ? "pending" : terminal.state.publication,
      transferDeadlineMs:
        event.verdict === "passed" && s.showPublicly ? now + d.transferWithinMs : null,
    };
    const intents: ReviewIntent[] = terminal.intents.filter(
      (i) =>
        next.publication !== "pending" ||
        (i.kind !== "handoff_cancel" && i.kind !== "cleanup_temporary"),
    );
    if (next.publication === "pending")
      intents.push(intent(next, "handoff_release", s.generation, next.transferDeadlineMs));
    if (admitted && s.submissionDay) {
      const qualification: QualificationIntent = {
        id: c.reviewId,
        accountId: c.accountId,
        communityId: c.communityId,
        songPostId: c.songPostId,
        audioRevision: c.audioRevision,
        grading_mode: "moderator_verdict",
        verdict: "passed",
        score_bps: null,
        calibration: null,
        floor: null,
        qualifiedAtMs: now,
        submissionDay: s.submissionDay.day,
        timezone: s.submissionDay.timezone,
        timezoneVersion: s.submissionDay.timezoneVersion,
        producerId: p.producerId,
        policyVersion: p.qualificationVersion,
        policyHash: p.qualificationHash,
        admissionVersion: p.admissionVersion,
        admissionHash: p.admissionHash,
        rewardMode: c.rewardMode,
        objectives: c.objectives,
      };
      intents.push(intent(next, "qualification", 0, null, qualification));
    }
    return { state: next, intents, refusal: null };
  }
  return denied(s, "invalid_state");
}

/** Final release guard only; the owning Post reducer must still atomically
 * fence this same generation/lifecycle and recheck every real publication gate. */
export function authorizeModeratorPublication(
  s: ModeratorReview,
  generation: number,
  now: number,
  f: ReviewFacts,
  mapping: Readonly<{
    accepted: boolean;
    sourceDigest: string;
    outputDigest: string;
    bodyStartMs: number;
    bodyEndMs: number;
    postGatesAccepted: boolean;
  }> | null,
): boolean {
  return (
    time(now) &&
    f.accountActive &&
    f.accountFenceRevision === s.capture.accountFenceRevision &&
    s.state === "reviewed" &&
    s.verdict === "passed" &&
    s.showPublicly === true &&
    s.publication === "pending" &&
    generation === s.generation &&
    s.transferDeadlineMs !== null &&
    now < s.transferDeadlineMs &&
    disposition(s.capture, f, now) !== null &&
    boundMedia(s.capture, f) &&
    boundSafety(s.capture, f) &&
    f.safety?.status === "accepted" &&
    mapping?.accepted === true &&
    mapping.postGatesAccepted &&
    mapping.sourceDigest === s.capture.sourceDigest &&
    hash(mapping.outputDigest) &&
    mapping.bodyStartMs === s.capture.bodyStartMs &&
    mapping.bodyEndMs === s.capture.bodyEndMs
  );
}

/** Only the owning Post adoption transaction may persist this transition. It
 * secures an independent input; it does not assert that the Post is published.
 * Qualification, verdict, Submit and review revision are unchanged. */
export function transferModeratorPublication(
  s: ModeratorReview,
  generation: number,
  now: number,
  facts: ReviewFacts,
  mapping: Parameters<typeof authorizeModeratorPublication>[4],
): ModeratorReview | null {
  if (!authorizeModeratorPublication(s, generation, now, facts, mapping)) return null;
  return { ...s, publication: "transferred", publicationRevision: s.publicationRevision + 1 };
}
