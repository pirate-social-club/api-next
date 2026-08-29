import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

suite("Study v2 Postgres foundation", () => {
  test("keeps versions immutable and review identity stable across regeneration", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_study_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);

    try {
      await runPostgresMigrations({
        connectionString: connectionForSchema(connectionString, schema),
      });
      const hash = "a".repeat(64);
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query("INSERT INTO users (user_id) VALUES ('account-1')");
        await admin.query(
          `INSERT INTO personas (persona_id, account_id, status, created_at)
           VALUES ('persona-1', 'account-1', 'active', clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO posts (
             community_id, post_id, post_type, status, visibility, created_at, updated_at
           ) VALUES (
             'community-1', 'post-1', 'song', 'published', 'public',
             clock_timestamp(), clock_timestamp()
           )`,
        );
        await admin.query(
          `INSERT INTO localization_lyric_line_versions (
             community_id, post_id, lyric_line_id, line_version,
             canonical_text, source_language, source_hash
           ) VALUES ('community-1', 'post-1', 'line-1', 1, 'Hold on', 'en', $1)`,
          [hash],
        );
        await admin.query(
          `INSERT INTO localization_study_units (
             community_id, post_id, study_unit_id, identity_normalization_revision,
             normalized_source_hash
           ) VALUES ('community-1', 'post-1', 'unit-1',
             'lyric_line_identity_normalization_v1', $1)`,
          [hash],
        );
        await admin.query(
          `INSERT INTO localization_lyric_line_study_units (
             community_id, post_id, lyric_line_id, line_version, study_unit_id
           ) VALUES ('community-1', 'post-1', 'line-1', 1, 'unit-1')`,
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const insertExercise = async (id: string, revision: number) =>
        admin.query(
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
           ) VALUES (
             $1, 'community-1', 'post-1', 1, 1, 'line-1', 1, $2, 'review-key-1',
             'say_it_back', 'spoken-recall-v1', 'en', NULL, NULL, $3,
             '{"kind":"say_it_back"}', '{"kind":"source_token_diff_v1"}', 'unit-1',
             'always_visible', 'every_graded_attempt', 'grader-v1', 'feedback-v1',
             'deterministic', $4, 'producer-v1', NULL, 'prompt-v1', $5, $6,
             'structure-v1', 'semantic-v1', 'safety-v1', 'quality-validator-v1',
             'quality-v1', clock_timestamp(), clock_timestamp(), clock_timestamp()
           )`,
          [id, hash, revision, `run-${revision}`, String(revision).repeat(64), "b".repeat(64)],
        );

      await insertExercise("exercise-v1", 1);
      await insertExercise("exercise-v2", 2);
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
         ) SELECT 'exercise-other-key', community_id, post_id, audio_revision, lyrics_revision,
           lyric_line_id, line_version, line_source_hash, 'review-key-other', exercise_type,
           exercise_variant, learning_language, target_language, learner_band, 1,
           presentation, private_grader, study_unit_id, answer_visibility, feedback_release,
           grader_policy_revision, feedback_policy_revision, generation_kind, 'run-other',
           producer_id, provider_model, prompt_revision, $1, raw_result_digest,
           structural_validator_revision, semantic_validator_revision,
           safety_validator_revision, quality_validator_revision, quality_policy_revision,
           generated_at, validated_at, accepted_at
         FROM study_exercise_versions WHERE exercise_version_id = 'exercise-v1'`,
        ["c".repeat(64)],
      );
      await expect(
        admin.query(
          "UPDATE study_exercise_versions SET exercise_variant = 'changed' WHERE exercise_version_id = 'exercise-v1'",
        ),
      ).rejects.toThrow("study_exercise_versions rows are immutable");

      await admin.query(
        `INSERT INTO study_review_items (
           review_item_id, account_id, exercise_review_key, current_exercise_version_id,
           scheduler_policy_revision, scheduler_state, community_id, post_id,
           study_unit_id, exercise_kind, learning_language, target_language, learner_band
         ) VALUES ('review-item-1', 'account-1', 'review-key-1', 'exercise-v1',
           'study_review_schedule_v1', '{}'::jsonb, 'community-1', 'post-1',
           'unit-1', 'say_it_back', 'en', NULL, NULL)`,
      );
      await admin.query(
        `UPDATE study_review_items
            SET current_exercise_version_id = 'exercise-v2', updated_at = clock_timestamp()
          WHERE review_item_id = 'review-item-1'`,
      );
      await expect(
        admin.query(
          `UPDATE study_review_items
              SET current_exercise_version_id = 'exercise-other-key'
            WHERE review_item_id = 'review-item-1'`,
        ),
      ).rejects.toThrow();
      const review = await admin.query(
        `SELECT review_item_id, exercise_review_key, current_exercise_version_id
           FROM study_review_items`,
      );
      expect(review.rows).toEqual([
        {
          review_item_id: "review-item-1",
          exercise_review_key: "review-key-1",
          current_exercise_version_id: "exercise-v2",
        },
      ]);

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO study_sessions_v2 (
           session_id, account_id, persona_id, community_id, post_id,
           audio_revision, lyrics_revision, learning_language, target_language,
           learner_band, study_profile_revision, source_set_revision,
           selection_policy_revision, qualification_policy_revision, timezone,
           idempotency_key, request_hash, current_session_item_id, current_presented_at
         ) VALUES ('session-1', 'account-1', 'persona-1', 'community-1', 'post-1',
           1, 1, 'en', NULL, NULL, 1, 1, 'selection-v1', 'qualification-v1', 'UTC',
           'session-command-1', $1, 'session-item-1', clock_timestamp())`,
        ["d".repeat(64)],
      );
      await admin.query(
        `INSERT INTO study_session_items_v2 (
           session_item_id, session_id, ordinal, exercise_review_key,
           exercise_version_id, review_item_id, item_snapshot, maximum_attempts, account_id
         ) VALUES ('session-item-1', 'session-1', 0, 'review-key-1',
           'exercise-v2', 'review-item-1', '{}'::jsonb, 3, 'account-1')`,
      );
      await admin.query(
        `INSERT INTO study_lesson_item_state_v2 (
           session_item_id, session_id, original_ordinal
         ) VALUES ('session-item-1', 'session-1', 0)`,
      );
      await admin.query("COMMIT");
      await expect(
        admin.query(
          `INSERT INTO study_session_items_v2 (
             session_item_id, session_id, ordinal, exercise_review_key,
             exercise_version_id, review_item_id, item_snapshot, maximum_attempts, account_id
           ) VALUES ('session-item-2', 'session-1', 1, 'review-key-1',
             'exercise-v1', 'review-item-1', '{}'::jsonb, 3, 'account-1')`,
        ),
      ).rejects.toThrow();
      await admin.query(
        `INSERT INTO learner_audio_artifacts (
           learner_audio_artifact_id, account_id, source_kind, attempt_ref,
           expected_object_ref, object_ref, content_digest, content_type, byte_size,
           duration_ms, platform_retention, provider_retention, recording_state, expires_at
         ) VALUES ('audio-1', 'account-1', 'study', 'attempt-2', 'private/audio-1',
           'private/audio-1', $1, 'audio/webm', 100, 1000, 'private_learning',
           'not_stored', 'stored', clock_timestamp() + interval '24 months')`,
        ["5".repeat(64)],
      );
      await admin.query(
        `INSERT INTO study_attempts_v2 (
           attempt_id, session_item_id, attempt_number, submission_kind,
           submission_evidence, outcome, first_pass, attempt_state, feedback_kind,
           feedback_evidence, grader_policy_revision, feedback_policy_revision,
           idempotency_key, request_hash, study_unit_id, exercise_kind,
           learning_language, target_language, learner_band, source_line_revision,
           language_profile_revision, localization_revision, grading_revision,
           review_schedule_version, audio_byte_size, audio_duration_ms,
           provider_detected_language, provider_detected_language_confidence,
           token_diff, learner_audio_artifact_id
         ) VALUES ('attempt-2', 'session-item-1', 1, 'raw_audio', '{}'::jsonb,
           'correct', TRUE, 'spent', 'transcript_diff', '{}'::jsonb,
           'grader-v1', 'feedback-v1', 'answer-command-2', $1, 'unit-1',
           'say_it_back', 'en', NULL, NULL, 1, NULL, NULL, 'grader-v1',
           'study_review_schedule_v1', 100, 1000, 'en', 0.99, '{}'::jsonb, 'audio-1')`,
        ["6".repeat(64)],
      );
      const retained = await admin.query(
        `SELECT attempt.audio_byte_size, artifact.recording_state
           FROM study_attempts_v2 attempt
           JOIN learner_audio_artifacts artifact
             ON artifact.learner_audio_artifact_id=attempt.learner_audio_artifact_id
          WHERE attempt.attempt_id='attempt-2'`,
      );
      expect(retained.rows).toEqual([{ audio_byte_size: "100", recording_state: "stored" }]);
      await expect(
        admin.query(
          `INSERT INTO study_attempts_v2 (
             attempt_id, session_item_id, attempt_number, submission_kind,
             submission_evidence, outcome, first_pass, attempt_state,
             feedback_kind, feedback_evidence, grader_policy_revision,
             feedback_policy_revision, idempotency_key, request_hash
           ) VALUES ('attempt-1', 'session-item-1', 1, 'text_response', '{}'::jsonb,
             'incorrect', FALSE, 'retryable', 'text_reveal', '{}'::jsonb,
             'grader-v1', 'feedback-v1', 'answer-command-1', $1)`,
          ["e".repeat(64)],
        ),
      ).rejects.toThrow();
      await admin.query(
        `INSERT INTO learner_audio_artifacts (
           learner_audio_artifact_id, account_id, source_kind, attempt_ref,
           expected_object_ref, object_ref, content_digest, content_type, byte_size,
           duration_ms, platform_retention, provider_retention, recording_state, expires_at
         ) VALUES ('audio-command-1', 'account-1', 'study', 'spoken-attempt-1',
           'learner-audio/study/spoken-attempt-1/audio', NULL, $1, 'audio/webm',
           100, 1000, 'private_learning', 'not_stored', 'pending',
           clock_timestamp() + interval '24 months')`,
        ["2".repeat(64)],
      );
      await admin.query(
        `INSERT INTO study_spoken_answer_commands (
           command_id, account_id, session_id, session_item_id, attempt_number,
           idempotency_key, request_hash, audio_digest, audio_content_type,
           audio_byte_size, audio_duration_ms, attempt_id, learner_audio_artifact_id,
           lease_token, lease_expires_at, state
         ) VALUES ('spoken-1', 'account-1', 'session-1', 'session-item-1', 1,
           'spoken-command-1', $1, $2, 'audio/webm', 100, 1000, 'spoken-attempt-1',
           'audio-command-1', 'lease-1', clock_timestamp() + interval '1 minute',
           'reserved')`,
        ["1".repeat(64), "2".repeat(64)],
      );
      await expect(
        admin.query(
          `INSERT INTO study_spoken_answer_commands (
             command_id, account_id, session_id, session_item_id, attempt_number,
             idempotency_key, request_hash, audio_digest, audio_content_type,
             audio_byte_size, audio_duration_ms, attempt_id, learner_audio_artifact_id,
             lease_token, lease_expires_at, state
           ) VALUES ('spoken-2', 'account-1', 'session-1', 'session-item-1', 1,
             'spoken-command-2', $1, $2, 'audio/webm', 100, 1000, 'spoken-attempt-1',
             'audio-command-1', 'lease-2', clock_timestamp() + interval '1 minute',
             'reserved')`,
          ["3".repeat(64), "4".repeat(64)],
        ),
      ).rejects.toThrow();
      await admin.query(
        `UPDATE study_spoken_answer_commands
            SET reserved_at=clock_timestamp() - interval '2 minutes',
                lease_expires_at=clock_timestamp() - interval '1 second'
          WHERE command_id='spoken-1'`,
      );
      const reclaimed = await admin.query(
        `UPDATE study_spoken_answer_commands
            SET lease_token='lease-2',
                lease_expires_at=clock_timestamp() + interval '1 minute',
                reserved_at=clock_timestamp()
          WHERE command_id='spoken-1' AND lease_expires_at <= clock_timestamp()
        RETURNING command_id`,
      );
      expect(reclaimed.rows).toEqual([{ command_id: "spoken-1" }]);
      const staleFinalizer = await admin.query(
        `UPDATE study_spoken_answer_commands
            SET state='retryable_failed', provider_failure_kind='timeout',
                completed_at=clock_timestamp()
          WHERE command_id='spoken-1' AND lease_token='lease-1'
            AND lease_expires_at > clock_timestamp()
        RETURNING command_id`,
      );
      expect(staleFinalizer.rows).toEqual([]);
      const pendingArtifact = await admin.query(
        `SELECT expected_object_ref, recording_state
           FROM learner_audio_artifacts
          WHERE learner_audio_artifact_id='audio-command-1'`,
      );
      expect(pendingArtifact.rows).toEqual([
        {
          expected_object_ref: "learner-audio/study/spoken-attempt-1/audio",
          recording_state: "pending",
        },
      ]);
      await expect(
        admin.query(
          `INSERT INTO study_sessions_v2 (
             session_id, account_id, persona_id, community_id, post_id,
             audio_revision, lyrics_revision, learning_language, target_language,
             learner_band, study_profile_revision, source_set_revision,
             selection_policy_revision, qualification_policy_revision, timezone,
             idempotency_key, request_hash
           ) VALUES ('session-2', 'account-1', 'persona-1', 'community-1', 'post-1',
             1, 1, 'en', NULL, NULL, 1, 1, 'selection-v1', 'qualification-v1', 'UTC',
             'session-command-1', $1)`,
          ["f".repeat(64)],
        ),
      ).rejects.toThrow();
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });
});
