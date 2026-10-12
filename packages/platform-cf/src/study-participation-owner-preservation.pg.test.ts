// This test reconstructs genuine 0001..0247, never the regenerated baseline.
// Keep the historical seed before wiring a store dependency on a 0249 routine.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import { type ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";
import { insertStudySongFixture } from "./study-v2-ready-song.pg-fixture.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";
import { defaultStudySpokenEvidence } from "./study-v2-spoken-test-evidence.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const connectionForSchema = (raw: string, schema: string) =>
  `${raw}${raw.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;

// New draft files can be tested before checksum/baseline regeneration. Every
// historical file MUST match the maintained immutable manifest; new files use
// their actual bytes and the runner's exact prefix fence. No baseline SQL loads.
async function migrationPacket() {
  const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")) as {
    algorithm: string;
    migrations: Record<string, string>;
  };
  expect(manifest.algorithm).toBe("sha256");
  const historicalNames = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 247)
    .sort();
  expect(historicalNames).toHaveLength(247);
  expect(historicalNames.at(-1)).toBe("0247_karaoke_instrumental_qualification_policy.sql");
  const readMigration = async (version: string): Promise<PostgresMigration> => {
    const sql = await readFile(new URL(version, directory), "utf8");
    return { version, sql, checksum: hash(sql) };
  };
  const historical = await Promise.all(historicalNames.map(readMigration));
  for (const migration of historical)
    expect(migration.checksum).toBe(manifest.migrations[migration.version]);
  const foundation = await readMigration("0248_guest_learning_authority_foundation.sql");
  const preservation = await readMigration("0249_study_participation_owner_preservation.sql");
  for (const migration of [foundation, preservation]) {
    const declared = manifest.migrations[migration.version];
    if (declared !== undefined) expect(migration.checksum).toBe(declared);
  }
  return { historical, foundation, preservation };
}

const families = [
  ["study_sessions_v2", "session_id"],
  ["study_review_items", "review_item_id"],
  ["study_session_items_v2", "session_item_id"],
  ["study_spoken_answer_commands", "command_id"],
  ["learner_audio_artifacts", "learner_audio_artifact_id"],
] as const;
const excluded = [
  "participation_owner_id",
  "participation_owner_kind",
  "guest_reward_mode",
  "guest_reward_terms",
  "guest_start_operation_id",
  "guest_disclosure_version",
  "guest_disclosure_accepted",
];
async function oldRowDigests(admin: Client) {
  const result: Record<string, unknown> = {};
  for (const [table, key] of families) {
    result[table] = (
      await admin.query(
        `SELECT ${quote(key)} AS id,
          encode(sha256(convert_to((to_jsonb(t)-$1::text[])::text,'UTF8')),'hex') AS digest
          FROM ${quote(table)} t ORDER BY ${quote(key)} COLLATE "C"`,
        [excluded],
      )
    ).rows;
  }
  return result;
}
async function guards(admin: Client) {
  return {
    triggers: (
      await admin.query(`SELECT tgname, tgtype::int AS bits, tgenabled,
          tgfoid::text AS function_id, pg_get_triggerdef(oid) AS definition
        FROM pg_trigger WHERE tgrelid IN ('study_sessions_v2'::regclass,'study_session_items_v2'::regclass)
          AND tgname IN ('study_sessions_v2_activity_authority','study_session_items_v2_immutable')
        ORDER BY tgname`)
    ).rows,
    function: (
      await admin.query(
        "SELECT pg_get_functiondef('guard_study_v2_activity_authority()'::regprocedure) AS definition",
      )
    ).rows,
  };
}

type Study = ReturnType<typeof makeControlPlaneStudyV2Repository>;
type Reservation = Effect.Success<ReturnType<Study["reserveSpokenAnswer"]>>;
const reserved = (value: Reservation): Extract<Reservation, { state: "reserved" }> => {
  if (value.state !== "reserved") throw new Error("expected a reserved command");
  return value;
};
const audio = (seed: string) => ({
  audioDigest: hash(seed),
  requestHash: hash(`${seed}:request`),
  audioByteSize: 100,
  audioContentType: "audio/webm" as const,
  audioDurationMs: 1000,
});
function studyDriver(scoped: string, accountId: string, personaId: string) {
  const runtime = makeDirectPostgresControlPlaneLayer(scoped);
  const store = makeControlPlaneStudyV2Repository();
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runtime))));
  let serial = 0;
  const id = (kind: string) => `${accountId}-${kind}-${++serial}`;
  return {
    start: (sessionId: string) =>
      run(
        store.startSession({
          accountId,
          personaId,
          communityId: "study-community",
          postId: "study-post",
          sessionId,
          idempotencyKey: `start:${sessionId}`,
          requestHash: hash(`start:${sessionId}`),
          createdAt: new Date().toISOString(),
          targetLanguage: null,
          learnerBand: null,
          timezone: "UTC",
        }),
      ),
    reserve: (sessionId: string, sessionItemId: string, seed: string) =>
      run(
        store.reserveSpokenAnswer({
          accountId,
          sessionId,
          sessionItemId,
          attemptNumber: 1,
          attemptId: id("attempt"),
          artifactId: id("artifact"),
          commandId: id("command"),
          idempotencyKey: seed,
          leaseToken: id("lease"),
          providerRetention: "stored",
          ...audio(seed),
        }),
      ),
    fail: (reservation: Reservation) => {
      const command = reserved(reservation);
      return run(
        store.failSpokenAnswer({
          accountId,
          commandId: command.commandId,
          leaseToken: command.leaseToken,
          failedAt: new Date().toISOString(),
          providerFailureKind: "unavailable",
        }),
      );
    },
    complete: (
      reservation: Reservation,
      sessionId: string,
      sessionItemId: string,
      seed: string,
    ) => {
      const command = reserved(reservation);
      return run(
        store.completeSpokenAnswer({
          ...defaultStudySpokenEvidence,
          ...audio(seed),
          accountId,
          communityId: "study-community",
          sessionId,
          sessionItemId,
          attemptNumber: 1,
          attemptId: command.attemptId,
          artifactId: command.artifactId,
          commandId: command.commandId,
          leaseToken: command.leaseToken,
          qualificationId: id("qualification"),
          acceptedAt: new Date().toISOString(),
          archive: {
            state: "stored",
            objectRef: `learner-audio/study/${command.attemptId}/${audio(seed).audioDigest}`,
          },
          grade: {
            correct: true,
            matchKind: "exact",
            heardTranscript: "I can love you",
            matched: [],
            missing: [],
            extra: [],
            substituted: [],
            policyRevision: "script_aware_token_phonetic_v2",
          },
          providerDetectedLanguage: "en",
          providerDetectedLanguageConfidence: 0.99,
        }),
      );
    },
  };
}

suite("populated Study participation-owner preservation", () => {
  test("preserves historical rows and guards, account upserts and retry provenance; refuses corrupt history and spoofed owners", async () => {
    if (!connectionString) throw new Error("test URL missing");
    const packet = await migrationPacket();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `guest_populated_${suffix}`;
    const role = `guest_populated_runtime_${suffix}`;
    const fixturePassword = crypto.randomUUID().replaceAll("-", "");
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({ connectionString });
    const runtimeUrl = new URL(scoped);
    runtimeUrl.username = role;
    runtimeUrl.password = fixturePassword;
    const runtime = new Client({ connectionString: runtimeUrl.toString() });
    await admin.connect();
    let roleCreated = false;
    let runtimeConnected = false;
    try {
      await admin.query(`CREATE SCHEMA ${quote(schema)}; SET search_path TO ${quote(schema)}`);
      await runPostgresMigrations({
        connectionString: scoped,
        migrations: packet.historical,
        expectedLedger: [],
      });
      await insertStudySongFixture(admin);
      // Same supported fixture convention as insertStudySongFixture: users and
      // active personas bypass wallet provisioning, not the actual Study writer.
      await admin.query("SET session_replication_role=replica");
      try {
        await admin.query("INSERT INTO users(user_id) VALUES('active-study-account')");
        await insertActiveCommunityMembershipFixture(admin, {
          communityId: "study-community",
          membershipId: "active-study-membership",
          userId: "active-study-account",
        });
        await admin.query(`INSERT INTO personas(persona_id,account_id,status,created_at)
          VALUES('active-study-persona','active-study-account','active',clock_timestamp());
          INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source)
          VALUES('active-study-persona','active-study-account','study-community','first_membership')`);
      } finally {
        await admin.query("SET session_replication_role=origin");
      }
      const historical = studyDriver(scoped, "study-account", "study-persona");
      const active = studyDriver(scoped, "active-study-account", "active-study-persona");
      const historicalSession = await historical.start("historical-populated-session");
      const activeSession = await active.start("active-populated-session");
      const historicalItem = historicalSession.lesson.current?.session_item_id;
      const activeItem = activeSession.lesson.current?.session_item_id;
      if (!historicalItem || !activeItem) throw new Error("fixture has no current lesson item");
      const accepted = reserved(
        await historical.reserve(
          historicalSession.session_id,
          historicalItem,
          "accepted-before-backfill",
        ),
      );
      await historical.complete(
        accepted,
        historicalSession.session_id,
        historicalItem,
        "accepted-before-backfill",
      );
      const failed = reserved(
        await active.reserve(activeSession.session_id, activeItem, "failed-before-backfill"),
      );
      await active.fail(failed);
      await admin.query(
        `INSERT INTO learner_audio_artifacts
        (learner_audio_artifact_id,account_id,source_kind,attempt_ref,expected_object_ref,object_ref,
         content_digest,content_type,byte_size,duration_ms,platform_retention,provider_retention,recording_state,expires_at)
        VALUES('historical-karaoke-artifact','study-account','karaoke','historical-karaoke-attempt',
         'learner-audio/karaoke/historical','learner-audio/karaoke/historical',$1,'audio/webm',100,1000,
         'private_learning','not_stored','stored',clock_timestamp()+INTERVAL '24 months')`,
        [hash("karaoke")],
      );
      await admin.query(
        `INSERT INTO learner_audio_artifacts
        (learner_audio_artifact_id,account_id,source_kind,attempt_ref,expected_object_ref,
         content_digest,content_type,byte_size,duration_ms,platform_retention,provider_retention,recording_state,expires_at)
        VALUES('historical-failed-karaoke-artifact','study-account','karaoke','historical-failed-karaoke-attempt',
         'learner-audio/karaoke/historical-failed',$1,'audio/webm',100,1000,
         'private_learning','not_stored','failed',clock_timestamp()+INTERVAL '24 months')`,
        [hash("failed-karaoke")],
      );
      // The fixture personas have no wallets. This models later valid status
      // transitions without claiming to test wallet lifecycle. Origin triggers
      // are restored before any migration or assertion.
      await admin.query("SET session_replication_role=replica");
      try {
        await admin.query(`UPDATE personas SET status='retired',retired_at=clock_timestamp() WHERE persona_id='study-persona';
          UPDATE users SET status='deleted' WHERE user_id='study-account';
          UPDATE posts SET status='hidden' WHERE post_id='study-post'`);
      } finally {
        await admin.query("SET session_replication_role=origin");
      }
      await expect(
        admin.query("UPDATE study_sessions_v2 SET timezone=timezone WHERE session_id=$1", [
          historicalSession.session_id,
        ]),
      ).rejects.toThrow("Study v2 activity authority is ineligible");
      await expect(
        admin.query("UPDATE study_sessions_v2 SET timezone=timezone WHERE session_id=$1", [
          activeSession.session_id,
        ]),
      ).rejects.toThrow("Study v2 activity authority is ineligible");
      const original = await oldRowDigests(admin);
      for (const [table] of families)
        expect((original[table] as unknown[]).length).toBeGreaterThan(0);
      const originalGuards = await guards(admin);
      expect(originalGuards.triggers).toHaveLength(2);
      // Deliberately inherited installation grants must not leak the new core
      // or six private account-composition functions to a runtime role.
      // An actual unprivileged login cannot escape with SET ROLE to the admin.
      // SET ROLE on an admin login alone would not prove this boundary.
      await admin.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${fixturePassword}'`);
      roleCreated = true;
      await admin.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)};
        GRANT ALL ON ALL TABLES IN SCHEMA ${quote(schema)} TO ${quote(role)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT ALL ON TABLES TO ${quote(role)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT EXECUTE ON FUNCTIONS TO ${quote(role)}`);
      const through248 = [...packet.historical, packet.foundation];
      await runPostgresMigrations({
        connectionString: scoped,
        migrations: through248,
        expectedLedger: packet.historical,
      });
      // Corrupt only this transaction's disposable fixture. The historical FK
      // was bypassed intentionally; 0249 must refuse, never erase the command.
      await admin.query("BEGIN; SET LOCAL session_replication_role=replica");
      await admin.query("DELETE FROM learner_audio_artifacts WHERE learner_audio_artifact_id=$1", [
        failed.artifactId,
      ]);
      await admin.query("SET LOCAL session_replication_role=origin");
      await expect(admin.query(packet.preservation.sql)).rejects.toThrow(
        "historical Study/audio source identity requires separate disposition",
      );
      await admin.query("ROLLBACK");
      expect(await oldRowDigests(admin)).toEqual(original);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='study_sessions_v2' AND column_name='participation_owner_id'",
            [schema],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (await admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
      ).toEqual(through248.map(({ version, checksum }) => ({ version, checksum })));
      const through249 = [...through248, packet.preservation];
      await runPostgresMigrations({
        connectionString: scoped,
        migrations: through249,
        expectedLedger: through248,
      });
      expect(await oldRowDigests(admin)).toEqual(original);
      expect(await guards(admin)).toEqual(originalGuards);
      expect(
        (
          await admin.query(
            "SELECT to_regprocedure('guest_migration_only_item_enrichment_v1()') AS temporary_guard",
          )
        ).rows,
      ).toEqual([{ temporary_guard: null }]);
      for (const [table] of families) {
        expect(
          (
            await admin.query(`SELECT count(*)::int AS invalid FROM ${quote(table)} t
          LEFT JOIN participation_owners o ON o.owner_id=t.participation_owner_id
          WHERE t.participation_owner_kind IS DISTINCT FROM 'account' OR o.kind IS DISTINCT FROM 'account'
            OR o.account_id IS DISTINCT FROM t.account_id`)
          ).rows,
        ).toEqual([{ invalid: 0 }]);
      }
      const owners = (
        await admin.query(
          "SELECT account_id,owner_id,state FROM participation_owners WHERE kind='account' ORDER BY account_id",
        )
      ).rows;
      expect(owners).toHaveLength(2);
      expect(owners.every((owner) => owner.state === "established")).toBe(true);
      const activeOwner = owners.find(
        (owner) => owner.account_id === "active-study-account",
      )?.owner_id;
      const historicalOwner = owners.find(
        (owner) => owner.account_id === "study-account",
      )?.owner_id;
      if (typeof activeOwner !== "string" || typeof historicalOwner !== "string")
        throw new Error("account owner mapping missing");
      // Mapping historical bookkeeping succeeds even though new admission is
      // rejected for the original deleted account; no alias or status reparent.
      expect(
        (
          await admin.query(
            "SELECT require_existing_account_participation_owner_v1('study-account') AS owner",
          )
        ).rows,
      ).toEqual([{ owner: historicalOwner }]);
      await expect(
        admin.query("SELECT provision_account_participation_owner_v1('study-account')"),
      ).rejects.toThrow("active canonical account required");
      await expect(
        admin.query("UPDATE study_sessions_v2 SET timezone=timezone WHERE session_id=$1", [
          historicalSession.session_id,
        ]),
      ).rejects.toThrow("Study v2 activity authority is ineligible");
      await expect(
        admin.query("UPDATE study_session_items_v2 SET ordinal=ordinal WHERE session_item_id=$1", [
          historicalItem,
        ]),
      ).rejects.toThrow();
      // Restore only the song. Historical account/persona remain revoked.
      await admin.query("UPDATE posts SET status='published' WHERE post_id='study-post'");
      const reclaimed = reserved(
        await active.reserve(activeSession.session_id, activeItem, "replacement-after-backfill"),
      );
      expect([reclaimed.commandId, reclaimed.attemptId, reclaimed.artifactId]).toEqual([
        failed.commandId,
        failed.attemptId,
        failed.artifactId,
      ]);
      expect(
        (
          await admin.query(
            "SELECT content_digest,expected_object_ref,recording_state FROM learner_audio_artifacts WHERE learner_audio_artifact_id=$1",
            [failed.artifactId],
          )
        ).rows,
      ).toEqual([
        {
          content_digest: audio("replacement-after-backfill").audioDigest,
          expected_object_ref: `learner-audio/study/${failed.attemptId}/${audio("replacement-after-backfill").audioDigest}`,
          recording_state: "pending",
        },
      ]);
      await expect(
        active.complete(failed, activeSession.session_id, activeItem, "failed-before-backfill"),
      ).rejects.toMatchObject({ reason: "idempotency-conflict" });
      const completion = await active.complete(
        reclaimed,
        activeSession.session_id,
        activeItem,
        "replacement-after-backfill",
      );
      expect(completion).toMatchObject({ outcome: "correct", attempt_state: "spent" });
      const replay = await active.reserve(
        activeSession.session_id,
        activeItem,
        "replacement-after-backfill",
      );
      expect(replay.state).toBe("completed");
      if (replay.state === "completed") expect(replay.result).toEqual(completion);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM study_attempts_v2 WHERE attempt_id=$1",
            [failed.attemptId],
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
      for (const mutation of [
        "idempotency_key='changed-after-complete'",
        "result_snapshot=result_snapshot||'{\"unexpected\":true}'::jsonb",
      ])
        await expect(
          admin.query(`UPDATE study_spoken_answer_commands SET ${mutation} WHERE command_id=$1`, [
            reclaimed.commandId,
          ]),
        ).rejects.toThrow("completed spoken outcome is immutable");
      await expect(
        admin.query(
          "UPDATE learner_audio_artifacts SET content_digest=$2 WHERE learner_audio_artifact_id=$1",
          [reclaimed.artifactId, hash("rewrite-accepted-study")],
        ),
      ).rejects.toThrow("accepted audio evidence is immutable");
      const reviewIds = (
        await admin.query(
          "SELECT review_item_id FROM study_review_items WHERE account_id='active-study-account' ORDER BY review_item_id",
        )
      ).rows;
      const second = await active.start("active-populated-second-session");
      expect(second.items).toHaveLength(4);
      expect(
        (
          await admin.query(
            "SELECT review_item_id FROM study_review_items WHERE account_id='active-study-account' ORDER BY review_item_id",
          )
        ).rows,
      ).toEqual(reviewIds);
      // Both items have the same owner. Only the exact session/current-item
      // constraint can distinguish this invalid cross-session selection.
      await expect(
        admin.query("UPDATE study_sessions_v2 SET current_session_item_id=$2 WHERE session_id=$1", [
          second.session_id,
          activeItem,
        ]),
      ).rejects.toMatchObject({ code: "23503", constraint: "study_session_exact_current_item_fk" });
      // Karaoke never rebinds audio. The accepted archive cannot enter a failed
      // state or substitute its reference; a historical failed artifact cannot
      // borrow the Study-only retry exception. Normal deletion keeps a tombstone.
      await expect(
        admin.query(
          "UPDATE learner_audio_artifacts SET recording_state='failed',object_ref=NULL WHERE learner_audio_artifact_id='historical-karaoke-artifact'",
        ),
      ).rejects.toThrow("accepted Karaoke archive state and reference are retained");
      await expect(
        admin.query(
          "UPDATE learner_audio_artifacts SET object_ref='substituted-reference' WHERE learner_audio_artifact_id='historical-karaoke-artifact'",
        ),
      ).rejects.toThrow("accepted Karaoke archive state and reference are retained");
      await expect(
        admin.query(
          "UPDATE learner_audio_artifacts SET content_digest=$1 WHERE learner_audio_artifact_id='historical-karaoke-artifact'",
          [hash("rewrite-karaoke")],
        ),
      ).rejects.toThrow("accepted audio evidence is immutable");
      await expect(
        admin.query(
          "UPDATE learner_audio_artifacts SET recording_state='pending',content_digest=$1,expected_object_ref='rewritten' WHERE learner_audio_artifact_id='historical-failed-karaoke-artifact'",
          [hash("rewrite-failed-karaoke")],
        ),
      ).rejects.toThrow("accepted audio evidence is immutable");
      await admin.query(
        "UPDATE learner_audio_artifacts SET recording_state='deleted',object_ref=NULL,deleted_at=clock_timestamp() WHERE learner_audio_artifact_id='historical-karaoke-artifact'",
      );
      expect(
        (
          await admin.query(
            "SELECT content_digest,recording_state,source_kind,participation_owner_id FROM learner_audio_artifacts WHERE learner_audio_artifact_id='historical-karaoke-artifact'",
          )
        ).rows,
      ).toEqual([
        {
          content_digest: hash("karaoke"),
          recording_state: "deleted",
          source_kind: "karaoke",
          participation_owner_id: historicalOwner,
        },
      ]);
      await expect(
        admin.query(
          "UPDATE learner_audio_artifacts SET recording_state='stored',object_ref='learner-audio/karaoke/historical',deleted_at=NULL WHERE learner_audio_artifact_id='historical-karaoke-artifact'",
        ),
      ).rejects.toThrow("accepted Karaoke archive state and reference are retained");
      await runtime.connect();
      runtimeConnected = true;
      expect((await runtime.query("SELECT current_user,session_user")).rows).toEqual([
        { current_user: role, session_user: role },
      ]);
      const migrationOwner = (await admin.query("SELECT current_user AS role")).rows[0]?.role;
      if (typeof migrationOwner !== "string") throw new Error("migration owner missing");
      await expect(runtime.query(`SET ROLE ${quote(migrationOwner)}`)).rejects.toMatchObject({
        code: "42501",
      });
      expect(
        (
          await runtime.query(
            "SELECT has_schema_privilege(current_user,$1,'CREATE') AS can_create",
            [schema],
          )
        ).rows,
      ).toEqual([{ can_create: false }]);
      for (const table of [
        "participation_owners",
        "guest_credentials",
        "guest_empty_owner_aliases",
        "participation_owner_clocks",
        "guest_learning_preferences",
        "guest_participation_operations",
        "guest_secret_issuance_operations",
        "guest_attachment_intents",
      ]) {
        await expect(runtime.query(`SELECT * FROM ${quote(table)}`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          runtime.query(`DELETE FROM ${quote(table)} WHERE FALSE`),
        ).rejects.toMatchObject({
          code: "42501",
        });
      }
      for (const signature of [
        "provision_account_participation_owner_v1(text)",
        "require_existing_account_participation_owner_v1(text)",
        "map_existing_account_learning_source_v1()",
        "preserve_learning_source_identity_v1()",
        "validate_study_command_audio_source_v1()",
        "validate_study_attempt_audio_source_v1()",
      ])
        expect(
          (
            await runtime.query(
              "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS executable",
              [signature],
            )
          ).rows,
        ).toEqual([{ executable: false }]);
      await expect(
        runtime.query("SELECT provision_account_participation_owner_v1('active-study-account')"),
      ).rejects.toMatchObject({ code: "42501" });
      // Existing account table grants survive. The immutable provenance trigger,
      // rather than lack of table permission, must close all five UPDATE paths.
      for (const [table, key] of families)
        await expect(
          runtime.query(
            `UPDATE ${quote(table)} SET participation_owner_id=$1 WHERE ${quote(key)}=(SELECT ${quote(key)} FROM ${quote(table)} WHERE account_id='active-study-account' LIMIT 1)`,
            [historicalOwner],
          ),
        ).rejects.toThrow("learning source provenance is immutable");
      await expect(
        runtime.query(
          `INSERT INTO learner_audio_artifacts
        (learner_audio_artifact_id,account_id,source_kind,attempt_ref,expected_object_ref,content_digest,content_type,byte_size,duration_ms,platform_retention,provider_retention,recording_state,expires_at,participation_owner_id,participation_owner_kind)
        VALUES('spoofed-artifact','active-study-account','karaoke','spoofed-attempt','spoofed-ref',$1,'audio/webm',100,1000,'private_learning','not_stored','pending',clock_timestamp()+INTERVAL '1 day',$2,'account')`,
          [hash("spoofed"), historicalOwner],
        ),
      ).rejects.toThrow("account source owner mismatch");
      expect(
        (await admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
      ).toEqual(through249.map(({ version, checksum }) => ({ version, checksum })));
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      if (runtimeConnected) await runtime.query("ROLLBACK; RESET ROLE").catch(() => undefined);
      await runtime.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      if (roleCreated) await admin.query(`DROP OWNED BY ${quote(role)}; DROP ROLE ${quote(role)}`);
      await admin.end();
    }
  }, 180_000);
});
