import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import {
  beginHistoricalAudioDeletionFixture,
  beginOwnedHistoricalApiNextWriter,
  closeOwnedHistoricalApiNextWriter,
  finishHistoricalAudioDeletionFixture,
} from "./learner-audio-deletion-history.pg-fixture.ts";
import { makeControlPlaneLearnerAudioDeletionStore } from "./learner-audio-deletion-repository.ts";
import { runCapturedStudyDeletionExpiryRegression } from "./learner-audio-deletion-captured-expiry.pg-fixture.ts";
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

    let originalWriter: ReturnType<typeof beginOwnedHistoricalApiNextWriter> | undefined;
    let primaryFailure: unknown;
    let failed = false;
    try {
      // Historical stored metadata is present BEFORE the real253 namespace backfill.
      // Account identities and immutable owners are born normally in the exact252 prefix.
      const history = await beginHistoricalAudioDeletionFixture(scopedConnection);
      const retainedObjectRefs = new Set<string>(["study/object", "karaoke/object", "other/object"]);
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
      await admin.query("SET session_replication_role = replica");
      try {
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
      for (let value = 1; value <= 1001; value++) retainedObjectRefs.add(`bulk/object/${value}`);
      originalWriter = beginOwnedHistoricalApiNextWriter(retainedObjectRefs);
      await finishHistoricalAudioDeletionFixture(scopedConnection, history);
      expect(
        (await admin.query("SELECT io_state FROM learner_audio_upload_attempts WHERE source_kind='karaoke' AND attempt_ref='karaoke-attempt'" )).rows,
      ).toEqual([{ io_state: "unknown" }]);
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM learner_audio_account_producer_captures")).rows,
      ).toEqual([{ n: 0 }]);

      let failStorage = true;
      const deletedKeys: string[][] = [];
      const store = makeControlPlaneLearnerAudioDeletionStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
        {
          delete: async (keys) => {
            deletedKeys.push(typeof keys === "string" ? [keys] : [...keys]);
            if (failStorage) throw new Error("fixture storage unavailable");
            for (const key of typeof keys === "string" ? [keys] : keys)
              retainedObjectRefs.delete(key);
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

      const retainedDeletion = await admin.query(
        `SELECT command.command_id,fence.revision::text AS revision,upload.upload_attempt_id
           FROM learner_audio_owner_fences fence
           JOIN participation_owners owner USING(owner_id)
           JOIN learner_audio_delete_commands command ON command.command_id=fence.active_delete_command_id
           JOIN learner_audio_upload_attempts upload ON upload.owner_id=owner.owner_id
           WHERE owner.account_id='account-1' AND upload.source_kind='karaoke'
             AND upload.attempt_ref='karaoke-attempt' AND upload.artifact_id='karaoke-artifact'`,
      );
      expect(retainedDeletion.rows).toHaveLength(1);
      const originalDeletion = Schema.decodeUnknownSync(Schema.Struct({
        command_id: Schema.NonEmptyString,
        revision: Schema.NonEmptyString,
        upload_attempt_id: Schema.NonEmptyString,
      }), { onExcessProperty: "error" })(retainedDeletion.rows[0]);
      failStorage = false;
      // Known bytes can make bounded progress while the SAME unknown writer
      // keeps its artifact, original command and active source fence held.
      const partial = await run("account-1", "2026-08-29T09:00:30.000Z");
      expect(partial).toMatchObject({ deleted_count: 1, remaining_count: 1 });
      expect(deletedKeys.at(-1)?.sort()).toEqual([
        "karaoke/account-1/karaoke-attempt.pcm", "karaoke/object", "study/object",
      ]);
      expect((await admin.query(
        `SELECT command.command_id,fence.revision::text AS revision,upload.upload_attempt_id,
                command.state,upload.io_state,upload.captured_revision::text AS captured_revision
           FROM learner_audio_owner_fences fence
           JOIN participation_owners owner USING(owner_id)
           JOIN learner_audio_delete_commands command ON command.command_id=fence.active_delete_command_id
           JOIN learner_audio_upload_attempts upload ON upload.owner_id=owner.owner_id
           WHERE owner.account_id='account-1' AND upload.source_kind='karaoke'
             AND upload.attempt_ref='karaoke-attempt' AND upload.artifact_id='karaoke-artifact'`,
      )).rows).toEqual([{ ...originalDeletion, state: "pending", io_state: "unknown", captured_revision: "0" }]);
      // Native uncertain disposition cannot authorize original publication.
      expect((await admin.query(
        "SELECT settle_learner_audio_upload_private_v1($1,'stored',FALSE,NULL) AS publish",
        [originalDeletion.upload_attempt_id],
      )).rows).toEqual([{ publish: false }]);
      expect(
        (await admin.query("SELECT io_state FROM learner_audio_upload_attempts WHERE source_kind='karaoke' AND attempt_ref='karaoke-attempt'")).rows,
      ).toEqual([{ io_state: "unknown" }]);
      expect(
        (await admin.query("SELECT recording_state,object_ref FROM learner_audio_artifacts WHERE learner_audio_artifact_id='karaoke-artifact'")).rows,
      ).toEqual([{ recording_state: "stored", object_ref: "karaoke/object" }]);
      // Native-core model only: an owned finite pre253 api-next writer actually
      // finishes on its original key; ALL work is drained before the terminal fact.
      if (originalWriter === undefined) throw new Error("Original historical writer was not owned");
      await closeOwnedHistoricalApiNextWriter(admin, originalWriter);
      const deleted = await run("account-1", "2026-08-29T09:01:00.000Z");
      expect(deleted).toMatchObject({ deleted_count: 1, remaining_count: 0 });
      // The prior known DELETE already covered the other two original names;
      // only the SAME original writer's re-created canonical key needs deletion.
      expect(deletedKeys.at(-1)).toEqual(["karaoke/account-1/karaoke-attempt.pcm"]);
      expect(retainedObjectRefs.has("karaoke/account-1/karaoke-attempt.pcm")).toBe(false);
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
      // Failed storage, known partial progress, then positively closed original deletion.
      expect(deletedKeys).toHaveLength(3);

      const firstBatch = await run("account-5", "2026-08-29T09:03:00.000Z");
      expect(firstBatch).toMatchObject({ deleted_count: 1000, remaining_count: 1 });
      expect(deletedKeys.at(-1)).toHaveLength(1000);
      const secondBatch = await run("account-5", "2026-08-29T09:04:00.000Z");
      expect(secondBatch).toMatchObject({ deleted_count: 1, remaining_count: 0 });
      expect(deletedKeys.at(-1)).toHaveLength(1);
    } catch (error) {
      failed = true;
      primaryFailure = error;
    }
    const cleanupFailures: unknown[] = [];
    // EVERY outcome drains the SAME original writer before schema teardown.
    try {
      if (originalWriter !== undefined) await originalWriter.releaseAndDrain();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await admin.end();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (failed && cleanupFailures.length > 0)
      throw new AggregateError([primaryFailure, ...cleanupFailures], "Historical audio fixture and cleanup failed");
    if (failed) throw primaryFailure;
    if (cleanupFailures.length > 0)
      throw new AggregateError(cleanupFailures, "Historical audio fixture cleanup failed");
  }, 60_000);

  test("holds unresolved Account writers after expiry and deletes only positive no-I/O generations", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    await runCapturedStudyDeletionExpiryRegression();
  }, 15_000);

});
