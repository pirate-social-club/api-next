import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import {
  HNS_AUTHORITY_SERVICE_VERSION,
  HNS_LIFECYCLE_JOB_ENVELOPE_VERSION,
} from "../apps/hns-authority-provisioner/src/schema-compatibility.ts";
import { loadPostgresMigrations, runPostgresMigrations } from "./postgres-migrations";
import {
  HNS_STAGING_BRANCH_ID,
  HNS_STAGING_BRANCH_NAME,
  HNS_STAGING_DATABASE_ID,
  HNS_STAGING_PROVIDER_DATABASE_NAME,
  HNS_STAGING_SERVICE_UNIT,
  HNS_STAGING_SQL_DATABASE,
  type HnsStagingPostMigrationPorts,
  type HnsStagingTargetBinding,
} from "./staging-hns-post-migration-contract.ts";
import {
  HnsStagingPostMigrationRefused,
  runHnsStagingPostMigration,
} from "./staging-hns-post-migration-entry.ts";
import {
  applyStagingPostMigrationGrants,
  makeHnsStagingPostMigrationPorts,
  readStagingPostMigrationPrivilegeMatrix,
} from "./staging-hns-post-migration-runtime.ts";

const raw = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!raw && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("local test URL required");
const suite = raw ? describe : describe.skip;

const bundleSha = "a".repeat(64);
const executorId = "staging-entry-pg-executor";
const templateName = `hns_entry_template_${crypto.randomUUID().replaceAll("-", "")}`;
const createdDatabases = new Set<string>([templateName]);
const createdRoles = new Set<string>();
const stagedDirectories = new Set<string>();

interface Fixture {
  readonly url: URL;
}

function databaseUrl(name: string): URL {
  const url = new URL(raw ?? "");
  url.pathname = `/${name}`;
  url.searchParams.set("options", "-c search_path=api_next,pg_catalog");
  return url;
}

async function withRoot<A>(use: (root: Client) => Promise<A>): Promise<A> {
  const root = new Client({ connectionString: raw ?? "" });
  await root.connect();
  try {
    return await use(root);
  } finally {
    await root.end().catch(() => undefined);
  }
}

async function createRole(prefix: string): Promise<string> {
  const role = `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await withRoot(async (root) => {
    await root.query(`CREATE ROLE "${role}" LOGIN`);
  });
  createdRoles.add(role);
  return role;
}

async function stageableBundle(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hns-entry-bundle-"));
  stagedDirectories.add(directory);
  const path = join(directory, "pirate-hns-authority-provisioner.mjs");
  await writeFile(path, "export {};\n");
  return path;
}

async function cloneDatabase(): Promise<Fixture> {
  const name = `hns_entry_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await withRoot(async (root) => {
    await root.query(`CREATE DATABASE "${name}" TEMPLATE "${templateName}"`);
  });
  createdDatabases.add(name);
  return { url: databaseUrl(name) };
}

async function withAdmin<A>(fixture: Fixture, use: (client: Client) => Promise<A>): Promise<A> {
  const client = new Client({ connectionString: fixture.url.toString() });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function targetBinding(migrator: string): HnsStagingTargetBinding {
  return {
    database_id: HNS_STAGING_DATABASE_ID,
    database_name: HNS_STAGING_PROVIDER_DATABASE_NAME,
    sql_database: HNS_STAGING_SQL_DATABASE,
    branch_id: HNS_STAGING_BRANCH_ID,
    branch_name: HNS_STAGING_BRANCH_NAME,
    branch_ready: true,
    migrator_role: migrator,
  };
}

function makeRealPorts(
  fixture: Fixture,
  input: {
    readonly runtimeRole: string;
    readonly operatorRole: string;
    readonly migratorRole: string;
    readonly events: string[];
    readonly startService?: (unit: string) => Promise<void>;
  },
): HnsStagingPostMigrationPorts {
  const runtimeUrl = new URL(fixture.url);
  runtimeUrl.username = input.runtimeRole;
  const operatorUrl = new URL(fixture.url);
  operatorUrl.username = input.operatorRole;
  const ports = makeHnsStagingPostMigrationPorts({
    connection_strings: {
      admin: fixture.url.toString(),
      runtime: runtimeUrl.toString(),
      operator: operatorUrl.toString(),
    },
    target_binding: targetBinding(input.migratorRole),
    start_service: async (unit) => {
      input.events.push("start");
      await (input.startService ?? (async () => undefined))(unit);
    },
  });
  return {
    ...ports,
    seedExecutionProbe: async () => {
      input.events.push("seed");
      await ports.seedExecutionProbe();
    },
    stageBundle: async (stage) => {
      input.events.push("stage");
      await ports.stageBundle(stage);
    },
  };
}

function inputFor(
  fixture: Fixture,
  input: {
    readonly runtimeRole: string;
    readonly operatorRole: string;
    readonly migratorRole: string;
    readonly ports: HnsStagingPostMigrationPorts;
    readonly attemptId: string;
    readonly bundlePath?: string;
    readonly stageDirectory?: string;
  },
) {
  return {
    authorized: {
      database_id: HNS_STAGING_DATABASE_ID,
      database_name: HNS_STAGING_PROVIDER_DATABASE_NAME,
      sql_database: HNS_STAGING_SQL_DATABASE,
      branch_id: HNS_STAGING_BRANCH_ID,
      branch_name: HNS_STAGING_BRANCH_NAME,
      runtime_role: input.runtimeRole,
      operator_role: input.operatorRole,
      migrator_role: input.migratorRole,
      service_unit: HNS_STAGING_SERVICE_UNIT,
    },
    release: {
      service_version: HNS_AUTHORITY_SERVICE_VERSION,
      job_envelope_version: HNS_LIFECYCLE_JOB_ENVELOPE_VERSION,
    },
    bundle: {
      bundle_path: input.bundlePath ?? "/stage/source/pirate-hns-authority-provisioner.mjs",
      bundle_sha256: bundleSha,
      service_version: HNS_AUTHORITY_SERVICE_VERSION,
      job_envelope_version: HNS_LIFECYCLE_JOB_ENVELOPE_VERSION,
      executor_id: executorId,
    },
    stage_directory: input.stageDirectory ?? `/tmp/staging-hns-entry-${crypto.randomUUID()}`,
    ports: input.ports,
    new_attempt_id: () => input.attemptId,
    identity_poll: { timeout_ms: 0 },
  };
}

async function refusalOf(run: () => Promise<unknown>): Promise<Readonly<Record<string, unknown>>> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(HnsStagingPostMigrationRefused);
    return (error as HnsStagingPostMigrationRefused).refusal as unknown as Record<string, unknown>;
  }
  throw new Error("expected a refusal");
}

afterAll(async () => {
  if (!raw) return;
  for (const directory of stagedDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  await withRoot(async (root) => {
    for (const database of createdDatabases) {
      await root.query(`DROP DATABASE IF EXISTS "${database}"`);
    }
    for (const role of createdRoles) {
      await root.query(`DROP OWNED BY "${role}"`);
      await root.query(`DROP ROLE IF EXISTS "${role}"`);
    }
  });
}, 180_000);

suite("HNS staging post-migration entry point (PostgreSQL)", () => {
  test("prepares the template with the complete reviewed chain", async () => {
    await withRoot(async (root) => {
      await root.query(`CREATE DATABASE "${templateName}"`);
    });
    const fixture = { url: databaseUrl(templateName) };
    const url = fixture.url.toString();
    await withAdmin(fixture, async (admin) => {
      await admin.query("CREATE SCHEMA api_next");
    });
    await runPostgresMigrations({ connectionString: url });
    await withAdmin(fixture, async (admin) => {
      const ledger = await admin.query<{ version: string }>(
        "SELECT version FROM api_next.schema_migrations ORDER BY version",
      );
      expect(ledger.rows.at(-1)?.version).toBe("0172_hns_cutover_evidence_consistency.sql");
    });
  });

  test("verifies the ledger, applies the reviewed grants and stops at the absent service", async () => {
    const fixture = await cloneDatabase();
    const runtimeRole = await createRole("hns_runtime");
    const operatorRole = await createRole("hns_operator");
    process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL = fixture.url.toString();
    const bundlePath = await stageableBundle();
    const stageDirectory = await mkdtemp(join(tmpdir(), "hns-entry-stage-"));
    stagedDirectories.add(stageDirectory);
    const events: string[] = [];
    const started: string[] = [];
    const ports = makeRealPorts(fixture, {
      runtimeRole,
      operatorRole,
      migratorRole: "postgres",
      events,
      startService: async (unit) => {
        started.push(unit);
      },
    });
    const refusal = await refusalOf(() =>
      runHnsStagingPostMigration(
        inputFor(fixture, {
          runtimeRole,
          operatorRole,
          migratorRole: "postgres",
          ports,
          attemptId: "attempt-pg-00000001",
          bundlePath,
          stageDirectory,
        }),
      ),
    );
    expect(refusal).toMatchObject({
      step: "service_identity",
      reason: "service_never_started",
      service_disposition: {
        unit: HNS_STAGING_SERVICE_UNIT,
        disposition: "started_unverified",
        attempt_id: "attempt-pg-00000001",
      },
      recovery: {
        resumable: true,
        stop_service_before_rerun: true,
        attempt_id: "attempt-pg-00000001",
      },
    });
    expect(events).toEqual(["stage", "seed", "start"]);
    expect(started).toEqual([HNS_STAGING_SERVICE_UNIT]);
    await withAdmin(fixture, async (admin) => {
      const probe = await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1, 'api_next.run_hns_lifecycle_readiness_cutover_probe_v1(text,text,text,text,text,timestamptz)', 'EXECUTE') AS allowed",
        [runtimeRole],
      );
      expect(probe.rows[0]?.allowed).toBe(true);
      const writes = await admin.query<{ allowed: boolean }>(
        `SELECT bool_or(has_table_privilege($1, 'api_next.hns_lifecycle_service_identity', privilege)) AS allowed
           FROM unnest(ARRAY['INSERT','UPDATE','DELETE']) AS privilege`,
        [runtimeRole],
      );
      expect(writes.rows[0]?.allowed).toBe(false);
      const seeded = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM api_next.hns_root_import_lifecycle_jobs WHERE root_import_session_id = 'cutover-readiness-probe'",
      );
      expect(Number(seeded.rows[0]?.count)).toBeGreaterThan(0);
    });
  });

  test("the shared steps resolve api_next without a search_path option", async () => {
    const fixture = await cloneDatabase();
    const runtimeRole = await createRole("hns_runtime");
    const operatorRole = await createRole("hns_operator");
    // The shared cutover steps open the administrator connection themselves;
    // an authorized staging URL need not carry a search_path option, so the
    // qualified statements must resolve on their own.
    const plain = new URL(fixture.url);
    plain.searchParams.delete("options");
    expect(plain.searchParams.get("options")).toBeNull();
    process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL = plain.toString();
    const bundlePath = await stageableBundle();
    const events: string[] = [];
    const ports = makeRealPorts(fixture, {
      runtimeRole,
      operatorRole,
      migratorRole: "postgres",
      events,
    });
    const refusal = await refusalOf(() =>
      runHnsStagingPostMigration(
        inputFor(fixture, {
          runtimeRole,
          operatorRole,
          migratorRole: "postgres",
          ports,
          attemptId: "attempt-pg-plain-search-path",
          bundlePath,
        }),
      ),
    );
    // Reaching the service-identity step proves the six-argument probe grant,
    // the probe seed and the schema-compatibility read all resolved.
    expect(refusal).toMatchObject({
      step: "service_identity",
      reason: "service_never_started",
    });
    expect(events).toEqual(["stage", "seed", "start"]);
  });

  test("refuses a short ledger before applying grants or starting the service", async () => {
    const fixture = await cloneDatabase();
    const runtimeRole = await createRole("hns_runtime");
    const operatorRole = await createRole("hns_operator");
    process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL = fixture.url.toString();
    await withAdmin(fixture, async (admin) => {
      await admin.query(
        "DELETE FROM api_next.schema_migrations WHERE version >= '0170_hns_renewal_authoritative_evidence.sql'",
      );
    });
    const events: string[] = [];
    const ports = makeRealPorts(fixture, {
      runtimeRole,
      operatorRole,
      migratorRole: "postgres",
      events,
    });
    const refusal = await refusalOf(() =>
      runHnsStagingPostMigration(
        inputFor(fixture, {
          runtimeRole,
          operatorRole,
          migratorRole: "postgres",
          ports,
          attemptId: "attempt-pg-short-ledger",
        }),
      ),
    );
    expect(refusal).toMatchObject({
      step: "target_and_ledger",
      reason: "migration_endpoint_missing",
      detail: { expected: "0172_hns_cutover_evidence_consistency.sql" },
    });
    expect(events).toEqual([]);
    await withAdmin(fixture, async (admin) => {
      const probe = await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1, 'api_next.run_hns_lifecycle_readiness_cutover_probe_v1(text,text,text,text,text,timestamptz)', 'EXECUTE') AS allowed",
        [runtimeRole],
      );
      expect(probe.rows[0]?.allowed).toBe(false);
    });
  });

  test("refuses a checksum mismatch and an unreviewed migration beyond the endpoint", async () => {
    const checksumFixture = await cloneDatabase();
    const checksumRuntime = await createRole("hns_runtime");
    const checksumOperator = await createRole("hns_operator");
    process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL = checksumFixture.url.toString();
    await withAdmin(checksumFixture, async (admin) => {
      await admin.query(
        "UPDATE api_next.schema_migrations SET checksum = repeat('0', 64) WHERE version = '0172_hns_cutover_evidence_consistency.sql'",
      );
    });
    const checksumEvents: string[] = [];
    const checksumPorts = makeRealPorts(checksumFixture, {
      runtimeRole: checksumRuntime,
      operatorRole: checksumOperator,
      migratorRole: "postgres",
      events: checksumEvents,
    });
    expect(
      await refusalOf(() =>
        runHnsStagingPostMigration(
          inputFor(checksumFixture, {
            runtimeRole: checksumRuntime,
            operatorRole: checksumOperator,
            migratorRole: "postgres",
            ports: checksumPorts,
            attemptId: "attempt-pg-checksum",
          }),
        ),
      ),
    ).toMatchObject({ step: "target_and_ledger", reason: "checksum_mismatch" });
    expect(checksumEvents).toEqual([]);

    const beyondFixture = await cloneDatabase();
    const beyondRuntime = await createRole("hns_runtime");
    const beyondOperator = await createRole("hns_operator");
    process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL = beyondFixture.url.toString();
    await withAdmin(beyondFixture, async (admin) => {
      await admin.query(
        "INSERT INTO api_next.schema_migrations (version, checksum) VALUES ('0173_unreviewed.sql', repeat('9', 64))",
      );
    });
    const beyondEvents: string[] = [];
    const beyondPorts = makeRealPorts(beyondFixture, {
      runtimeRole: beyondRuntime,
      operatorRole: beyondOperator,
      migratorRole: "postgres",
      events: beyondEvents,
    });
    expect(
      await refusalOf(() =>
        runHnsStagingPostMigration(
          inputFor(beyondFixture, {
            runtimeRole: beyondRuntime,
            operatorRole: beyondOperator,
            migratorRole: "postgres",
            ports: beyondPorts,
            attemptId: "attempt-pg-beyond",
          }),
        ),
      ),
    ).toMatchObject({
      step: "target_and_ledger",
      reason: "migration_endpoint_exceeded",
      detail: { first_beyond: "0173_unreviewed.sql" },
    });
    expect(beyondEvents).toEqual([]);
  });

  test("refuses an effective identity-table write inherited through a role", async () => {
    const fixture = await cloneDatabase();
    const runtimeRole = await createRole("hns_runtime");
    const operatorRole = await createRole("hns_operator");
    const parentRole = await createRole("hns_parent");
    process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL = fixture.url.toString();
    await withAdmin(fixture, async (admin) => {
      await admin.query(
        `GRANT INSERT ON api_next.hns_lifecycle_service_identity TO "${parentRole}"`,
      );
      await admin.query(`GRANT "${parentRole}" TO "${runtimeRole}"`);
    });
    const events: string[] = [];
    const ports = makeRealPorts(fixture, {
      runtimeRole,
      operatorRole,
      migratorRole: "postgres",
      events,
    });
    const refusal = await refusalOf(() =>
      runHnsStagingPostMigration(
        inputFor(fixture, {
          runtimeRole,
          operatorRole,
          migratorRole: "postgres",
          ports,
          attemptId: "attempt-pg-inherited",
        }),
      ),
    );
    expect(refusal).toMatchObject({
      step: "privilege_matrix",
      reason: "identity_write_allowed",
      detail: { identity_kind: "runtime", privilege: "INSERT" },
    });
    expect(events).not.toContain("start");
  });

  test("the reviewed grant application and matrix readback hold against real roles", async () => {
    const fixture = await cloneDatabase();
    const runtimeRole = await createRole("hns_runtime");
    const operatorRole = await createRole("hns_operator");
    await withAdmin(fixture, async (admin) => {
      const before = await readStagingPostMigrationPrivilegeMatrix(fixture.url.toString(), {
        runtime_role: runtimeRole,
        operator_role: operatorRole,
      });
      expect(before.runtime.probe_execute).toBe(false);
      await applyStagingPostMigrationGrants(fixture.url.toString(), {
        runtime_role: runtimeRole,
        operator_role: operatorRole,
      });
      const after = await readStagingPostMigrationPrivilegeMatrix(fixture.url.toString(), {
        runtime_role: runtimeRole,
        operator_role: operatorRole,
      });
      expect(after.runtime.probe_execute).toBe(true);
      expect(after.runtime.identity_insert).toBe(false);
      expect(after.runtime.identity_update).toBe(false);
      expect(after.runtime.identity_delete).toBe(false);
      expect(after.operator.identity_insert).toBe(false);
      expect(after.operator.identity_update).toBe(false);
      expect(after.operator.identity_delete).toBe(false);
    });
  });

  test("a failed migration call leaves the committed prefix and the entry point refuses", async () => {
    const name = `hns_entry_replay_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await withRoot(async (root) => {
      await root.query(`CREATE DATABASE "${name}"`);
    });
    createdDatabases.add(name);
    const url = databaseUrl(name).toString();
    const replayFixture = { url: new URL(url) };
    await withAdmin(replayFixture, async (admin) => {
      await admin.query("CREATE SCHEMA api_next");
    });
    const migrations = await loadPostgresMigrations();
    // This models the in-place cutover's atomic call, not the phased reset's
    // one-commit-per-migration replay: the call that fails rolls back whole
    // while the earlier committed call survives. The reset path's own
    // restore-on-failure proof is staging-persona-phased-reset.pg.test.ts.
    await runPostgresMigrations({ connectionString: url, migrations: migrations.slice(0, 3) });
    const failingChain = migrations
      .slice(0, 5)
      .map((migration, index) =>
        index === 3 ? { ...migration, sql: "SELECT this_is_not_valid_sql();" } : migration,
      );
    let failed = false;
    try {
      await runPostgresMigrations({ connectionString: url, migrations: failingChain });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const fixture = replayFixture;
    await withAdmin(fixture, async (admin) => {
      const ledger = await admin.query<{ version: string }>(
        "SELECT version FROM api_next.schema_migrations ORDER BY version",
      );
      const versions = ledger.rows.map((row) => row.version);
      expect(versions).toEqual(migrations.slice(0, 3).map((migration) => migration.version));
      expect(versions).not.toContain(migrations[3]?.version);
      expect(versions).not.toContain(migrations[4]?.version);
    });
    // The failed replay leaves no terminal endpoint, so the entry point refuses
    // before any grant, probe seed or service start.
    process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL = url;
    const runtimeRole = await createRole("hns_runtime");
    const operatorRole = await createRole("hns_operator");
    const events: string[] = [];
    const ports = makeRealPorts(fixture, {
      runtimeRole,
      operatorRole,
      migratorRole: "postgres",
      events,
    });
    const refusal = await refusalOf(() =>
      runHnsStagingPostMigration(
        inputFor(fixture, {
          runtimeRole,
          operatorRole,
          migratorRole: "postgres",
          ports,
          attemptId: "attempt-pg-failed-replay",
        }),
      ),
    );
    expect(refusal).toMatchObject({
      step: "target_and_ledger",
      reason: "migration_endpoint_missing",
    });
    expect(events).toEqual([]);
  });
});
