import { Effect } from "effect";
import type { Client } from "pg";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import { prepareModeratedDancePolicyPublication } from "../../application/src/use-cases/dance/moderated-policy.ts";
import { moderatedDanceIntakeFacts } from "../../testing/src/moderated-dance-intake-fixture.ts";
import { makeControlPlaneModeratedDanceIntakeStore } from "./dance-moderated-intake-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

export async function seedModeratedDanceIntake(
  admin: Client,
  connection: string,
  runtimeRevision?: string,
) {
  const facts = moderatedDanceIntakeFacts(),
    f =
      runtimeRevision === undefined
        ? facts
        : { ...facts, profile: { ...facts.profile, mediaRuntimeRevision: runtimeRevision } },
    now = Date.now(),
    hash = "a".repeat(64);
  const publication = await Effect.runPromise(
    prepareModeratedDancePolicyPublication({
      version: "dance-moderated-policy-publication-v1",
      policy_id: "private-test-policy",
      community_id: f.communityId,
      policy: f.policy,
      profile: f.profile,
      safety_policy: f.safetyPolicy,
      disposition: {
        ...f.disposition,
        validUntilMs: now + 10 * 86400000,
        hold: { ...f.disposition.hold, disposeByMs: now + 10 * 86400000 },
      },
      disclosure: {
        version: "dance-moderated-disclosure-v1",
        consent_text: "Fictional consent",
        retention_text: "Fictional finite retention",
        publication_text: "Fictional independent optional Post",
        owner_rubric_text: "Fictional cue/routine owner attestation",
      },
      valid_from: new Date(now - 10 * 86400000).toISOString(),
      valid_until: new Date(now + 3600000).toISOString(),
      accepted_by: "test-operator",
      acceptance_ref: "isolated-test-only",
      acceptance_hash: hash,
      producer_registration: {
        status: "active",
        acceptance_ref: "isolated-test-producer",
        acceptance_hash: hash,
      },
    }),
  );
  const referenceTermsHash = await Effect.runPromise(
    canonicalBodyHash([
      "moderated-canonical-reference-v1",
      f.choreographyId,
      1,
      "fictional-verified-master",
      "private-reference",
      hash,
      hash,
      publication.policy.normalizationHash,
    ]),
  );
  // The pre-existing public-song graph is bootstrap fixture data, not evidence
  // of a real renderer/provider. New intake commands run with all guards ON.
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role=replica");
    await admin.query("INSERT INTO users(user_id) VALUES($1),('private-test-owner')", [
      f.accountId,
    ]);
    await admin.query(
      "INSERT INTO personas(persona_id,account_id) VALUES($1,$2),('private-owner-persona','private-test-owner')",
      [f.personaId, f.accountId],
    );
    await admin.query(
      "INSERT INTO communities(community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES($1,'Private Dance test','active','private-test-owner',statement_timestamp(),statement_timestamp())",
      [f.communityId],
    );
    await admin.query(
      "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES($1,$2,$3,'activity_participation')",
      [f.personaId, f.accountId, f.communityId],
    );
    await admin.query(
      "INSERT INTO community_role_assignments(role_assignment_id,community_id,account_id,role) VALUES('private-owner-assignment',$1,'private-test-owner','owner')",
      [f.communityId],
    );
    await admin.query(
      "INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,content_rating,author_declared_rating,created_at,updated_at) VALUES($1,$2,'private-test-owner','private-owner-persona','song','published','public','general','general',statement_timestamp(),statement_timestamp()),($1,'private-reference','private-test-owner','private-owner-persona','video','published','public','general','general',statement_timestamp(),statement_timestamp())",
      [f.communityId, f.songPostId],
    );
    await admin.query(
      "INSERT INTO media_publication_projections(submission_id,community_id,actor_user_id,author_persona_id,operation_id,post_id,creation_revision,audio_revision,analysis_revision,decision_revision,canonical_audio_sha256,title,audio_asset_ref,language_status,lyrics_explicitness,alignment,data_registration,locked_delivery) VALUES('private-song-submission',$1,'private-test-owner','private-owner-persona','private-song-operation',$2,1,$3,1,1,$4,'Test song','test/song','not_applicable','not_applicable','not_applicable','pending','not_required')",
      [f.communityId, f.songPostId, f.audioRevision, hash],
    );
    await admin.query(
      "INSERT INTO dance_song_segments(segment_id,community_id,song_post_id,song_submission_id,audio_revision,start_ms,end_ms,canonical_audio_duration_ms,canonical_segment_audio_ref,canonical_segment_sha256,extraction_policy_version,source_media_sha256,segment_terms_hash) VALUES($1,$2,$3,'private-song-submission',$4,10000,20000,180000,'test/segment',$5,'test-canonical-extraction',$5,$5)",
      [f.segmentId, f.communityId, f.songPostId, f.audioRevision, hash],
    );
    await admin.query(
      "INSERT INTO dance_moderator_reference_revisions_v1(choreography_id,revision,community_id,song_post_id,audio_revision,segment_id,reference_post_id,video_render_revision,reference_digest,source_binding,alignment_evidence,terms_hash) VALUES($1,1,$2,$3,$4,$5,'private-reference','fictional-verified-master',$6,'{}',$7::jsonb,$8)",
      [
        f.choreographyId,
        f.communityId,
        f.songPostId,
        f.audioRevision,
        f.segmentId,
        hash,
        JSON.stringify({
          reference_body_start_ms: 0,
          reference_body_end_ms: f.bodyDurationMs,
          normalization_hash: publication.policy.normalizationHash,
        }),
        referenceTermsHash,
      ],
    );
    await admin.query(
      "INSERT INTO account_streak_clocks(account_id,timezone,timezone_updated_at,next_change_allowed_at) VALUES($1,'UTC',statement_timestamp(),statement_timestamp()+interval '7 days')",
      [f.accountId],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  await admin.query("SELECT publish_moderated_dance_policy_v1($1::jsonb)", [
    JSON.stringify(publication),
  ]);
  const runtime = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeControlPlaneModeratedDanceIntakeStore(runtime, f.accountId, {
    signer: {
      presign: async () => {
        throw new Error("No storage URL requested by these SQL cases");
      },
    },
    randomU32: () => 1,
  });
  const create = {
    version: "dance-moderated-intake-v1",
    operation: "create",
    idempotency_key: "private-create",
    community_id: f.communityId,
    song_post_id: f.songPostId,
    persona_id: f.personaId,
    choreography_id: f.choreographyId,
    choreography_revision: 1,
    expected_policy_hash: publication.policy.hash,
  } as const;
  const ready = async () => {
    await admin.query("SELECT record_moderated_dance_maintenance_v1()");
    await admin.query("SELECT announce_moderated_dance_processor_v1($1,$2,$3::jsonb)", [
      f.profile.mediaRuntimeRevision,
      f.profile.safetyProviderRevision,
      JSON.stringify(f.profile.replayCompatibleEpochs),
    ]);
  };
  return { store, create, ready, facts: f, publication, connection, runtime };
}
