import { createHash } from "node:crypto";
import { Schema } from "effect";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import { RUNTIME_DENIAL_CATALOG_SQL } from "./staging-persona-runtime-denial.ts";
import { observeSessionDrain } from "./staging-persona-session-drain.ts";
import { collectStagingProviderBinding } from "./staging-persona-target-binding.ts";

const Runtime = Schema.Struct({
  role: Schema.String.check(Schema.isPattern(/^[a-z_][a-z0-9_]{0,62}$/u)),
  connectionString: Schema.String,
});
const Scan = Schema.Struct({
  schema_count: Schema.Literal(1),
  elevated: Schema.Literal(false),
  database_create: Schema.Literal(false),
  owns_objects: Schema.Literal(false),
  schema_access: Schema.Literal(false),
  table_access: Schema.Literal(false),
  sequence_access: Schema.Literal(false),
  definer_access: Schema.Literal(false),
});
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(value);

export function isDatabaseReconnectDenial(error: unknown): boolean {
  const result = Schema.decodeUnknownOption(
    Schema.Struct({ code: Schema.Literals(["42501", "28000"]) }),
  )(error);
  return result._tag === "Some";
}

/** A TCP failure or bad password does not prove reconnect denial. */
export async function probeDeniedRuntimeReconnect(connectionString: string): Promise<boolean> {
  const url = new URL(connectionString);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.searchParams.get("sslmode") !== "verify-full"
  )
    throw new Error("database_probe_tls_required");
  const client = new Client({
    connectionString: normalizePostgresConnectionString(connectionString),
    connectionTimeoutMillis: 3_000,
    application_name: "staging-reconnect-proof",
  });
  try {
    await client.connect();
    return false;
  } catch (error) {
    return isDatabaseReconnectDenial(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Dedicated authenticated admin connection; runtime list comes from independently
 * verified provider/Hyperdrive inventory. Never derive roles from a submitted manifest.
 * Reads privileges, probes reconnect and proves drain; it changes no ACL or session. */
export async function observeMaintainedDatabaseFence(input: {
  readonly admin: Client;
  readonly expectedAdmin: string;
  readonly runtimes: readonly { readonly role: string; readonly connectionString: string }[];
  readonly probeReconnect?: (connectionString: string) => Promise<boolean>;
}) {
  const runtimes = decode(
    Schema.Array(Runtime).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    input.runtimes,
  );
  if (
    new Set(runtimes.map((runtime) => runtime.role)).size !== runtimes.length ||
    runtimes.some((runtime) => runtime.role === input.expectedAdmin)
  )
    throw new Error("database_runtime_inventory_unproven");
  try {
    const scans: { roleDigest: string; reconnectDenied: true }[] = [];
    for (const runtime of runtimes) {
      await input.admin.query("BEGIN READ ONLY");
      await input.admin.query("SET LOCAL statement_timeout='3s'");
      await input.admin.query("SET LOCAL search_path=pg_catalog");
      const identity = await input.admin.query(
        "SELECT session_user::text AS login,current_user::text AS effective",
      );
      if (
        identity.rows[0]?.login !== input.expectedAdmin ||
        identity.rows[0]?.effective !== input.expectedAdmin
      )
        throw new Error("database_observer_identity");
      const result = await input.admin.query(RUNTIME_DENIAL_CATALOG_SQL, [
        "api_next",
        runtime.role,
      ]);
      decode(Scan, result.rows[0]);
      // Includes PUBLIC grants and every available SET ROLE path, not only the login role.
      const connect = await input.admin.query(
        `SELECT count(*)::int AS roles,
        coalesce(bool_or(has_database_privilege(oid,current_database(),'CONNECT')),true) AS can_connect
        FROM pg_catalog.pg_roles WHERE pg_has_role($1::name,oid,'MEMBER')`,
        [runtime.role],
      );
      if (
        connect.rows[0]?.can_connect !== false ||
        !Number.isSafeInteger(connect.rows[0]?.roles) ||
        connect.rows[0].roles < 1
      )
        throw new Error("database_connect_privilege");
      await input.admin.query("ROLLBACK");
      if (!(await (input.probeReconnect ?? probeDeniedRuntimeReconnect)(runtime.connectionString)))
        throw new Error("database_reconnect_admitted");
      scans.push({
        roleDigest: createHash("sha256").update(runtime.role).digest("hex"),
        reconnectDenied: true,
      });
    }
    await observeSessionDrain(input.admin, input.expectedAdmin);
    return {
      verifiedAt: new Date().toISOString(),
      databaseWrites: true as const,
      reconnectDenied: true as const,
      runtimeSessions: 0 as const,
      runtimeIdentityFingerprints: scans.map((scan) => scan.roleDigest),
      evidenceDigest: createHash("sha256").update(JSON.stringify(scans)).digest("hex"),
    };
  } catch {
    throw new Error("staging_database_fence_unproven");
  } finally {
    await input.admin.query("ROLLBACK").catch(() => undefined);
  }
}

/** Concrete fixed-target reader. Unknown provider roles are not silently excluded.
 * The private binding includes credentials in memory; only redacted evidence leaves. */
export async function collectStagingDatabaseFence() {
  const binding = await collectStagingProviderBinding();
  if (binding.otherActiveRoleIds.length !== 0)
    throw new Error("database_runtime_inventory_unproven");
  const admin = new Client({
    connectionString: normalizePostgresConnectionString(binding.adminRaw),
    connectionTimeoutMillis: 3000,
    application_name: "staging-fence-observer",
  });
  try {
    await admin.connect();
    const evidence = await observeMaintainedDatabaseFence({
      admin,
      expectedAdmin: binding.admin.sqlRole,
      runtimes: [{ role: binding.runtime.sqlRole, connectionString: binding.runtimeRaw }],
    });
    return { ...evidence, targetBindingDigest: binding.target_binding_sha256 };
  } catch {
    throw new Error("staging_database_fence_unproven");
  } finally {
    await admin.end().catch(() => undefined);
  }
}

if (import.meta.main) {
  try {
    if (Bun.argv.length !== 3 || Bun.argv[2] !== "--read-only") throw new Error();
    console.log(JSON.stringify(await collectStagingDatabaseFence()));
  } catch {
    console.error("staging_database_fence_unproven");
    process.exitCode = 1;
  }
}
