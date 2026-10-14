// This test reconstructs genuine 0001..0247, never the regenerated baseline.
// Keep the historical seed before wiring a store dependency on a 0249 routine.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeHistoricalStudyV2Repository3ef } from "./historical-api-next-3ef1f879.pg-fixture/index.pg-fixture.ts";
import { type ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";
import { insertStudySongFixture } from "./study-v2-ready-song.pg-fixture.ts";
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
  for (const migration of historical) {
    const declared = manifest.migrations[migration.version];
    if (typeof declared !== "string") throw new Error("historical checksum missing");
    expect(migration.checksum).toBe(declared);
  }
  const foundation = await readMigration("0248_guest_learning_authority_foundation.sql");
  const preservation = await readMigration("0249_study_participation_owner_preservation.sql");
  for (const migration of [foundation, preservation]) {
    const declared = manifest.migrations[migration.version];
    if (declared !== undefined) expect(migration.checksum).toBe(declared);
  }
  const authority = await readMigration("0250_guest_browser_authority_transitions.sql");
  const resource = await readMigration("0251_guest_learning_resource_reservations.sql");
  expect(foundation.checksum).toBe(
    "2c99571cedbe0640733b3509c657e81d4a89f505ba6d3fed61ea7e0c4befaed1",
  );
  expect(preservation.checksum).toBe(
    "8c3578dcbbbdf929fb412e4493e6e16ab5d2af0fe13d518bd3f582892cd0c732",
  );
  expect(authority.checksum).toBe(
    "c025474320a4bc244d974929415fed95ad26b22d0e2cf9657fbd2f328ddafcf9",
  );
  expect(resource.checksum).toBe(
    "2de6e6508ec498a616b2db85ceafef1e2dbde7323a060cfae9956d0353d1aae4",
  );
  const rowBoundary = await readMigration("0252_guest_learning_controlled_row_admission.sql");
  expect(rowBoundary.checksum).toBe(
    "fc49e0678b1a14430455b29c9f1079c10fe8ee6408724edcbad110cd22b9ea7f",
  );
  return { historical, foundation, preservation, authority, resource, rowBoundary };
}

type Study = ReturnType<typeof makeHistoricalStudyV2Repository3ef>;
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
  const store = makeHistoricalStudyV2Repository3ef();
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runtime))));
  // Distinct driver instances represent separate server ID-generator scopes.
  const driverId = crypto.randomUUID();
  let serial = 0;
  const id = (kind: string) => `${accountId}-${driverId}-${kind}-${++serial}`;
  return {
    read: (sessionId: string) =>
      run(store.getSession({ accountId, sessionId, communityId: "study-community" })),
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
    reserve: (sessionId: string, sessionItemId: string, seed: string, idempotencyKey = seed) =>
      run(
        store.reserveSpokenAnswer({
          accountId,
          sessionId,
          sessionItemId,
          attemptNumber: 1,
          attemptId: id("attempt"),
          artifactId: id("artifact"),
          commandId: id("command"),
          idempotencyKey,
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

const fixtureCreatorSql =
  "-- Fixture ONLY. Not product authorization or a serving function. Private exact\n-- templates are seeded from an ordinary account graph produced by real store.\nCREATE TABLE guest_row_fixture_templates(relation_name TEXT PRIMARY KEY,row_data JSONB NOT NULL);\nREVOKE ALL ON guest_row_fixture_templates FROM PUBLIC;\nCREATE FUNCTION guest_row_fixture_create_v1(seed TEXT, patches JSONB DEFAULT '{}'::JSONB)\nRETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$\nDECLARE owner_id TEXT; sid TEXT; iid TEXT; rid TEXT; aid TEXT; cid TEXT; artifact TEXT;\n operation_id TEXT; op JSONB; policy JSONB; budget JSONB; reservation guest_resource_session_reservations%ROWTYPE;\n row_json JSONB; names TEXT[]; fixture_relation TEXT; now_at TIMESTAMPTZ; presentation_cap INTEGER; call_plan JSONB;\nBEGIN\n IF seed IS NULL OR seed !~ '^[a-z0-9_-]{1,48}$' OR jsonb_typeof(patches)<>'object'\n   OR EXISTS(SELECT 1 FROM jsonb_object_keys(patches) k WHERE k NOT IN(\n    'study_sessions_v2','study_review_items','study_session_items_v2','study_spoken_answer_commands',\n    'learner_audio_artifacts','study_attempts_v2','study_presentations_v2','study_lesson_item_state_v2'))\n THEN RAISE EXCEPTION 'invalid fixture graph input'; END IF;\n -- Resource GLOBAL lock precedes all owner/proof locks. No IO in this function.\n PERFORM pg_advisory_xact_lock_shared(83000003,1);\n PERFORM 1 FROM guest_resource_global_lock WHERE singleton FOR UPDATE;\n IF NOT FOUND THEN RAISE EXCEPTION 'actual resource global anchor unavailable'; END IF;\n owner_id:='owner_'||gen_random_uuid()::TEXT;sid:='guest-row-session-'||seed;\n iid:='guest-row-item-'||seed;rid:='guest-row-review-'||seed;aid:='guest-row-attempt-'||seed;\n cid:='guest-row-command-'||seed;artifact:='guest-row-artifact-'||seed;operation_id:='guest-row-start-'||seed;\n INSERT INTO participation_owners(owner_id,kind,guest_origin,state) VALUES(owner_id,'guest','https://app.example','empty');\n op:=jsonb_build_object('sourceOwnerId',owner_id,'kind','study_start','idempotencyKey','guest-row-key-'||seed,'requestHash',repeat('a',64));\n policy:='{\"version\":\"row-fixture-v1\",\"costPolicyVersion\":\"row-cost-v1\",\"maximumOwnerActiveSessions\":2,\"maximumOwnerReservedPaidCallsPerRollingDay\":60,\"maximumGlobalActiveSessions\":1000,\"maximumGlobalPaidCallsPerRollingDay\":10000,\"maximumGlobalCostMicrosPerRollingDay\":\"1000000\",\"maximumOwnerCostMicrosPerRollingDay\":\"1000000\",\"maximumTrustedEdgeSessionsPerWindow\":1000,\"trustedEdgeWindowSeconds\":60,\"maximumProviderCallCostMicros\":\"10\"}'::JSONB;\n -- This fixture stores ONE actual spoken card per eight-family row graph.\n -- It is deliberately not a four-to-ten-card lesson/engine admission proof.\n SELECT LEAST(20,3*count(*)::INTEGER) INTO presentation_cap\n  FROM guest_row_fixture_templates t WHERE t.relation_name='study_session_items_v2'\n   AND ((t.row_data||COALESCE(patches->'study_session_items_v2','{}'::JSONB))\n    #>>'{item_snapshot,exercise_type}')='say_it_back';\n IF presentation_cap<>3 THEN RAISE EXCEPTION 'fixture requires its actual one spoken card'; END IF;\n call_plan:=jsonb_build_object('policy_revision','study_spoken_rerecord_v1',\n  'graded_presentation_cap',presentation_cap,'ungraded_rerecord_per_presentation',1,\n  'maximum_paid_calls',2*presentation_cap);\n budget:=reserve_guest_resource_session_v1(owner_id,op,sid,2*presentation_cap,\n  (2*presentation_cap*(policy->>'maximumProviderCallCostMicros')::NUMERIC)::TEXT,'row-fixture-edge',policy);\n IF budget#>>'{result,state}'<>'reserved' THEN RAISE EXCEPTION 'fixture resource reservation failed'; END IF;\n SELECT * INTO STRICT reservation FROM guest_resource_session_reservations WHERE reservation_id=budget->>'outcome_id';\n now_at:=clock_timestamp();\n INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,created_at)\n VALUES(operation_id,owner_id,'study_start',guest_study_start_resource_scope_v1('study-community','study-post'),op->>'idempotencyKey',op->>'requestHash','reserved',reservation.created_at);\n names:=ARRAY['study_sessions_v2','study_review_items','study_session_items_v2','learner_audio_artifacts','study_spoken_answer_commands','study_attempts_v2','study_presentations_v2','study_lesson_item_state_v2'];\n FOREACH fixture_relation IN ARRAY names LOOP\n  SELECT row_data INTO STRICT row_json FROM guest_row_fixture_templates WHERE guest_row_fixture_templates.relation_name=fixture_relation;\n  CASE fixture_relation\n   WHEN 'study_sessions_v2' THEN row_json:=row_json||jsonb_build_object('session_id',sid,'account_id',NULL,'persona_id',NULL,'participation_owner_id',owner_id,'participation_owner_kind','guest','guest_reward_mode','practice_only','guest_reward_terms',NULL,'guest_start_operation_id',operation_id,'guest_resource_reservation_id',reservation.reservation_id,'guest_spoken_call_plan',call_plan,'guest_disclosure_version','reviewed-fixture-disclosure-v1','guest_disclosure_accepted',TRUE,'telegram_practice_only',FALSE,'idempotency_key',op->>'idempotencyKey','request_hash',op->>'requestHash','created_at',reservation.created_at,'expires_at',reservation.reservation_expires_at,'status','completed','completed_at',now_at,'completion_reason','all_resolved','current_session_item_id',NULL,'current_presented_at',NULL);\n   WHEN 'study_review_items' THEN row_json:=row_json||jsonb_build_object('review_item_id',rid,'account_id',NULL,'participation_owner_id',owner_id,'participation_owner_kind','guest');\n   WHEN 'study_session_items_v2' THEN row_json:=row_json||jsonb_build_object('session_item_id',iid,'session_id',sid,'review_item_id',rid,'account_id',NULL,'participation_owner_id',owner_id,'participation_owner_kind','guest','ordinal',0);\n   WHEN 'learner_audio_artifacts' THEN row_json:=row_json||jsonb_build_object('learner_audio_artifact_id',artifact,'account_id',NULL,'participation_owner_id',owner_id,'participation_owner_kind','guest','source_kind','study','attempt_ref',aid,'expected_object_ref','fixture/'||seed,'object_ref','fixture/'||seed);\n   WHEN 'study_spoken_answer_commands' THEN row_json:=row_json||jsonb_build_object('command_id',cid,'account_id',NULL,'participation_owner_id',owner_id,'participation_owner_kind','guest','session_id',sid,'session_item_id',iid,'attempt_id',aid,'learner_audio_artifact_id',artifact,'idempotency_key','guest-answer-'||seed,'lease_token','guest-lease-'||seed);\n   WHEN 'study_attempts_v2' THEN row_json:=row_json||jsonb_build_object('attempt_id',aid,'session_item_id',iid,'learner_audio_artifact_id',artifact,'idempotency_key','guest-answer-'||seed,'submission_evidence',(row_json->'submission_evidence')||jsonb_build_object('learner_audio_artifact_id',artifact));\n   WHEN 'study_presentations_v2' THEN row_json:=row_json||jsonb_build_object('presentation_id','guest-presentation-'||seed,'session_id',sid,'session_item_id',iid,'queue_ordinal',0);\n   WHEN 'study_lesson_item_state_v2' THEN row_json:=row_json||jsonb_build_object('session_id',sid,'session_item_id',iid,'original_ordinal',0);\n  END CASE;\n  row_json:=row_json||COALESCE(patches->fixture_relation,'{}'::JSONB);\n  EXECUTE format('INSERT INTO %I SELECT (jsonb_populate_record(NULL::%I,$1)).*',fixture_relation,fixture_relation) USING row_json;\n END LOOP;\n RETURN jsonb_build_object('owner_id',owner_id,'session_id',sid,'session_item_id',iid,'review_item_id',rid,'attempt_id',aid,'command_id',cid,'artifact_id',artifact);\nEND $$;\nCREATE FUNCTION guest_row_fixture_counts_v1() RETURNS JSONB LANGUAGE sql SECURITY DEFINER AS $$\n SELECT jsonb_build_object(\n 'study_sessions_v2',(SELECT count(*) FROM study_sessions_v2 WHERE participation_owner_kind='guest'),\n 'study_review_items',(SELECT count(*) FROM study_review_items WHERE participation_owner_kind='guest'),\n 'study_session_items_v2',(SELECT count(*) FROM study_session_items_v2 WHERE participation_owner_kind='guest'),\n 'study_spoken_answer_commands',(SELECT count(*) FROM study_spoken_answer_commands WHERE participation_owner_kind='guest'),\n 'learner_audio_artifacts',(SELECT count(*) FROM learner_audio_artifacts WHERE participation_owner_kind='guest'),\n 'study_attempts_v2',(SELECT count(*) FROM study_attempts_v2 a JOIN study_session_items_v2 i USING(session_item_id) WHERE i.participation_owner_kind='guest'),\n 'study_presentations_v2',(SELECT count(*) FROM study_presentations_v2 a JOIN study_session_items_v2 i USING(session_item_id) WHERE i.participation_owner_kind='guest'),\n 'study_lesson_item_state_v2',(SELECT count(*) FROM study_lesson_item_state_v2 a JOIN study_session_items_v2 i USING(session_item_id) WHERE i.participation_owner_kind='guest'))\n$$;\nDO $bind_fixture_only_row_helpers$\nDECLARE signature TEXT; trusted_schema TEXT:=current_schema(); grantee_name TEXT;\nBEGIN\n FOREACH signature IN ARRAY ARRAY['guest_row_fixture_create_v1(text,jsonb)','guest_row_fixture_counts_v1()'] LOOP\n  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);\n  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);\n  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f\n   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a\n   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP\n   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);\n  END LOOP;\n END LOOP;\n FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c\n  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a\n  WHERE c.oid='guest_row_fixture_templates'::regclass AND a.grantee<>0 AND a.grantee<>c.relowner LOOP\n  EXECUTE format('REVOKE ALL ON TABLE guest_row_fixture_templates FROM %I',grantee_name);\n END LOOP;\nEND $bind_fixture_only_row_helpers$;\n";

const rowFamilies = [
  ["study_sessions_v2", "session_id"],
  ["study_review_items", "review_item_id"],
  ["study_session_items_v2", "session_item_id"],
  ["study_spoken_answer_commands", "command_id"],
  ["learner_audio_artifacts", "learner_audio_artifact_id"],
  ["study_attempts_v2", "attempt_id"],
  ["study_presentations_v2", "presentation_id"],
  ["study_lesson_item_state_v2", "session_item_id"],
] as const;
const ownerFamilies = new Set(rowFamilies.slice(0, 5).map(([table]) => table));
async function accountRows(admin: Client) {
  const rows: Record<string, unknown> = {};
  for (const [table, key] of rowFamilies) {
    const predicate = ownerFamilies.has(table)
      ? "t.account_id IS NOT NULL"
      : "EXISTS(SELECT 1 FROM study_session_items_v2 i WHERE i.session_item_id=t.session_item_id AND i.account_id IS NOT NULL)";
    rows[table] = (
      await admin.query(
        `SELECT ${quote(key)} AS id,
      encode(sha256(convert_to((to_jsonb(t)-$1::text[])::text,'UTF8')),'hex') AS hash
      FROM ${quote(table)} t WHERE ${predicate} ORDER BY ${quote(key)} COLLATE "C"`,
        [
          [
            "participation_owner_id",
            "participation_owner_kind",
            "guest_reward_mode",
            "guest_reward_terms",
            "guest_start_operation_id",
            "guest_disclosure_version",
            "guest_disclosure_accepted",
            "guest_resource_reservation_id",
            "guest_spoken_call_plan",
          ],
        ],
      )
    ).rows;
  }
  return rows;
}
async function financialCounts(admin: Client) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "activity_qualifications",
    "song_streaks",
    "community_streaks",
    "megapot_pool_shares",
    "reward_ledger_credits",
  ]) {
    if (!(await admin.query("SELECT to_regclass($1) AS relation", [table])).rows[0]?.relation)
      throw new Error(`expected actual financial inventory relation missing: ${table}`);
    result[table] = (await admin.query(`SELECT count(*)::INT AS n FROM ${quote(table)}`)).rows;
  }
  return result;
}

suite("guest learning raw-row privilege boundary", () => {
  test("preserves ordinary account stores and fences all eight guest families under real restricted LOGIN", async () => {
    if (!connectionString) throw new Error("test URL missing");
    const packet = await migrationPacket();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `guest_row_${suffix}`;
    const role = `guest_row_runtime_${suffix}`;
    const bypassRole = `guest_row_bypass_${suffix}`;
    const createRole = `guest_row_create_${suffix}`;
    const fixturePassword = crypto.randomUUID().replaceAll("-", "");
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({
      connectionString,
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
    });
    const runtimeUrl = new URL(scoped);
    runtimeUrl.username = role;
    runtimeUrl.password = fixturePassword;
    const runtime = new Client({
      connectionString: runtimeUrl.toString(),
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
    });
    const roles: string[] = [];
    let connected = false;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${quote(schema)};SET search_path TO ${quote(schema)}`);
      await runPostgresMigrations({
        connectionString: scoped,
        migrations: packet.historical,
        expectedLedger: [],
      });
      await insertStudySongFixture(admin);
      const original = studyDriver(scoped, "study-account", "study-persona");
      const first = await original.start("ordinary-before-row-boundary");
      const firstItem = first.lesson.current?.session_item_id;
      if (!firstItem) throw new Error("ordinary current lesson missing");
      const command = reserved(
        await original.reserve(first.session_id, firstItem, "ordinary-before-audio"),
      );
      await original.complete(command, first.session_id, firstItem, "ordinary-before-audio");
      const beforeRows = await accountRows(admin);
      for (const rows of Object.values(beforeRows))
        expect((rows as unknown[]).length).toBeGreaterThan(0);
      const originalAccountGuard = (
        await admin.query(
          "SELECT pg_get_functiondef('guard_study_v2_activity_authority()'::REGPROCEDURE) AS definition",
        )
      ).rows;
      await admin.query(
        `CREATE ROLE ${quote(role)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOREPLICATION PASSWORD '${fixturePassword}'`,
      );
      roles.push(role);
      await admin.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)};
        GRANT ALL ON ALL TABLES IN SCHEMA ${quote(schema)} TO ${quote(role)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT ALL ON TABLES TO ${quote(role)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT EXECUTE ON FUNCTIONS TO ${quote(role)}`);
      const full = [
        ...packet.historical,
        packet.foundation,
        packet.preservation,
        packet.authority,
        packet.resource,
        packet.rowBoundary,
      ];
      await runPostgresMigrations({
        connectionString: scoped,
        migrations: full,
        expectedLedger: packet.historical,
      });
      expect(await accountRows(admin)).toEqual(beforeRows);
      expect(
        (
          await admin.query(
            "SELECT pg_get_functiondef('guard_study_v2_activity_authority()'::REGPROCEDURE) AS definition",
          )
        ).rows,
      ).toEqual(originalAccountGuard);
      expect(
        (await admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
      ).toEqual(full.map(({ version, checksum }) => ({ version, checksum })));
      // Applying row admission over an existing policy/RLS state refuses
      // before any privilege or nullable-account rewrite; transaction rollback
      // preserves the accepted boundary. No cleanup/replacement is inferred.
      await admin.query("BEGIN");
      await expect(admin.query(packet.rowBoundary.sql)).rejects.toThrow(
        "learning relation owner/RLS requires explicit reconciliation",
      );
      await admin.query("ROLLBACK");
      await admin.query("SELECT require_guest_learning_runtime_role_v1($1::REGROLE)", [role]);
      const owner = (await admin.query("SELECT current_user AS role")).rows[0]?.role;
      if (typeof owner !== "string") throw new Error("migration owner missing");
      await runtime.connect();
      connected = true;
      expect((await runtime.query("SELECT current_user,session_user")).rows).toEqual([
        { current_user: role, session_user: role },
      ]);
      await expect(runtime.query(`SET ROLE ${quote(owner)}`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        runtime.query(`CREATE TABLE ${quote(schema)}.bad_row_table(n INTEGER)`),
      ).rejects.toMatchObject({ code: "42501" });
      for (const signature of [
        "map_controlled_guest_learning_source_v1()",
        "guard_controlled_guest_study_session_v1()",
        "validate_study_command_audio_source_v1()",
        "validate_guest_alias_state_v1()",
        "require_guest_learning_runtime_role_v1(regrole)",
      ]) {
        expect(
          (
            await runtime.query(
              "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS executable",
              [signature],
            )
          ).rows,
        ).toEqual([{ executable: false }]);
      }
      // Existing inherited default ALL grants survive as ordinary CRUD, but
      //252 strips exactly destructive TRUNCATE, which bypasses RLS entirely.
      for (const [table] of rowFamilies) {
        expect(
          (
            await runtime.query(
              "SELECT (has_table_privilege(current_user,$1,'SELECT') AND has_table_privilege(current_user,$1,'INSERT') AND has_table_privilege(current_user,$1,'UPDATE') AND has_table_privilege(current_user,$1,'DELETE')) AS ordinary,has_table_privilege(current_user,$1,'TRUNCATE') AS bulk",
              [table],
            )
          ).rows,
        ).toEqual([{ ordinary: true, bulk: false }]);
        await expect(runtime.query(`TRUNCATE TABLE ${quote(table)} CASCADE`)).rejects.toMatchObject(
          { code: "42501" },
        );
      }
      await admin.query(`GRANT TRUNCATE ON study_sessions_v2 TO ${quote(role)}`);
      expect(
        (
          await runtime.query(
            "SELECT has_table_privilege(current_user,'study_sessions_v2','TRUNCATE') AS bulk",
          )
        ).rows,
      ).toEqual([{ bulk: true }]);
      await expect(
        admin.query("SELECT require_guest_learning_runtime_role_v1($1::REGROLE)", [role]),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query(`REVOKE TRUNCATE ON study_sessions_v2 FROM ${quote(role)}`);
      await admin.query("SELECT require_guest_learning_runtime_role_v1($1::REGROLE)", [role]);
      // Existing ordinary store uses actual runtime LOGIN, not owner SET ROLE.
      const account = studyDriver(runtimeUrl.toString(), "study-account", "study-persona");
      const after = await account.start("ordinary-after-row-boundary");
      expect((await account.read(after.session_id))?.session_id).toBe(after.session_id);
      const afterItem = after.lesson.current?.session_item_id;
      if (!afterItem) throw new Error("ordinary post-boundary lesson missing");
      const afterCommand = reserved(
        await account.reserve(after.session_id, afterItem, "ordinary-after-audio"),
      );
      await account.fail(afterCommand);
      const retry = reserved(
        await account.reserve(
          after.session_id,
          afterItem,
          "ordinary-after-retry",
          "ordinary-after-audio",
        ),
      );
      expect(retry.commandId).toBe(afterCommand.commandId);
      const result = await account.complete(
        retry,
        after.session_id,
        afterItem,
        "ordinary-after-retry",
      );
      expect(result.outcome).toBe("correct");
      expect(
        (
          await account.reserve(
            after.session_id,
            afterItem,
            "ordinary-after-retry",
            "ordinary-after-audio",
          )
        ).state,
      ).toBe("completed");
      const accountAtGuestStart = await accountRows(admin);
      const moneyAtGuestStart = await financialCounts(admin);
      // Fixture-only SD graph writer is not a proposed product procedure. All
      // rows copy real ordinary snapshots, while actual guards/FKs stay enabled.
      await admin.query(fixtureCreatorSql);
      const templates: Record<string, string> = {
        study_sessions_v2: "session_id=$1",
        study_review_items:
          "review_item_id=(SELECT review_item_id FROM study_session_items_v2 WHERE session_item_id=$1)",
        study_session_items_v2: "session_item_id=$1",
        study_spoken_answer_commands: "command_id=$1",
        learner_audio_artifacts: "learner_audio_artifact_id=$1",
        study_attempts_v2: "attempt_id=$1",
        study_presentations_v2: "session_item_id=$1",
        study_lesson_item_state_v2: "session_item_id=$1",
      };
      const templateId: Record<string, string> = {
        study_sessions_v2: first.session_id,
        study_review_items: firstItem,
        study_session_items_v2: firstItem,
        study_spoken_answer_commands: command.commandId,
        learner_audio_artifacts: command.artifactId,
        study_attempts_v2: command.attemptId,
        study_presentations_v2: firstItem,
        study_lesson_item_state_v2: firstItem,
      };
      for (const [table] of rowFamilies)
        await admin.query(
          `INSERT INTO guest_row_fixture_templates SELECT $2,to_jsonb(t) FROM ${quote(table)} t WHERE ${templates[table]} ORDER BY to_jsonb(t)::TEXT LIMIT 1`,
          [templateId[table], table],
        );
      expect(
        (await admin.query("SELECT count(*)::INT AS n FROM guest_row_fixture_templates")).rows,
      ).toEqual([{ n: 8 }]);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION guest_row_fixture_create_v1(TEXT,JSONB),guest_row_fixture_counts_v1() TO ${quote(role)}`,
      );
      const graph = (await runtime.query("SELECT guest_row_fixture_create_v1('accepted') AS graph"))
        .rows[0]?.graph;
      expect(graph).toHaveProperty("owner_id");
      // Private controlled fixture graph has one actual spoken item, hence
      // three graded slots plus three paid rerecords. No zero-budget fiction.
      const plan = {
        policy_revision: "study_spoken_rerecord_v1",
        graded_presentation_cap: 3,
        ungraded_rerecord_per_presentation: 1,
        maximum_paid_calls: 6,
      };
      expect(
        (
          await admin.query(
            `SELECT s.guest_spoken_call_plan AS plan,r.initial_units,
        r.worst_case_cost_micros::text AS cost,
        (SELECT count(*)::int FROM study_session_items_v2 i WHERE i.session_id=s.session_id
          AND i.item_snapshot->>'exercise_type'='say_it_back') AS spoken_cards
        FROM study_sessions_v2 s JOIN guest_resource_session_reservations r
          ON r.reservation_id=s.guest_resource_reservation_id WHERE s.session_id=$1`,
            [graph.session_id],
          )
        ).rows,
      ).toEqual([{ plan, initial_units: 6, cost: "60", spoken_cards: 1 }]);
      expect(
        (
          await admin.query(
            `SELECT owner_active::int AS owner_active,owner_calls::text,owner_cost::text
        FROM guest_resource_usage_v1(ARRAY[$1]::text[],clock_timestamp())`,
            [graph.owner_id],
          )
        ).rows,
      ).toEqual([{ owner_active: 1, owner_calls: "6", owner_cost: "60" }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM study_sessions_v2 WHERE participation_owner_kind='account' AND guest_spoken_call_plan IS NOT NULL",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      await expect(
        admin.query(
          "UPDATE study_sessions_v2 SET guest_spoken_call_plan=NULL WHERE session_id=$1",
          [graph.session_id],
        ),
      ).rejects.toMatchObject({ code: "GP003" });
      await expect(
        admin.query(
          "UPDATE study_sessions_v2 SET guest_spoken_call_plan=$2::jsonb WHERE session_id=$1",
          [graph.session_id, { ...plan, graded_presentation_cap: 6, maximum_paid_calls: 12 }],
        ),
      ).rejects.toMatchObject({ code: "GP003" });
      expect(
        (
          await runtime.query(
            "UPDATE study_sessions_v2 SET guest_spoken_call_plan=NULL WHERE session_id=$1 RETURNING session_id",
            [graph.session_id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT guest_spoken_call_plan AS plan FROM study_sessions_v2 WHERE session_id=$1",
            [graph.session_id],
          )
        ).rows,
      ).toEqual([{ plan }]);
      const controlled = (await runtime.query("SELECT guest_row_fixture_counts_v1() AS counts"))
        .rows[0]?.counts;
      expect(controlled).toEqual(Object.fromEntries(rowFamilies.map(([table]) => [table, 1])));
      for (const [table] of rowFamilies) {
        const raw = (await runtime.query(`SELECT count(*)::INT AS n FROM ${quote(table)}`)).rows;
        const accountCount = (accountAtGuestStart[table] as unknown[]).length;
        expect(raw).toEqual([{ n: accountCount }]);
      }
      // Extra permissive TRUE cannot defeat each actual restrictive guest gate.
      for (const [table] of rowFamilies)
        await admin.query(
          `CREATE POLICY fixture_extra_permissive_true ON ${quote(table)} AS PERMISSIVE FOR ALL TO PUBLIC USING(TRUE) WITH CHECK(TRUE)`,
        );
      for (const [table, key] of rowFamilies) {
        const row = (
          await admin.query(
            `SELECT to_jsonb(t) AS row FROM ${quote(table)} t WHERE ${quote(key)}=$1`,
            [
              table === "study_sessions_v2"
                ? graph.session_id
                : table === "study_review_items"
                  ? graph.review_item_id
                  : table === "study_spoken_answer_commands"
                    ? graph.command_id
                    : table === "learner_audio_artifacts"
                      ? graph.artifact_id
                      : table === "study_attempts_v2"
                        ? graph.attempt_id
                        : table === "study_presentations_v2"
                          ? "guest-presentation-accepted"
                          : graph.session_item_id,
            ],
          )
        ).rows[0]?.row;
        if (!row) throw new Error(`guest fixture row missing: ${table}`);
        expect(
          (
            await runtime.query(
              `SELECT count(*)::INT AS n FROM ${quote(table)} WHERE ${quote(key)}=$1`,
              [row[key]],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        expect(
          (
            await runtime.query(
              `UPDATE ${quote(table)} SET ${quote(key)}=${quote(key)} WHERE ${quote(key)}=$1 RETURNING ${quote(key)}`,
              [row[key]],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await runtime.query(
              `DELETE FROM ${quote(table)} WHERE ${quote(key)}=$1 RETURNING ${quote(key)}`,
              [row[key]],
            )
          ).rowCount,
        ).toBe(0);
        await expect(
          runtime.query(
            `INSERT INTO ${quote(table)} SELECT (jsonb_populate_record(NULL::${quote(table)},$1::JSONB)).* RETURNING ${quote(key)}`,
            [row],
          ),
        ).rejects.toMatchObject({ code: table === "study_attempts_v2" ? "P0001" : "42501" });
        await expect(
          runtime.query(
            `INSERT INTO ${quote(table)} SELECT (jsonb_populate_record(NULL::${quote(table)},$1::JSONB)).* ON CONFLICT(${quote(key)}) DO UPDATE SET ${quote(key)}=EXCLUDED.${quote(key)} RETURNING ${quote(key)}`,
            [row],
          ),
        ).rejects.toMatchObject({ code: table === "study_attempts_v2" ? "P0001" : "42501" });
        expect(
          (
            await runtime.query(
              `WITH touched AS (DELETE FROM ${quote(table)} WHERE ${quote(key)}=$1 RETURNING *) SELECT count(*)::INT AS n FROM touched`,
              [row[key]],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
      }
      await runtime.query("SET row_security=off");
      await expect(runtime.query("SELECT * FROM study_sessions_v2")).rejects.toMatchObject({
        code: "42501",
      });
      await runtime.query("SET row_security=on");
      // Deferred content-type/size/duration must fail at real runtime COMMIT
      // AFTER fixture SD function returns, while exact owner/attempt/digest FKs
      // still match. Before correction0249 silently skipped hidden guest rows.
      for (const [field, bad] of [
        ["audio_content_type", "audio/wav"],
        ["audio_byte_size", 101],
        ["audio_duration_ms", 1001],
      ] as const) {
        await runtime.query("BEGIN");
        await runtime.query("SELECT guest_row_fixture_create_v1($1,$2::JSONB)", [
          `deferred-${field}`,
          { study_spoken_answer_commands: { [field]: bad } },
        ]);
        await expect(runtime.query("COMMIT")).rejects.toThrow(
          "spoken command and original audio provenance disagree",
        );
        await runtime.query("ROLLBACK");
        expect(
          (await runtime.query("SELECT guest_row_fixture_counts_v1() AS counts")).rows[0]?.counts,
        ).toEqual(controlled);
      }
      for (const [seed, patch] of [
        ["missing-paid-plan", { study_sessions_v2: { guest_spoken_call_plan: null } }],
        [
          "unfunded-paid-plan",
          {
            study_sessions_v2: {
              guest_spoken_call_plan: {
                policy_revision: "study_spoken_rerecord_v1",
                graded_presentation_cap: 12,
                ungraded_rerecord_per_presentation: 1,
                maximum_paid_calls: 24,
              },
            },
          },
        ],
        ["false-consent", { study_sessions_v2: { guest_disclosure_accepted: false } }],
        ["missing-consent", { study_sessions_v2: { guest_disclosure_accepted: null } }],
        ["false-persona", { study_sessions_v2: { persona_id: "study-persona" } }],
        ["false-account", { study_sessions_v2: { account_id: "study-account" } }],
        ["reward-mode", { study_sessions_v2: { guest_reward_mode: "megapot_guest_v1" } }],
        ["reward-terms", { study_sessions_v2: { guest_reward_terms: { fake: true } } }],
        ["wrong-start", { study_sessions_v2: { guest_start_operation_id: "missing-start" } }],
        [
          "wrong-resource",
          { study_sessions_v2: { guest_resource_reservation_id: "missing-reservation" } },
        ],
        ["wrong-clock", { study_sessions_v2: { created_at: "2000-01-01T00:00:00Z" } }],
        ["space-disclosure", { study_sessions_v2: { guest_disclosure_version: "bad version" } }],
        ["guest-karaoke", { learner_audio_artifacts: { source_kind: "karaoke" } }],
        ["other-session-item", { study_session_items_v2: { session_id: first.session_id } }],
      ] as const) {
        await expect(
          runtime.query("SELECT guest_row_fixture_create_v1($1,$2::JSONB)", [seed, patch]),
        ).rejects.toThrow();
        expect(
          (await runtime.query("SELECT guest_row_fixture_counts_v1() AS counts")).rows[0]?.counts,
        ).toEqual(controlled);
      }
      expect(await accountRows(admin)).toEqual(accountAtGuestStart);
      expect(await financialCounts(admin)).toEqual(moneyAtGuestStart);
      // Membership schedules use actual PG17 membership options. Direct role
      // flags alone, effective inherited privileges alone and SET-only owner
      // scans each have a different unsafe counterexample.
      await admin.query(
        `CREATE ROLE ${quote(bypassRole)} NOLOGIN BYPASSRLS;CREATE ROLE ${quote(createRole)} NOLOGIN`,
      );
      roles.push(bypassRole, createRole);
      await admin.query(
        `GRANT ${quote(bypassRole)} TO ${quote(role)} WITH INHERIT FALSE, SET TRUE`,
      );
      await expect(
        admin.query("SELECT require_guest_learning_runtime_role_v1($1::REGROLE)", [role]),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query(`REVOKE ${quote(bypassRole)} FROM ${quote(role)}`);
      await admin.query(
        `GRANT CREATE ON SCHEMA ${quote(schema)} TO ${quote(createRole)};GRANT ${quote(createRole)} TO ${quote(role)} WITH INHERIT FALSE, SET TRUE`,
      );
      expect(
        (
          await runtime.query(
            "SELECT has_schema_privilege(current_user,$1,'CREATE') AS create_allowed",
            [schema],
          )
        ).rows,
      ).toEqual([{ create_allowed: false }]);
      await expect(
        admin.query("SELECT require_guest_learning_runtime_role_v1($1::REGROLE)", [role]),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query(`REVOKE ${quote(createRole)} FROM ${quote(role)}`);
      await admin.query(`GRANT ${quote(owner)} TO ${quote(role)} WITH INHERIT TRUE, SET FALSE`);
      expect(
        (
          await admin.query(
            "SELECT pg_has_role($1::REGROLE,$2::REGROLE,'SET') AS can_set,pg_has_role($1::REGROLE,$2::REGROLE,'USAGE') AS inherits_owner",
            [role, owner],
          )
        ).rows,
      ).toEqual([{ can_set: false, inherits_owner: true }]);
      await expect(
        admin.query("SELECT require_guest_learning_runtime_role_v1($1::REGROLE)", [role]),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query(`REVOKE ${quote(owner)} FROM ${quote(role)}`);
      await admin.query("SELECT require_guest_learning_runtime_role_v1($1::REGROLE)", [role]);
      expect(
        (
          await admin.query(
            "SELECT bool_and(relrowsecurity AND NOT relforcerowsecurity) AS expected FROM pg_class WHERE relnamespace=$1::REGNAMESPACE AND relname=ANY($2::TEXT[])",
            [schema, rowFamilies.map(([table]) => table)],
          )
        ).rows,
      ).toEqual([{ expected: true }]);
    } finally {
      await runtime.query("ROLLBACK;RESET ROLE").catch(() => undefined);
      if (connected) await runtime.end();
      else await runtime.end().catch(() => undefined);
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      for (const fixtureRole of roles.reverse())
        await admin.query(`DROP OWNED BY ${quote(fixtureRole)};DROP ROLE ${quote(fixtureRole)}`);
      await admin.end();
    }
  }, 180_000);
});
