import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  danceServingGrantPlan,
  danceServingLedgerHash,
} from "../../../scripts/dance-serving-grant-plan.ts";
import {
  DANCE_SOURCE_GATEWAY_READ_TABLES,
  type DanceServingConsumer,
} from "../../../scripts/dance-serving-permission-contract.ts";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";

type Fixture = Readonly<{
  admin: Client;
  owner: Client;
  ownerRole: string;
  schema: string;
  quote: (s: string) => string;
  makeRole: () => Promise<{ role: string; url: string }>;
  apply: (plan: ReturnType<typeof danceServingGrantPlan>) => Promise<void>;
  plan: (
    role: string,
    consumers: readonly DanceServingConsumer[],
  ) => ReturnType<typeof danceServingGrantPlan>;
  gatewayBase: (role: string) => Promise<void>;
}>;
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
export async function withDanceServingPermissionFixture(
  base: string,
  use: (f: Fixture) => Promise<void>,
) {
  const url = new URL(base);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "5432" ||
    url.pathname !== "/postgres" ||
    url.username !== "postgres"
  )
    throw Error("Dance permission fixture requires disposable literal-loopback PostgreSQL");
  const admin = new Client({ connectionString: base });
  await admin.connect();
  const id = randomUUID().replaceAll("-", "");
  const schema = `dance_permissions_${id}`,
    ownerRole = `dance_owner_${id}`;
  const roles: string[] = [];
  let owner: Client | undefined;
  let schemaOid: number | undefined;
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    await use(await prepare());
  } catch (error) {
    failures.push(error);
  }
  await attempt(async () => {
    await owner?.end();
  });
  await attempt(async () => {
    if (schemaOid !== undefined) {
      // Small committed groups keep PG18.6 cleanup within its default lock
      // table. Identity is rechecked before every owned-schema mutation.
      for (let batch = 0; batch < 200; batch++) {
        const identity = (
          await admin.query(
            "SELECT oid,pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname=$1",
            [schema],
          )
        ).rows;
        if (
          identity.length !== 1 ||
          identity[0]?.oid !== schemaOid ||
          identity[0]?.owner !== ownerRole
        )
          throw Error("Owned Dance permission schema changed during cleanup");
        const group = (
          await admin.query<{ sql: string }>(
            `SELECT format('DROP %s IF EXISTS %I.%I CASCADE',
          CASE relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'c' THEN 'TYPE' END,
          $1::text,relname) sql FROM pg_class WHERE relnamespace=$2 AND relkind IN('r','p','v','m','f','c') ORDER BY relkind,relname LIMIT 8`,
            [schema, schemaOid],
          )
        ).rows;
        for (const { sql } of group) await admin.query(sql);
        if (group.length === 0) break;
        if (batch === 199) throw Error("Owned Dance permission cleanup bound exceeded");
      }
      await admin.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
    }
  });
  for (const role of [...roles, ownerRole])
    await attempt(() => admin.query(`DROP ROLE IF EXISTS ${quote(role)}`));
  await attempt(() => admin.end());
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Dance permission proof and cleanup failed");

  async function prepare() {
    const password = randomUUID().replaceAll("-", "");
    await admin.query(
      `CREATE ROLE ${quote(ownerRole)} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION BYPASSRLS PASSWORD '${password}'; CREATE SCHEMA ${quote(schema)} AUTHORIZATION ${quote(ownerRole)}`,
    );
    schemaOid = Number(
      (await admin.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [schema])).rows[0]?.oid,
    );
    const scoped = (role: string) => {
      const u = new URL(base);
      u.username = role;
      u.password = password;
      u.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
      return u.toString();
    };
    const migrations = await loadPostgresMigrations();
    for (let end = 25; end < migrations.length; end += 25)
      await runPostgresMigrations({
        connectionString: scoped(ownerRole),
        migrations: migrations.slice(0, end),
      });
    await runPostgresMigrations({ connectionString: scoped(ownerRole), migrations });
    const ownerClient = new Client({ connectionString: scoped(ownerRole) });
    await ownerClient.connect();
    owner = ownerClient;
    const makeRole = async () => {
      const role = `dance_runtime_${randomUUID().replaceAll("-", "")}`;
      await admin.query(
        `CREATE ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'; GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`,
      );
      roles.push(role);
      return { role, url: scoped(role) };
    };
    const apply = async (plan: ReturnType<typeof danceServingGrantPlan>) => {
      try {
        await ownerClient.query(plan.statements.join(";\n"));
      } catch (error) {
        await ownerClient.query("ROLLBACK");
        throw error;
      }
    };
    const plan = (role: string, consumers: readonly DanceServingConsumer[]) =>
      danceServingGrantPlan({
        role,
        schema,
        consumers,
        ledgerSha256: danceServingLedgerHash(migrations),
      });
    const gatewayBase = async (role: string) => {
      for (const table of DANCE_SOURCE_GATEWAY_READ_TABLES)
        await ownerClient.query(
          `GRANT SELECT ON ${quote(schema)}.${quote(table)} TO ${quote(role)}`,
        );
    };
    return {
      admin,
      owner: ownerClient,
      ownerRole,
      schema,
      quote,
      makeRole,
      apply,
      plan,
      gatewayBase,
    };
  }
}
