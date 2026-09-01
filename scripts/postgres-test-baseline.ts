import { afterAll } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyPostgresTestBaseline,
  postgresTestSchemaCatalogFingerprint,
  resetPostgresTestBaseline,
} from "@pirate/testing/postgres";
import { Client } from "pg";

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
}): Promise<void> {
  const schema = selectedSchema(options.connectionString);
  if (schema !== undefined && reusableSchemaNames.has(schema)) return;
  const client = new Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    await applyPostgresTestBaseline(client);
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
    await admin
      .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(state.schema)} CASCADE`)
      .catch(() => undefined);
    await admin.end();
    state.initialized = false;
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
  await precedingFixture;
  state.active = true;
  const admin = new Client({ connectionString: state.baseConnectionString });
  try {
    await admin.connect();
    try {
      await prepareReusableSchema(state, admin);
      return await options.use({
        admin,
        connectionString: state.scopedConnectionString,
        schema: state.schema,
      });
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.query("SET search_path TO public").catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  } finally {
    state.active = false;
    releaseFixture();
  }
}
