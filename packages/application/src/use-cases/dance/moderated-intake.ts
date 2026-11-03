import { Effect, Schema } from "effect";
import { ModerationPolicyTableV1 } from "../../../../contracts/src/community-moderation-policy.ts";
import { ModeratorReviewPolicySchema } from "../../../../domain/src/dance/moderator-review-schema.ts";
import { canonicalBodyHash } from "../content/common.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const ModeratedDanceSafetyPolicySnapshot = Schema.Struct({
  policy_revision: Id,
  policy_hash: Hash,
  platform_policy_revision: Id,
  platform_policy_hash: Hash,
  platform_policy: ModerationPolicyTableV1,
  community_policy_revision: Id,
  community_policy_hash: Hash,
  community_policy: ModerationPolicyTableV1,
});
export const ModeratedDanceDisposition = Schema.Struct({
  accepted: Schema.Literal(true),
  version: Id,
  hash: Hash,
  validUntilMs: Positive,
  cleanupWithinMs: Positive,
  temporaryCleanupWithinMs: Positive,
  transferWithinMs: Positive,
  hold: Schema.Struct({
    accepted: Schema.Literal(true),
    authorityRef: Id,
    policyHash: Hash,
    disposeByMs: Positive,
  }),
});
/** Every value comes from a dated admitted profile. No adapter-selected TTL,
 * upload, rate, work, replay-retention or safety-spend limit is authoritative. */
export const ModeratedDanceIntakeProfile = Schema.Struct({
  version: Schema.Literals([
    "dance-moderated-intake-profile-v1",
    "dance-moderated-intake-profile-v2",
  ]),
  sessionTtlMs: Positive,
  uploadTtlMs: Positive,
  presignTtlSeconds: Positive,
  maximumBytes: Positive,
  maximumActiveSessions: Positive,
  maximumPendingMediaPerAccount: Positive,
  maximumPendingMediaGlobal: Positive,
  maximumAccountProviderSpendPerWindow: Positive,
  maximumGlobalProviderSpendPerWindow: Positive,
  windowMs: Positive,
  maximumSessionsPerWindow: Positive,
  maximumCommandsPerWindow: Positive,
  maximumReadsPerWindow: Positive,
  mediaLeaseMs: Positive,
  maximumOwnerPendingReviews: Positive,
  cueStartMs: Natural,
  cueEndMs: Natural,
  cueHoldMs: Natural,
  bodyStartMs: Natural,
  normalizationWidth: Positive,
  normalizationHeight: Positive,
  normalizationFps: Positive,
  normalizationTimeoutSeconds: Positive,
  providerWaitMs: Positive,
  readinessLeaseMs: Positive,
  workLeaseMs: Positive,
  maximumFrameBytes: Positive,
  maximumDurationErrorMs: Natural,
  replayCompatibleEpochs: Schema.Array(Id).check(Schema.isMinLength(1)),
  maximumProviderCalls: Positive,
  maximumProviderSpendMicrounits: Positive,
  replayScope: Id,
  replayKeyEpoch: Id,
  replayRetentionMs: Positive,
  mediaRuntimeRevision: Id,
  safetyProviderRevision: Id,
}).check(
  Schema.makeFilter((p) =>
    p.presignTtlSeconds <= 604800 &&
    p.presignTtlSeconds * 1000 <= p.uploadTtlMs &&
    p.uploadTtlMs <= p.sessionTtlMs &&
    (p.version === "dance-moderated-intake-profile-v2"
      ? p.cueStartMs === 0 && p.cueEndMs === 0 && p.cueHoldMs === 0 && p.bodyStartMs === 0
      : p.cueStartMs < p.cueEndMs &&
        p.cueEndMs <= p.bodyStartMs &&
        p.cueHoldMs > 0 &&
        p.cueHoldMs <= p.cueEndMs - p.cueStartMs) &&
    p.normalizationWidth <= 4096 &&
    p.normalizationHeight <= 4096 &&
    p.normalizationFps <= 120 &&
    p.normalizationTimeoutSeconds <= 86400 &&
    p.mediaLeaseMs <= 604800000 &&
    p.maximumProviderCalls >= 6 &&
    p.maximumDurationErrorMs <= Math.floor(1000 / p.normalizationFps) &&
    p.maximumFrameBytes <= 524288 &&
    p.readinessLeaseMs <= p.providerWaitMs &&
    p.workLeaseMs <= p.providerWaitMs &&
    new Set(p.replayCompatibleEpochs).size === p.replayCompatibleEpochs.length &&
    p.replayCompatibleEpochs.includes(p.replayKeyEpoch)
      ? undefined
      : "Inconsistent admitted media bounds",
  ),
);
export type ModeratedDanceIntakeProfile = typeof ModeratedDanceIntakeProfile.Type;
export const ModeratedDanceCreationFacts = Schema.Struct({
  nowMs: Positive,
  mediaReady: Schema.Boolean,
  accountFenceRevision: Positive,
  accountId: Id,
  personaId: Id,
  communityId: Id,
  songPostId: Id,
  audioRevision: Positive,
  choreographyId: Id,
  choreographyRevision: Positive,
  segmentId: Id,
  bodyDurationMs: Positive,
  timezone: Id,
  timezoneVersion: Id,
  policyId: Id,
  policy: ModeratorReviewPolicySchema,
  safetyPolicy: ModeratedDanceSafetyPolicySnapshot,
  disposition: ModeratedDanceDisposition,
  profile: ModeratedDanceIntakeProfile,
  objectives: Schema.Array(
    Schema.Struct({
      id: Id,
      version: Id,
      termsHash: Hash,
      fundingPolicyHash: Hash,
      gradingMode: Schema.Literal("moderator_verdict"),
    }),
  ),
});
export type ModeratedDanceCreationFacts = typeof ModeratedDanceCreationFacts.Type;

/** Unbiased crypto choice; the chosen cue is persisted before consent/bytes.
 * The caller supplies entropy so deterministic tests never claim live capture. */
export function selectModeratedDanceCue(nextU32: () => number) {
  const choices = ["hands_on_head", "arms_t", "hands_on_hips"] as const;
  for (let n = 0; n < 32; n++) {
    const value = nextU32();
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new TypeError("Invalid cue entropy");
    if (value < 4294967295) return choices[value % 3] ?? choices[0];
  }
  throw new Error("Cue entropy unavailable");
}

/** Acyclic immutable terms. No client-derived duration, cue, timezone, policy,
 * objective or identity participates as authority. Actual seal/screen facts are
 * added later, without replacing any captured field. */
export const prepareModeratedDanceTerms = Effect.fn("ModeratedDance.prepareTerms")(function* (
  facts: ModeratedDanceCreationFacts,
  ids: Readonly<{ sessionId: string; reviewId: string; attemptId: string }>,
  cue: "hands_on_head" | "arms_t" | "hands_on_hips" | "none",
) {
  const f = Schema.decodeUnknownSync(ModeratedDanceCreationFacts, { onExcessProperty: "error" })(
    facts,
  );
  const noPose = f.policy.version === "moderator-review-policy-v2";
  if (
    noPose !== (f.profile.version === "dance-moderated-intake-profile-v2") ||
    noPose !== (cue === "none") ||
    f.bodyDurationMs < 6000 ||
    f.bodyDurationMs > 30000 ||
    !Number.isSafeInteger(f.nowMs + f.profile.sessionTtlMs) ||
    (f.policy.admission !== "money_admitted" && f.objectives.length !== 0)
  )
    throw new TypeError("Invalid immutable capture");
  // Cover the latest valid upload, settled seven-day review and captured finite
  // cleanup/transfer obligations. An adapter cannot extend accepted authority.
  const lastDispositionMs =
    f.nowMs +
    f.profile.sessionTtlMs +
    f.policy.reviewWindowMs +
    Math.max(
      f.disposition.cleanupWithinMs,
      f.disposition.temporaryCleanupWithinMs,
      f.disposition.transferWithinMs,
    );
  if (
    !Number.isSafeInteger(lastDispositionMs) ||
    f.disposition.validUntilMs < lastDispositionMs ||
    f.disposition.hold.disposeByMs < lastDispositionMs ||
    f.disposition.hash !== f.policy.retentionHash ||
    f.nowMs >= f.disposition.validUntilMs ||
    f.nowMs >= f.disposition.hold.disposeByMs ||
    (yield* canonicalBodyHash(f.safetyPolicy)) !== f.policy.safetyHash
  )
    throw new TypeError("Captured safety/disposition authority unavailable");
  new Intl.DateTimeFormat("en", { timeZone: f.timezone }).format(f.nowMs);
  const capture = {
    reviewId: ids.reviewId,
    sessionId: ids.sessionId,
    attemptId: ids.attemptId,
    accountId: f.accountId,
    personaId: f.personaId,
    communityId: f.communityId,
    songPostId: f.songPostId,
    audioRevision: f.audioRevision,
    choreographyId: f.choreographyId,
    choreographyRevision: f.choreographyRevision,
    segmentId: f.segmentId,
    policy: f.policy,
    accountFenceRevision: f.accountFenceRevision,
    captureExpiresAtMs: f.nowMs + f.profile.sessionTtlMs,
    bodyStartMs: f.profile.bodyStartMs,
    bodyEndMs: f.profile.bodyStartMs + f.bodyDurationMs,
    cueId: cue,
    cueStartMs: f.profile.cueStartMs,
    cueEndMs: f.profile.cueEndMs,
    cueHoldMs: f.profile.cueHoldMs,
    timezone: f.timezone,
    timezoneVersion: f.timezoneVersion,
    rewardMode: f.objectives.length === 0 ? ("practice" as const) : ("reward_eligible" as const),
    objectives: f.objectives,
  };
  const preimage = {
    version: noPose ? "dance-moderated-capture-terms-v2" : "dance-moderated-capture-terms-v1",
    session_id: ids.sessionId,
    created_at_ms: f.nowMs,
    policy_id: f.policyId,
    profile: f.profile,
    capture,
    safety_policy: f.safetyPolicy,
    disposition: f.disposition,
  };
  const terms_hash = yield* canonicalBodyHash(preimage);
  return { ...preimage, terms_hash, capture: { ...capture, termsHash: terms_hash } };
});
