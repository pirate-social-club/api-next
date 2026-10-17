import { expect } from "bun:test";
import { toErrorBody } from "@pirate/contracts";
import { Effect } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { type Fixture, harness } from "./account-study-producer.pg-fixture.ts";
import { proveGuestStudyCompletionOwnerRepair } from "./activity-completion-guest-study.pg-fixture.ts";
import { makeControlPlaneActivityCompletionStore } from "./activity-completion-repository.ts";
import { makeOwnedOrdinaryAccountBirthFixture } from "./ordinary-study-account-birth.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientFactory } from "./postgres.ts";
import { insertStudySongFixture } from "./study-v2-ready-song.pg-fixture.ts";

const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
// Same controlled Study entry points as the existing ordinary-account fixture;
// no generic helper, financial mutation or blanket function EXECUTE grant.
const functions = [
  "lock_original_account_audio_source_private_v1(text)",
  "capture_account_study_audio_private_v1(text,text,text,text)",
  "find_account_spoken_success_private_v1(text,text,text,integer,text,text,text,bigint,integer)",
  "begin_account_spoken_provider_private_v1(text)",
  "mark_account_spoken_provider_unknown_private_v1(text)",
  "persist_account_spoken_success_private_v1(text,jsonb)",
  "load_account_spoken_success_private_v1(text)",
  "require_account_spoken_success_private_v1(text,jsonb)",
  "require_account_spoken_archive_private_v1(text,text,text)",
  "claim_captured_learner_audio_private_v1(jsonb)",
  "require_captured_learner_audio_private_v1(jsonb)",
  "settle_learner_audio_terminal_fact_private_v1(text,text,boolean,text,jsonb)",
  "list_closed_account_spoken_checkpoints_private_v1(integer)",
  "prepare_account_audio_delete_private_v1(text,integer)",
  "confirm_account_audio_delete_private_v1(text,bigint,timestamp with time zone)",
  "fail_account_audio_delete_private_v1(text,bigint)",
  "settle_account_spoken_provider_refusal_private_v1(jsonb,integer)",
  "read_account_study_spoken_block_private_v1(text,text,text)",
  "require_account_study_spoken_available_private_v1(text,text,text)",
];
const writes = [
  "study_sessions_v2",
  "study_session_items_v2",
  "study_review_items",
  "study_attempts_v2",
  "study_spoken_answer_commands",
  "learner_audio_artifacts",
  "study_lesson_item_state_v2",
  "study_presentations_v2",
  "activity_qualifications",
  "account_streak_clocks",
  "song_streaks",
  "community_streaks",
  "song_streak_days",
  "song_streak_day_activities",
  "community_streak_days",
  "persona_activity_presentations",
];
const locks = [
  "communities",
  "users",
  "personas",
  "persona_community_bindings",
  "posts",
  "media_publication_projections",
  "media_post_submissions",
];

export async function proveActivityCompletionForwardAcl(connectionString: string): Promise<void> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `activity_completion_${suffix}`;
  const role = `activity_completion_acl_${suffix}`;
  const password = crypto.randomUUID().replaceAll("-", "");
  const scoped = new URL(connectionString);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const login = new URL(scoped);
  login.username = role;
  login.password = password;
  const admin = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  const serving = new Client({
    connectionString: login.toString(),
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  const clients = new Set<Client>();
  const sqlFailures: Array<{ code: unknown; table: unknown; column: unknown }> = [];
  const drainers: Array<() => Promise<unknown>> = [];
  let schemaCreated = false,
    roleCreated = false,
    loginChecks = 0;
  const clientFactory: PostgresClientFactory = (_url, config) => {
    const client = new Client(config);
    clients.add(client);
    return {
      connection: client.connection,
      connect: async () => {
        await client.connect();
        expect((await client.query("SELECT session_user::text,current_user::text")).rows).toEqual([
          { session_user: role, current_user: role },
        ]);
        loginChecks += 1;
      },
      query: async ({ text, values }) => {
        try {
          return await client.query({ text, values: values === undefined ? [] : [...values] });
        } catch (error) {
          if (error !== null && typeof error === "object")
            sqlFailures.push({
              code: Reflect.get(error, "code"),
              table: Reflect.get(error, "table"),
              column: Reflect.get(error, "column"),
            });
          // Only statement/constraint metadata from this synthetic owned schema.
          if (error !== null && typeof error === "object")
            console.error("activity-acl-statement", {
              statement: text.slice(0, 90),
              code: Reflect.get(error, "code"),
              constraint: Reflect.get(error, "constraint"),
              message: Reflect.get(error, "message"),
            });
          throw error;
        }
      },
      end: async () => {
        try {
          await client.end();
        } finally {
          clients.delete(client);
        }
      },
    };
  };
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${q(schema)}`);
    schemaCreated = true;
    await admin.query(`SET search_path TO ${q(schema)},pg_catalog`);
    const migrations = await loadPostgresMigrations();
    const predecessor = migrations.filter((entry) => Number(entry.version.slice(0, 4)) <= 268);
    expect(predecessor.map((entry) => Number(entry.version.slice(0, 4)))).toEqual(
      Array.from({ length: 268 }, (_, index) => index + 1),
    );
    const candidate = migrations.find(
      (entry) => entry.version === "0269_activity_completion_decisions.sql",
    );
    if (candidate === undefined) throw new Error("activity completion migration absent");
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: predecessor,
      expectedLedger: [],
    });
    await admin.query(
      `CREATE ROLE ${q(role)} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
    );
    roleCreated = true;
    expect(
      (
        await admin.query(
          "SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1",
          [role],
        )
      ).rows,
    ).toEqual([
      {
        rolcanlogin: true,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ]);
    await admin.query(`GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(role)}`);
    // Mirror SELECT on the ordinary fixture's old (through0247) read surface.
    // Later owner/capture tables remain private; do not blanket-grant them.
    const historicalReads = new Set(
      predecessor
        .filter((entry) => Number(entry.version.slice(0, 4)) <= 247)
        .flatMap((entry) =>
          [
            ...entry.sql.matchAll(
              /^CREATE (?:OR REPLACE )?(?:TABLE|VIEW) (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gmu,
            ),
          ]
            .map((match) => match[1])
            .filter((name): name is string => name !== undefined),
        ),
    );
    for (const name of historicalReads) {
      if (
        (await admin.query("SELECT to_regclass($1) AS relation", [`${schema}.${name}`])).rows[0]
          ?.relation !== null
      )
        await admin.query(`GRANT SELECT ON ${q(schema)}.${q(name)} TO ${q(role)}`);
    }
    await admin.query(`GRANT SELECT ON activity_qualifications TO ${q(role)}`);
    for (const table of writes)
      await admin.query(`GRANT INSERT,UPDATE ON ${q(table)} TO ${q(role)}`);
    for (const table of locks) await admin.query(`GRANT UPDATE ON ${q(table)} TO ${q(role)}`);
    for (const signature of functions)
      await admin.query(`GRANT EXECUTE ON FUNCTION ${q(schema)}.${signature} TO ${q(role)}`);
    await admin.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(schema)} GRANT ALL ON TABLES TO ${q(role)}`,
    );
    await admin.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(schema)} GRANT EXECUTE ON FUNCTIONS TO ${q(role)}`,
    );
    // Witness that the inherited defaults genuinely exist before269 consumes them.
    await admin.query(
      "CREATE TABLE acl_default_probe(id text); CREATE FUNCTION acl_default_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
    );
    expect(
      (
        await admin.query(
          "SELECT has_table_privilege($1,'acl_default_probe','INSERT,UPDATE,DELETE,TRUNCATE') AS mutation,has_function_privilege($1,'acl_default_probe()','EXECUTE') AS execute",
          [role],
        )
      ).rows,
    ).toEqual([{ mutation: true, execute: true }]);
    await admin.query("DROP TABLE acl_default_probe; DROP FUNCTION acl_default_probe()");
    const applied = await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: [...predecessor, candidate],
      expectedLedger: predecessor,
    });
    expect(applied).toMatchObject({ dryRun: false, result: { applied: [candidate.version] } });
    await serving.connect();
    expect((await serving.query("SELECT session_user::text,current_user::text")).rows).toEqual([
      { session_user: role, current_user: role },
    ]);
    expect(
      (
        await serving.query(
          "SELECT has_table_privilege(current_user,'activity_qualifications','SELECT') AS old_read,has_table_privilege(current_user,'activity_completion_decisions','SELECT') AS copied_read",
        )
      ).rows,
    ).toEqual([{ old_read: true, copied_read: true }]);
    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])
      expect(
        (
          await serving.query(
            "SELECT has_table_privilege(current_user,'activity_completion_decisions',$1) AS allowed",
            [privilege],
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
    expect(
      (
        await serving.query(
          "SELECT has_function_privilege(current_user,'capture_activity_completion_decision_private_v1()','EXECUTE') AS allowed",
        )
      ).rows,
    ).toEqual([{ allowed: false }]);
    for (const sql of [
      "INSERT INTO activity_completion_decisions DEFAULT VALUES",
      "UPDATE activity_completion_decisions SET outcome=outcome",
      "DELETE FROM activity_completion_decisions",
      "TRUNCATE activity_completion_decisions",
      "SELECT capture_activity_completion_decision_private_v1()",
    ])
      await expect(serving.query(sql)).rejects.toMatchObject({ code: "42501" });
    for (const table of ["participation_owners", "learner_audio_account_producer_captures"])
      await expect(serving.query(`SELECT 1 FROM ${q(table)}`)).rejects.toMatchObject({
        code: "42501",
      });
    for (const table of ["song_reward_offer_legs", "megapot_pool_drawings"])
      expect(
        (
          await serving.query(
            "SELECT has_any_column_privilege(current_user,$1,'UPDATE') AS allowed",
            [table],
          )
        ).rows,
      ).toEqual([{ allowed: false }]);

    const adminRuntime = makeDirectPostgresControlPlaneLayer(scoped.toString());
    await makeOwnedOrdinaryAccountBirthFixture(adminRuntime)("study-account");
    const { lines } = await insertStudySongFixture(admin, { accountAlreadyBorn: true });
    const f: Fixture = {
      admin,
      serving,
      schema,
      role,
      runtimeUrl: login.toString(),
      lines,
      candidate: "0262_ordinary_audio_producer_capture.sql",
      runtime: (options) =>
        makeDirectPostgresControlPlaneLayer(login.toString(), { ...options, clientFactory }),
      registerDrain: (drain) => drainers.push(drain),
      deferDestructiveCleanup: () => {
        throw new Error("ACL fixture cleanup cannot be deferred");
      },
      destructiveCleanupDeferred: () => false,
    };
    await proveGuestStudyCompletionOwnerRepair({
      admin,
      serving,
      role,
      schema,
      lines,
      runtime: f.runtime(),
      connectionString: scoped.toString(),
      sqlFailures,
    });
    const objects = new Map<string, Uint8Array>();
    const ordinary = harness(f, {
      put: async (key, bytes) => {
        objects.set(key, new Uint8Array(bytes));
        return { size: bytes.byteLength };
      },
    });
    const reads = makeControlPlaneActivityCompletionStore(f.runtime());
    const identity = {
      accountId: "study-account",
      communityId: "study-community",
      readAt: new Date().toISOString(),
    };
    expect(
      (await Effect.runPromise(reads.getProgress({ ...identity, postId: "study-post" }))).streak
        .total_days,
    ).toBe(0);
    let session = await ordinary.start("acl-completion-session");
    const answers = [];
    const inputs = [];
    for (let index = 0; session.status === "active" && index < 4; index += 1) {
      const input = await ordinary.input(session, `acl-card-${index}`);
      inputs.push(input);
      const answer = await Effect.runPromise(ordinary.submit(input));
      answers.push(answer);
      session = answer.session;
    }
    expect(session.status).toBe("completed");
    expect(answers).toHaveLength(4);
    expect(objects.size).toBe(4);
    expect(
      (
        await serving.query(
          "SELECT outcome FROM activity_completion_decisions WHERE session_id=$1",
          [session.session_id],
        )
      ).rows,
    ).toEqual([{ outcome: "qualified" }]);
    const request = {
      ...identity,
      activity: "study" as const,
      sessionId: session.session_id,
      attemptId: null,
    };
    const completion = await Effect.runPromise(reads.getCompletion(request));
    expect(completion.decision).toMatchObject({
      status: "qualified",
      earned_day: {
        status: "recorded",
        song_day_newly_earned: true,
        community_day_newly_earned: true,
      },
    });
    const finalInput = inputs.at(-1);
    const finalAnswer = answers.at(-1);
    if (finalInput === undefined || finalAnswer === undefined)
      throw new Error("final ordinary input or answer missing");
    const tables = (
      await admin.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [
        schema,
      ])
    ).rows as Array<{ tablename: string }>;
    // Accepted access helpers take FOR SHARE locks, so read-only transaction
    // mode would reject valid reads. Compare every table in this owned schema
    // instead: receipts, private evidence, projections and all other rows.
    const snapshot = async () => {
      const rows: Record<string, unknown> = {};
      for (const { tablename } of tables) {
        rows[tablename] = (
          await admin.query(
            `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${q(schema)}.${q(tablename)} t`,
          )
        ).rows;
      }
      return rows;
    };
    const before = await snapshot();
    expect(await Effect.runPromise(ordinary.submit(finalInput))).toEqual(finalAnswer);
    expect(objects.size).toBe(4);
    expect(ordinary.calls()).toBe(4);
    expect(await Effect.runPromise(reads.getCompletion(request))).toEqual(completion);
    expect(
      (await Effect.runPromise(reads.getProgress({ ...identity, postId: "study-post" }))).streak
        .total_days,
    ).toBe(1);
    await Effect.runPromise(reads.getPresentation(identity));
    const failure = await Effect.runPromise(
      reads.getCompletion({ ...request, accountId: "private-foreign-marker" }).pipe(Effect.flip),
    );
    expect(failure).toMatchObject({ reason: "not-found" });
    expect(JSON.stringify(toErrorBody(failure))).not.toContain("private-foreign-marker");
    expect(await snapshot()).toEqual(before);
    expect(loginChecks).toBeGreaterThan(0);
    expect(
      (
        await serving.query(
          "SELECT has_function_privilege(current_user,'capture_activity_completion_decision_private_v1()','EXECUTE') AS allowed",
        )
      ).rows,
    ).toEqual([{ allowed: false }]);
  } finally {
    try {
      for (const drain of drainers) await drain();
    } finally {
      try {
        await serving.end();
        for (const client of clients) await client.end();
      } finally {
        try {
          if (schemaCreated) await admin.query(`DROP SCHEMA ${q(schema)} CASCADE`);
          if (roleCreated) await admin.query(`DROP ROLE ${q(role)}`);
        } finally {
          await admin.end();
        }
      }
    }
  }
}
