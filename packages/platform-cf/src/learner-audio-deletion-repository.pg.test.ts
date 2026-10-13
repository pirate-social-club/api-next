import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
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

// Staging's ledger ends at 0247. Seed account audio in the shapes that ledger
// produced, then let every learning successor import it as an upgrade would.
const LEGACY_LEDGER = 247;
const migrateLegacy = async (scoped: string) => {
  const all = await loadPostgresMigrations();
  await runPostgresMigrations({
    connectionString: scoped,
    migrations: all.slice(0, LEGACY_LEDGER),
  });
};
const upgrade = async (scoped: string) => {
  const all = await loadPostgresMigrations();
  await runPostgresMigrations({
    connectionString: scoped,
    migrations: all,
    expectedLedger: all.slice(0, LEGACY_LEDGER),
  });
};
const legacyUpload = (session: string, attempt: string, artifact: string) =>
  `lau_legacy_${new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([session, attempt, artifact]).replaceAll(",", ", "))
    .digest("hex")}`;

// Main's legacy Study writer PUT the answer to this exact digest-named key.
const studyDigest = "d".repeat(64);
const studyKey = (n: string) => `learner-audio/study/attempt-${n}/${studyDigest}`;
const receipt = (label: string) => new Bun.CryptoHasher("sha256").update(label).digest("hex");

const karaokeSession = (
  admin: Client,
  input: Readonly<{ session: string; attempt: string; account: string; completed: boolean }>,
) =>
  admin.query(
    `INSERT INTO karaoke_sessions (
       session_id, attempt_id, account_id, persona_id, community_id, post_id,
       audio_revision, karaoke_revision_id, qualification_policy_version_id,
       idempotency_key, request_hash, timezone, status, expires_at, completed_at,
       lyrics_revision, line_snapshot
     ) VALUES ($1, $2, $3, 'persona-' || $3, 'community-1', 'post-1', 1, 'revision-1',
       'policy-1', 'idem-' || $1, $4, 'UTC', $5, clock_timestamp() + interval '1 hour',
       CASE WHEN $5 = 'completed' THEN clock_timestamp() END, 1, '[{}]'::jsonb)`,
    [
      input.session,
      input.attempt,
      input.account,
      "f".repeat(64),
      input.completed ? "completed" : "active",
    ],
  );

suite("learner audio deletion repository", () => {
  test("upgrades stored Study and Karaoke audio and deletes exact objects batch by batch", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_audio_delete_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    const scopedConnection = connectionForSchema(connectionString, schema);
    const karaokeKey = "karaoke/account-1/karaoke-attempt.pcm";

    try {
      await migrateLegacy(scopedConnection);
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          "INSERT INTO users (user_id) VALUES ('account-1'), ('account-2'), ('account-5')",
        );
        // The legacy attempt host completed its single multipart upload, read the
        // object back and recorded its digest; the common artifact agrees.
        await karaokeSession(admin, {
          session: "karaoke-session",
          attempt: "karaoke-attempt",
          account: "account-1",
          completed: true,
        });
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
              $4, $4, $2, 'audio/L16;rate=16000;channels=1',
              1000, 2000, 'private_learning', 'not_stored', 'stored',
              clock_timestamp() + interval '24 months'),
             ('other-artifact', 'account-2', 'study', 'other-attempt',
              'other/object', 'other/object', $3, 'audio/ogg', 100, 1000,
              'private_learning', 'not_stored', 'stored', clock_timestamp() + interval '24 months')`,
          ["a".repeat(64), "b".repeat(64), "c".repeat(64), karaokeKey],
        );
        await admin.query(
          `INSERT INTO karaoke_recordings (
             session_id, attempt_id, account_id, artifact_id, state, object_ref,
             content_sha256, byte_size, duration_ms, reconciled_at
           ) VALUES ('karaoke-session', 'karaoke-attempt', 'account-1',
             'karaoke-artifact', 'stored', $2, $1, 1000, 2000, clock_timestamp())`,
          ["b".repeat(64), karaokeKey],
        );
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
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await upgrade(scopedConnection);
      expect(
        (
          await admin.query(
            "SELECT io_state, storage_disposition FROM learner_audio_upload_attempts WHERE upload_attempt_id=$1",
            [legacyUpload("karaoke-session", "karaoke-attempt", "karaoke-artifact")],
          )
        ).rows,
      ).toEqual([{ io_state: "closed", storage_disposition: "stored" }]);

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
        { recording_state: "stored", object_ref: karaokeKey },
        { recording_state: "stored", object_ref: "study/object" },
      ]);

      failStorage = false;
      const deleted = await run("account-1", "2026-08-29T09:01:00.000Z");
      expect(deleted).toMatchObject({ deleted_count: 2, remaining_count: 0 });
      // The retry deletes the same exact keys the failed attempt prepared.
      expect(deletedKeys.map((keys) => [...keys].sort())).toEqual([
        [karaokeKey, "study/object"],
        [karaokeKey, "study/object"],
      ]);
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
      expect(replay).toMatchObject({ deleted_count: 0, remaining_count: 0 });
      expect(deletedKeys.slice(2).flat()).toEqual([]);

      const before = deletedKeys.length;
      const firstBatch = await run("account-5", "2026-08-29T09:03:00.000Z");
      expect(firstBatch).toMatchObject({ deleted_count: 1000, remaining_count: 1 });
      expect(deletedKeys.at(-1)).toHaveLength(1000);
      const secondBatch = await run("account-5", "2026-08-29T09:04:00.000Z");
      expect(secondBatch).toMatchObject({ deleted_count: 1, remaining_count: 0 });
      expect(deletedKeys.at(-1)).toHaveLength(1);
      expect(new Set(deletedKeys.slice(before).flat()).size).toBe(1001);
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });

  test("keeps unresolved producers in flight past lease expiry until authoritative settlement", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_audio_lock_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    const scopedConnection = connectionForSchema(connectionString, schema);
    let hostileRole: string | undefined;

    try {
      await migrateLegacy(scopedConnection);
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          "INSERT INTO users (user_id) VALUES ('account-3'), ('account-4'), ('account-6'), ('account-7')",
        );
        // Legacy Study answers reserved their audio but never resolved it. Account 7
        // holds only this producer: no capture, Karaoke history or deletion.
        for (const n of ["3", "7"]) {
          const account = `account-${n}`;
          await admin.query(
            `INSERT INTO study_review_items (
               review_item_id, account_id, exercise_review_key, current_exercise_version_id,
               scheduler_policy_revision, scheduler_state, community_id, post_id,
               study_unit_id, exercise_kind, learning_language, target_language, learner_band
             ) VALUES ($1, $2, $3, 'exercise-' || $4,
               'study_review_schedule_v1', '{}'::jsonb, 'community-1', 'post-1',
               'unit-1', 'say_it_back', 'en', NULL, NULL)`,
            [`review-${n}`, account, `review-key-${n}`, n],
          );
          await admin.query(
            `INSERT INTO study_sessions_v2 (
               session_id, account_id, persona_id, community_id, post_id,
               audio_revision, lyrics_revision, learning_language, target_language,
               learner_band, study_profile_revision, source_set_revision,
               selection_policy_revision, qualification_policy_revision, timezone,
               idempotency_key, request_hash, status, completed_at, completion_reason
             ) VALUES ($1, $2, 'persona-' || $3, 'community-1', 'post-1',
               1, 1, 'en', NULL, NULL, 1, 1, 'selection-v1', 'qualification-v1', 'UTC',
               'session-command-' || $3, $4, 'completed', clock_timestamp(), 'all_resolved')`,
            [`session-${n}`, account, n, "d".repeat(64)],
          );
          await admin.query(
            `INSERT INTO study_session_items_v2 (
               session_item_id, session_id, ordinal, exercise_review_key,
               exercise_version_id, review_item_id, item_snapshot, maximum_attempts, account_id
             ) VALUES ($1, $2, 0, $3, 'exercise-' || $5, $4, '{}'::jsonb, 3, $6)`,
            [`item-${n}`, `session-${n}`, `review-key-${n}`, `review-${n}`, n, account],
          );
          await admin.query(
            `INSERT INTO learner_audio_artifacts (
               learner_audio_artifact_id, account_id, source_kind, attempt_ref,
               expected_object_ref, content_digest, content_type, byte_size, duration_ms,
               platform_retention, provider_retention, recording_state, expires_at
             ) VALUES ($1, $2, 'study', $3, $4, $5, 'audio/ogg', 100, 1000,
               'private_learning', 'not_stored', 'pending', clock_timestamp() + interval '24 months')`,
            [`study-artifact-${n}`, account, `attempt-${n}`, studyKey(n), studyDigest],
          );
          await admin.query(
            `INSERT INTO study_spoken_answer_commands (
               command_id, account_id, session_id, session_item_id, attempt_number,
               idempotency_key, request_hash, audio_digest, audio_content_type,
               audio_byte_size, audio_duration_ms, attempt_id,
               learner_audio_artifact_id, lease_token, reserved_at, lease_expires_at, state
             ) VALUES ($1, $2, $3, $4, 1, 'idem-' || $8,
               $5, $6, 'audio/ogg', 100, 1000, $7, $9, 'lease-' || $8,
               clock_timestamp() - interval '1 second',
               clock_timestamp() + interval '1 hour', 'reserved')`,
            [
              `command-${n}`,
              account,
              `session-${n}`,
              `item-${n}`,
              "e".repeat(64),
              studyDigest,
              `attempt-${n}`,
              n,
              `study-artifact-${n}`,
            ],
          );
        }
        // Legacy Karaoke attempts whose hosts never reported a terminal result.
        for (const [account, session, attempt] of [
          ["account-4", "session-4", "attempt-4"],
          ["account-6", "session-6", "attempt-6"],
        ] as const) {
          await karaokeSession(admin, { session, attempt, account, completed: false });
          await admin.query(
            `INSERT INTO karaoke_recordings (session_id, attempt_id, account_id, artifact_id)
             VALUES ($1, $2, $3, 'artifact-' || $2)`,
            [session, attempt, account],
          );
        }
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      // Creation-time default privileges must not reach the private evidence.
      const hostile = `hostile_${schema}`.slice(0, 63);
      await admin.query(`CREATE ROLE ${quoteIdentifier(hostile)} NOLOGIN`);
      await admin.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdentifier(schema)} GRANT ALL ON TABLES TO ${quoteIdentifier(hostile)}`,
      );
      await admin.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdentifier(schema)} GRANT EXECUTE ON FUNCTIONS TO ${quoteIdentifier(hostile)}`,
      );
      hostileRole = hostile;
      await upgrade(scopedConnection);
      expect(
        (
          await admin.query(
            `SELECT has_table_privilege($1, 'learner_audio_legacy_settlements', 'SELECT') AS can_select,
                    has_table_privilege($1, 'learner_audio_legacy_settlements', 'INSERT') AS can_insert,
                    has_table_privilege($1, 'learner_audio_legacy_settlements', 'UPDATE') AS can_update,
                    has_table_privilege($1, 'learner_audio_legacy_settlements', 'DELETE') AS can_delete,
                    has_table_privilege($1, 'learner_audio_legacy_settlements', 'TRUNCATE') AS can_truncate,
                    has_function_privilege($1, 'settle_legacy_learner_audio_upload_private_v1(text,text,jsonb)', 'EXECUTE') AS can_settle,
                    has_function_privilege($1, 'guard_learner_audio_legacy_settlement_private_v1()', 'EXECUTE') AS can_guard`,
            [hostile],
          )
        ).rows,
      ).toEqual([
        {
          can_select: false,
          can_insert: false,
          can_update: false,
          can_delete: false,
          can_truncate: false,
          can_settle: false,
          can_guard: false,
        },
      ]);
      await expect(admin.query("TRUNCATE learner_audio_legacy_settlements")).rejects.toThrow(
        "legacy producer settlement evidence is immutable",
      );
      // The unresolved legacy Study reservation is now an unknown producer of its
      // exact key. Before any deletion starts, a reclaim still cannot open a new
      // generation on that key while the legacy write is unresolved.
      const study = await admin.query<{
        upload_attempt_id: string;
        object_ref: string;
        io_state: string;
      }>(
        "SELECT upload_attempt_id, object_ref, io_state FROM learner_audio_upload_attempts WHERE command_ref='command-3'",
      );
      expect(study.rows).toEqual([
        {
          upload_attempt_id: expect.stringMatching(/^lau_legacy_[0-9a-f]{64}$/),
          object_ref: studyKey("3"),
          io_state: "unknown",
        },
      ]);
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        "UPDATE study_spoken_answer_commands SET lease_token='lease-3-reclaim', lease_expires_at=clock_timestamp() + interval '1 hour' WHERE command_id='command-3'",
      );
      await admin.query("SET session_replication_role = origin");
      await expect(
        admin.query(
          "SELECT capture_account_study_audio_private_v1('account-3','command-3','lease-3-reclaim','upload-reclaim')",
        ),
      ).rejects.toThrow("prior object write or cleanup is unresolved");

      const deletedKeys: string[][] = [];
      const store = makeControlPlaneLearnerAudioDeletionStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
        {
          delete: async (keys) => {
            deletedKeys.push(typeof keys === "string" ? [keys] : [...keys]);
          },
        },
      );
      const run = (accountId: string) =>
        Effect.runPromise(store.deleteBatch({ accountId, deletedAt: "2026-08-29T10:00:00.000Z" }));
      // The reviewed operator closure records storage evidence observed after only
      // capture-era serving versions remain, bound to sanitized receipt digests.
      // These fixture values test the database's validation, not quiescence.
      const observation = (key: string, head: "present" | "absent", observedMinutesAgo = 1) => ({
        objectRef: key,
        headStatus: head,
        openMultipartUploads: 0,
        servingCutoverAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        observedAt: new Date(Date.now() - observedMinutesAgo * 60_000).toISOString(),
        servingVersions: [
          {
            script: "pirate-jobs-worker-staging",
            versionId: "fixture-capture-version",
            sourceCommit: "a".repeat(40),
            artifactSha256: receipt("artifact"),
          },
        ],
      });
      const evidence = (key: string, head: "present" | "absent", observedMinutesAgo = 1) => ({
        ...observation(key, head, observedMinutesAgo),
        abortedMultipartUploadIds: [],
        receipts: {
          servingReadback: receipt("readback"),
          head: receipt("head"),
          listing: receipt("listing"),
          abort: receipt("abort"),
        },
      });
      const studyEvidence = (key: string, contentSha256: string) => ({
        ...observation(key, "present"),
        contentSha256,
        receipts: {
          servingReadback: receipt("readback"),
          head: receipt("head"),
          listing: receipt("listing"),
        },
      });
      const settle = (
        client: Client,
        upload: string,
        disposition: "stored" | "absent",
        proof: Readonly<Record<string, unknown>>,
      ) =>
        client.query(
          "SELECT settle_legacy_learner_audio_upload_private_v1($1,$2,$3::jsonb) AS settled",
          [upload, disposition, JSON.stringify(proof)],
        );
      const expireProducers = async () => {
        await admin.query("SET session_replication_role = replica");
        await admin.query(
          "UPDATE study_spoken_answer_commands SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE command_id='command-3'",
        );
        await admin.query(
          "UPDATE karaoke_sessions SET expires_at=created_at + interval '1 millisecond' WHERE session_id IN ('session-4','session-6')",
        );
        await admin.query("SET session_replication_role = origin");
      };

      // A Study-only owner settles straight after the upgrade, before any capture
      // or deletion created state for it: the import established its fence.
      const upload7 = (
        await admin.query<{ upload_attempt_id: string }>(
          "SELECT upload_attempt_id FROM learner_audio_upload_attempts WHERE command_ref='command-7'",
        )
      ).rows[0]?.upload_attempt_id;
      if (upload7 === undefined) throw new Error("legacy Study producer was not imported");
      expect(
        (
          await admin.query(
            `SELECT f.revision, f.active_delete_command_id FROM learner_audio_owner_fences f
               JOIN participation_owners o USING(owner_id) WHERE o.account_id='account-7'`,
          )
        ).rows,
      ).toEqual([{ revision: "0", active_delete_command_id: null }]);
      await expect(
        settle(admin, upload7, "stored", studyEvidence(studyKey("7"), "c".repeat(64))),
      ).rejects.toThrow("legacy Study object differs from its reserved content");
      expect(
        (await settle(admin, upload7, "stored", studyEvidence(studyKey("7"), studyDigest))).rows,
      ).toEqual([{ settled: true }]);
      await expect(run("account-7")).resolves.toMatchObject({
        deleted_count: 1,
        remaining_count: 0,
      });

      await expect(run("account-3")).rejects.toMatchObject({ reason: "in-flight" });
      await expect(run("account-4")).rejects.toMatchObject({ reason: "in-flight" });
      await expect(run("account-6")).rejects.toMatchObject({ reason: "in-flight" });
      // Lease and session expiry are not facts about storage I/O.
      await expireProducers();
      await expect(run("account-3")).rejects.toMatchObject({ reason: "in-flight" });
      await expect(run("account-4")).rejects.toMatchObject({ reason: "in-flight" });
      await expect(run("account-6")).rejects.toMatchObject({ reason: "in-flight" });

      // An authoritative absent settlement lets deletion finish.
      const upload6 = legacyUpload("session-6", "attempt-6", "artifact-attempt-6");
      const key6 = "karaoke/account-6/attempt-6.pcm";
      await expect(
        settle(admin, upload6, "absent", evidence("karaoke/other.pcm", "absent")),
      ).rejects.toThrow("only an unknown imported legacy producer of this key can be settled");
      await expect(settle(admin, upload6, "stored", evidence(key6, "absent"))).rejects.toThrow(
        "legacy settlement disposition differs from the observed object",
      );
      await expect(settle(admin, upload6, "absent", evidence(key6, "absent", 20))).rejects.toThrow(
        "legacy producer must be observed after serving cutover",
      );
      const proof6 = evidence(key6, "absent");
      await settle(admin, upload6, "absent", proof6);
      expect((await settle(admin, upload6, "absent", proof6)).rows).toEqual([{ settled: false }]);
      await expect(
        settle(admin, upload6, "absent", {
          ...proof6,
          receipts: { ...proof6.receipts, head: receipt("another head") },
        }),
      ).rejects.toThrow("legacy settlement already recorded differently");
      await expect(run("account-6")).resolves.toMatchObject({ remaining_count: 0 });
      expect(
        (await admin.query("SELECT state FROM karaoke_recordings WHERE session_id='session-6'"))
          .rows,
      ).toEqual([{ state: "deleted" }]);

      // Late write: the legacy host publishes after deletion already removed the
      // key. Deletion serializes behind the writer, then removes the object again.
      const key4 = "karaoke/account-4/attempt-4.pcm";
      const deletesBefore = deletedKeys.filter((keys) => keys.includes(key4)).length;
      expect(deletesBefore).toBeGreaterThan(0);
      const writer = new Client({ connectionString: scopedConnection });
      await writer.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT lock_original_account_audio_source_private_v1('account-4')");
        let finished = false;
        const blocked = run("account-4").finally(() => {
          finished = true;
        });
        await Bun.sleep(100);
        expect(finished).toBe(false);
        await settle(
          writer,
          legacyUpload("session-4", "attempt-4", "artifact-attempt-4"),
          "stored",
          evidence(key4, "present"),
        );
        await writer.query("COMMIT");
        await expect(blocked).resolves.toMatchObject({ remaining_count: 0 });
      } finally {
        await writer.end();
      }
      expect(deletedKeys.filter((keys) => keys.includes(key4)).length).toBe(deletesBefore + 1);
      expect(
        (await admin.query("SELECT state FROM karaoke_recordings WHERE session_id='session-4'"))
          .rows,
      ).toEqual([{ state: "deleted" }]);

      // Evidence-bound settlement of the legacy Study write lets deletion finish.
      const studyUpload = study.rows[0]?.upload_attempt_id ?? "";
      await expect(
        settle(admin, studyUpload, "absent", {
          ...studyEvidence(studyKey("3"), studyDigest),
          headStatus: "absent",
        }),
      ).rejects.toThrow("an absent legacy Study object does not prove its write ended");
      await settle(admin, studyUpload, "stored", studyEvidence(studyKey("3"), studyDigest));
      await expect(run("account-3")).resolves.toMatchObject({ remaining_count: 0 });
      expect(
        (
          await admin.query(
            "SELECT recording_state FROM learner_audio_artifacts WHERE learner_audio_artifact_id='study-artifact-3'",
          )
        ).rows,
      ).toEqual([{ recording_state: "deleted" }]);
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      if (hostileRole !== undefined) {
        await admin.query(`DROP OWNED BY ${quoteIdentifier(hostileRole)}`);
        await admin.query(`DROP ROLE ${quoteIdentifier(hostileRole)}`);
      }
      await admin.end();
    }
  });
});
