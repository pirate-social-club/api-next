/** Copy the staging runtime ACL into a distinct role on the isolated database. */
import pg from "pg";
import { normalizePostgresConnectionString } from "../../../scripts/postgres-migrations.ts";

type Grant = { object: string; rights: string[]; kind: "TABLE" | "SEQUENCE" | "FUNCTION" };

const sourceRole = "pscale_api_gy9lze83nr29";
const allowedRights = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER",
  "MAINTAIN", "USAGE", "EXECUTE",
]);

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function branchUrl(source: string, branchCredential: string): string {
  const original = new URL(source);
  const branch = new URL(branchCredential);
  const [originalRole, originalBranch] = original.username.split(".");
  const [branchRole, branchId] = branch.username.split(".");
  if (!originalRole || !originalBranch || !branchRole || !branchId ||
      originalBranch === branchId || branch.protocol !== "postgresql:") {
    throw new Error("isolated database credential must use a distinct branch selector");
  }
  original.username = `${originalRole}.${branchId}`;
  original.host = branch.host;
  return normalizePostgresConnectionString(original.toString());
}

async function grants(client: pg.Client, role: string): Promise<Grant[]> {
  const relations = await client.query<{
    schema: string; name: string; kind: string; rights: string[];
  }>(`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
            array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) AS rights
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN LATERAL aclexplode(c.relacl) a ON true
      WHERE n.nspname='api_next'
        AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1)
      GROUP BY n.nspname,c.relname,c.relkind`, [role]);
  const functions = await client.query<{
    schema: string; name: string; arguments: string; rights: string[];
  }>(`SELECT n.nspname AS schema, p.proname AS name,
            pg_get_function_identity_arguments(p.oid) AS arguments,
            array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) AS rights
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid=p.pronamespace
       JOIN LATERAL aclexplode(p.proacl) a ON true
      WHERE n.nspname='api_next'
        AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1)
      GROUP BY n.nspname,p.proname,p.oid`, [role]);
  return [
    ...relations.rows.map((row) => ({
      object: `${identifier(row.schema)}.${identifier(row.name)}`,
      rights: row.rights,
      kind: row.kind === "S" ? "SEQUENCE" : "TABLE",
    }) satisfies Grant),
    ...functions.rows.map((row) => ({
      object: `${identifier(row.schema)}.${identifier(row.name)}(${row.arguments})`,
      rights: row.rights,
      kind: "FUNCTION",
    }) satisfies Grant),
  ].sort((a, b) => `${a.kind}:${a.object}`.localeCompare(`${b.kind}:${b.object}`));
}

function grouped(grantsToApply: Grant[]): string[] {
  const groups = new Map<string, string[]>();
  for (const grant of grantsToApply) {
    if (grant.rights.length === 0 || grant.rights.some((right) => !allowedRights.has(right))) {
      throw new Error("unexpected database privilege");
    }
    const key = `${grant.kind}|${grant.rights.join(",")}`;
    groups.set(key, [...(groups.get(key) ?? []), grant.object]);
  }
  return [...groups.entries()].map(([key, objects]) => {
    const [kind, rights] = key.split("|");
    return `GRANT ${rights} ON ${kind} ${objects.join(", ")}`;
  });
}

async function main(): Promise<void> {
  const adminUrl = process.env.MEGAPOT_E2E_ADMIN_POSTGRES_URL;
  const runtimeUrl = process.env.MEGAPOT_E2E_RUNTIME_POSTGRES_URL;
  const stagingAdminUrl = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  if (!adminUrl || !runtimeUrl || !stagingAdminUrl) throw new Error("missing role inputs");
  const runtimeRole = new URL(runtimeUrl).username.split(".")[0];
  if (!runtimeRole || !/^pscale_api_[a-z0-9]+$/u.test(runtimeRole) ||
      runtimeRole === sourceRole ||
      new URL(runtimeUrl).username.split(".")[1] !==
        new URL(adminUrl).username.split(".")[1]) {
    throw new Error("runtime credential is not for this isolated branch");
  }
  const client = new pg.Client({ connectionString: branchUrl(stagingAdminUrl, adminUrl) });
  try {
    await client.connect();
    const branchCheck = await client.query<{ present: boolean }>(
      "SELECT exists(SELECT 1 FROM pg_roles WHERE rolname=$1) AS present",
      [new URL(adminUrl).username.split(".")[0]],
    );
    if (branchCheck.rows[0]?.present !== true) {
      throw new Error("connected database does not contain the isolated admin role");
    }
    const source = await grants(client, sourceRole);
    const relationCount = source.filter((grant) => grant.kind !== "FUNCTION").length;
    const functionCount = source.length - relationCount;
    if (relationCount !== 465 || functionCount !== 31) {
      throw new Error("source runtime ACL count drifted");
    }
    const statements = grouped(source);
    if (!process.argv.includes("--execute")) {
      console.log(JSON.stringify({ action: "dry-run", relationCount, functionCount,
        statementGroups: statements.length, target: runtimeRole }));
      return;
    }
    await client.query("BEGIN");
    try {
      await client.query(`GRANT USAGE ON SCHEMA api_next TO ${identifier(runtimeRole)}`);
      for (const statement of statements) {
        await client.query(`${statement} TO ${identifier(runtimeRole)}`);
      }
      const target = await grants(client, runtimeRole);
      if (JSON.stringify(target) !== JSON.stringify(source)) {
        throw new Error("isolated runtime ACL differs from the staging runtime ACL");
      }
      await client.query("COMMIT");
      console.log(JSON.stringify({ action: "granted", relationCount, functionCount,
        statementGroups: statements.length, target: runtimeRole }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

if (import.meta.main) await main();
