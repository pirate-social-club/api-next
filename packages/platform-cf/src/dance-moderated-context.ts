import { Effect, Schema } from "effect";
import { consistentCommittedTerms } from "../../application/src/rewards/song-megapot-contributions.ts";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import {
  ModeratedDanceCreationFacts,
  ModeratedDanceDisposition,
  ModeratedDanceIntakeProfile,
  ModeratedDanceSafetyPolicySnapshot,
} from "../../application/src/use-cases/dance/moderated-intake.ts";
import {
  ModeratedDanceCaptureContext,
  ModeratedDanceCapturedObjective,
  ModeratedDanceCaptureReference,
  ModeratedDanceOwnerRubric,
} from "../../contracts/src/dance-moderated-context.ts";
import {
  ModeratedDancePolicyDisclosure,
  ModeratedDanceSessionView,
} from "../../contracts/src/dance-moderated-intake.ts";
import {
  HashV2,
  IdV2,
  projectQualificationBinding,
  RevisionV2,
} from "../../contracts/src/rewards-song-contributions-v2.ts";
import { ModeratorReviewPolicySchema } from "../../domain/src/dance/moderator-review-schema.ts";

const Natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const f = ModeratedDanceCreationFacts.fields;
const Capture = Schema.Struct({
  reviewId: IdV2,
  sessionId: IdV2,
  attemptId: IdV2,
  accountId: f.accountId,
  personaId: f.personaId,
  communityId: f.communityId,
  songPostId: f.songPostId,
  audioRevision: f.audioRevision,
  choreographyId: f.choreographyId,
  choreographyRevision: f.choreographyRevision,
  segmentId: f.segmentId,
  policy: ModeratorReviewPolicySchema,
  accountFenceRevision: f.accountFenceRevision,
  captureExpiresAtMs: RevisionV2,
  bodyStartMs: Natural,
  bodyEndMs: RevisionV2,
  cueId: Schema.Literals(["hands_on_head", "arms_t", "hands_on_hips"]),
  cueStartMs: Natural,
  cueEndMs: RevisionV2,
  cueHoldMs: RevisionV2,
  timezone: f.timezone,
  timezoneVersion: f.timezoneVersion,
  rewardMode: Schema.Literals(["practice", "reward_eligible"]),
  objectives: f.objectives,
  termsHash: HashV2,
});
const StoredTerms = Schema.Struct({
  version: Schema.Literal("dance-moderated-capture-terms-v1"),
  session_id: IdV2,
  created_at_ms: RevisionV2,
  policy_id: IdV2,
  profile: ModeratedDanceIntakeProfile,
  capture: Capture,
  safety_policy: ModeratedDanceSafetyPolicySnapshot,
  disposition: ModeratedDanceDisposition,
  terms_hash: HashV2,
});
const common = { terms: StoredTerms, disclosure: ModeratedDancePolicyDisclosure };
const CapturePacket = Schema.Struct({
  ...common,
  session: ModeratedDanceSessionView,
  reference: Schema.Struct({
    ...ModeratedDanceCaptureReference.fields,
    reference_digest: HashV2,
    segment_terms_hash: HashV2,
    normalization_hash: HashV2,
  }),
  objectives: Schema.Array(
    Schema.Struct({
      ...ModeratedDanceCapturedObjective.fields,
      qualification_document: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ).check(Schema.isMaxLength(1)),
});
const OwnerPacket = Schema.Struct({
  ...common,
  community_id: IdV2,
  review_id: IdV2,
  review_revision: RevisionV2,
  session_terms_hash: HashV2,
});
const decode = <S extends Schema.ConstraintDecoder<unknown>>(s: S, value: unknown) =>
  Schema.decodeUnknownSync(s, { onExcessProperty: "error" })(value);
const unavailable = () => new Error("Frozen private Dance context unavailable");
const parse = <S extends Schema.ConstraintDecoder<unknown>>(s: S, value: unknown) =>
  Effect.try({ try: () => decode(s, value), catch: unavailable });

/** Verify the ORIGINAL complete documents before projecting private context.
 * In particular, neither policy text nor shortened public fields are a hash
 * preimage. This read never re-prepares or upgrades an existing capture. */
const verifyTerms = Effect.fn("ModeratedDanceContext.verifyTerms")(function* (
  terms: typeof StoredTerms.Type,
  disclosure: typeof ModeratedDancePolicyDisclosure.Type,
) {
  const { terms_hash, capture, ...rest } = terms;
  const { termsHash, ...captured } = capture;
  const { hash: policyHash, ...policy } = capture.policy;
  const { hash: retentionHash, ...disposition } = terms.disposition;
  if (
    terms.session_id !== capture.sessionId ||
    terms_hash !== termsHash ||
    (yield* canonicalBodyHash({ ...rest, capture: captured })) !== terms_hash ||
    (yield* canonicalBodyHash([
      "dance-moderated-policy-v1",
      policy,
      terms.profile,
      terms.disposition,
      disclosure,
      terms.safety_policy,
    ])) !== policyHash ||
    (yield* canonicalBodyHash([
      "dance-private-retention-v1",
      disclosure.retention_text,
      disposition,
    ])) !== retentionHash ||
    retentionHash !== policy.retentionHash ||
    (yield* canonicalBodyHash([
      "dance-recording-consent-v1",
      policy.consentVersion,
      disclosure.consent_text,
      retentionHash,
    ])) !== policy.consentHash ||
    (yield* canonicalBodyHash([
      "dance-owner-rubric-v1",
      policy.rubricVersion,
      disclosure.owner_rubric_text,
    ])) !== policy.rubricHash ||
    (yield* canonicalBodyHash(terms.safety_policy)) !== policy.safetyHash ||
    (yield* canonicalBodyHash([
      "dance-body-normalization-v1",
      "6.1.4",
      terms.profile.normalizationWidth,
      terms.profile.normalizationHeight,
      terms.profile.normalizationFps,
      "body-only/no-audio/grayscale/framehash-sha256",
    ])) !== policy.normalizationHash ||
    capture.captureExpiresAtMs !== terms.created_at_ms + terms.profile.sessionTtlMs ||
    capture.bodyStartMs !== terms.profile.bodyStartMs ||
    capture.bodyEndMs - capture.bodyStartMs < 6000 ||
    capture.bodyEndMs - capture.bodyStartMs > 30000 ||
    capture.cueStartMs !== terms.profile.cueStartMs ||
    capture.cueEndMs !== terms.profile.cueEndMs ||
    capture.cueHoldMs !== terms.profile.cueHoldMs ||
    (capture.rewardMode === "practice") !== (capture.objectives.length === 0) ||
    (capture.rewardMode === "reward_eligible" && policy.admission !== "money_admitted") ||
    new Set(capture.objectives.map((o) => o.id)).size !== capture.objectives.length
  )
    return yield* Effect.fail(unavailable());
  const qualification = {
    grading_mode: "moderator_verdict",
    verdict: "passed",
    score_bps: null,
    calibration: null,
    numeric_floor_bps: null,
    producer_id: policy.producerId,
    admission: policy.admission,
    admission_version: policy.admissionVersion,
    admission_hash: policy.admissionHash,
  };
  if (
    (yield* canonicalBodyHash([
      "pirate.shared-song-qualification-policy.v1",
      policy.qualificationVersion,
      "dance",
      "dance_owner_verdict_v1",
      qualification,
    ])) !== policy.qualificationHash
  )
    return yield* Effect.fail(unavailable());
  return { capture, policy: capture.policy, qualification };
});

export const decodeModeratedDanceCaptureContext = Effect.fn("ModeratedDanceContext.capture")(
  function* (
    value: unknown,
    actor: Readonly<{ accountId: string; communityId: string; sessionId: string }>,
    rewardsEnabled: boolean,
  ) {
    const packet = yield* parse(CapturePacket, value);
    const {
      capture: c,
      policy: p,
      qualification,
    } = yield* verifyTerms(packet.terms, packet.disclosure);
    const s = packet.session,
      r = packet.reference;
    if (
      c.accountId !== actor.accountId ||
      c.communityId !== actor.communityId ||
      c.sessionId !== actor.sessionId ||
      s.session_id !== c.sessionId ||
      s.review_id !== c.reviewId ||
      s.attempt_id !== c.attemptId ||
      s.community_id !== c.communityId ||
      s.song_post_id !== c.songPostId ||
      s.choreography_id !== c.choreographyId ||
      s.choreography_revision !== c.choreographyRevision ||
      s.terms_hash !== c.termsHash ||
      s.policy_hash !== p.hash ||
      s.consent_version !== p.consentVersion ||
      s.consent_hash !== p.consentHash ||
      s.retention_hash !== p.retentionHash ||
      s.normalization_version !== p.normalizationVersion ||
      s.normalization_hash !== p.normalizationHash ||
      s.safety_hash !== p.safetyHash ||
      s.created_at_ms !== packet.terms.created_at_ms ||
      s.expires_at_ms !== c.captureExpiresAtMs ||
      s.maximum_bytes !== packet.terms.profile.maximumBytes ||
      s.body_start_ms !== c.bodyStartMs ||
      s.body_end_ms !== c.bodyEndMs ||
      s.cue.kind !== c.cueId ||
      s.cue.start_ms !== c.cueStartMs ||
      s.cue.end_ms !== c.cueEndMs ||
      s.cue.hold_ms !== c.cueHoldMs ||
      r.canonical_song_end_ms - r.canonical_song_start_ms !== c.bodyEndMs - c.bodyStartMs ||
      r.reference_body_end_ms - r.reference_body_start_ms !== c.bodyEndMs - c.bodyStartMs ||
      (yield* canonicalBodyHash([
        "moderated-canonical-reference-v1",
        c.choreographyId,
        c.choreographyRevision,
        r.video_render_revision,
        r.reference_post_id,
        r.reference_digest,
        r.segment_terms_hash,
        r.normalization_hash,
      ])) !== r.reference_terms_hash ||
      packet.objectives.length !== c.objectives.length
    )
      return yield* Effect.fail(unavailable());
    const objectives: ModeratedDanceCaptureContext["objectives"][number][] = [];
    for (const captured of c.objectives) {
      const matches = packet.objectives.filter((o) => o.binding.objective_id === captured.id);
      const o = matches[0];
      if (matches.length !== 1 || o === undefined) return yield* Effect.fail(unavailable());
      const { target, terms, binding: b, qualification_document: q } = o;
      const { policy_hash: qh, ...qb } = q;
      if (
        target.community_id !== c.communityId ||
        target.post_id !== c.songPostId ||
        target.canonical_song_id !== c.songPostId ||
        target.audio_revision !== c.audioRevision ||
        terms.terms_hash !== captured.termsHash ||
        terms.funding_policy_hash !== captured.fundingPolicyHash ||
        captured.version !== p.qualificationVersion ||
        b.qualification_policy_id !== captured.version ||
        b.qualification_policy_hash !== p.qualificationHash ||
        b.activity !== "dance" ||
        b.grading_family !== "moderator_verdict" ||
        b.numeric_floor_bps !== null ||
        b.admission_id !== p.admissionVersion ||
        b.admission_hash !== p.admissionHash ||
        terms.qualification_bindings.filter(
          (x) =>
            JSON.stringify(projectQualificationBinding(x)) ===
            JSON.stringify(projectQualificationBinding(b)),
        ).length !== 1 ||
        !(yield* consistentCommittedTerms(terms, target)) ||
        (yield* canonicalBodyHash(qb)) !== (yield* canonicalBodyHash(qualification)) ||
        qh !== p.qualificationHash
      )
        return yield* Effect.fail(unavailable());
      objectives.push(
        yield* parse(ModeratedDanceCapturedObjective, {
          target,
          terms,
          binding: b,
          chain_id: o.chain_id,
          token_address: o.token_address,
          token_decimals: o.token_decimals,
        }),
      );
    }
    return yield* parse(ModeratedDanceCaptureContext, {
      version: "dance-moderated-capture-context-v1",
      session: s,
      persona_id: c.personaId,
      audio_revision: c.audioRevision,
      segment_id: c.segmentId,
      reference: {
        reference_post_id: r.reference_post_id,
        video_render_revision: r.video_render_revision,
        reference_terms_hash: r.reference_terms_hash,
        canonical_song_start_ms: r.canonical_song_start_ms,
        canonical_song_end_ms: r.canonical_song_end_ms,
        reference_body_start_ms: r.reference_body_start_ms,
        reference_body_end_ms: r.reference_body_end_ms,
      },
      reward_mode: c.rewardMode,
      rewards_enabled: rewardsEnabled,
      captured_policy: {
        admission: p.admission,
        admission_version: p.admissionVersion,
        admission_hash: p.admissionHash,
        qualification_policy_version_id: p.qualificationVersion,
        qualification_policy_hash: p.qualificationHash,
        producer_id: p.producerId,
        publication_disclosure_version: p.disclosureVersion,
        rubric_version: p.rubricVersion,
        rubric_hash: p.rubricHash,
      },
      disclosure: packet.disclosure,
      objectives,
    });
  },
);

export const decodeModeratedDanceOwnerRubric = Effect.fn("ModeratedDanceContext.ownerRubric")(
  function* (value: unknown, communityId: string, reviewId: string) {
    const packet = yield* parse(OwnerPacket, value);
    const { capture: c, policy: p } = yield* verifyTerms(packet.terms, packet.disclosure);
    if (
      packet.community_id !== communityId ||
      c.communityId !== communityId ||
      packet.review_id !== reviewId ||
      c.reviewId !== reviewId ||
      packet.session_terms_hash !== c.termsHash
    )
      return yield* Effect.fail(unavailable());
    return yield* parse(ModeratedDanceOwnerRubric, {
      version: "dance-moderated-owner-rubric-v1",
      community_id: communityId,
      review_id: reviewId,
      review_revision: packet.review_revision,
      session_terms_hash: c.termsHash,
      policy_hash: p.hash,
      rubric_version: p.rubricVersion,
      rubric_hash: p.rubricHash,
      rubric_text: packet.disclosure.owner_rubric_text,
      attestation_version: "dance-owner-verdict-attestation-v1",
    });
  },
);
