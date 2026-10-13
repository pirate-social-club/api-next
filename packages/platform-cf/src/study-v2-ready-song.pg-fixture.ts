import type { Client } from "pg";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";

const digest = async (value: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "hex",
  );

// TEST ONLY: the existing trusted prepared-source loader can add a second song
// to its already-created actor/community. This remaps only closed fixture source
// IDs in actual SQL and bound values, never query results or learning/money rows.
const preparedSourceQuery = (admin: Pick<Client, "query">, tag?: string) => {
  if (tag !== undefined && !/^[a-z][a-z0-9-]{0,24}$/u.test(tag))
    throw new Error("Bounded trusted prepared source tag required");
  const mapped = (value: string): string =>
    tag === undefined
      ? value
      : value
          .replaceAll("study-post", `${tag}-post`)
          .replaceAll("study-submission", `${tag}-submission`)
          .replaceAll("study-operation", `${tag}-operation`)
          .replaceAll("study-idempotency", `${tag}-idempotency`)
          .replaceAll("study-run-", `${tag}-run-`)
          .replace(/\bexercise-([1-4])\b/gu, `${tag}-exercise-$1`);
  return (text: string, values?: readonly unknown[]) =>
    admin.query(
      mapped(text),
      values === undefined
        ? undefined
        : values.map((value) => (typeof value === "string" ? mapped(value) : value)),
    );
};

/**
 * One published general-rated English song in `study-community` with four accepted
 * say-it-back exercises, owned by `study-account` / `study-persona`.
 */
export async function insertStudySongFixture(
  admin: Pick<Client, "query">,
  options?: {
    readonly accountAlreadyBorn?: true;
    readonly initializeOwnerPolicy?: true;
    readonly additionalSourceTag?: string;
  },
) {
  const query = preparedSourceQuery(admin, options?.additionalSourceTag);
  const lines = [
    "I can love you",
    "We keep moving forward",
    "Hold the rhythm closer",
    "Sing the night together",
  ];
  const lyrics = lines.join("\n");
  const creationRevision = options?.initializeOwnerPolicy === true ? 2 : 1;
  const lineHashes = await Promise.all(lines.map(digest));
  // TEST ONLY: trusted prepared-media fixture; the production policy producer
  // must run on its INITIAL publication insert, not on a fabricated head.
  let policyTriggerArmed = false;
  await query("SET session_replication_role = replica");
  try {
    // Normal identity birth owns its first-persona reservation and immutable owner.
    // This fixture adds its explicit non-first activity persona without replacing either.
    if (options?.additionalSourceTag === undefined) {
      if (options?.accountAlreadyBorn !== true)
        await query("INSERT INTO users (user_id) VALUES ('study-account')");
      await query(
        `INSERT INTO communities (
             community_id, display_name, status, created_by_user_id, created_at, updated_at
           ) VALUES ('study-community','Study community','active','study-account',
           clock_timestamp(),clock_timestamp())`,
      );
      await insertActiveCommunityMembershipFixture(admin, {
        communityId: "study-community",
        membershipId: "study-membership",
        userId: "study-account",
      });
      await query(
        `INSERT INTO personas (
           persona_id, account_id, status, created_at
         ) VALUES ('study-persona', 'study-account', 'active', clock_timestamp())`,
      );
      await query(
        `INSERT INTO persona_community_bindings (
             persona_id, account_id, community_id, binding_source
           ) VALUES ('study-persona', 'study-account', 'study-community', 'first_membership')`,
      );
    }
    await query(
      `INSERT INTO posts (
           community_id, post_id, post_type, status, visibility, created_at, updated_at
         ) VALUES ('study-community', 'study-post', 'song', 'published', 'public',
           clock_timestamp(), clock_timestamp())`,
    );
    await query("UPDATE posts SET content_rating='general' WHERE post_id='study-post'");
    if (options?.initializeOwnerPolicy === true)
      await query(
        "UPDATE posts SET author_user_id='study-account',author_persona_id='study-persona' WHERE community_id='study-community' AND post_id='study-post'",
      );
    await query(
      `INSERT INTO media_post_submissions (
         submission_id, community_id, actor_user_id, operation_id, idempotency_key,
         request_hash, title, song_type, start_input, audio_reservation_id,
         creation_revision, audio_revision, analysis_revision, current_analysis_revision,
         current_immutable_ref, status, phase, post_id,
         response_snapshot_bytes, response_snapshot_sha256,
         author_persona_id, lyrics_revision, current_lyrics_revision, current_terms_revision
       ) VALUES ('study-submission','study-community','study-account','study-operation',
         'study-idempotency',$1,'Study song','original','{}'::jsonb,'study-reservation',
         $3::bigint,1,1,1,'audio-ref','published',NULL,'study-post',convert_to('snapshot','UTF8'),$2,
         'study-persona',1,1,$4::bigint)`,
      [
        "1".repeat(64),
        await digest("snapshot"),
        creationRevision,
        options?.initializeOwnerPolicy === true ? 2 : null,
      ],
    );
    await query(
      `INSERT INTO media_analysis_evidence (
          submission_id,community_id,actor_user_id,operation_id,analysis_version,
          audio_revision,analysis_revision,canonical_audio_sha256,finalized_audio_ref,
          probe_evidence_ref,embedded_metadata_evidence_ref,embedded_metadata_adapter_revision,
          embedded_title,embedded_title_provenance,cover_status,cover_facts,speech_status,
          transcript_artifact_ref,transcript_sha256,explicitness,primary_language_bcp47,
          speech_evidence_ref,speech_policy_revision,speech_adapter_revision,acr_decision,
          acr_evidence_ref,acr_policy_revision,acr_adapter_revision,media_safety,lyrics_safety,
          cover_moderation_decision,cover_moderation_reason,
          cover_moderation_matched_categories,analysis_snapshot,author_persona_id,
          lyrics_revision
        ) VALUES (
          'study-submission','study-community','study-account','study-operation',
          'song-trusted-analysis-v1',1,1,$1,'audio-ref','probe-ref','metadata-ref',
          'metadata-v1',NULL,'absent','absent','{"reasonCode":"not_embedded"}'::jsonb,
          'ready',NULL,NULL,'not_explicit','en','speech-ref','speech-policy-v1',
          'speech-adapter-v1','allow','acr-no-match-1001','acr-policy-v1','acr-adapter-v1',
          'allow','allow','not_applicable','not_embedded','[]'::jsonb,
          '{}'::jsonb,'study-persona',1
        )`,
      ["2".repeat(64)],
    );
    if (options?.initializeOwnerPolicy === true) {
      // Explicit licensed prepared input for the actual 0107 initializer.
      // This supplies no policy row/hash: the native producer derives both.
      await query(`INSERT INTO media_submission_terms (
        submission_id,community_id,actor_user_id,author_persona_id,operation_id,
        creation_revision,license_preset,commercial_remix_share_bps,royalty_allocations,
        access_mode,terms_snapshot
      ) VALUES ('study-submission','study-community','study-account','study-persona','study-operation',
        2,'commercial-remix',1000,'[{"recipient_id":"study-account","share_bps":10000}]'::jsonb,
        'public','{"license_preset":"commercial-remix"}'::jsonb)`);
      // Existing fixture inputs are inserted in replica mode. Make ONLY the
      // actual policy initializer run there, then restore its exact O state.
      // No production migration/body/grant or financial guard changes.
      await query(
        "ALTER TABLE media_publication_projections ENABLE ALWAYS TRIGGER media_publication_song_owner_policy_initialize",
      );
      policyTriggerArmed = true;
    }
    await query(
      `INSERT INTO media_publication_projections (
         submission_id, community_id, actor_user_id, operation_id, post_id,
         creation_revision, audio_revision, analysis_revision, decision_revision,
         canonical_audio_sha256, title, audio_asset_ref, language_status,
         primary_language_bcp47, lyrics_explicitness, alignment, data_registration,
         locked_delivery, projected_at, author_persona_id, lyrics_status,
         lyrics_revision, lyrics_text
       ) VALUES ('study-submission','study-community','study-account','study-operation',
         'study-post',$3::bigint,1,1,1,$1,'Study song','audio-ref','ready','en','not_explicit',
         'ready','registered','not_required',clock_timestamp(),'study-persona','ready',1,$2)`,
      ["2".repeat(64), lyrics, creationRevision],
    );
    if (policyTriggerArmed) {
      const state = (
        await query(`SELECT publication.creation_revision::text AS publication_creation,
        terms.creation_revision::text AS terms_creation,submission.creation_revision::text AS submission_creation,
        submission.current_terms_revision::text AS current_terms,publication.audio_revision::text AS audio_revision,
        publication.lyrics_revision::text AS lyrics_revision,publication.operation_id=terms.operation_id
        AND publication.operation_id=submission.operation_id AS same_operation,
        publication.actor_account_id=terms.actor_user_id AND publication.actor_account_id=submission.actor_user_id AS same_actor
        FROM media_publication_projections publication JOIN media_submission_terms terms
          ON terms.submission_id=publication.submission_id AND terms.creation_revision=publication.creation_revision
        JOIN media_post_submissions submission ON submission.submission_id=publication.submission_id
        WHERE publication.community_id='study-community' AND publication.post_id='study-post'`)
      ).rows;
      if (
        state.length !== 1 ||
        state[0]?.publication_creation !== "2" ||
        state[0]?.terms_creation !== "2" ||
        state[0]?.submission_creation !== "2" ||
        state[0]?.current_terms !== "2" ||
        state[0]?.audio_revision !== "1" ||
        state[0]?.lyrics_revision !== "1" ||
        state[0]?.same_operation !== true ||
        state[0]?.same_actor !== true
      )
        throw new Error("Prepared initial licensed publication revision/source tuple differs");
      await query(
        "ALTER TABLE media_publication_projections ENABLE TRIGGER media_publication_song_owner_policy_initialize",
      );
      policyTriggerArmed = false;
    }

    for (const slot of ["instrumental_audio", "vocal_audio"]) {
      const tag = options?.additionalSourceTag;
      if (tag === undefined) {
        // Preserve every historical default identity and exact SQL/values.
        await query(
          `INSERT INTO media_song_stems(submission_id,slot,community_id,actor_user_id,operation_id,reservation_id,immutable_ref,destination_ref,etag,object_version,size_bytes,content_type,canonical_sha256,author_persona_id) VALUES('study-submission',$1,'study-community','study-account','study-operation',$1,'sealed-ref-'||$1,'sealed-destination-'||$1,'etag','version',1024,'audio/mpeg',$2,'study-persona')`,
          [slot, "b".repeat(64)],
        );
      } else {
        // The slot is a closed enum; only its globally unique fixture IDs differ.
        await query(
          `INSERT INTO media_song_stems(submission_id,slot,community_id,actor_user_id,operation_id,reservation_id,immutable_ref,destination_ref,etag,object_version,size_bytes,content_type,canonical_sha256,author_persona_id) VALUES('study-submission',$1,'study-community','study-account','study-operation',$3,$4,$5,'etag','version',1024,'audio/mpeg',$2,'study-persona')`,
          [
            slot,
            "b".repeat(64),
            `${tag}-stem-${slot}`,
            `${tag}-sealed-ref-${slot}`,
            `${tag}-sealed-destination-${slot}`,
          ],
        );
      }
    }
    for (const [index, line] of lines.entries()) {
      const ordinal = index + 1;
      await query(
        `INSERT INTO localization_lyric_line_occurrences (
             community_id, post_id, lyric_line_id
           ) VALUES ('study-community','study-post',$1)`,
        [`line-${ordinal}`],
      );
      await query(
        `INSERT INTO localization_lyric_line_versions (
             community_id, post_id, lyric_line_id, line_version, canonical_text,
             source_language, source_hash
           ) VALUES ('study-community','study-post',$1,1,$2,'en',$3)`,
        [`line-${ordinal}`, line, lineHashes[index]],
      );
      await query(
        `INSERT INTO localization_study_units (
             community_id, post_id, study_unit_id, identity_normalization_revision,
             normalized_source_hash
           ) VALUES ('study-community','study-post',$1,
             'lyric_line_identity_normalization_v1',$2)`,
        [`unit-${ordinal}`, lineHashes[index]],
      );
      await query(
        `INSERT INTO localization_lyric_line_study_units (
             community_id, post_id, lyric_line_id, line_version, study_unit_id
           ) VALUES ('study-community','study-post',$1,1,$2)`,
        [`line-${ordinal}`, `unit-${ordinal}`],
      );
      await query(
        `INSERT INTO localization_lyrics_revision_lines (
             community_id, actor_user_id, post_id, submission_id, lyrics_revision,
             ordinal, lyric_line_id, line_version, source_hash
           ) VALUES ('study-community','study-account','study-post','study-submission',1,
             $1,$2,1,$3)`,
        [ordinal, `line-${ordinal}`, lineHashes[index]],
      );
      await query(
        `INSERT INTO study_exercise_versions (
           exercise_version_id, community_id, post_id, audio_revision, lyrics_revision,
           lyric_line_id, line_version, line_source_hash, exercise_review_key,
           exercise_type, exercise_variant, learning_language, target_language,
           learner_band, content_revision, presentation, private_grader, study_unit_id,
           answer_visibility, feedback_release, grader_policy_revision,
           feedback_policy_revision, generation_kind, generation_run_id, producer_id,
           provider_model, prompt_revision, request_hash, raw_result_digest,
           structural_validator_revision, semantic_validator_revision,
           safety_validator_revision, quality_validator_revision,
           quality_policy_revision, generated_at, validated_at, accepted_at
         ) VALUES ($1,'study-community','study-post',1,1,$2,1,$3,$4,
           'say_it_back','spoken-recall-v2','en',NULL,NULL,1,$5::jsonb,$6::jsonb,$7,
           'always_visible','every_graded_attempt','script_aware_token_phonetic_v2',
           'spoken-feedback-v1','deterministic',$8,'accepted-lyrics-say-it-back-v2',NULL,
           'accepted-say-it-back-v2',$9,$3,'study-source-structure-v1',
           'study-source-semantic-v1','study-source-safety-v1','study-source-quality-v1',
           'accepted-source-v1',clock_timestamp(),clock_timestamp(),clock_timestamp())`,
        [
          `exercise-${ordinal}`,
          `line-${ordinal}`,
          lineHashes[index],
          `study-say-it-back:study-post:unit-${ordinal}`,
          JSON.stringify({
            kind: "say_it_back",
            reference_text: line,
            capture: "microphone_audio",
          }),
          JSON.stringify({
            kind: "source_token_phonetic_v2",
            reference_text: line,
            tokenizer_policy_revision: "script_aware_token_phonetic_v2",
          }),
          `unit-${ordinal}`,
          `study-run-${ordinal}`,
          await digest(`exercise-${ordinal}`),
        ],
      );
    }
  } finally {
    try {
      if (policyTriggerArmed)
        await query(
          "ALTER TABLE media_publication_projections ENABLE TRIGGER media_publication_song_owner_policy_initialize",
        );
    } finally {
      await query("SET session_replication_role = origin");
    }
  }
  return { lines };
}

/** Language profile that admits the fixture song to Telegram read-aloud practice. */
export async function insertTelegramPracticeReadinessFixture(
  admin: Pick<Client, "query">,
  options?: Readonly<{ additionalSourceTag?: string }>,
) {
  const query = preparedSourceQuery(admin, options?.additionalSourceTag);
  await query("SET session_replication_role=replica");
  try {
    await query(
      `INSERT INTO study_language_profiles(community_id,post_id,lyrics_revision,language_profile_revision,source_hash,provider_id,provider_model,prompt_revision,validator_revision,request_hash,accepted_at) VALUES('study-community','study-post',1,1,$1,'fixture','fixture','fixture','fixture',$1,clock_timestamp())`,
      ["a".repeat(64)],
    );
    for (let ordinal = 1; ordinal <= 4; ordinal++)
      await query(
        `INSERT INTO study_language_profile_units(community_id,post_id,lyrics_revision,language_profile_revision,study_unit_id,detected_languages,dominant_language,mixed,vocable_only,proper_name_only,confidence) VALUES('study-community','study-post',1,1,$1,'["en"]'::jsonb,'en',FALSE,FALSE,FALSE,0.99)`,
        [`unit-${ordinal}`],
      );
  } finally {
    await query("SET session_replication_role=origin");
  }
}
