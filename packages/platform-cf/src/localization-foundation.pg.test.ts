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

suite("localization Postgres foundation", () => {
  test("keeps source and accepted versions immutable and selections identity-bound", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_localization_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);

    try {
      await runPostgresMigrations({
        connectionString: connectionForSchema(connectionString, schema),
      });
      const sourceHash = "a".repeat(64);
      await admin.query(
        `INSERT INTO localization_source_units (
           source_unit_kind, source_unit_id, field_key, source_revision,
           source_language, source_language_policy_version, source_hash,
           hash_policy_version, canonical_value
         ) VALUES ('post', 'post_1', 'body', 1, 'en',
           'language-detection-v1', $1, 'source-hash-v1', 'Canonical source')`,
        [sourceHash],
      );
      await admin.query(
        `INSERT INTO localization_translation_versions (
           translation_version_id, source_unit_kind, source_unit_id, field_key,
           source_revision, source_hash, target_language, translation_policy_version,
           version_number, translated_value, translation_origin, provider_id, model_id,
           prompt_revision, generation_run_id, quality_policy_revision, moderation_result
         ) VALUES ('translation_1', 'post', 'post_1', 'body', 1, $1, 'es',
           'translation-policy-v1', 1, 'Fuente canónica', 'machine', 'provider-test',
           'model-test', 'content-translation-prompt-v1', 'run_1', 'quality-v1', 'allow')`,
        [sourceHash],
      );
      await expect(
        admin.query(
          `INSERT INTO localization_translation_versions (
             translation_version_id, source_unit_kind, source_unit_id, field_key,
             source_revision, source_hash, target_language, translation_policy_version,
             version_number, translated_value, translation_origin, generation_run_id,
             quality_policy_revision, moderation_result
           ) VALUES ('translation_human_invalid', 'post', 'post_1', 'body', 1, $1, 'fr',
             'translation-policy-v1', 1, 'Source canonique', 'human', 'machine-run',
             'quality-v1', 'allow')`,
          [sourceHash],
        ),
      ).rejects.toThrow();
      await admin.query(
        `INSERT INTO localization_translation_selections (
           source_unit_kind, source_unit_id, field_key, source_revision, source_hash,
           target_language, translation_policy_version, selected_translation_version_id,
           selected_by
         ) VALUES ('post', 'post_1', 'body', 1, $1, 'es',
           'translation-policy-v1', 'translation_1', 'quality-review-v1')`,
        [sourceHash],
      );

      await expect(
        admin.query(
          `INSERT INTO localization_translation_selections (
             source_unit_kind, source_unit_id, field_key, source_revision, source_hash,
             target_language, translation_policy_version, selected_translation_version_id,
             selected_by
           ) VALUES ('post', 'post_1', 'body', 1, $1, 'fr',
             'translation-policy-v1', 'translation_1', 'quality-review-v1')`,
          [sourceHash],
        ),
      ).rejects.toThrow();
      await expect(
        admin.query(
          "UPDATE localization_source_units SET canonical_value = 'mutated' WHERE source_unit_id = 'post_1'",
        ),
      ).rejects.toThrow("localization_source_units rows are immutable");

      await admin.query(
        `INSERT INTO localization_translation_jobs (
           translation_job_id, source_unit_kind, source_unit_id, field_key,
           source_revision, source_hash, target_language, translation_policy_version,
           prompt_revision, attempt_number, status, deadline_at, retryable, failure_reason
         ) VALUES ('job_1', 'post', 'post_1', 'body', 1, $1, 'es',
           'translation-policy-v1', 'content-translation-prompt-v1', 1, 'stale',
           clock_timestamp() + interval '1 minute', FALSE, 'source_identity_changed')`,
        [sourceHash],
      );
      const evidence = await admin.query<{
        selected_translation_version_id: string;
        stale_jobs: string;
        shard_table: string | null;
      }>(
        `SELECT selection.selected_translation_version_id,
           (SELECT count(*)::text FROM localization_translation_jobs WHERE status = 'stale') AS stale_jobs,
           to_regclass('content_translations')::text AS shard_table
         FROM localization_translation_selections AS selection`,
      );
      expect(evidence.rows).toEqual([
        {
          selected_translation_version_id: "translation_1",
          stale_jobs: "1",
          shard_table: null,
        },
      ]);

      await admin.query("INSERT INTO users (user_id) VALUES ('lyrics_author')");
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id, created_at, updated_at
         ) VALUES ('lyrics_community', 'Lyrics', 'active', 'lyrics_author',
           clock_timestamp(), clock_timestamp())`,
      );
      await admin.query(
        `INSERT INTO posts (
           community_id, post_id, author_user_id, post_type, status, visibility,
           created_at, updated_at
         ) VALUES ('lyrics_community', 'song_post', NULL, 'song', 'published',
           'public', clock_timestamp(), clock_timestamp())`,
      );
      await admin.query(
        `INSERT INTO localization_lyric_line_occurrences (
           community_id, post_id, lyric_line_id
         ) VALUES
           ('lyrics_community', 'song_post', 'line_a'),
           ('lyrics_community', 'song_post', 'line_b'),
           ('lyrics_community', 'song_post', 'line_split_1'),
           ('lyrics_community', 'song_post', 'line_split_2')`,
      );
      const repeatedHash = "b".repeat(64);
      await admin.query(
        `INSERT INTO localization_lyric_line_versions (
           community_id, post_id, lyric_line_id, line_version,
           canonical_text, source_language, source_hash
         ) VALUES
           ('lyrics_community', 'song_post', 'line_a', 1, 'Repeated chorus', 'en', $1),
           ('lyrics_community', 'song_post', 'line_a', 2, 'Corrected chorus', 'en', $2),
           ('lyrics_community', 'song_post', 'line_b', 1, 'Repeated chorus', 'en', $1),
           ('lyrics_community', 'song_post', 'line_split_1', 1, 'Repeated', 'en', $3),
           ('lyrics_community', 'song_post', 'line_split_2', 1, 'chorus', 'en', $4)`,
        [repeatedHash, "c".repeat(64), "d".repeat(64), "e".repeat(64)],
      );
      await admin.query(
        `UPDATE localization_lyric_line_occurrences
           SET lifecycle_status = 'retired', retirement_reason = 'split',
               retired_at = clock_timestamp()
         WHERE community_id = 'lyrics_community' AND post_id = 'song_post'
           AND lyric_line_id = 'line_a'`,
      );
      await admin.query(
        `INSERT INTO localization_lyric_line_lineage (
           community_id, post_id, transition_kind, predecessor_line_id, successor_line_id
         ) VALUES
           ('lyrics_community', 'song_post', 'split', 'line_a', 'line_split_1'),
           ('lyrics_community', 'song_post', 'split', 'line_a', 'line_split_2')`,
      );
      await admin.query(
        `INSERT INTO localization_lyric_reconciliation_decisions (
           reconciliation_id, community_id, post_id, from_lyrics_revision,
           to_lyrics_revision, prior_ordinal, candidate_ordinal, outcome,
           lyric_line_id, reason
         ) VALUES ('reconcile_uncertain', 'lyrics_community', 'song_post', 1, 2,
           1, 1, 'uncertain', NULL, 'multiple plausible repeated occurrences')`,
      );
      await expect(
        admin.query(
          `INSERT INTO localization_lyric_reconciliation_decisions (
             reconciliation_id, community_id, post_id, from_lyrics_revision,
             to_lyrics_revision, prior_ordinal, candidate_ordinal, outcome,
             lyric_line_id, reason
           ) VALUES ('reconcile_guess', 'lyrics_community', 'song_post', 1, 2,
             1, 1, 'uncertain', 'line_b', 'forbidden guess')`,
        ),
      ).rejects.toThrow();
      await expect(
        admin.query(
          `UPDATE localization_lyric_line_occurrences
             SET retirement_reason = 'replaced'
           WHERE community_id = 'lyrics_community' AND post_id = 'song_post'
             AND lyric_line_id = 'line_a'`,
        ),
      ).rejects.toThrow("lyric line lifecycle permits only one active-to-retired transition");

      const lyricEvidence = await admin.query<{
        repeated_occurrences: string;
        line_a_versions: string;
        split_successors: string;
        uncertain_without_identity: boolean;
      }>(
        `SELECT
           (SELECT count(*)::text FROM localization_lyric_line_versions
             WHERE canonical_text = 'Repeated chorus') AS repeated_occurrences,
           (SELECT count(*)::text FROM localization_lyric_line_versions
             WHERE lyric_line_id = 'line_a') AS line_a_versions,
           (SELECT count(*)::text FROM localization_lyric_line_lineage
             WHERE predecessor_line_id = 'line_a') AS split_successors,
           (SELECT lyric_line_id IS NULL FROM localization_lyric_reconciliation_decisions
             WHERE reconciliation_id = 'reconcile_uncertain') AS uncertain_without_identity`,
      );
      expect(lyricEvidence.rows).toEqual([
        {
          repeated_occurrences: "2",
          line_a_versions: "2",
          split_successors: "2",
          uncertain_without_identity: true,
        },
      ]);
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });
});
