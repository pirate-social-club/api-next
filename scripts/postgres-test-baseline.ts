import { afterAll } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  applyPostgresTestBaseline,
  postgresTestSchemaCatalogFingerprint,
  resetPostgresTestBaseline,
} from "@pirate/testing/postgres";
import { Client } from "pg";
import { emitPostgresCiFixturePhase } from "./postgres-ci-wait-diagnostic.ts";

const reusableSchemaNames = new Set<string>();

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  const existingOptions = url.searchParams.get("options")?.trim();
  url.searchParams.set(
    "options",
    [existingOptions, `-c search_path=${schema}`].filter(Boolean).join(" "),
  );
  url.search = [...url.searchParams]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return url.toString();
}

function selectedSchema(connectionString: string): string | undefined {
  const options = new URL(connectionString).searchParams.get("options");
  return options?.match(/(?:^|\s)-c\s+search_path=([^\s,]+)/u)?.[1];
}

export async function applyPostgresTestBaselineConnection(options: {
  readonly connectionString: string;
  readonly rewardsRunning?: boolean;
}): Promise<void> {
  const schema = selectedSchema(options.connectionString);
  const reused = schema !== undefined && reusableSchemaNames.has(schema);
  const client = new Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    if (!reused) await applyPostgresTestBaseline(client);
    if (options.rewardsRunning) {
      await client.query(
        "SELECT set_reward_operations_paused_v1(revision,FALSE,'isolated_test_fixture') FROM reward_operations_control WHERE singleton",
      );
    }
  } finally {
    await client.end();
  }
}

type ReusableSchemaState = {
  readonly baseConnectionString: string;
  readonly schema: string;
  readonly scopedConnectionString: string;
  active: boolean;
  initialized: boolean;
  catalogFingerprint: string | undefined;
  queue: Promise<void>;
};

const reusableSchemas = new Map<string, ReusableSchemaState>();

function reusableSchemaState(
  baseConnectionString: string,
  schemaName: string,
): ReusableSchemaState {
  const key = `${baseConnectionString}\0${schemaName}`;
  const existing = reusableSchemas.get(key);
  if (existing !== undefined) return existing;
  const slug = schemaName
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/g, "_")
    .slice(0, 24);
  const digest = createHash("sha256").update(schemaName).digest("hex").slice(0, 12);
  const schema = `api_next_reuse_${slug}_${digest}_${process.pid}`;
  const state: ReusableSchemaState = {
    baseConnectionString,
    schema,
    scopedConnectionString: connectionForSchema(baseConnectionString, schema),
    active: false,
    initialized: false,
    catalogFingerprint: undefined,
    queue: Promise.resolve(),
  };
  reusableSchemas.set(key, state);
  afterAll(() => cleanupReusableSchema(state));
  return state;
}

async function prepareReusableSchema(state: ReusableSchemaState, admin: Client): Promise<void> {
  if (!state.initialized) {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(state.schema)}`);
    try {
      await admin.query(`SET search_path TO ${quoteIdentifier(state.schema)}`);
      await applyPostgresTestBaseline(admin);
      state.catalogFingerprint = await postgresTestSchemaCatalogFingerprint(admin);
      state.initialized = true;
      reusableSchemaNames.add(state.schema);
      return;
    } catch (error) {
      await admin.query("SET search_path TO public").catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(state.schema)} CASCADE`)
        .catch(() => undefined);
      throw error;
    }
  }
  await admin.query(`SET search_path TO ${quoteIdentifier(state.schema)}`);
  await resetPostgresTestBaseline(admin);
  const fingerprint = await postgresTestSchemaCatalogFingerprint(admin);
  if (fingerprint !== state.catalogFingerprint) {
    throw new Error(
      `Reusable PostgreSQL test schema ${state.schema} retained persistent DDL between fixture runs`,
    );
  }
}

async function cleanupReusableSchema(state: ReusableSchemaState): Promise<void> {
  if (!state.initialized) return;
  if (state.active) {
    throw new Error(
      `Reusable PostgreSQL test schema ${state.schema} is still active during cleanup`,
    );
  }
  const admin = new Client({ connectionString: state.baseConnectionString });
  await admin.connect();
  emitPostgresCiFixturePhase("cleanup_started", state.schema, admin);
  let failure: unknown;
  try {
    await admin.query(`SET search_path TO ${quoteIdentifier(state.schema)}`);
    await resetPostgresTestBaseline(admin);
    const fingerprint = await postgresTestSchemaCatalogFingerprint(admin);
    if (fingerprint !== state.catalogFingerprint) {
      throw new Error(
        `Reusable PostgreSQL test schema ${state.schema} retained persistent DDL after its final fixture run`,
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    reusableSchemaNames.delete(state.schema);
    await admin.query("SET search_path TO public").catch(() => undefined);
    // A refused reset is preservation evidence, never permission to erase the
    // retained business/source history or catalogue fault via schema cleanup.
    if (failure === undefined) {
      await admin
        .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(state.schema)} CASCADE`)
        .catch(() => undefined);
      state.initialized = false;
    }
    await admin.end();
    emitPostgresCiFixturePhase("cleanup_finished", state.schema, admin);
  }
  if (failure !== undefined) throw failure;
}

export async function withReusablePostgresTestSchema<A>(options: {
  readonly baseConnectionString: string;
  readonly schemaName: string;
  readonly use: (context: {
    readonly admin: Client;
    readonly connectionString: string;
    readonly schema: string;
  }) => Promise<A>;
}): Promise<A> {
  const state = reusableSchemaState(options.baseConnectionString, options.schemaName);
  const precedingFixture = state.queue;
  let releaseFixture: () => void = () => undefined;
  state.queue = new Promise<void>((resolve) => {
    releaseFixture = resolve;
  });
  emitPostgresCiFixturePhase("queued", state.schema);
  await precedingFixture;
  state.active = true;
  const admin = new Client({ connectionString: state.baseConnectionString });
  try {
    await admin.connect();
    emitPostgresCiFixturePhase("connected", state.schema, admin);
    try {
      emitPostgresCiFixturePhase("prepare_started", state.schema, admin);
      await prepareReusableSchema(state, admin);
      emitPostgresCiFixturePhase("prepare_finished", state.schema, admin);
      emitPostgresCiFixturePhase("use_started", state.schema, admin);
      try {
        return await options.use({
          admin,
          connectionString: state.scopedConnectionString,
          schema: state.schema,
        });
      } finally {
        emitPostgresCiFixturePhase("use_finished", state.schema, admin);
      }
    } finally {
      emitPostgresCiFixturePhase("rollback_started", state.schema, admin);
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.query("SET search_path TO public").catch(() => undefined);
      await admin.end().catch(() => undefined);
      emitPostgresCiFixturePhase("disconnected", state.schema, admin);
    }
  } finally {
    state.active = false;
    releaseFixture();
    emitPostgresCiFixturePhase("released", state.schema, admin);
  }
}

/** Fresh owned case scope; committed history remains until disposable PostgreSQL teardown. */
export async function withPreservedPostgresTestSchema<A>(options: {
  readonly baseConnectionString: string;
  readonly schemaName: string;
  readonly use: (context: {
    readonly admin: Client;
    readonly connectionString: string;
    readonly schema: string;
  }) => Promise<A>;
}): Promise<A> {
  // Match the existing owned fixtures: this helper owns only a fresh namespace,
  // while the test runner owns the loopback PostgreSQL lifecycle and final stop.
  if (!["127.0.0.1", "localhost"].includes(new URL(options.baseConnectionString).hostname))
    throw new Error("Preserved PostgreSQL fixture requires the owned loopback test target");
  const slug = options.schemaName
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/g, "_")
    .slice(0, 16);
  const schema = `api_next_keep_${slug}_${randomUUID().replaceAll("-", "")}`;
  const connectionString = connectionForSchema(options.baseConnectionString, schema);
  const admin = new Client({ connectionString: options.baseConnectionString });
  let outcome: { kind: "completed"; result: A } | { kind: "failed"; error: unknown } | undefined;
  const closeFailures: unknown[] = [];
  emitPostgresCiFixturePhase("queued", schema);
  try {
    await admin.connect();
    emitPostgresCiFixturePhase("connected", schema, admin);
    emitPostgresCiFixturePhase("prepare_started", schema, admin);
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await applyPostgresTestBaseline(admin);
    // Existing same-scope setup calls must not apply the baseline a second time.
    // This registration is process metadata, not a runtime readiness witness.
    reusableSchemaNames.add(schema);
    emitPostgresCiFixturePhase("prepare_finished", schema, admin);
    emitPostgresCiFixturePhase("use_started", schema, admin);
    try {
      outcome = {
        kind: "completed",
        result: await options.use({ admin, connectionString, schema }),
      };
    } finally {
      emitPostgresCiFixturePhase("use_finished", schema, admin);
    }
  } catch (error) {
    outcome = { kind: "failed", error };
  } finally {
    emitPostgresCiFixturePhase("rollback_started", schema, admin);
    // Only uncommitted work on this connection is rolled back. Other connections'
    // actual commits, positive obligations and original operation rows survive.
    for (const statement of ["ROLLBACK", "SET search_path TO public"])
      try {
        await admin.query(statement);
      } catch (error) {
        closeFailures.push(error);
      }
    try {
      await admin.end();
    } catch (error) {
      closeFailures.push(error);
    }
    reusableSchemaNames.delete(schema);
    emitPostgresCiFixturePhase("disconnected", schema, admin);
    emitPostgresCiFixturePhase("released", schema, admin);
    // No reset, DELETE, TRUNCATE, schema DROP or invented settlement. The exact
    // runner-owned PostgreSQL database/container remains the removal boundary.
  }
  if (closeFailures.length > 0)
    throw new AggregateError(
      outcome?.kind === "failed" ? [outcome.error, ...closeFailures] : closeFailures,
      "Preserved PostgreSQL fixture connection cleanup failed",
    );
  if (outcome === undefined) throw new Error("Preserved PostgreSQL fixture has no outcome");
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.result;
}
