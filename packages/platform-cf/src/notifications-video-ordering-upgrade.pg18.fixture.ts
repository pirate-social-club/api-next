import { expect } from "bun:test";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { withInbox } from "./notifications.pg-fixture.ts";
import { provisionNotificationsVideoAclRoles } from "./notifications-video-acl.pg-fixture.ts";
import type { VideoMatrixFixture } from "./notifications-video-matrix.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

// The dedicated hosted invocation supplies both values before importing the
// maintained inbox fixture. Changing either value later cannot retarget it.
const inboxConnectionAtImport = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;

export function validateVideoUpgradeTarget(
  value: string | undefined,
  inboxConnection: string | undefined,
): string {
  if (!value || value !== inboxConnection)
    throw new Error("Video upgrade and maintained inbox targets must be identical");
  const url = new URL(value);
  const entries = Array.from(url.searchParams.entries());
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new Error("Video upgrade requires PostgreSQL");
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "5432" ||
    url.pathname !== "/postgres" ||
    url.username !== "postgres" ||
    url.hash ||
    entries.length !== 1 ||
    entries[0]?.[0] !== "sslmode" ||
    entries[0]?.[1] !== "disable"
  )
    throw new Error("Video upgrade requires the literal loopback disposable PostgreSQL target");
  return url.toString();
}

async function requirePostgres186(connectionString: string) {
  const client = new Client({ connectionString });
  const failures: unknown[] = [];
  try {
    await client.connect();
    expect(
      Number((await client.query("SHOW server_version_num")).rows[0]?.server_version_num),
    ).toBe(180006);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await client.end();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "PostgreSQL18 probe and cleanup failed");
}

function requireScopedTarget(connectionString: string, schema: string, base: string) {
  const scoped = new URL(connectionString);
  if (
    !/^api_next_notifications_[0-9a-f]{32}$/u.test(schema) ||
    scoped.searchParams.getAll("options").length !== 1 ||
    scoped.searchParams.get("options") !== `-c search_path=${schema}`
  )
    throw new Error("Video upgrade requires its owned schema-scoped inbox connection");
  scoped.searchParams.delete("options");
  if (scoped.toString() !== base) throw new Error("Maintained inbox used another target");
}

type UpgradeFixture = VideoMatrixFixture &
  Readonly<{
    runtimeClient: Client;
    runtimeRole: string;
    inheritedRole: string;
    readerRuntime: ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
    upgrade: () => Promise<void>;
  }>;

// Full-schema DROP CASCADE exceeds the default PG18 lock table. Reduce only
// this disposable schema in small committed groups after the proof; unchanged
// withInbox still owns final schema removal and role/socket cleanup.
async function reduceOwnedUpgradeSchema(admin: Client, schema: string, expectedOid: number) {
  if (!/^api_next_notifications_[0-9a-f]{32}$/u.test(schema))
    throw new Error("Owned video upgrade schema required for cleanup");
  const identity = async () =>
    (
      await admin.query<{ oid: number; owner: string; actor: string }>(
        `SELECT oid,pg_get_userbyid(nspowner) AS owner,current_user AS actor
        FROM pg_catalog.pg_namespace WHERE nspname=$1`,
        [schema],
      )
    ).rows;
  const initial = await identity();
  expect(initial).toHaveLength(1);
  expect(initial[0]).toEqual({ oid: expectedOid, owner: "postgres", actor: "postgres" });
  for (let batch = 0; batch < 128; batch++) {
    await admin.query("BEGIN");
    try {
      expect(await identity()).toEqual(initial);
      const group = (
        await admin.query<{ statement: string }>(
          `SELECT pg_catalog.format('DROP %s IF EXISTS %I.%I CASCADE',
            CASE relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE'
              WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
              WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'c' THEN 'TYPE' END,
            $1::text,relname) AS statement
          FROM pg_catalog.pg_class WHERE relnamespace=$2::oid
            AND relkind IN ('r','p','v','m','f','c')
          ORDER BY CASE relkind WHEN 'v' THEN 0 WHEN 'm' THEN 0
            WHEN 'r' THEN 1 WHEN 'p' THEN 1 WHEN 'f' THEN 2 WHEN 'c' THEN 3 END,relname
          LIMIT 10`,
          [schema, initial[0]?.oid],
        )
      ).rows;
      for (const { statement } of group) await admin.query(statement);
      const locks = Number(
        (await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE pid=pg_backend_pid()"))
          .rows[0]?.n,
      );
      if (!Number.isSafeInteger(locks) || locks > 1000)
        throw new Error("Video upgrade cleanup lock ceiling exceeded");
      await admin.query("COMMIT");
      if (group.length === 0) return;
    } catch (error) {
      try {
        await admin.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Video upgrade cleanup rollback failed");
      }
      throw error;
    }
  }
  throw new Error("Video upgrade cleanup batch bound exceeded");
}

export async function withVideoOrderingUpgrade(use: (fixture: UpgradeFixture) => Promise<void>) {
  const base = validateVideoUpgradeTarget(
    process.env.CONTROL_PLANE_POSTGRES18_VIDEO_UPGRADE_TEST_URL,
    inboxConnectionAtImport,
  );
  if (process.env.CONTROL_PLANE_POSTGRES_TEST_URL !== inboxConnectionAtImport)
    throw new Error("Maintained inbox target changed after import");
  // This occurs before withInbox may create any schema or role.
  await requirePostgres186(base);
  const migrations = await loadPostgresMigrations();
  expect(migrations).toHaveLength(275);
  expect(migrations.at(-1)).toMatchObject({
    version: "0275_video_root_comment_ordering.sql",
    checksum: "ce3a162f0ff721e78bec5fdb065b9da8dc0cdbfb1371aaba4c3952eaa503c8d4",
  });
  const prefix = migrations.slice(0, -1).map(({ version, checksum }) => ({ version, checksum }));
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const runtimeRole = `notifications_upgrade_${suffix}r`;
  const inheritedRole = `notifications_upgrade_${suffix}g`;
  const operatorRole = `notifications_upgrade_${suffix}o`;
  const password = crypto.randomUUID(); // ephemeral local fixture only, never emitted
  const clients: Client[] = [];
  let upgradeAttempted = false;
  await withInbox(
    async (f) => {
      const schema = new URL(f.url).searchParams.get("options")?.slice("-c search_path=".length);
      if (!schema) throw new Error("Scoped inbox schema required");
      requireScopedTarget(f.url, schema, base);
      expect(
        (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version"))
          .rows,
      ).toEqual(prefix);
      const readerUrl = new URL(f.url);
      const schemaOid = Number(
        (await f.admin.query("SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1", [schema]))
          .rows[0]?.oid,
      );
      if (!Number.isSafeInteger(schemaOid) || schemaOid <= 0)
        throw new Error("Original owned upgrade schema identity required");
      readerUrl.username = runtimeRole;
      readerUrl.password = password;
      const runtimeClient = new Client({ connectionString: readerUrl.toString() });
      clients.push(runtimeClient);
      await runtimeClient.connect();
      expect(
        (await runtimeClient.query("SELECT current_user AS role,session_user AS session_role"))
          .rows,
      ).toEqual([{ role: runtimeRole, session_role: runtimeRole }]);
      const upgrade = async () => {
        if (upgradeAttempted) throw new Error("Video upgrade fixture does not retry");
        upgradeAttempted = true;
        const result = await runPostgresMigrations({
          connectionString: f.url,
          migrations,
          expectedLedger: prefix,
        });
        expect(result).toEqual({
          dryRun: false,
          result: {
            applied: ["0275_video_root_comment_ordering.sql"],
            currentVersion: "0275_video_root_comment_ordering.sql",
          },
        });
        expect(
          (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version"))
            .rows,
        ).toEqual(migrations.map(({ version, checksum }) => ({ version, checksum })));
      };
      const failures: unknown[] = [];
      try {
        await use({
          ...f,
          runtimeClient,
          runtimeRole,
          inheritedRole,
          readerRuntime: makeDirectPostgresControlPlaneLayer(readerUrl.toString()),
          upgrade,
        });
        expect(upgradeAttempted).toBe(true);
      } catch (error) {
        failures.push(error);
      }
      try {
        requireScopedTarget(f.url, schema, base);
        await reduceOwnedUpgradeSchema(f.admin, schema, schemaOid);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Video upgrade proof and bounded cleanup failed");
    },
    async (admin, schema, scopedUrl) => {
      requireScopedTarget(scopedUrl, schema, base);
      expect(
        Number((await admin.query("SHOW server_version_num")).rows[0]?.server_version_num),
      ).toBe(180006);
      return provisionNotificationsVideoAclRoles({
        admin,
        schema,
        runtimeRole,
        inheritedRole,
        operatorRole,
        password,
        clients,
      });
    },
    "pre_video_ordering_migrations",
  );
}

export async function readVideoUpgradeFunctions(f: UpgradeFixture) {
  return (
    await f.admin.query<{
      function_name: string;
      owner: string;
      security_definer: boolean;
      settings: string[] | null;
      acl: string | null;
      runtime_execute: boolean;
      runtime_owns: boolean;
      body_sha256: string;
    }>(
      `SELECT p.proname AS function_name,pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,p.proconfig AS settings,p.proacl::text AS acl,
       has_function_privilege($1,p.oid,'EXECUTE') AS runtime_execute,
       pg_has_role($1,p.proowner,'MEMBER') AS runtime_owns,
       encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256
      FROM pg_proc p WHERE p.oid IN (
        'resolve_comment_navigation_v1(text,text)'::regprocedure,
        'list_post_comment_children_v1(text,text,text,text)'::regprocedure
      ) ORDER BY p.proname`,
      [f.runtimeRole],
    )
  ).rows;
}

export async function readVideoUpgradeHistory(f: UpgradeFixture) {
  const history: Record<string, unknown> = {};
  for (const table of [
    "users",
    "communities",
    "community_memberships",
    "posts",
    "comments",
    "text_content_submissions",
    "media_post_submissions",
    "media_submission_command_replays",
    "content_publication_outbox",
    "notification_inbox",
    "notification_publication_deliveries",
    "video_alias_audit_runs_v1",
    "video_alias_audit_items_v1",
    "video_notification_cutovers_v1",
  ]) {
    history[table] = (
      await f.admin.query(`SELECT COALESCE(jsonb_agg(to_jsonb(entry)
      ORDER BY to_jsonb(entry)::text),'[]'::jsonb) AS document FROM ${table} entry`)
    ).rows[0]?.document;
  }
  history.receipt_bytes = (
    await f.admin.query(`SELECT submission_id,encode(response_snapshot_bytes,'hex') AS bytes,
    response_snapshot_sha256 FROM text_content_submissions ORDER BY submission_id`)
  ).rows;
  return history;
}
