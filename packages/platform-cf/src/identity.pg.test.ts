import { afterAll, describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
import { Client } from "pg";
import { makeControlPlaneIdentityRepository } from "./identity-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";
import { applyPostgresMigrations, type PostgresMigration } from "./postgres-migrations";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_IDENTITY_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-identity-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-identity-suite-complete\n";
let completedTestCount = 0;

const migrations: readonly PostgresMigration[] = [
  {
    version: "0001_v1_product_slice.sql",
    checksum: "6592c575801a7964dc5f051a611ec823a44db966759622d82a12ef964df71e93",
    sql: await Bun.file(
      new URL("../../../db/postgres/migrations/0001_v1_product_slice.sql", import.meta.url),
    ).text(),
  },
  {
    version: "0002_identity.sql",
    checksum: "c017a6681711f3edcb7e0cb247b60c96ed847bf94c766974cda2e74664f37112",
    sql: await Bun.file(
      new URL("../../../db/postgres/migrations/0002_identity.sql", import.meta.url),
    ).text(),
  },
];

function schemaIdentifier(): string {
  return `api_next_identity_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  const option = encodeURIComponent(`-c search_path=${schema}`);
  return `${raw}${separator}options=${option}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function apply(connection: string): Promise<void> {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* ControlPlaneDb;
        yield* applyPostgresMigrations(migrations);
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
    ),
  );
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): E {
  if (!Exit.isFailure(exit)) throw new Error("expected a failed effect");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error("expected a typed repository error");
  return failure.success;
}

async function resolve(connection: string, sourceUserId: string) {
  const repository = makeControlPlaneIdentityRepository();
  return Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* repository.resolveCanonical({ sourceUserId });
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
    ),
  );
}

suite("Postgres 17 identity repository", () => {
  test("follows active aliases and merge aliases to an active canonical user", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await admin.query("INSERT INTO users (user_id) VALUES ($1), ($2), ($3)", [
        "usr_source",
        "usr_merge",
        "usr_canonical",
      ]);
      await admin.query(
        `INSERT INTO account_aliases (source_user_id, canonical_user_id, kind, status)
         VALUES ($1, $2, 'alias', 'active'), ($3, $4, 'merge', 'completed')`,
        ["usr_source", "usr_merge", "usr_merge", "usr_canonical"],
      );

      const result = await resolve(connection, "usr_source");
      expect(Exit.isSuccess(result) ? result.value : undefined).toEqual({
        sourceUserId: "usr_source",
        canonicalUserId: "usr_canonical",
        aliasPath: ["usr_source", "usr_merge"],
      });
    });
    completedTestCount += 1;
  });

  test("fails closed for alias cycles and missing canonical users", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await admin.query("INSERT INTO users (user_id) VALUES ($1), ($2), ($3)", [
        "usr_cycle_a",
        "usr_cycle_b",
        "usr_missing_source",
      ]);
      await admin.query(
        `INSERT INTO account_aliases (source_user_id, canonical_user_id, kind, status)
         VALUES ($1, $2, 'alias', 'active'), ($2, $1, 'alias', 'active'),
                ($3, 'usr_missing_canonical', 'alias', 'active')`,
        ["usr_cycle_a", "usr_cycle_b", "usr_missing_source"],
      );

      const cycle = await resolve(connection, "usr_cycle_a");
      expect(failureOf(cycle)).toMatchObject({ _tag: "IdentityRepositoryError", reason: "cyclic" });
      const missing = await resolve(connection, "usr_missing_source");
      expect(failureOf(missing)).toMatchObject({
        _tag: "IdentityRepositoryError",
        reason: "missing",
      });
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 2) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
