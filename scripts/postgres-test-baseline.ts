import { createHash, randomUUID } from "node:crypto";
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
  readonly rewardsRunning?: boolean;
}): Promise<void> {
  const schema = selectedSchema(options.connectionString);
  const reused = schema !== undefined && reusableSchemaNames.has(schema);
  await withSchemaClient(postgresSchemaDriver, options.connectionString, async (client) => {
    if (!reused) await applyPostgresTestBaseline(client);
    if (options.rewardsRunning) {
      await client.query(
        "SELECT set_reward_operations_paused_v1(revision,FALSE,'isolated_test_fixture') FROM reward_operations_control WHERE singleton",
      );
    }
  });
}

/** The owner is declared by a test file/suite; its afterAll must await dispose before any marker. */
type ReusablePostgresTestSchemaOwner<C> = {
  readonly run: <A>(options: {
    readonly baseConnectionString: string;
    readonly schemaName: string;
    readonly use: (context: {
      readonly admin: C;
      readonly connectionString: string;
      readonly schema: string;
    }) => Promise<A>;
  }) => Promise<A>;
  readonly dispose: () => Promise<void>;
};

/** Injectable I/O only: production and socket-free proofs share the same ownership state machine. */
export type ReusablePostgresTestSchemaDriver<C> = {
  readonly client: (connectionString: string) => C;
  readonly connect: (client: C) => Promise<void>;
  readonly close: (client: C) => Promise<void>;
  readonly create: (client: C, schema: string) => Promise<void>;
  readonly select: (client: C, schema: string) => Promise<void>;
  readonly initialize: (client: C) => Promise<void>;
  readonly reset: (client: C) => Promise<void>;
  readonly fingerprint: (client: C) => Promise<string>;
  readonly rollback: (client: C) => Promise<void>;
  readonly clearSearchPath: (client: C) => Promise<void>;
  readonly drop: (client: C, schema: string) => Promise<void>;
  readonly exists: (client: C, schema: string) => Promise<boolean>;
};

const postgresSchemaDriver: ReusablePostgresTestSchemaDriver<Client> = {
  client: (connectionString) => new Client({ connectionString }),
  connect: async (client) => {
    await client.connect();
  },
  close: async (client) => {
    await client.end();
  },
  create: async (client, schema) => {
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  },
  select: async (client, schema) => {
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  },
  initialize: applyPostgresTestBaseline,
  reset: resetPostgresTestBaseline,
  fingerprint: postgresTestSchemaCatalogFingerprint,
  rollback: async (client) => {
    await client.query("ROLLBACK");
  },
  clearSearchPath: async (client) => {
    await client.query("SET search_path TO public");
  },
  drop: async (client, schema) => {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
  },
  exists: async (client, schema) => {
    const result = await client.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1::text) AS present",
      [schema],
    );
    const present = result.rows[0]?.present;
    if (typeof present !== "boolean")
      throw new Error("Schema disappearance query returned no boolean");
    return present;
  },
};

function throwFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message, { cause: failures[0] });
}

async function attempt(failures: unknown[], action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(error);
  }
}

async function withSchemaClient<C, A>(
  driver: ReusablePostgresTestSchemaDriver<C>,
  connectionString: string,
  use: (client: C) => Promise<A>,
): Promise<A> {
  const client = driver.client(connectionString);
  const failures: unknown[] = [];
  let connected = false;
  let result: { readonly value: A } | undefined;
  try {
    await driver.connect(client);
    connected = true;
    result = { value: await use(client) };
  } catch (error) {
    failures.push(error);
  }
  if (connected) {
    await attempt(failures, () => driver.rollback(client));
    await attempt(failures, () => driver.clearSearchPath(client));
  }
  await attempt(failures, () => driver.close(client));
  throwFailures(failures, "PostgreSQL fixture operation and client cleanup failed");
  if (result === undefined) throw new Error("PostgreSQL fixture completed without a result");
  return result.value;
}

type ReusableSchemaState = {
  readonly baseConnectionString: string;
  readonly schemaName: string;
  readonly schema: string;
  readonly scopedConnectionString: string;
  creationAttempted: boolean;
  created: boolean;
  initialized: boolean;
  catalogFingerprint: string | undefined;
  prepareFailure: { readonly error: unknown } | undefined;
};

function newSchemaState(baseConnectionString: string, schemaName: string): ReusableSchemaState {
  const slug = schemaName
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/g, "_")
    .slice(0, 18);
  const digest = createHash("sha256").update(schemaName).digest("hex").slice(0, 8);
  const schema = `api_next_reuse_${slug}_${digest}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  return {
    baseConnectionString,
    schemaName,
    schema,
    scopedConnectionString: connectionForSchema(baseConnectionString, schema),
    creationAttempted: false,
    created: false,
    initialized: false,
    catalogFingerprint: undefined,
    prepareFailure: undefined,
  };
}

async function prepareReusableSchema<C>(
  state: ReusableSchemaState,
  driver: ReusablePostgresTestSchemaDriver<C>,
  admin: C,
): Promise<void> {
  if (state.prepareFailure !== undefined) throw state.prepareFailure.error;
  if (!state.initialized) {
    state.creationAttempted = true;
    await driver.create(admin, state.schema);
    state.created = true;
    await driver.select(admin, state.schema);
    await driver.initialize(admin);
    state.catalogFingerprint = await driver.fingerprint(admin);
    state.initialized = true;
    reusableSchemaNames.add(state.schema);
    return;
  }
  await driver.select(admin, state.schema);
  await driver.reset(admin);
  const fingerprint = await driver.fingerprint(admin);
  if (fingerprint !== state.catalogFingerprint) {
    throw new Error(
      `Reusable PostgreSQL test schema ${state.schema} retained persistent DDL between fixture runs`,
    );
  }
}

async function cleanupReusableSchema<C>(
  state: ReusableSchemaState,
  driver: ReusablePostgresTestSchemaDriver<C>,
): Promise<void> {
  reusableSchemaNames.delete(state.schema);
  if (!state.creationAttempted) return;
  await withSchemaClient(driver, state.baseConnectionString, async (admin) => {
    if (!state.created) {
      if (await driver.exists(admin, state.schema)) {
        throw new Error(
          `Reusable PostgreSQL test schema ${state.schema} exists after failed creation; ownership is unconfirmed and DROP was refused`,
        );
      }
      return;
    }
    const failures: unknown[] = [];
    if (state.initialized) {
      await attempt(failures, async () => {
        await driver.select(admin, state.schema);
        await driver.reset(admin);
        if ((await driver.fingerprint(admin)) !== state.catalogFingerprint) {
          throw new Error(
            `Reusable PostgreSQL test schema ${state.schema} retained persistent DDL after its final fixture run`,
          );
        }
      });
    }
    await attempt(failures, () => driver.clearSearchPath(admin));
    await attempt(failures, () => driver.drop(admin, state.schema));
    await attempt(failures, async () => {
      if (await driver.exists(admin, state.schema)) {
        throw new Error(
          `Reusable PostgreSQL test schema ${state.schema} still exists after disposal`,
        );
      }
      state.created = false;
      state.initialized = false;
    });
    throwFailures(failures, "PostgreSQL fixture final reset and schema disposal failed");
  });
}

export function createReusablePostgresTestSchemaOwner(): ReusablePostgresTestSchemaOwner<Client> {
  return createReusablePostgresTestSchemaOwnerWithDriver(postgresSchemaDriver);
}

export async function disposeReusablePostgresTestSchemaOwners(
  ...owners: readonly { readonly dispose: () => Promise<void> }[]
): Promise<void> {
  const failures: unknown[] = [];
  for (const owner of owners) await attempt(failures, owner.dispose);
  throwFailures(failures, "Multiple reusable PostgreSQL test schema owners failed disposal");
}

export function createReusablePostgresTestSchemaOwnerWithDriver<C>(
  driver: ReusablePostgresTestSchemaDriver<C>,
): ReusablePostgresTestSchemaOwner<C> {
  let state: ReusableSchemaState | undefined;
  let pending = 0;
  let queue = Promise.resolve();
  let closed = false;
  let disposal: Promise<void> | undefined;
  return {
    async run(options) {
      if (closed) throw new Error("Reusable PostgreSQL test schema owner is disposed");
      state ??= newSchemaState(options.baseConnectionString, options.schemaName);
      const current = state;
      if (
        current.baseConnectionString !== options.baseConnectionString ||
        current.schemaName !== options.schemaName
      ) {
        throw new Error(
          "A reusable PostgreSQL test schema owner cannot change its schema key or connection",
        );
      }
      pending += 1;
      const preceding = queue;
      let release: () => void = () => undefined;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await preceding;
      try {
        return await withSchemaClient(driver, current.baseConnectionString, async (admin) => {
          try {
            await prepareReusableSchema(current, driver, admin);
          } catch (error) {
            current.prepareFailure = { error };
            throw error;
          }
          return options.use({
            admin,
            connectionString: current.scopedConnectionString,
            schema: current.schema,
          });
        });
      } finally {
        pending -= 1;
        release();
      }
    },
    async dispose() {
      if (pending !== 0)
        throw new Error("Reusable PostgreSQL test schema owner is still active during cleanup");
      closed = true;
      disposal ??= state === undefined ? Promise.resolve() : cleanupReusableSchema(state, driver);
      await disposal;
    },
  };
}
