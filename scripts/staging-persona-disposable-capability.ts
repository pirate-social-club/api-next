import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

const executeFile = promisify(execFile);
const identifier = /^[a-z_][a-z0-9_]{0,62}$/u;
const providerId = /^[a-z0-9]{12}$/u;
const providerRoleName = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export type DisposableCapabilityCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
}>;

export type DisposableCapabilityCommand = (
  args: readonly string[],
) => Promise<DisposableCapabilityCommandResult>;

export type DisposableCapabilityRecovery = Readonly<{
  roleId: string;
  roleName: string;
  expiresAt: string | null;
  databaseCreateRetired: boolean;
}>;

type RoleMetadata = Readonly<{
  id: string;
  name: string;
  username: string;
  baseUsername: string;
  accessHost: string;
  expiresAt: number;
}>;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("staging_disposable_role_shape_unproven");
  }
  return value as Record<string, unknown>;
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("staging_disposable_role_shape_unproven");
  }
}

function readRole(
  value: unknown,
  expected: {
    readonly name: string;
    readonly accessHost: string;
    readonly branchId: string;
    readonly nowMs: number;
  },
): RoleMetadata {
  const role = object(value);
  const branch = object(role.branch);
  const expiresAt = typeof role.expires_at === "string" ? Date.parse(role.expires_at) : Number.NaN;
  if (
    typeof role.id !== "string" ||
    !providerId.test(role.id) ||
    role.name !== expected.name ||
    typeof role.username !== "string" ||
    !role.username.endsWith(`.${expected.branchId}`) ||
    typeof role.base_username !== "string" ||
    !identifier.test(role.base_username) ||
    role.access_host_url !== expected.accessHost ||
    role.database_name !== "postgres" ||
    branch.id !== expected.branchId ||
    branch.name !== "main" ||
    role.expired !== false ||
    role.deleted_at != null ||
    role.dropped_at != null ||
    role.disabled_at != null ||
    !Array.isArray(role.inherited_roles) ||
    role.inherited_roles.length !== 1 ||
    role.inherited_roles[0] !== "postgres" ||
    !Number.isFinite(expiresAt) ||
    expiresAt < expected.nowMs + 20 * 60_000 ||
    expiresAt > expected.nowMs + 35 * 60_000
  ) {
    throw new Error("staging_disposable_role_target_unproven");
  }
  return {
    id: role.id,
    name: expected.name,
    username: role.username,
    baseUsername: role.base_username,
    accessHost: expected.accessHost,
    expiresAt,
  };
}

function creationConnection(value: unknown, role: RoleMetadata): string {
  const created = object(value);
  if (typeof created.database_url !== "string") {
    throw new Error("staging_disposable_role_credential_unproven");
  }
  const url = new URL(created.database_url);
  const entries = [...url.searchParams];
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hash ||
    decodeURIComponent(url.pathname) !== "/postgres" ||
    decodeURIComponent(url.username) !== role.username ||
    !url.password ||
    url.hostname !== role.accessHost ||
    (url.port || "5432") !== "5432" ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    new Set(entries.map(([key]) => key)).size !== entries.length ||
    entries.some(([key, entry]) =>
      key === "sslmode" ? entry !== "verify-full" : key !== "sslrootcert" || entry !== "system",
    )
  ) {
    throw new Error("staging_disposable_role_credential_unproven");
  }
  return normalizePostgresConnectionString(url.toString());
}

export async function runDisposableCapabilityCommand(
  args: readonly string[],
): Promise<DisposableCapabilityCommandResult> {
  try {
    const result = await executeFile("pscale", [...args], {
      timeout: 45_000,
      maxBuffer: 1_048_576,
      encoding: "utf8",
    });
    return { ok: true, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

export async function writeDisposableCapabilityRecovery(
  markerDirectory: string,
  evidence: DisposableCapabilityRecovery,
): Promise<void> {
  const record = {
    schema_version: 1,
    disposition: "capability_cleanup_unresolved",
    role_id: evidence.roleId,
    role_name: evidence.roleName,
    role_expires_at: evidence.expiresAt,
    database_create_retired: evidence.databaseCreateRetired,
  };
  await mkdir(markerDirectory, { recursive: true });
  const path = join(markerDirectory, "staging-disposable-capability-recovery.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function quote(value: string): string {
  if (!identifier.test(value)) throw new Error("staging_disposable_identifier_invalid");
  return `"${value}"`;
}

function assertDatabaseCreateRetired(value: unknown): void {
  if (value !== false) throw new Error("staging_disposable_database_create_retained");
}

function discoverCreatedRoleId(value: unknown, name: string): string | undefined {
  if (!Array.isArray(value)) throw new Error("staging_disposable_role_lookup_unproven");
  const matches = value.filter((entry) => object(entry).name === name);
  if (matches.length === 0) return undefined;
  const discovered = matches.length === 1 ? object(matches[0]).id : undefined;
  if (typeof discovered !== "string" || !providerId.test(discovered)) {
    throw new Error("staging_disposable_role_lookup_unproven");
  }
  return discovered;
}

function assertCreatedRoleAbsent(value: unknown, id: string): void {
  if (!Array.isArray(value) || value.some((entry) => object(entry).id === id)) {
    throw new Error("staging_disposable_role_absence_unproven");
  }
}

async function changeDatabaseCreate(
  client: Pick<Client, "query">,
  ownerRole: string,
  mode: "grant" | "revoke",
) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE postgres");
    await client.query(
      `${mode === "grant" ? "GRANT" : "REVOKE"} CREATE ON DATABASE postgres ${
        mode === "grant" ? "TO" : "FROM"
      } ${quote(ownerRole)}`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** Supplies database CREATE only for one fenced schema replacement. Provider
 * credentials remain in process memory. Cleanup revokes CREATE, closes the SQL
 * client, deletes the provider role and proves it absent before returning. */
export async function withPlanetScaleDatabaseCreate<T>(input: {
  readonly ownerRole: string;
  readonly roleName: string;
  readonly accessHost: string;
  readonly branchId: string;
  readonly execute: () => Promise<T>;
  readonly command?: DisposableCapabilityCommand;
  readonly connect?: (connectionString: string) => Client;
  readonly now?: () => number;
  readonly recordRecovery?: (evidence: DisposableCapabilityRecovery) => Promise<void>;
}): Promise<T> {
  if (!identifier.test(input.ownerRole) || !providerRoleName.test(input.roleName)) {
    throw new Error("staging_disposable_identifier_invalid");
  }
  const command = input.command ?? runDisposableCapabilityCommand;
  const now = input.now?.() ?? Date.now();
  let role: RoleMetadata | undefined;
  let roleId: string | undefined;
  let createAttempted = false;
  let roleAbsenceProven = false;
  let client: Client | undefined;
  let grantAttempted = false;
  let createRetired = false;
  let result: T | undefined;
  let operationError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    createAttempted = true;
    const created = await command([
      "role",
      "create",
      "pirate-staging",
      "main",
      input.roleName,
      "--ttl",
      "30m",
      "--inherited-roles",
      "postgres",
      "--format",
      "json",
    ]);
    if (!created.ok) throw new Error("staging_disposable_role_create_unproven");
    const createdValue = parseJson(created.stdout);
    const createdObject = object(createdValue);
    if (typeof createdObject.id !== "string" || !providerId.test(createdObject.id)) {
      throw new Error("staging_disposable_role_shape_unproven");
    }
    roleId = createdObject.id;
    const observed = await command([
      "api",
      `organizations/{org}/databases/pirate-staging/branches/main/roles/${roleId}`,
      "--method",
      "GET",
      "--api-url",
      "https://api.planetscale.com/",
    ]);
    if (!observed.ok) throw new Error("staging_disposable_role_readback_unproven");
    role = readRole(parseJson(observed.stdout), {
      name: input.roleName,
      accessHost: input.accessHost,
      branchId: input.branchId,
      nowMs: now,
    });
    const connectionString = creationConnection(createdValue, role);
    const { Client: PgClient } = await import("pg");
    client =
      input.connect?.(connectionString) ??
      new PgClient({ connectionString, connectionTimeoutMillis: 10_000 });
    await client.connect();
    const identity = (
      await client.query(`SELECT session_user AS login,current_user AS active,
        current_database() AS database,pg_has_role(current_user,'postgres','MEMBER') AS member`)
    ).rows[0];
    if (
      identity?.login !== role.baseUsername ||
      identity.active !== role.baseUsername ||
      identity.database !== "postgres" ||
      identity.member !== true
    ) {
      throw new Error("staging_disposable_role_sql_identity_unproven");
    }
    // Treat the grant as potentially committed before awaiting its response. A
    // lost COMMIT response is ambiguous, so cleanup must still issue and prove
    // the compensating REVOKE before retiring the provider role.
    grantAttempted = true;
    await changeDatabaseCreate(client, input.ownerRole, "grant");
    const allowed = (
      await client.query("SELECT has_database_privilege($1,current_database(),'CREATE') AS value", [
        input.ownerRole,
      ])
    ).rows[0]?.value;
    if (allowed !== true) throw new Error("staging_disposable_database_create_unproven");
    result = await input.execute();
  } catch (error) {
    operationError = error;
  } finally {
    if (client !== undefined && grantAttempted) {
      try {
        await changeDatabaseCreate(client, input.ownerRole, "revoke");
        const allowed = (
          await client.query(
            "SELECT has_database_privilege($1,current_database(),'CREATE') AS value",
            [input.ownerRole],
          )
        ).rows[0]?.value;
        assertDatabaseCreateRetired(allowed);
        createRetired = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (client !== undefined) {
      try {
        await client.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (createAttempted && roleId === undefined) {
      const listed = await command(["role", "list", "pirate-staging", "main", "--format", "json"]);
      try {
        const values = listed.ok ? parseJson(listed.stdout) : null;
        roleId = discoverCreatedRoleId(values, input.roleName);
        roleAbsenceProven = roleId === undefined;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (roleId !== undefined && (!grantAttempted || createRetired)) {
      const deleted = await command([
        "role",
        "delete",
        "pirate-staging",
        "main",
        roleId,
        "--force",
        "--format",
        "json",
      ]);
      if (!deleted.ok) cleanupErrors.push(new Error("staging_disposable_role_delete_unproven"));
      const listed = await command(["role", "list", "pirate-staging", "main", "--format", "json"]);
      try {
        const values = listed.ok ? parseJson(listed.stdout) : null;
        assertCreatedRoleAbsent(values, roleId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else if (roleId !== undefined && grantAttempted) {
      cleanupErrors.push(new Error("staging_disposable_role_retained_for_recovery"));
    } else if (createAttempted && !roleAbsenceProven) {
      cleanupErrors.push(new Error("staging_disposable_role_absence_unproven"));
    }
  }
  if (cleanupErrors.length > 0) {
    if (roleId !== undefined && input.recordRecovery !== undefined) {
      try {
        await input.recordRecovery({
          roleId,
          roleName: input.roleName,
          expiresAt: role === undefined ? null : new Date(role.expiresAt).toISOString(),
          databaseCreateRetired: createRetired,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    throw new Error("staging_disposable_capability_cleanup_unresolved", {
      cause: new AggregateError(
        operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
      ),
    });
  }
  if (operationError !== undefined) throw operationError;
  return result as T;
}
