import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-migrations";
import { observeInplaceInventory } from "./staging-persona-inplace-inventory";

const execute = promisify(execFile);
const databaseId = "mvydkmmwh5x4";
const sourceId = "syu03e00w3ux";
const branchId = "0ny029b910ob";
const branchName = "persona-reset-rehearsal-20260906";
const base = "organizations/{org}/databases/pirate-staging";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Credential-bearing result: private to the collector, never output. */
function restoredConnection(raw: string, host: string) {
  const url = new URL(raw);
  const username = decodeURIComponent(url.username);
  const entries = [...url.searchParams];
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hash ||
    decodeURIComponent(url.pathname) !== "/postgres" ||
    (url.port || "5432") !== "5432" ||
    !username.endsWith(`.${sourceId}`) ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    new Set(entries.map(([key]) => key)).size !== entries.length ||
    entries.some(([key, value]) =>
      key === "sslmode" ? value !== "verify-full" : key !== "sslrootcert" || value !== "system",
    ) ||
    !/^[a-zA-Z0-9.-]+$/.test(host)
  )
    throw new Error("rehearsal_connection_unproven");
  const role = username.slice(0, -sourceId.length - 1);
  if (!role) throw new Error("rehearsal_connection_unproven");
  url.username = `${role}.${branchId}`;
  url.hostname = host;
  return { connectionString: normalizePostgresConnectionString(url.toString()), role };
}

/** One MVCC snapshot of table contents. Sequence state is observed separately:
 * the caller must exclude producers for it to be a stable recovery comparison.
 * No row values or per-row digests leave PostgreSQL.
 */
export async function fingerprintRehearsalData(client: Pick<Client, "query">) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL search_path=pg_catalog");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL timezone='UTC'");
    await client.query("SET LOCAL datestyle='ISO, YMD'");
    await client.query("SET LOCAL bytea_output='hex'");
    const relations = (
      await client.query(`SELECT relname,relkind FROM pg_catalog.pg_class
        WHERE relnamespace='api_next'::regnamespace AND relkind IN ('r','p','S','f','m')
        ORDER BY relname COLLATE "C" LIMIT 2001`)
    ).rows;
    if (relations.length > 2000 || relations.some((row) => ["f", "m"].includes(row.relkind)))
      throw new Error("rehearsal_data_classes_unproven");
    const tables: { table: string; count: number; sha256: string }[] = [];
    const sequences: { sequence: string; sha256: string }[] = [];
    for (const relation of relations) {
      const target = `api_next.${identifier(relation.relname)}`;
      if (relation.relkind === "S") {
        const result = await client.query(`SELECT last_value::text,is_called FROM ${target}`);
        if (result.rows.length !== 1) throw new Error("rehearsal_sequence_unproven");
        sequences.push({ sequence: relation.relname, sha256: hash(result.rows[0]) });
        continue;
      }
      const result = await client.query(`WITH rows AS MATERIALIZED (
        SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest
        FROM ONLY ${target} t LIMIT 1000001
      ) SELECT count(*)::int AS count,
        encode(sha256(convert_to(coalesce(string_agg(digest,'' ORDER BY digest COLLATE "C"),''),'UTF8')),'hex') AS sha256
        FROM rows`);
      const row = result.rows[0];
      if (!row || !Number.isSafeInteger(row.count) || row.count > 1_000_000)
        throw new Error("rehearsal_data_limit");
      tables.push({ table: relation.relname, count: row.count, sha256: row.sha256 });
    }
    await client.query("ROLLBACK");
    return { version: 1, tables, sequences, sha256: hash({ tables, sequences }) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function provider(path: string) {
  const { stdout } = await execute(
    "pscale",
    ["api", path, "--method", "GET", "--api-url", "https://api.planetscale.com/"],
    {
      timeout: 30_000,
      maxBuffer: 1_048_576,
      encoding: "utf8",
    },
  );
  return JSON.parse(stdout);
}

/** Fixed isolated branch only. This neither fences nor invokes reconstruction. */
export async function inspectProviderRehearsal() {
  let client: Client | undefined;
  let phase = "target";
  try {
    const database = await provider(base);
    const branch = await provider(`${base}/branches/${branchName}`);
    const access = await provider(`${base}/branches/${branchName}/roles/default`);
    if (
      database.id !== databaseId ||
      database.kind !== "postgresql" ||
      branch.id !== branchId ||
      branch.name !== branchName ||
      branch.ready !== true ||
      branch.state !== "ready" ||
      branch.restored_from_branch?.id !== sourceId ||
      access.branch?.id !== branchId ||
      access.default !== true ||
      typeof access.access_host_url !== "string"
    )
      throw new Error();
    let runtimeRole: string | undefined;
    for (const [kind, key] of [
      ["runtime", "CONTROL_PLANE_POSTGRES_RUNTIME_URL"],
      ["operator", "CONTROL_PLANE_POSTGRES_ADMIN_URL"],
    ]) {
      phase = `${kind}_identity`;
      const resolved = restoredConnection(process.env[key] ?? "", access.access_host_url);
      client = new Client({
        connectionString: resolved.connectionString,
        connectionTimeoutMillis: 10_000,
      });
      await client.connect();
      const identity = (
        await client.query(
          "SELECT session_user AS login,current_user AS active,current_database() AS database",
        )
      ).rows[0];
      if (
        identity?.login !== resolved.role ||
        identity.active !== resolved.role ||
        identity.database !== "postgres"
      )
        throw new Error();
      if (kind === "runtime") runtimeRole = resolved.role;
      else {
        if (runtimeRole === resolved.role) throw new Error();
        phase = "catalog";
        const inventory = await observeInplaceInventory(client, runtimeRole);
        phase = "data";
        const data = await fingerprintRehearsalData(client);
        return {
          observed_at: new Date().toISOString(),
          branch_id: branchId,
          source_branch_id: sourceId,
          inventory: {
            ...inventory,
            owners: inventory.owners.map((owner) => ({
              kind: owner.kind,
              count: owner.count,
              not_effectively_owned_count: owner.not_effectively_owned.length,
            })),
          },
          data,
          fence_verified: false,
          recovery_verified: false,
          execution_authorized: false,
        };
      }
      await client.end();
      client = undefined;
    }
    throw new Error();
  } catch {
    throw new Error(`provider_rehearsal_unproven:${phase}`);
  } finally {
    await client?.end().catch(() => undefined);
  }
}

if (import.meta.main) {
  try {
    if (Bun.argv.length !== 3 || Bun.argv[2] !== "--read-only") throw new Error();
    console.log(JSON.stringify(await inspectProviderRehearsal()));
  } catch {
    console.error("provider_rehearsal_unproven");
    process.exitCode = 1;
  }
}
