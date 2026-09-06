import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-migrations";

const execute = promisify(execFile);
const databaseId = "mvydkmmwh5x4";
const branchId = "syu03e00w3ux";
const hyperdriveId = "8cb7658a0f7143359c1becfec6a15c23";
const base = "organizations/{org}/databases/pirate-staging";
type ConnectionKind = "admin" | "runtime";
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("target_shape");
  return value as Record<string, unknown>;
};

function assertConnectionParameters(url: URL, kind: ConnectionKind) {
  const expected = new Map(
    kind === "admin"
      ? [["sslmode", "verify-full"]]
      : [
          ["sslmode", "verify-full"],
          ["sslrootcert", "system"],
        ],
  );
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== expected.size ||
    new Set(entries.map(([key]) => key)).size !== expected.size ||
    entries.some(([key, value]) => expected.get(key) !== value)
  )
    throw new Error("staging_connection_parameters");
}

/** Pure consistency check. Provider metadata is supplied by the live collector
 * below, never treated as an authorization receipt from a JSON caller.
 */
export function matchStagingRole(value: unknown, rawUrl: string, kind: ConnectionKind) {
  const role = object(value);
  const branch = object(role.branch);
  const url = new URL(rawUrl);
  assertConnectionParameters(url, kind);
  const username = decodeURIComponent(url.username);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hash ||
    decodeURIComponent(url.pathname) !== "/postgres" ||
    (url.port || "5432") !== "5432" ||
    role.username !== username ||
    role.access_host_url !== url.hostname ||
    role.database_name !== "postgres" ||
    branch.id !== branchId ||
    branch.name !== "main" ||
    role.expired !== false ||
    role.deleted_at != null ||
    role.dropped_at != null ||
    role.disabled_at != null ||
    typeof role.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(role.id) ||
    typeof role.base_username !== "string" ||
    !role.base_username ||
    (role.expires_at != null &&
      (typeof role.expires_at !== "string" ||
        !Number.isFinite(Date.parse(role.expires_at)) ||
        Date.parse(role.expires_at) <= Date.now()))
  )
    throw new Error("staging_role_target_mismatch");
  return {
    id: role.id,
    sqlRole: role.base_username,
    hostname: url.hostname,
    port: url.port || "5432",
    username,
  };
}

async function provider(path: string, page?: number) {
  const { stdout } = await execute(
    "pscale",
    [
      "api",
      path,
      "--method",
      "GET",
      "--api-url",
      "https://api.planetscale.com/",
      ...(page === undefined ? [] : ["--query", `page=${page}`]),
    ],
    { timeout: 30_000, maxBuffer: 2_097_152, encoding: "utf8" },
  );
  return object(JSON.parse(stdout));
}

export function inspectStagingRolePage(value: unknown, page: number) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("staging_role_pagination");
  const response = object(value);
  if (
    !Array.isArray(response.data) ||
    response.current_page !== page ||
    !Object.hasOwn(response, "next_page")
  )
    throw new Error("staging_role_pagination_metadata");
  const nextPage = response.next_page;
  if (nextPage !== null && (!Number.isSafeInteger(nextPage) || nextPage !== page + 1))
    throw new Error("staging_role_pagination");
  return { data: response.data, nextPage };
}

async function sqlIdentity(raw: string, expectedRole: string) {
  const client = new Client({
    connectionString: normalizePostgresConnectionString(raw),
    connectionTimeoutMillis: 10_000,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout='5s'");
    const row = (
      await client.query(
        "SELECT current_database() AS database,session_user AS login,current_user AS active",
      )
    ).rows[0];
    if (row?.database !== "postgres" || row.login !== expectedRole || row.active !== expectedRole)
      throw new Error("staging_sql_identity_mismatch");
    await client.query("ROLLBACK");
  } finally {
    if (connected) await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

/** Fixed-target, read-only collector. Secrets remain in process memory. This
 * proves neither a fence nor recovery and cannot invoke reconstruction.
 */
export async function collectStagingTargetBinding() {
  let phase = "credentials";
  try {
    const adminRaw = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
    const runtimeRaw = process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
    if (!adminRaw || !runtimeRaw) throw new Error("missing_connection");
    phase = "provider";
    const database = await provider(base);
    const branch = await provider(`${base}/branches/main`);
    if (
      database.id !== databaseId ||
      database.name !== "pirate-staging" ||
      database.kind !== "postgresql" ||
      branch.id !== branchId ||
      branch.name !== "main" ||
      branch.kind !== "postgresql" ||
      branch.ready !== true ||
      branch.state !== "ready"
    )
      throw new Error("staging_provider_target_mismatch");
    phase = "roles";
    const roles: unknown[] = [];
    // Fixed endpoint pagination: never follow an arbitrary provider-supplied URL.
    let complete = false;
    for (let page = 1; page <= 20; page++) {
      const response = await provider(`${base}/branches/main/roles`, page);
      const pageData = inspectStagingRolePage(response, page);
      roles.push(...pageData.data);
      if (pageData.nextPage === null) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error("staging_role_list_incomplete");
    const resolve = (raw: string, kind: ConnectionKind) => {
      const username = decodeURIComponent(new URL(raw).username);
      const matches = roles.filter((role) => object(role).username === username);
      if (matches.length !== 1) throw new Error("staging_role_not_unique");
      return matchStagingRole(matches[0], raw, kind);
    };
    phase = "admin_binding";
    const admin = resolve(adminRaw, "admin");
    phase = "runtime_binding";
    const runtime = resolve(runtimeRaw, "runtime");
    if (admin.sqlRole === runtime.sqlRole || admin.id === runtime.id)
      throw new Error("staging_roles_not_separate");
    phase = "hyperdrive";
    const { stdout } = await execute(
      "bunx",
      [
        "wrangler",
        "hyperdrive",
        "get",
        hyperdriveId,
        "--config",
        "apps/http-worker/wrangler.jsonc",
        "--env",
        "staging",
      ],
      { timeout: 30_000, maxBuffer: 1_048_576, encoding: "utf8" },
    );
    const hyperdrive = object(JSON.parse(stdout.slice(stdout.indexOf("{"))));
    const origin = object(hyperdrive.origin);
    if (
      hyperdrive.id !== hyperdriveId ||
      origin.host !== runtime.hostname ||
      String(origin.port) !== runtime.port ||
      origin.database !== "postgres" ||
      origin.user !== runtime.username ||
      object(hyperdrive.caching).disabled !== true
    )
      throw new Error("staging_hyperdrive_target_mismatch");
    // Sequential fresh sessions do not consume two scarce staging slots at once.
    phase = "runtime_sql";
    await sqlIdentity(runtimeRaw, runtime.sqlRole);
    phase = "admin_sql";
    await sqlIdentity(adminRaw, admin.sqlRole);
    const tuple = {
      databaseId,
      branchId,
      hyperdriveId,
      adminId: admin.id,
      runtimeId: runtime.id,
      adminHost: admin.hostname,
      runtimeHost: runtime.hostname,
      adminRole: admin.sqlRole,
      runtimeRole: runtime.sqlRole,
    };
    return {
      observed_at: new Date().toISOString(),
      database_id: databaseId,
      branch_id: branchId,
      hyperdrive_id: hyperdriveId,
      target_binding_sha256: createHash("sha256").update(JSON.stringify(tuple)).digest("hex"),
      provider_sql_hyperdrive_bound: true,
      caching_disabled: true,
      fence_verified: false,
      recovery_verified: false,
      execution_authorized: false,
    };
  } catch {
    // Driver/CLI bodies can contain credentials: never propagate them.
    throw new Error(`staging_target_binding_unproven:${phase}`);
  }
}

if (import.meta.main) {
  try {
    if (Bun.argv.length !== 3 || Bun.argv[2] !== "--read-only") throw new Error();
    console.log(JSON.stringify(await collectStagingTargetBinding()));
  } catch (error) {
    console.error(
      error instanceof Error && /^staging_target_binding_unproven:[a-z_]+$/.test(error.message)
        ? error.message
        : "staging_target_binding_unproven",
    );
    process.exitCode = 1;
  }
}
