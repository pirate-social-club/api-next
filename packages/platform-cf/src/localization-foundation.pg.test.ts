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
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });
});
