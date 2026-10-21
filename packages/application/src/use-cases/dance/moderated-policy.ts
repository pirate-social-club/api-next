import { Effect, Schema } from "effect";
import { ModeratedDancePolicyDisclosure } from "../../../../contracts/src/dance-moderated-intake.ts";
import { ModeratorReviewPolicySchema } from "../../../../domain/src/dance/moderator-review-schema.ts";
import { canonicalBodyHash } from "../content/common.ts";
import {
  ModeratedDanceDisposition,
  ModeratedDanceIntakeProfile,
  ModeratedDanceSafetyPolicySnapshot,
} from "./moderated-intake.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Instant = Schema.String.check(
  Schema.makeFilter((s) =>
    Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s
      ? undefined
      : "Invalid instant",
  ),
);
/** Operator data, never a browser/owner permission toggle. All numbers, hold
 * authority, admission, qualification and disclosure are explicitly supplied.
 * Preparing this document does not accept it or activate a runtime. */
export const ModeratedDancePolicyDraft = Schema.Struct({
  version: Schema.Literal("dance-moderated-policy-publication-v1"),
  policy_id: Id,
  community_id: Id,
  policy: ModeratorReviewPolicySchema,
  profile: ModeratedDanceIntakeProfile,
  disposition: ModeratedDanceDisposition,
  safety_policy: ModeratedDanceSafetyPolicySnapshot,
  disclosure: ModeratedDancePolicyDisclosure,
  valid_from: Instant,
  valid_until: Instant,
  accepted_by: Id,
  acceptance_ref: Id,
  acceptance_hash: Hash,
  producer_registration: Schema.Struct({
    status: Schema.Literals(["reserved", "active"]),
    acceptance_ref: Id,
    acceptance_hash: Hash,
  }),
  qualification_policy_document: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export const prepareModeratedDancePolicyPublication = Effect.fn(
  "ModeratedDance.preparePolicyPublication",
)(function* (value: unknown) {
  const input = Schema.decodeUnknownSync(ModeratedDancePolicyDraft, { onExcessProperty: "error" })(
    value,
  );
  const lastDispositionMs =
    Date.parse(input.valid_until) +
    input.profile.sessionTtlMs +
    input.policy.reviewWindowMs +
    Math.max(
      input.disposition.cleanupWithinMs,
      input.disposition.temporaryCleanupWithinMs,
      input.disposition.transferWithinMs,
    );
  if (
    !Number.isSafeInteger(lastDispositionMs) ||
    input.disposition.validUntilMs < lastDispositionMs ||
    input.disposition.hold.disposeByMs < lastDispositionMs ||
    Date.parse(input.valid_from) >= Date.parse(input.valid_until) ||
    input.disposition.validUntilMs < Date.parse(input.valid_until) ||
    input.disposition.hold.disposeByMs <= Date.parse(input.valid_from)
  )
    throw new TypeError("Policy window/disposition unavailable");
  const { hash: _retentionHash, ...dispositionRest } = input.disposition;
  const retentionHash = yield* canonicalBodyHash([
    "dance-private-retention-v1",
    input.disclosure.retention_text,
    dispositionRest,
  ]);
  const disposition = { ...input.disposition, hash: retentionHash };
  const consentHash = yield* canonicalBodyHash([
    "dance-recording-consent-v1",
    input.policy.consentVersion,
    input.disclosure.consent_text,
    retentionHash,
  ]);
  const rubricHash = yield* canonicalBodyHash([
    "dance-owner-rubric-v1",
    input.policy.rubricVersion,
    input.disclosure.owner_rubric_text,
  ]);
  const normalizationHash = yield* canonicalBodyHash([
    "dance-body-normalization-v1",
    "6.1.4",
    input.profile.normalizationWidth,
    input.profile.normalizationHeight,
    input.profile.normalizationFps,
    "body-only/no-audio/grayscale/framehash-sha256",
  ]);
  const safetyHash = yield* canonicalBodyHash(input.safety_policy);
  const qualificationWithoutHash = {
    grading_mode: "moderator_verdict",
    verdict: "passed",
    score_bps: null,
    calibration: null,
    numeric_floor_bps: null,
    producer_id: input.policy.producerId,
    admission: input.policy.admission,
    admission_version: input.policy.admissionVersion,
    admission_hash: input.policy.admissionHash,
  };
  const qualificationHash = yield* canonicalBodyHash([
    "pirate.shared-song-qualification-policy.v1",
    input.policy.qualificationVersion,
    "dance",
    "dance_owner_verdict_v1",
    qualificationWithoutHash,
  ]);
  const qualification_policy_document = {
    ...qualificationWithoutHash,
    policy_hash: qualificationHash,
  };
  const { hash: _policyHash, ...rest } = input.policy;
  const policyWithoutHash = {
    ...rest,
    consentHash,
    rubricHash,
    normalizationHash,
    safetyHash,
    retentionHash,
    qualificationHash,
  };
  const hash = yield* canonicalBodyHash([
    "dance-moderated-policy-v1",
    policyWithoutHash,
    input.profile,
    disposition,
    input.disclosure,
    input.safety_policy,
  ]);
  return {
    ...input,
    policy: { ...policyWithoutHash, hash },
    disposition,
    qualification_policy_document,
  };
});
