import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function assertOwnedSchema(
  actual: { oid: number; owner: string } | undefined,
  oid: number | undefined,
  owner: string,
) {
  if (actual !== undefined && (actual.oid !== oid || actual.owner !== owner))
    throw Error("Owned browser-session fixture identity changed");
}
export const browserSessionFunctions = [
  "create_browser_session_v1(jsonb)",
  "read_browser_session_access_v1(text,text,text)",
  "read_browser_session_renewal_v1(text,text,text,text)",
  "renew_browser_session_v1(text,text,text,text)",
  "revoke_browser_session_v1(text,text,text,text,text)",
] as const;

/** All mutation is confined to a freshly owned schema and two disposable roles. */
export async function withBrowserSessionFixture(
  base: string,
  use: (fixture: {
    owner: Client;
    runtime: Client;
    schema: string;
    role: string;
    runtimeUrl: string;
    quote: typeof quote;
  }) => Promise<void>,
) {
  const address = new URL(base);
  if (
    address.hostname !== "127.0.0.1" ||
    !["5432", "15439"].includes(address.port) ||
    address.pathname !== "/postgres" ||
    address.username !== "postgres"
  )
    throw Error("Browser session fixture requires disposable literal-loopback PostgreSQL");
  const id = randomUUID().replaceAll("-", "");
  const schema = `browser_session_${id}`,
    ownerRole = `browser_owner_${id}`,
    role = `browser_http_${id}`;
  const password = randomUUID();
  const admin = new Client({ connectionString: base });
  let owner: Client | undefined, runtime: Client | undefined, schemaOid: number | undefined;
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${quote(ownerRole)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      CREATE SCHEMA ${quote(schema)} AUTHORIZATION ${quote(ownerRole)}`);
    schemaOid = (await admin.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [schema]))
      .rows[0].oid;
    const connection = (user: string) => {
      const value = new URL(base);
      value.username = user;
      value.password = password;
      value.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
      return value.toString();
    };
    owner = new Client({ connectionString: connection(ownerRole) });
    await owner.connect();
    await owner.query(
      await readFile(
        new URL("../../../db/postgres/migrations/0002_identity.sql", import.meta.url),
        "utf8",
      ),
    );
    await owner.query(
      await readFile(
        new URL("../../../db/postgres/migrations/0015_identity_credentials.sql", import.meta.url),
        "utf8",
      ),
    );
    await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT ALL ON TABLES TO ${quote(role)};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT EXECUTE ON FUNCTIONS TO ${quote(role)}`);
    try {
      await owner.query(
        await readFile(
          new URL("../../../db/postgres/migrations/0330_browser_sessions.sql", import.meta.url),
          "utf8",
        ),
      );
    } finally {
      await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} REVOKE ALL ON TABLES FROM ${quote(role)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} REVOKE EXECUTE ON FUNCTIONS FROM ${quote(role)}`);
    }
    await owner.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)};
      GRANT SELECT ON users,account_aliases TO ${quote(role)};
      GRANT EXECUTE ON FUNCTION ${browserSessionFunctions.join(",")} TO ${quote(role)}`);
    const runtimeUrl = connection(role);
    runtime = new Client({ connectionString: runtimeUrl });
    await runtime.connect();
    await use({ owner, runtime, schema, role, runtimeUrl, quote });
  } finally {
    await runtime?.end();
    await owner?.end();
    try {
      const actual = (
        await admin.query(
          "SELECT oid,pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname=$1",
          [schema],
        )
      ).rows[0];
      assertOwnedSchema(actual, schemaOid, ownerRole);
      if (actual !== undefined) await admin.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
      await admin.query(
        `DROP ROLE IF EXISTS ${quote(role)}; DROP ROLE IF EXISTS ${quote(ownerRole)}`,
      );
    } finally {
      await admin.end();
    }
  }
}
