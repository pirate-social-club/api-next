import { Schema } from "effect";
import type {
  DispositionAuthority,
  FrozenObjective,
  ModeratorReview,
  OwnerAttestation,
  ReviewFacts,
  ReviewPolicy,
  ReviewState,
  SealedReviewCapture,
  SubmitReceipt,
} from "./moderator-review.ts";
import { MODERATED_DANCE_REPLAY_RETIRED } from "./moderator-review.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u));

export const ModeratorReviewPolicySchema: Schema.Codec<ReviewPolicy> = Schema.Struct({
  version: Schema.Literal("moderator-review-policy-v1"),
  hash: Hash,
  qualificationVersion: Id,
  qualificationHash: Hash,
  rubricVersion: Id,
  rubricHash: Hash,
  disclosureVersion: Id,
  consentVersion: Id,
  consentHash: Hash,
  normalizationVersion: Id,
  normalizationHash: Hash,
  safetyHash: Hash,
  retentionHash: Hash,
  reviewWindowMs: Schema.Literal(7 * 24 * 60 * 60 * 1000),
  admission: Schema.Literals(["shadow", "streak_admitted", "money_admitted"]),
  admissionVersion: Id,
  admissionHash: Hash,
  producerId: Id,
});
const Objective: Schema.Codec<FrozenObjective> = Schema.Struct({
  id: Id,
  version: Id,
  termsHash: Hash,
  fundingPolicyHash: Hash,
  gradingMode: Schema.Literal("moderator_verdict"),
});
const CaptureFields = {
  reviewId: Id,
  sessionId: Id,
  attemptId: Id,
  accountId: Id,
  personaId: Id,
  communityId: Id,
  songPostId: Id,
  audioRevision: Positive,
  choreographyId: Id,
  choreographyRevision: Positive,
  segmentId: Id,
  termsHash: Hash,
  policy: ModeratorReviewPolicySchema,
  accountFenceRevision: Positive,
  uploadId: Id,
  sourceDigest: Hash,
  normalizedDigest: Hash,
  analysisRevision: Positive,
  firstStoredAtMs: Natural,
  uploadedAtMs: Natural,
  captureExpiresAtMs: Natural,
  bodyStartMs: Natural,
  bodyEndMs: Positive,
  cueId: Id,
  cueStartMs: Natural,
  cueEndMs: Positive,
  cueHoldMs: Positive,
  timezone: Id,
  timezoneVersion: Id,
  rewardMode: Schema.Literals(["practice", "reward_eligible"]),
  objectives: Schema.Array(Objective),
  consent: Schema.Struct({
    receiptId: Id,
    uploadId: Id,
    recordedAtMs: Natural,
    accountId: Id,
    personaId: Id,
    termsHash: Hash,
    version: Id,
    policyHash: Hash,
  }),
};
export const SealedModeratorCaptureSchema: Schema.Codec<SealedReviewCapture> =
  Schema.Struct(CaptureFields);
const RetainedCapture = Schema.Struct({
  ...CaptureFields,
  normalizedDigest: Schema.Union([Hash, Schema.Literal(MODERATED_DANCE_REPLAY_RETIRED)]),
});
const Submit: Schema.Codec<SubmitReceipt> = Schema.Struct({
  id: Id,
  showPublicly: Schema.Boolean,
  disclosureVersion: Id,
  submittedAtMs: Natural,
  uploadId: Id,
  sourceDigest: Hash,
});
const Attestation: Schema.Codec<OwnerAttestation> = Schema.Struct({
  version: Schema.Literal("dance-owner-verdict-attestation-v1"),
  producer: Schema.Literal("owner_verdict_attestation"),
  cue: Schema.Literals(["affirmed", "not_attested"]),
  reviewerAccountId: Id,
  assignmentId: Id,
  assignmentRevision: Positive,
  sourceDigest: Hash,
  rubricVersion: Id,
  rubricHash: Hash,
  termsHash: Hash,
  cueId: Id,
  choreographyId: Id,
  choreographyRevision: Positive,
  bodyStartMs: Natural,
  bodyEndMs: Positive,
  committedAtMs: Natural,
});
const State: Schema.Codec<ReviewState> = Schema.Literals([
  "uploaded",
  "screening",
  "awaiting_review",
  "reviewed",
  "review_expired",
  "withdrawn",
  "held",
  "expired",
  "abandoned",
  "processing_failed",
]);
export const ModeratorReviewSchema: Schema.Codec<ModeratorReview> = Schema.Struct({
  capture: RetainedCapture,
  revision: Positive,
  state: State,
  reviewDeadlineMs: Natural,
  initialSubmit: Schema.NullOr(Submit),
  submittedAtMs: Schema.NullOr(Natural),
  submissionDay: Schema.NullOr(Schema.Struct({ day: Day, timezone: Id, timezoneVersion: Id })),
  showPublicly: Schema.NullOr(Schema.Boolean),
  choiceRevision: Natural,
  generation: Natural,
  publication: Schema.Literals(["none", "staged", "cancelled", "pending", "failed", "transferred"]),
  publicationRevision: Natural,
  transferDeadlineMs: Schema.NullOr(Natural),
  terminalAtMs: Schema.NullOr(Natural),
  verdict: Schema.NullOr(Schema.Literals(["passed", "not_passed"])),
  attestation: Schema.NullOr(Attestation),
  qualificationRef: Schema.NullOr(Id),
}).check(
  Schema.makeFilter((s) =>
    s.capture.normalizedDigest !== MODERATED_DANCE_REPLAY_RETIRED ||
    (s.terminalAtMs !== null &&
      !["uploaded", "screening", "awaiting_review"].includes(s.state) &&
      s.publication !== "pending")
      ? undefined
      : "Replay material may retire only after review and handoff close",
  ),
);
const Disposition: Schema.Codec<DispositionAuthority> = Schema.Struct({
  accepted: Schema.Boolean,
  version: Id,
  hash: Hash,
  validUntilMs: Natural,
  cleanupWithinMs: Positive,
  temporaryCleanupWithinMs: Positive,
  transferWithinMs: Positive,
  hold: Schema.NullOr(
    Schema.Struct({
      accepted: Schema.Boolean,
      authorityRef: Id,
      policyHash: Hash,
      disposeByMs: Natural,
    }),
  ),
});
export const ModeratorReviewFactsSchema: Schema.Codec<ReviewFacts> = Schema.Struct({
  accountActive: Schema.Boolean,
  accountFenceRevision: Positive,
  workerAuthorized: Schema.Boolean,
  ownedPersona: Schema.NullOr(
    Schema.Struct({ active: Schema.Boolean, accountId: Id, personaId: Id, communityId: Id }),
  ),
  owner: Schema.NullOr(
    Schema.Struct({
      accountId: Id,
      communityId: Id,
      assignmentId: Id,
      revision: Positive,
      canInspect: Schema.Boolean,
    }),
  ),
  referenceCutoffAtMs: Schema.NullOr(Natural),
  media: Schema.NullOr(
    Schema.Struct({
      accepted: Schema.Boolean,
      sourceDigest: Hash,
      normalizedDigest: Hash,
      normalizationVersion: Id,
      normalizationHash: Hash,
    }),
  ),
  safety: Schema.NullOr(
    Schema.Struct({
      status: Schema.Literals(["accepted", "flagged", "failed", "unknown"]),
      persisted: Schema.Boolean,
      sourceDigest: Hash,
      analysisRevision: Positive,
      policyHash: Hash,
      frameDigests: Schema.Tuple([Hash, Hash, Hash]),
    }),
  ),
  integrity: Schema.NullOr(
    Schema.Struct({
      status: Schema.Literals(["unique", "blocked", "unknown"]),
      persisted: Schema.Boolean,
      sourceDigest: Hash,
      normalizedDigest: Hash,
      policyHash: Hash,
    }),
  ),
  disposition: Schema.NullOr(Disposition),
  submissionDay: Schema.NullOr(
    Schema.Struct({ atMs: Natural, day: Day, timezone: Id, timezoneVersion: Id }),
  ),
  qualification: Schema.NullOr(
    Schema.Struct({
      admitted: Schema.Boolean,
      producerId: Id,
      policyVersion: Id,
      policyHash: Hash,
      admissionVersion: Id,
      admissionHash: Hash,
    }),
  ),
});
