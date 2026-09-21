import type { Client } from "pg";
import {
  AUDIO_REVISION,
  AUTHOR_ID,
  AUTHOR_PERSONA_ID,
  CANONICAL_AUDIO_SHA256,
  COMMUNITY_ID,
  digest,
  LYRIC_LINES,
  LYRICS_REVISION,
  OPERATION_ID,
  POST_ID,
  SUBMISSION_ID,
} from "./activity-participation-composed.pg-fixture.ts";

export async function seedActivitySong(admin: Client): Promise<void> {
  const lyrics = LYRIC_LINES.join("\n");
  const lineHashes = await Promise.all(LYRIC_LINES.map((line) => digest(line)));
  await admin.query("INSERT INTO users (user_id) VALUES ($1)", [AUTHOR_ID]);
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id, created_at, updated_at
     ) VALUES ($1,'Composed practice','active',$2,clock_timestamp(),clock_timestamp())`,
    [COMMUNITY_ID, AUTHOR_ID],
  );
  await admin.query(
    `INSERT INTO personas (
       persona_id, account_id, status, is_first_persona, created_at, retired_at
     ) VALUES ($1,$2,'active',true,clock_timestamp(),NULL)`,
    [AUTHOR_PERSONA_ID, AUTHOR_ID],
  );
  await admin.query(
    `INSERT INTO persona_community_bindings (
       persona_id, account_id, community_id, binding_source
     ) VALUES ($1,$2,$3,'community_creation')`,
    [AUTHOR_PERSONA_ID, AUTHOR_ID, COMMUNITY_ID],
  );
  await admin.query(
    `INSERT INTO posts (
       community_id, post_id, author_user_id, author_persona_id, post_type,
       status, visibility, title, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'song','published','public','Composed song',
       clock_timestamp(),clock_timestamp())`,
    [COMMUNITY_ID, POST_ID, AUTHOR_ID, AUTHOR_PERSONA_ID],
  );
  await admin.query("UPDATE posts SET content_rating='general' WHERE post_id=$1", [POST_ID]);
  await admin.query(
    `INSERT INTO media_post_submissions (
       submission_id, community_id, actor_user_id, operation_id, idempotency_key,
       request_hash, title, song_type, start_input, audio_reservation_id,
       creation_revision, audio_revision, analysis_revision, current_analysis_revision,
       current_immutable_ref, status, phase, post_id,
       response_snapshot_bytes, response_snapshot_sha256,
       author_persona_id, lyrics_revision, current_lyrics_revision
     ) VALUES ($1,$2,$3,$4,$5,$6,'Composed song','original','{}'::jsonb,
       'composed-reservation',1,$7,$7,$7,'audio-ref','published',NULL,$8,
       convert_to('snapshot','UTF8'),$9,$10,$11,$11)`,
    [
      SUBMISSION_ID,
      COMMUNITY_ID,
      AUTHOR_ID,
      OPERATION_ID,
      "composed-idempotency",
      CANONICAL_AUDIO_SHA256,
      AUDIO_REVISION,
      POST_ID,
      await digest("snapshot"),
      AUTHOR_PERSONA_ID,
      LYRICS_REVISION,
    ],
  );
  await admin.query(
    `INSERT INTO media_publication_projections (
       submission_id, community_id, actor_user_id, operation_id, post_id,
       creation_revision, audio_revision, analysis_revision, decision_revision,
       canonical_audio_sha256, title, audio_asset_ref, language_status,
       primary_language_bcp47, lyrics_explicitness, alignment, data_registration,
       locked_delivery, projected_at, author_persona_id, lyrics_status,
       lyrics_revision, lyrics_text
     ) VALUES ($1,$2,$3,$4,$5,1,$6,$6,1,$7,'Composed song','audio-ref',
       'ready','en','not_explicit','ready','registered','not_required',
       clock_timestamp(),$8,'ready',$9,$10)`,
    [
      SUBMISSION_ID,
      COMMUNITY_ID,
      AUTHOR_ID,
      OPERATION_ID,
      POST_ID,
      AUDIO_REVISION,
      CANONICAL_AUDIO_SHA256,
      AUTHOR_PERSONA_ID,
      LYRICS_REVISION,
      lyrics,
    ],
  );
  for (const [index, line] of LYRIC_LINES.entries()) {
    const ordinal = index + 1;
    const lineId = `composed-line-${ordinal}`;
    const unitId = `composed-unit-${ordinal}`;
    const lineHash = lineHashes[index] ?? "";
    await admin.query(
      `INSERT INTO localization_lyric_line_occurrences (
         community_id, post_id, lyric_line_id
       ) VALUES ($1,$2,$3)`,
      [COMMUNITY_ID, POST_ID, lineId],
    );
    await admin.query(
      `INSERT INTO localization_lyric_line_versions (
         community_id, post_id, lyric_line_id, line_version, canonical_text,
         source_language, source_hash
       ) VALUES ($1,$2,$3,1,$4,'en',$5)`,
      [COMMUNITY_ID, POST_ID, lineId, line, lineHash],
    );
    await admin.query(
      `INSERT INTO localization_study_units (
         community_id, post_id, study_unit_id, identity_normalization_revision,
         normalized_source_hash
       ) VALUES ($1,$2,$3,'lyric_line_identity_normalization_v1',$4)`,
      [COMMUNITY_ID, POST_ID, unitId, lineHash],
    );
    await admin.query(
      `INSERT INTO localization_lyric_line_study_units (
         community_id, post_id, lyric_line_id, line_version, study_unit_id
       ) VALUES ($1,$2,$3,1,$4)`,
      [COMMUNITY_ID, POST_ID, lineId, unitId],
    );
    await admin.query(
      `INSERT INTO localization_lyrics_revision_lines (
         community_id, actor_user_id, post_id, submission_id, lyrics_revision,
         ordinal, lyric_line_id, line_version, source_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)`,
      [COMMUNITY_ID, AUTHOR_ID, POST_ID, SUBMISSION_ID, LYRICS_REVISION, ordinal, lineId, lineHash],
    );
  }
  for (const [index, line] of LYRIC_LINES.slice(0, 4).entries()) {
    const ordinal = index + 1;
    await admin.query(
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
       ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,
         'say_it_back','spoken-recall-v2','en',NULL,NULL,1,$9::jsonb,$10::jsonb,$11,
         'always_visible','every_graded_attempt','script_aware_token_phonetic_v2',
         'spoken-feedback-v1','deterministic',$12,'accepted-lyrics-say-it-back-v2',NULL,
         'accepted-say-it-back-v2',$13,$7,'study-source-structure-v1',
         'study-source-semantic-v1','study-source-safety-v1','study-source-quality-v1',
         'accepted-source-v1',clock_timestamp(),clock_timestamp(),clock_timestamp())`,
      [
        `composed-exercise-${ordinal}`,
        COMMUNITY_ID,
        POST_ID,
        AUDIO_REVISION,
        LYRICS_REVISION,
        `composed-line-${ordinal}`,
        lineHashes[index] ?? "",
        `study-say-it-back:${POST_ID}:composed-unit-${ordinal}`,
        JSON.stringify({ kind: "say_it_back", reference_text: line, capture: "microphone_audio" }),
        JSON.stringify({
          kind: "source_token_phonetic_v2",
          reference_text: line,
          tokenizer_policy_revision: "script_aware_token_phonetic_v2",
        }),
        `composed-unit-${ordinal}`,
        `composed-run-${ordinal}`,
        await digest(`composed-exercise-${ordinal}`),
      ],
    );
  }
  let cursor = 0;
  const segments = LYRIC_LINES.flatMap((line) =>
    line.split(" ").map((word) => {
      const segment = { text: word, start_ms: cursor, end_ms: cursor + 300 };
      cursor += 350;
      return segment;
    }),
  );
  const artifact = {
    version: "media-timed-lyrics-artifact-v1",
    mode: "word",
    segments,
  };
  await admin.query(
    `INSERT INTO media_alignment_projections (
       submission_id, community_id, actor_user_id, operation_id, post_id,
       audio_revision, analysis_revision, canonical_audio_sha256, alignment_revision,
       status, current_artifact_ref, current_artifact_revision, author_persona_id,
       lyrics_revision
     ) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,1,'ready','composed-artifact',1,$8,$9)`,
    [
      SUBMISSION_ID,
      COMMUNITY_ID,
      AUTHOR_ID,
      OPERATION_ID,
      POST_ID,
      AUDIO_REVISION,
      CANONICAL_AUDIO_SHA256,
      AUTHOR_PERSONA_ID,
      LYRICS_REVISION,
    ],
  );
  await admin.query(
    `INSERT INTO media_timed_lyrics_artifacts (
       artifact_ref, community_id, actor_user_id, submission_id, operation_id,
       post_id, audio_revision, analysis_revision, artifact_revision,
       canonical_audio_sha256, artifact_sha256, artifact, author_persona_id,
       lyrics_revision
     ) VALUES ('composed-artifact',$1,$2,$3,$4,$5,$6,$6,1,$7,
       encode(sha256(convert_to($8::jsonb::text,'UTF8')),'hex'),$8::jsonb,$9,$10)`,
    [
      COMMUNITY_ID,
      AUTHOR_ID,
      SUBMISSION_ID,
      OPERATION_ID,
      POST_ID,
      AUDIO_REVISION,
      CANONICAL_AUDIO_SHA256,
      JSON.stringify(artifact),
      AUTHOR_PERSONA_ID,
      LYRICS_REVISION,
    ],
  );
}
