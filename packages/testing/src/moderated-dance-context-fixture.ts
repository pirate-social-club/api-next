import { Effect } from "effect";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import { prepareModeratedDanceTerms } from "../../application/src/use-cases/dance/moderated-intake.ts";
import { prepareModeratedDancePolicyPublication } from "../../application/src/use-cases/dance/moderated-policy.ts";
import {
  moderatedDanceIntakeFacts,
  noPoseModeratedDanceIntakeFacts,
} from "./moderated-dance-intake-fixture.ts";
import { sharedSongParticipantFixture } from "./shared-song-participant-fixture.ts";

/** Hash-valid, fictional documents only. No operational admissions or media. */
export async function moderatedDanceContextFixture(funded = false, noPose = false) {
  const shared = await sharedSongParticipantFixture(undefined, noPose);
  const b = shared.projection.terms.qualification_bindings.find((x) => x.activity === "dance");
  const q = shared.qualification_documents.find((x) => x.activity === "dance");
  if (b === undefined || q === undefined) throw new Error("Missing fictional Dance objective");
  const base = noPose ? noPoseModeratedDanceIntakeFacts() : moderatedDanceIntakeFacts();
  const facts = {
    ...base,
    communityId: shared.projection.target.community_id,
    songPostId: shared.projection.target.post_id,
    audioRevision: shared.projection.target.audio_revision,
    policy: {
      ...base.policy,
      admission: "money_admitted" as const,
      qualificationVersion: b.qualification_policy_id,
      producerId: "test-producer",
      admissionVersion: b.admission_id,
      admissionHash: b.admission_hash,
    },
  };
  const publication = await Effect.runPromise(
    prepareModeratedDancePolicyPublication({
      version: "dance-moderated-policy-publication-v1",
      policy_id: facts.policyId,
      community_id: facts.communityId,
      policy: facts.policy,
      profile: facts.profile,
      disposition: facts.disposition,
      safety_policy: facts.safetyPolicy,
      disclosure: {
        version: "dance-moderated-disclosure-v1",
        consent_text: "Fictional private consent",
        retention_text: "Fictional bounded retention",
        publication_text: "Fictional independent optional Post",
        owner_rubric_text: noPose
          ? "Fictional selected dance rubric; no opening pose required"
          : "Fictional assigned cue and selected dance rubric",
      },
      valid_from: "1970-01-01T00:00:01.000Z",
      valid_until: "1970-01-01T01:00:00.000Z",
      accepted_by: "test-operator",
      acceptance_ref: "test-only-no-activation",
      acceptance_hash: "a".repeat(64),
      producer_registration: {
        status: "reserved",
        acceptance_ref: "test-only-no-activation",
        acceptance_hash: "b".repeat(64),
      },
    }),
  );
  const objective = {
    id: b.objective_id,
    version: b.qualification_policy_id,
    termsHash: shared.projection.terms.terms_hash,
    fundingPolicyHash: shared.projection.terms.funding_policy_hash,
    gradingMode: "moderator_verdict" as const,
  };
  const terms = await Effect.runPromise(
    prepareModeratedDanceTerms(
      {
        ...facts,
        policy: publication.policy,
        disposition: publication.disposition,
        objectives: funded ? [objective] : [],
      },
      {
        sessionId: "test-capture-session",
        reviewId: "test-capture-review",
        attemptId: "test-capture-attempt",
      },
      noPose ? "none" : "arms_t",
    ),
  );
  const c = terms.capture,
    p = c.policy;
  const reference = {
    reference_post_id: "test-reference-post",
    video_render_revision: "test-reference-render",
    reference_digest: "8".repeat(64),
    segment_terms_hash: "9".repeat(64),
    normalization_hash: p.normalizationHash,
    canonical_song_start_ms: 10000,
    canonical_song_end_ms: 20000,
    reference_body_start_ms: 0,
    reference_body_end_ms: 10000,
    reference_terms_hash: "",
  };
  reference.reference_terms_hash = await Effect.runPromise(
    canonicalBodyHash([
      "moderated-canonical-reference-v1",
      c.choreographyId,
      c.choreographyRevision,
      reference.video_render_revision,
      reference.reference_post_id,
      reference.reference_digest,
      reference.segment_terms_hash,
      reference.normalization_hash,
    ]),
  );
  const session = {
    version: "dance-moderated-session-v1",
    session_id: c.sessionId,
    review_id: c.reviewId,
    attempt_id: c.attemptId,
    community_id: c.communityId,
    song_post_id: c.songPostId,
    choreography_id: c.choreographyId,
    choreography_revision: c.choreographyRevision,
    terms_hash: terms.terms_hash,
    policy_hash: p.hash,
    consent_version: p.consentVersion,
    consent_hash: p.consentHash,
    retention_hash: p.retentionHash,
    normalization_version: p.normalizationVersion,
    normalization_hash: p.normalizationHash,
    safety_hash: p.safetyHash,
    state: "created",
    created_at_ms: terms.created_at_ms,
    expires_at_ms: c.captureExpiresAtMs,
    body_start_ms: c.bodyStartMs,
    body_end_ms: c.bodyEndMs,
    cue: { kind: c.cueId, start_ms: c.cueStartMs, end_ms: c.cueEndMs, hold_ms: c.cueHoldMs },
    maximum_bytes: terms.profile.maximumBytes,
    upload_id: null,
    upload_state: null,
    uploaded_at_ms: null,
    review_deadline_ms: null,
    score_bps: null,
  };
  const resolved = {
    target: shared.projection.target,
    terms: shared.projection.terms,
    binding: b,
    chain_id: shared.projection.chain_id,
    token_address: shared.projection.token_address,
    token_decimals: shared.projection.token_decimals,
    qualification_document: q.document,
  };
  const disclosure = { ...publication.disclosure };
  return {
    actor: { accountId: c.accountId, communityId: c.communityId, sessionId: c.sessionId },
    packet: {
      terms,
      disclosure,
      session,
      reference,
      objectives: funded ? [resolved] : [],
    },
    ownerPacket: {
      terms,
      disclosure,
      community_id: c.communityId,
      review_id: c.reviewId,
      review_revision: 2,
      session_terms_hash: terms.terms_hash,
    },
    resolved,
  };
}
