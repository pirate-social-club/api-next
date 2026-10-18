import { afterAll, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { postgresTestSchemaCatalogFingerprint } from "@pirate/testing/postgres";
import { Client } from "pg";
import {
  createReusablePostgresTestSchemaOwner,
  createReusablePostgresTestSchemaOwnerWithDriver,
  disposeReusablePostgresTestSchemaOwners,
  type ReusablePostgresTestSchemaDriver,
} from "./postgres-test-baseline.ts";

type ProofClient = {
  readonly id: number;
  connected: boolean;
  closed: boolean;
  schema: string | undefined;
};
type ProofSchema = { data: Map<string, string>; catalog: string };
type Operation = keyof ReusablePostgresTestSchemaDriver<ProofClient>;

/** I/O double only. Initialization, queueing, resets, fingerprints and disposal use the maintained owner. */
export function makeLifecycleProofDriver(record: (event: string) => void = () => undefined) {
  const clients: ProofClient[] = [];
  const schemas = new Map<string, ProofSchema>();
  const events: string[] = [];
  const failures = new Map<Operation, Error>();
  const controls = { retainAfterDrop: false };
  function event(operation: Operation, client?: ProofClient): void {
    events.push(operation);
    record(`${operation}:${client?.id ?? "none"}`);
    if (failures.has(operation)) throw failures.get(operation);
  }
  function selected(client: ProofClient): ProofSchema {
    if (!client.connected || client.closed) throw new Error("Proof client is not open");
    const schema = client.schema === undefined ? undefined : schemas.get(client.schema);
    if (schema === undefined) throw new Error("Proof client has no selected schema");
    return schema;
  }
  const driver: ReusablePostgresTestSchemaDriver<ProofClient> = {
    client() {
      event("client");
      const client = { id: clients.length + 1, connected: false, closed: false, schema: undefined };
      clients.push(client);
      return client;
    },
    async connect(client) {
      event("connect", client);
      client.connected = true;
    },
    async close(client) {
      client.closed = true;
      event("close", client);
    },
    async create(client, schema) {
      event("create", client);
      if (schemas.has(schema)) throw new Error("Proof schema already exists");
      schemas.set(schema, { data: new Map(), catalog: "baseline-catalog" });
    },
    async select(client, schema) {
      event("select", client);
      client.schema = schema;
      selected(client);
    },
    async initialize(client) {
      event("initialize", client);
      selected(client).data.set("seed", "baseline");
    },
    async reset(client) {
      event("reset", client);
      selected(client).data = new Map([["seed", "baseline"]]);
    },
    async fingerprint(client) {
      event("fingerprint", client);
      return selected(client).catalog;
    },
    async rollback(client) {
      event("rollback", client);
    },
    async clearSearchPath(client) {
      event("clearSearchPath", client);
      client.schema = undefined;
    },
    async drop(client, schema) {
      event("drop", client);
      if (!controls.retainAfterDrop) schemas.delete(schema);
    },
    async exists(client, schema) {
      event("exists", client);
      return schemas.has(schema);
    },
  };
  return { driver, clients, schemas, events, failures, controls, selected };
}

// This function is invoked at declaration time separately by each generated test file.
// Importing this shared module registers no hook and creates no owner.
const processSchemas = new Set<string>();
export function declareLifecycleProofSuite(
  options:
    | {
        readonly kind: "socket_free";
        readonly label: string;
        readonly tracePath: string;
        readonly failPrimaryAndDrop: boolean;
      }
    | {
        readonly kind: "postgres";
        readonly baseConnectionString: string;
        readonly complete: (schemas: readonly string[]) => Promise<void>;
      },
): void {
  if (options.kind === "postgres") {
    declareRealPostgresLifecycleProofSuite(options);
    return;
  }
  const { label, tracePath, failPrimaryAndDrop } = options;
  const record = (event: string) => appendFileSync(tracePath, `${label}:${event}\n`);
  const io = makeLifecycleProofDriver(record);
  const primary = createReusablePostgresTestSchemaOwnerWithDriver(io.driver);
  const secondary = createReusablePostgresTestSchemaOwnerWithDriver(io.driver);
  const baseConnectionString = "postgres://socket-free.invalid/fixture";
  let completed = 0;
  record("declared");
  expect(io.events).toEqual([]);
  expect(processSchemas.size).toBe(0);

  afterAll(async () => {
    record("dispose-enter");
    await disposeReusablePostgresTestSchemaOwners(primary, secondary);
    expect(io.schemas.size).toBe(0);
    expect(io.clients.every((client) => client.closed)).toBe(true);
    expect(io.events.filter((event) => event === "initialize")).toHaveLength(2);
    expect(io.events.filter((event) => event === "reset")).toHaveLength(3);
    expect(io.events.filter((event) => event === "exists")).toHaveLength(2);
    processSchemas.clear();
    expect(completed).toBe(3);
    record("marker");
  });

  test(`${label} first use`, async () => {
    await primary.run({
      baseConnectionString,
      schemaName: "shared-key",
      use: async ({ admin, schema }) => {
        processSchemas.add(schema);
        expect(io.selected(admin).data.get("seed")).toBe("baseline");
        io.selected(admin).data.set("dirty", "first-use");
        record("use-1");
        if (failPrimaryAndDrop) throw new Error("synthetic primary failure");
      },
    });
    completed += 1;
  });
  test(`${label} second use retains the same initialized schema until final hook`, async () => {
    expect(io.events).not.toContain("drop");
    await primary.run({
      baseConnectionString,
      schemaName: "shared-key",
      use: async ({ admin, schema }) => {
        expect(processSchemas.has(schema)).toBe(true);
        expect(io.selected(admin).data.has("dirty")).toBe(false);
        expect(io.selected(admin).data.get("seed")).toBe("baseline");
        expect(io.events.filter((event) => event === "initialize")).toHaveLength(1);
        record("use-2");
      },
    });
    completed += 1;
  });
  test(`${label} independent second owner in the same file`, async () => {
    await secondary.run({
      baseConnectionString,
      schemaName: "shared-key",
      use: async ({ schema }) => {
        expect(processSchemas.has(schema)).toBe(false);
        processSchemas.add(schema);
        expect(io.schemas.size).toBe(2);
        record("use-secondary");
      },
    });
    completed += 1;
    if (failPrimaryAndDrop) io.failures.set("drop", new Error("synthetic DROP failure"));
  });
}

/** Explicit parent-only entry point. Importing this module never connects to PostgreSQL. */
function declareRealPostgresLifecycleProofSuite(options: {
  readonly baseConnectionString: string;
  readonly complete: (schemas: readonly string[]) => Promise<void>;
}): void {
  const primary = createReusablePostgresTestSchemaOwner();
  const secondary = createReusablePostgresTestSchemaOwner();
  const schemaName = "maintained-lifecycle-parent-proof";
  const schemas = new Set<string>();
  let initial:
    | { readonly schema: string; readonly users: number; readonly catalog: string }
    | undefined;
  let completed = 0;

  afterAll(async () => {
    await disposeReusablePostgresTestSchemaOwners(primary, secondary);
    const observer = new Client({ connectionString: options.baseConnectionString });
    const failures: unknown[] = [];
    try {
      await observer.connect();
      const found = await observer.query<{ nspname: string }>(
        "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[])",
        [[...schemas]],
      );
      expect(schemas.size).toBe(2);
      expect(found.rows).toEqual([]);
      expect(completed).toBe(4);
    } catch (error) {
      failures.push(error);
    }
    try {
      await observer.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Independent schema disappearance proof and observer close failed",
        { cause: failures[0] },
      );
    await options.complete([...schemas]);
  });

  test("real lifecycle first use records the baseline and persists a row until reuse", async () => {
    await primary.run({
      baseConnectionString: options.baseConnectionString,
      schemaName,
      use: async ({ admin, schema }) => {
        schemas.add(schema);
        const users = await admin.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM users",
        );
        const count = users.rows[0]?.count;
        if (typeof count !== "number") throw new Error("Baseline user count unavailable");
        initial = {
          schema,
          users: count,
          catalog: await postgresTestSchemaCatalogFingerprint(admin),
        };
        await admin.query("INSERT INTO users (user_id) VALUES ('maintained_lifecycle_probe_1')");
        expect(
          (
            await admin.query(
              "SELECT user_id FROM users WHERE user_id = 'maintained_lifecycle_probe_1'",
            )
          ).rows,
        ).toHaveLength(1);
      },
    });
    completed += 1;
  });
  test("real lifecycle second use resets data without rebuilding the catalog or schema", async () => {
    if (initial === undefined) throw new Error("The first lifecycle case did not complete");
    const baseline = initial;
    await primary.run({
      baseConnectionString: options.baseConnectionString,
      schemaName,
      use: async ({ admin, schema }) => {
        expect(schema).toBe(baseline.schema);
        expect(
          (
            await admin.query(
              "SELECT user_id FROM users WHERE user_id = 'maintained_lifecycle_probe_1'",
            )
          ).rows,
        ).toEqual([]);
        const users = await admin.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM users",
        );
        expect(users.rows[0]?.count).toBe(baseline.users);
        expect(await postgresTestSchemaCatalogFingerprint(admin)).toBe(baseline.catalog);
        await admin.query("INSERT INTO users (user_id) VALUES ('maintained_lifecycle_probe_2')");
      },
    });
    completed += 1;
  });
  test("real lifecycle refuses active disposal and retains the initialized owner", async () => {
    if (initial === undefined) throw new Error("The first lifecycle case did not complete");
    const baseline = initial;
    await primary.run({
      baseConnectionString: options.baseConnectionString,
      schemaName,
      use: async ({ admin, schema }) => {
        expect(schema).toBe(baseline.schema);
        await expect(primary.dispose()).rejects.toThrow("still active");
        expect(
          (
            await admin.query(
              "SELECT user_id FROM users WHERE user_id = 'maintained_lifecycle_probe_2'",
            )
          ).rows,
        ).toEqual([]);
        expect(await postgresTestSchemaCatalogFingerprint(admin)).toBe(baseline.catalog);
      },
    });
    completed += 1;
  });
  test("real lifecycle owns two independent schemas even when their logical keys match", async () => {
    if (initial === undefined) throw new Error("The first lifecycle case did not complete");
    const baseline = initial;
    const ownBaseline = await secondary.run({
      baseConnectionString: options.baseConnectionString,
      schemaName,
      use: async ({ admin, schema }) => {
        schemas.add(schema);
        expect(schema).not.toBe(baseline.schema);
        const users = await admin.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM users",
        );
        expect(users.rows[0]?.count).toBe(baseline.users);
        const catalog = await postgresTestSchemaCatalogFingerprint(admin);
        await admin.query("INSERT INTO users (user_id) VALUES ('maintained_lifecycle_secondary')");
        return { schema, catalog };
      },
    });
    await secondary.run({
      baseConnectionString: options.baseConnectionString,
      schemaName,
      use: async ({ admin, schema }) => {
        expect(schema).toBe(ownBaseline.schema);
        expect(await postgresTestSchemaCatalogFingerprint(admin)).toBe(ownBaseline.catalog);
        expect(
          (
            await admin.query(
              "SELECT user_id FROM users WHERE user_id = 'maintained_lifecycle_secondary'",
            )
          ).rows,
        ).toEqual([]);
      },
    });
    completed += 1;
  });
}
