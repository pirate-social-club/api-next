import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneLearnerAudioDeletionStore } from "./learner-audio-deletion-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

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

suite("learner audio deletion repository", () => {
  test("deletes bytes first, tombstones both producers, and is account scoped", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_audio_delete_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    const scopedConnection = connectionForSchema(connectionString, schema);

    try {
      await applyPostgresTestBaselineConnection({ connectionString: scopedConnection });
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          "INSERT INTO users (user_id) VALUES ('account-1'), ('account-2'), ('account-3'), ('account-4'), ('account-5')",
        );
        await admin.query(
          `INSERT INTO learner_audio_artifacts (
             learner_audio_artifact_id, account_id, source_kind, attempt_ref,
             expected_object_ref, object_ref, content_digest, content_type,
             byte_size, duration_ms, platform_retention, provider_retention,
             recording_state, expires_at
           ) VALUES
             ('study-artifact', 'account-1', 'study', 'study-attempt',
              'study/object', 'study/object', $1, 'audio/ogg', 100, 1000,
              'private_learning', 'not_stored', 'stored', clock_timestamp() + interval '24 months'),
             ('karaoke-artifact', 'account-1', 'karaoke', 'karaoke-attempt',
              'karaoke/object', 'karaoke/object', $2, 'audio/L16;rate=16000;channels=1',
              1000, 2000, 'private_learning', 'not_stored', 'stored',
              clock_timestamp() + interval '24 months'),
             ('other-artifact', 'account-2', 'study', 'other-attempt',
              'other/object', 'other/object', $3, 'audio/ogg', 100, 1000,
              'private_learning', 'not_stored', 'stored', clock_timestamp() + interval '24 months')`,
          ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
        );
        await admin.query(
          `INSERT INTO karaoke_recordings (
             session_id, attempt_id, account_id, artifact_id, state, object_ref,
             content_sha256, byte_size, duration_ms, reconciled_at
           ) VALUES ('karaoke-session', 'karaoke-attempt', 'account-1',
             'karaoke-artifact', 'stored', 'karaoke/object', $1, 1000, 2000,
             clock_timestamp())`,
          ["b".repeat(64)],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      let failStorage = true;
      const deletedKeys: string[][] = [];
      const store = makeControlPlaneLearnerAudioDeletionStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
        {
          delete: async (keys) => {
            deletedKeys.push(typeof keys === "string" ? [keys] : [...keys]);
            if (failStorage) throw new Error("fixture storage unavailable");
          },
        },
      );
      const run = (accountId: string, deletedAt: string) =>
        Effect.runPromise(store.deleteBatch({ accountId, deletedAt }));

      await expect(run("account-1", "2026-08-29T09:00:00.000Z")).rejects.toMatchObject({
        reason: "storage-unavailable",
      });
      expect(
        (
          await admin.query(
            `SELECT recording_state, object_ref FROM learner_audio_artifacts
              WHERE account_id='account-1' ORDER BY learner_audio_artifact_id`,
          )
        ).rows,
      ).toEqual([
        { recording_state: "stored", object_ref: "karaoke/object" },
        { recording_state: "stored", object_ref: "study/object" },
      ]);

      failStorage = false;
      const deleted = await run("account-1", "2026-08-29T09:01:00.000Z");
      expect(deleted).toMatchObject({ deleted_count: 2, remaining_count: 0 });
      expect(deletedKeys.at(-1)?.sort()).toEqual(["karaoke/object", "study/object"]);
      expect(
        (
          await admin.query(
            `SELECT learner_audio_artifact_id, recording_state, object_ref,
                    content_digest, deleted_at IS NOT NULL AS has_deleted_at
               FROM learner_audio_artifacts WHERE account_id='account-1'
               ORDER BY learner_audio_artifact_id`,
          )
        ).rows,
      ).toEqual([
        {
          learner_audio_artifact_id: "karaoke-artifact",
          recording_state: "deleted",
          object_ref: null,
          content_digest: "b".repeat(64),
          has_deleted_at: true,
        },
        {
          learner_audio_artifact_id: "study-artifact",
          recording_state: "deleted",
          object_ref: null,
          content_digest: "a".repeat(64),
          has_deleted_at: true,
        },
      ]);
      expect((await admin.query("SELECT state, object_ref FROM karaoke_recordings")).rows).toEqual([
        { state: "deleted", object_ref: null },
      ]);
      expect(
        (
          await admin.query(
            "SELECT recording_state, object_ref FROM learner_audio_artifacts WHERE account_id='account-2'",
          )
        ).rows,
      ).toEqual([{ recording_state: "stored", object_ref: "other/object" }]);

      const replay = await run("account-1", "2026-08-29T09:02:00.000Z");
      expect(replay).toMatchObject({
        deleted_count: 0,
        remaining_count: 0,
        last_deleted_at: "2026-08-29T09:01:00.000Z",
      });
      expect(deletedKeys).toHaveLength(2);

      await admin.query(
        `INSERT INTO learner_audio_artifacts (
           learner_audio_artifact_id, account_id, source_kind, attempt_ref,
           expected_object_ref, object_ref, content_digest, content_type,
           byte_size, duration_ms, platform_retention, provider_retention,
           recording_state, expires_at
         ) SELECT 'bulk-' || lpad(value::text, 4, '0'), 'account-5', 'study',
             'bulk-attempt-' || value, 'bulk/object/' || value, 'bulk/object/' || value,
             repeat('9', 64), 'audio/ogg', 100, 1000, 'private_learning', 'not_stored',
             'stored', clock_timestamp() + interval '24 months'
           FROM generate_series(1, 1001) AS value`,
      );
      const firstBatch = await run("account-5", "2026-08-29T09:03:00.000Z");
      expect(firstBatch).toMatchObject({ deleted_count: 1000, remaining_count: 1 });
      expect(deletedKeys.at(-1)).toHaveLength(1000);
      const secondBatch = await run("account-5", "2026-08-29T09:04:00.000Z");
      expect(secondBatch).toMatchObject({ deleted_count: 1, remaining_count: 0 });
      expect(deletedKeys.at(-1)).toHaveLength(1);
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });

  test("blocks live producers but ignores an expired Study lease", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_audio_lock_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    const scopedConnection = connectionForSchema(connectionString, schema);

    try {
      await applyPostgresTestBaselineConnection({ connectionString: scopedConnection });
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query("INSERT INTO users (user_id) VALUES ('account-3'), ('account-4')");
        await admin.query(
          `INSERT INTO learner_audio_artifacts (
             learner_audio_artifact_id, account_id, source_kind, attempt_ref,
             expected_object_ref, content_digest, content_type, byte_size, duration_ms,
             platform_retention, provider_retention, recording_state, expires_at
           ) VALUES ('pending-study', 'account-3', 'study', 'attempt-3', 'pending/object',
             $1, 'audio/ogg', 100, 1000, 'private_learning', 'not_stored', 'pending',
             clock_timestamp() + interval '24 months')`,
          ["d".repeat(64)],
        );
        await admin.query(
          `INSERT INTO study_spoken_answer_commands (
             command_id, account_id, session_id, session_item_id, attempt_number,
             idempotency_key, request_hash, audio_digest, audio_content_type,
             audio_byte_size, audio_duration_ms, attempt_id,
             learner_audio_artifact_id, lease_token, reserved_at, lease_expires_at, state
           ) VALUES ('command-3', 'account-3', 'session-3', 'item-3', 1, 'idem-3',
             $1, $2, 'audio/ogg', 100, 1000, 'attempt-3', 'pending-study', 'lease-3',
             clock_timestamp() - interval '1 second',
             clock_timestamp() + interval '1 hour', 'reserved')`,
          ["e".repeat(64), "d".repeat(64)],
        );
        await admin.query(
          `INSERT INTO karaoke_sessions (
             session_id, attempt_id, account_id, persona_id, community_id, post_id,
             audio_revision, karaoke_revision_id, qualification_policy_version_id,
             idempotency_key, request_hash, timezone, status, expires_at,
             lyrics_revision, line_snapshot
           ) VALUES ('session-4', 'attempt-4', 'account-4', 'persona-4', 'community-4',
             'post-4', 1, 'revision-4', 'policy-4', 'idem-4', $1, 'UTC', 'active',
             clock_timestamp() + interval '1 hour', 1, '[{}]'::jsonb)`,
          ["f".repeat(64)],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const store = makeControlPlaneLearnerAudioDeletionStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
        { delete: async () => {} },
      );
      const run = (accountId: string) =>
        Effect.runPromise(store.deleteBatch({ accountId, deletedAt: "2026-08-29T10:00:00.000Z" }));
      await expect(run("account-3")).rejects.toMatchObject({ reason: "in-flight" });
      await expect(run("account-4")).rejects.toMatchObject({ reason: "in-flight" });

      await admin.query("SET session_replication_role = replica");
      await admin.query(
        "UPDATE study_spoken_answer_commands SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE command_id='command-3'",
      );
      await admin.query("SET session_replication_role = origin");
      await expect(run("account-3")).resolves.toMatchObject({
        deleted_count: 0,
        remaining_count: 0,
      });

      const locker = new Client({ connectionString: scopedConnection });
      await locker.connect();
      await locker.query("BEGIN");
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [
        "account-3",
        83_000_001,
      ]);
      let settled = false;
      const blocked = run("account-3").finally(() => {
        settled = true;
      });
      await Bun.sleep(50);
      expect(settled).toBe(false);
      await locker.query("COMMIT");
      await locker.end();
      await expect(blocked).resolves.toMatchObject({ deleted_count: 0 });
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });
});
