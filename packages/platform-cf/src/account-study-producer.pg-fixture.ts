// Draft copied beside platform-cf/src only after root adopts the real ordinary
// producer packet. No rendered baseline, external SQL or fixture producer rows.
import { expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Clock, IdGen, type StudyBatchTranscriber, StudyV2StoreFailed } from "@pirate/application";
import {
  makeControlledAccountSpokenService,
  type AccountSpokenInput,
  type ControlledAccountSpokenProtocol,
} from "@pirate/application/controlled-account-spoken";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientFactory,
  type PostgresControlPlaneOptions,
} from "./postgres.ts";
import {
  insertStudySongFixture,
  insertTelegramPracticeReadinessFixture,
} from "./study-v2-ready-song.pg-fixture.ts";
import { makeControlledAccountStudyV2Store } from "./controlled-account-study-store.ts";
import { makeAccountControlledSpokenProtocol } from "./account-spoken-producer-protocol.ts";
import type { CapturedStudyAudioBucket } from "./learner-audio-captured-io.ts";
import type { StudyV2Admission } from "./study-v2-repository.ts";

export const pgUrl = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !pgUrl)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
export const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
export const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
export const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.scoped(e));
export const rejected = <A, E>(e: Effect.Effect<A, E>) => run(Effect.flip(e));
export async function bounded<A>(
  promise: Promise<A>,
  label: string,
  milliseconds = 5000,
): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Owned fixture ${label} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const privateTables = [
  "learner_audio_account_producer_captures",
  "learner_audio_upload_terminal_facts",
  "learner_audio_upload_cleanup_commands",
  "learner_audio_account_spoken_checkpoints",
  "learner_audio_account_provider_calls",
] as const;
// Every function owned by the new producer migration, including trigger/private
// helpers, is probed BEFORE any controlled EXECUTE grant is introduced.
export const producerFunctions = [
  "lock_account_audio_group_private_v1(text)",
  "lock_original_account_audio_source_private_v1(text)",
  "capture_account_study_audio_private_v1(text,text,text,text)",
  "capture_account_karaoke_audio_private_v1(text,text,text)",
  "note_learner_audio_multipart_id_private_v1(text,text)",
  "close_unclaimed_learner_audio_private_v1(text)",
  "persist_account_spoken_success_private_v1(text,jsonb)",
  "settle_learner_audio_terminal_fact_private_v1(text,text,boolean,text,jsonb)",
  "read_captured_learner_audio_private_v1(text)",
  "require_captured_learner_audio_private_v1(jsonb)",
  "read_learner_audio_upload_status_private_v1(text)",
  "claim_captured_learner_audio_private_v1(jsonb)",
  "continue_captured_learner_audio_private_v1(jsonb)",
  "guard_account_audio_provider_call_private_v1()",
  "begin_account_spoken_provider_private_v1(text)",
  "mark_account_spoken_provider_unknown_private_v1(text)",
  "learner_audio_producer_component_has_history_private_v1(text[])",
  "find_account_spoken_success_private_v1(text,text,text,integer,text,text,text,bigint,integer)",
  "load_account_spoken_success_private_v1(text)",
  "require_account_spoken_success_private_v1(text,jsonb)",
  "require_account_spoken_archive_private_v1(text,text,text)",
  "prepare_account_audio_delete_private_v1(text,integer)",
  "confirm_account_audio_delete_private_v1(text,bigint,timestamp with time zone)",
  "fail_account_audio_delete_private_v1(text,bigint)",
  "register_learner_audio_upload_private_v1(text,text,text,text,text,text,text,text,bigint)",
  "guard_captured_audio_cleanup_private_v1()",
  "prepare_captured_audio_cleanup_private_v1(jsonb)",
  "confirm_captured_audio_cleanup_private_v1(text,text,text,timestamp with time zone)",
  "list_closed_account_spoken_checkpoints_private_v1(integer)",
  "read_account_karaoke_audio_capture_private_v1(text,text,text,text)",
  "require_captured_karaoke_recording_result_private_v1(text,text,text,text,jsonb)",
  "require_captured_audio_deletion_stop_private_v1(jsonb)",
  "karaoke_audio_target_can_tombstone_private_v1(text,text,text)",
  "guard_karaoke_recording()",
  "confirm_learner_audio_delete_private_v1(text,bigint,text,timestamp with time zone)",
] as const;
// Only methods actually invoked by the ordinary Study SDK in this test. No raw
// 0253 helper, owner/core/resource table, Karaoke method or multipart grant.
const controlledFunctions = [
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
] as const;

async function migrations() {
  const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      algorithm: Schema.Literal("sha256"),
      migrations: Schema.Record(Schema.String, Schema.String),
    }),
  )(JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")));
  const names = (await readdir(directory)).filter((n) => /^\d{4}_.+\.sql$/u.test(n)).sort();
  // Bind the genuine adopted migration that defines the ordinary native producer,
  // wherever root places it. Never append the outside proposal to a real schema.
  const candidates: string[] = [];
  for (const name of names)
    if (
      Number(name.slice(0, 4)) > 260 &&
      /CREATE FUNCTION capture_account_study_audio_private_v1\(/u.test(
        await readFile(new URL(name, directory), "utf8"),
      )
    )
      candidates.push(name);
  if (candidates.length !== 1)
    throw new Error("Exactly one adopted ordinary producer migration is required");
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error("Adopted producer migration absent");
  const end = Number(candidate.slice(0, 4));
  const chosen = names.filter((n) => Number(n.slice(0, 4)) <= end);
  expect(chosen.map((n) => Number(n.slice(0, 4)))).toEqual(
    Array.from({ length: end }, (_, i) => i + 1),
  );
  expect(chosen[246]).toBe("0247_karaoke_instrumental_qualification_policy.sql");
  const all: PostgresMigration[] = [];
  for (const version of chosen) {
    const sql = await readFile(new URL(version, directory), "utf8");
    const checksum = hash(sql),
      declared = manifest.migrations[version];
    if (declared === undefined) throw new Error(`Maintained checksum missing for ${version}`);
    expect(checksum).toBe(declared);
    all.push({ version, checksum, sql });
  }
  return { historical: all.slice(0, 247), all, candidate };
}

// Fixture diagnostics expose statement names and backend constraint metadata,
// never connection strings, bound values, payloads or synthetic credentials.
const diagnosticClientFactory: PostgresClientFactory = (_url, config) => {
  const client = new Client(config);
  return {
    connection: client.connection,
    connect: () => client.connect(),
    end: () => client.end(),
    query: async ({ text, values }) => {
      try {
        return await client.query({ text, values: values === undefined ? [] : [...values] });
      } catch (error) {
        if (error !== null && typeof error === "object") {
          console.error(
            JSON.stringify({
              fixture: "ordinary-native-statement-failure",
              statement: text.slice(0, 80),
              code: Reflect.get(error, "code"),
              constraint: Reflect.get(error, "constraint"),
              message: Reflect.get(error, "message"),
            }),
          );
        }
        throw error;
      }
    },
  };
};

export function dropCommitAcknowledgement(needle: string) {
  let dropped = false;
  const clientFactory: PostgresClientFactory = (_url, config) => {
    const client = new Client(config);
    let touched = false;
    return {
      connection: client.connection,
      connect: () => client.connect(),
      end: () => client.end(),
      query: async ({ text, values }) => {
        const result = await client.query({
          text,
          values: values === undefined ? [] : [...values],
        });
        if (text.includes(needle)) touched = true;
        // This waits for the genuine successful backend COMMIT, then withholds
        // only its acknowledgement from the adapter. No fake query result.
        if (text === "COMMIT" && touched && !dropped) {
          dropped = true;
          throw new Error("owned ordinary producer COMMIT acknowledgement withheld");
        }
        return result;
      },
    };
  };
  return { clientFactory, observed: () => dropped };
}

export type Fixture = {
  admin: Client;
  serving: Client;
  schema: string;
  role: string;
  runtimeUrl: string;
  lines: readonly string[];
  candidate: string;
  runtime: (
    options?: PostgresControlPlaneOptions,
  ) => ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
  registerDrain: (drain: () => Promise<unknown>) => void;
};
export async function fixture(use: (f: Fixture) => Promise<void>) {
  if (!pgUrl) throw new Error("Owned Postgres URL missing");
  if (!["127.0.0.1", "localhost"].includes(new URL(pgUrl).hostname))
    throw new Error("Owned loopback PostgreSQL required");
  const packet = await migrations(),
    suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `account_capture_${suffix}`,
    role = `account_capture_login_${suffix}`;
  const password = hash(randomBytes(32)); // synthetic fixture-only credential
  const admin = new Client({
    connectionString: pgUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  let serving: Client | undefined,
    schemaCreated = false,
    roleCreated = false;
  const drainers: Array<() => Promise<unknown>> = [];
  let primaryFailure: unknown;
  try {
    await bounded(admin.connect(), "admin initial connect", 5000);
    await admin.query(`CREATE SCHEMA ${q(schema)}`);
    schemaCreated = true;
    await admin.query(`SET search_path TO ${q(schema)},pg_catalog`);
    const scoped = new URL(pgUrl);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: packet.historical,
      expectedLedger: [],
    });
    const { lines } = await insertStudySongFixture(admin);
    await insertTelegramPracticeReadinessFixture(admin);
    expect((await admin.query("SHOW session_replication_role")).rows).toEqual([
      { session_replication_role: "origin" },
    ]);
    const roleSql = await admin.query<{ sql: string }>(
      "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) AS sql",
      [role, password],
    );
    const create = roleSql.rows[0]?.sql;
    if (create === undefined) throw new Error("Role command missing");
    await admin.query(create);
    roleCreated = true;
    await admin.query(`GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(role)}`);
    // Probe inherited default grants: native migrations must revoke these new
    // private objects. Historical SELECT is the existing account read surface.
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${q(schema)} TO ${q(role)}`);
    await admin.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(schema)} GRANT ALL ON TABLES TO ${q(role)}`,
    );
    await admin.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(schema)} GRANT EXECUTE ON FUNCTIONS TO ${q(role)}`,
    );
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: packet.all,
      expectedLedger: packet.historical,
    });
    expect(
      (await admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(packet.all.map(({ version, checksum }) => ({ version, checksum })));
    expect(
      (await admin.query("SELECT phase FROM guest_learning_schema_phase WHERE singleton")).rows,
    ).toEqual([{ phase: "practice_only_owner_audio_producer_history_v5" }]);
    await admin.query("SELECT require_guest_practice_only_schema_phase_v1()");
    const runtimeUrl = new URL(scoped);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    serving = new Client({
      connectionString: runtimeUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    await bounded(serving.connect(), "serving initial connect", 5000);
    expect(
      (await serving.query("SELECT current_user::text AS current,session_user::text AS session"))
        .rows,
    ).toEqual([{ current: role, session: role }]);
    const migrationOwner = (
      await admin.query<{ owner: string }>(
        "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='participation_owners'::regclass",
      )
    ).rows[0]?.owner;
    if (migrationOwner === undefined) throw new Error("Migration owner missing");
    await expect(serving.query(`SET ROLE ${q(migrationOwner)}`)).rejects.toMatchObject({
      code: "42501",
    });
    for (const table of privateTables) {
      expect(
        (
          await admin.query(
            "SELECT c.relowner=o.relowner AS same_owner,c.relnamespace=o.relnamespace AS same_namespace,c.relkind FROM pg_class c CROSS JOIN pg_class o WHERE c.oid=$1::regclass AND o.oid='participation_owners'::regclass",
            [`${schema}.${table}`],
          )
        ).rows,
      ).toEqual([{ same_owner: true, same_namespace: true, relkind: "r" }]);
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
      ])
        expect(
          (
            await serving.query("SELECT has_table_privilege(current_user,$1,$2) AS allowed", [
              `${schema}.${table}`,
              privilege,
            ])
          ).rows,
        ).toEqual([{ allowed: false }]);
      await expect(serving.query(`SELECT 1 FROM ${q(table)} LIMIT 1`)).rejects.toMatchObject({
        code: "42501",
      });
    }
    for (const table of [
      "participation_owners",
      "guest_learning_schema_phase",
      "learner_audio_owner_fences",
      "learner_audio_upload_attempts",
    ])
      await expect(serving.query(`SELECT 1 FROM ${q(table)} LIMIT 1`)).rejects.toMatchObject({
        code: "42501",
      });
    for (const signature of producerFunctions) {
      const rows = await admin.query(
        "SELECT p.proowner=c.relowner AS same_owner,p.pronamespace=c.relnamespace AS same_namespace,p.proconfig,has_function_privilege($1,p.oid,'EXECUTE') AS allowed FROM pg_proc p CROSS JOIN pg_class c WHERE p.oid=$2::regprocedure AND c.oid='participation_owners'::regclass",
        [role, `${schema}.${signature}`],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        same_owner: true,
        same_namespace: true,
        allowed: false,
      });
      const frame = rows.rows[0]?.proconfig;
      if (!Array.isArray(frame))
        throw new Error(`Private native search path missing: ${signature}`);
      expect(frame).toContain(`search_path=pg_catalog, ${schema}, pg_temp`);
    }
    // These native raw primitives remain inaccessible even AFTER controlled grants.
    for (const signature of [
      "lock_learner_audio_sources_private_v1(text[])",
      "register_learner_audio_upload_private_v1(text,text,text,text,text,text,text,text,bigint)",
      "claim_learner_audio_upload_private_v1(text)",
      "prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)",
    ])
      expect(
        (
          await serving.query(
            "SELECT has_function_privilege(current_user,$1::regprocedure,'EXECUTE') AS allowed",
            [`${schema}.${signature}`],
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
    expect(
      (
        await serving.query(
          "SELECT has_sequence_privilege(current_user,'learner_audio_fence_revision_v1','USAGE') AS allowed",
        )
      ).rows,
    ).toEqual([{ allowed: false }]);
    const legacyWrites = [
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
      "telegram_study_conversations",
    ];
    for (const table of legacyWrites)
      await admin.query(`GRANT INSERT,UPDATE ON ${q(table)} TO ${q(role)}`);
    // PostgreSQL requires UPDATE privilege for the genuine admission's FOR
    // SHARE row locks even though this fixture never mutates these authority
    // parents through the serving connection.
    for (const table of [
      "communities",
      "community_telegram_integrations",
      "users",
      "personas",
      "persona_community_bindings",
      "telegram_bot_grants",
      "telegram_account_associations",
      "posts",
      "media_publication_projections",
      "media_post_submissions",
      // The existing Account qualification projection locks prospective legs
      // even when no eligible offer exists. Guest roles receive no such grant.
      "song_reward_offer_legs",
    ])
      await admin.query(`GRANT UPDATE ON ${q(table)} TO ${q(role)}`);
    for (const signature of controlledFunctions)
      await admin.query(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO ${q(role)}`);
    const f: Fixture = {
      admin,
      serving,
      schema,
      role,
      runtimeUrl: runtimeUrl.toString(),
      lines,
      candidate: packet.candidate,
      runtime: (options) =>
        makeDirectPostgresControlPlaneLayer(runtimeUrl.toString(), {
          closeTimeoutMs: 2000,
          clientFactory: diagnosticClientFactory,
          ...options,
        }),
      registerDrain: (drain) => drainers.push(drain),
    };
    await use(f);
    for (const table of privateTables)
      expect(
        (
          await serving.query(
            "SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE') AS allowed",
            [`${schema}.${table}`],
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const failures: Error[] = [];
    const attempt = async (label: string, action: () => Promise<unknown>, ms: number) => {
      try {
        await bounded(action(), label, ms);
      } catch {
        failures.push(new Error(`Owned fixture cleanup failed: ${label}`));
      }
    };
    // Each schema/role cleanup uses its own bounded connection: one timed-out
    // statement cannot queue every later cleanup behind the original client.
    const cleanupQuery = async (text: string) => {
      const cleaner = new Client({
        connectionString: pgUrl,
        connectionTimeoutMillis: 2000,
        statement_timeout: 3000,
        query_timeout: 3500,
      });
      try {
        await bounded(cleaner.connect(), "cleanup connect", 2500);
        await bounded(cleaner.query(text), "cleanup query", 4000);
      } finally {
        await bounded(cleaner.end(), "cleanup client close", 1500);
      }
    };
    await attempt(
      "all producer background drains",
      () => Promise.all(drainers.map((drain) => drain())),
      8000,
    );
    await attempt(
      "serving client close",
      async () => {
        await serving?.end();
      },
      2000,
    );
    if (schemaCreated)
      await attempt(
        "owned schema removal",
        () => cleanupQuery(`DROP SCHEMA ${q(schema)} CASCADE`),
        8000,
      );
    if (roleCreated)
      await attempt("owned login removal", () => cleanupQuery(`DROP ROLE ${q(role)}`), 8000);
    await attempt("admin client close", () => admin.end(), 2000);
    if (failures.length)
      throw new AggregateError(
        primaryFailure === undefined ? failures : [primaryFailure, ...failures],
        "Owned fixture cleanup did not complete",
      );
  }
}

export function harness(
  f: Fixture,
  bucket: CapturedStudyAudioBucket,
  options: PostgresControlPlaneOptions = {},
  admission?: StudyV2Admission,
) {
  const runtime = f.runtime(options),
    store = makeControlledAccountStudyV2Store(runtime, admission);
  const tasks: Promise<unknown>[] = [];
  const drain = () => Promise.all(tasks);
  f.registerDrain(drain);
  const protocol = makeAccountControlledSpokenProtocol(
    runtime,
    store.reserve,
    store.finalize,
    bucket,
    (p) => tasks.push(p),
  );
  let calls = 0,
    ids = 0;
  const transcriber: StudyBatchTranscriber = {
    providerRetention: "stored",
    transcribe: Effect.fn("accountProducerFixture.transcribe")(function* (
      input: Parameters<StudyBatchTranscriber["transcribe"]>[0],
    ) {
      yield* Effect.promise(async () => {
        const evidence = await f.admin.query(
          "SELECT c.account_id,c.source_kind,u.io_state FROM learner_audio_account_producer_captures c JOIN learner_audio_upload_attempts u USING(upload_attempt_id) JOIN learner_audio_account_provider_calls p USING(upload_attempt_id) WHERE c.content_digest=$1 AND p.state='started'",
          [hash(input.audio)],
        );
        expect(evidence.rows).toEqual([
          { account_id: "study-account", source_kind: "study", io_state: "registered" },
        ]);
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=$1 AND xact_start IS NOT NULL",
              [f.role],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
      });
      calls++;
      return {
        transcript: new TextDecoder().decode(input.audio),
        detectedLanguage: "en",
        detectedLanguageConfidence: 0.99,
      };
    }),
  };
  const submit = (
    input: AccountSpokenInput,
    custom: ControlledAccountSpokenProtocol = protocol,
    provider: StudyBatchTranscriber | null = transcriber,
  ) =>
    makeControlledAccountSpokenService(store.ordinary, custom, provider, false)
      .submitSpokenAnswer(input)
      .pipe(
        Effect.provideService(Clock, { now: Effect.sync(() => Date.now()) }),
        Effect.provideService(IdGen, {
          next: Effect.sync(() => {
            ids++;
            return crypto.randomUUID();
          }),
        }),
      );
  const start = (sessionId: string) =>
    run(
      store.ordinary.startSession({
        accountId: "study-account",
        personaId: "study-persona",
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
    );
  const input = async (
    session: Awaited<ReturnType<typeof start>>,
    key: string,
  ): Promise<AccountSpokenInput> => {
    const current = session.lesson.current;
    if (current === null) throw new Error("Current item required");
    const base = {
      accountId: "study-account",
      communityId: "study-community",
      sessionId: session.session_id,
      sessionItemId: current.session_item_id,
      idempotencyKey: key,
    };
    const context = await run(store.ordinary.loadSpokenAnswerContext(base));
    return {
      ...base,
      attemptNumber: current.presentation_number,
      audio: new TextEncoder().encode(context.referenceText),
      audioContentType: "audio/webm",
      audioDurationMs: 1000,
    };
  };
  return {
    runtime,
    store,
    protocol,
    submit,
    start,
    input,
    calls: () => calls,
    ids: () => ids,
    drain,
    transcriber,
  };
}

export function deferred<A>() {
  let resolve!: (a: A) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<A>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
export const stopBeforeFinalize = (
  base: ControlledAccountSpokenProtocol,
): ControlledAccountSpokenProtocol => ({
  ...base,
  finalize: Effect.fn("accountProducerFixture.stopBeforeFinalize")(function* () {
    return yield* new StudyV2StoreFailed({ reason: "unavailable" });
  }),
});
