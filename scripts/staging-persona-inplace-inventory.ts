import { createHash } from "node:crypto";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-migrations";
import {
  assertStagingResetLedger,
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";

const classes = [
  ["pg_class", "relnamespace", "relowner"],
  ["pg_proc", "pronamespace", "proowner"],
  ["pg_type", "typnamespace", "typowner"],
  ["pg_operator", "oprnamespace", "oprowner"],
  ["pg_opclass", "opcnamespace", "opcowner"],
  ["pg_opfamily", "opfnamespace", "opfowner"],
  ["pg_collation", "collnamespace", "collowner"],
  ["pg_conversion", "connamespace", "conowner"],
  ["pg_ts_config", "cfgnamespace", "cfgowner"],
  ["pg_ts_dict", "dictnamespace", "dictowner"],
  ["pg_statistic_ext", "stxnamespace", "stxowner"],
] as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Catalog evidence, not DROP eligibility or an approved grant replay manifest. */
export async function observeInplaceInventory(client: Client, runtimeRole?: string) {
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL search_path = pg_catalog");
    const identity = await client.query(
      "SELECT current_database() = 'postgres' AS target, session_user = current_user AS direct",
    );
    if (identity.rows[0]?.target !== true || identity.rows[0]?.direct !== true) throw new Error();
    const ledger = await client.query(
      "SELECT version, checksum FROM api_next.schema_migrations ORDER BY version",
    );
    assertStagingResetLedger(
      validateStagingResetArtifacts(loadStagingResetArtifacts()),
      ledger.rows,
    );
    const owners = [];
    for (const [table, namespace, owner] of classes) {
      const result = await client.query(
        `SELECT o.oid::text AS object_id, identified.identity,
          ${owner}::text AS owner_id, pg_has_role(current_user, ${owner}, 'USAGE') AS effective_owner
        FROM pg_catalog.${table} o
        CROSS JOIN LATERAL pg_identify_object($1::regclass,o.oid,0) identified
        WHERE ${namespace} = 'api_next'::regnamespace ORDER BY o.oid`,
        [`pg_catalog.${table}`],
      );
      owners.push({ class: table, rows: result.rows });
    }
    const schema = await client.query(`SELECT nspowner::text AS owner_id, nspacl::text AS acl,
        has_schema_privilege(current_user,oid,'CREATE') AS can_create_objects,
        pg_has_role(current_user,nspowner,'USAGE') AS effective_owner
      FROM pg_namespace WHERE nspname='api_next'`);
    const acls = await client.query(`WITH objects AS (
      SELECT 'schema' AS kind, oid AS id, coalesce(nspacl,acldefault('n',nspowner)) AS acl
        FROM pg_namespace WHERE nspname='api_next'
      UNION ALL SELECT 'relation',oid,coalesce(relacl,acldefault(CASE WHEN relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,relowner))
        FROM pg_class WHERE relnamespace='api_next'::regnamespace AND relkind IN ('r','p','v','m','f','S')
      UNION ALL SELECT 'function',oid,coalesce(proacl,acldefault('f',proowner))
        FROM pg_proc WHERE pronamespace='api_next'::regnamespace
      UNION ALL SELECT 'type',oid,coalesce(typacl,acldefault('T',typowner))
        FROM pg_type WHERE typnamespace='api_next'::regnamespace
    ) SELECT kind,id::text, grantor::text,grantee::text,privilege_type,is_grantable
      FROM objects CROSS JOIN LATERAL aclexplode(acl)
      ORDER BY kind,id,grantor,grantee,privilege_type,is_grantable`);
    const columns =
      await client.query(`SELECT a.attrelid::text,a.attnum,a.attacl::text FROM pg_attribute a
      JOIN pg_class r ON r.oid=a.attrelid WHERE r.relnamespace='api_next'::regnamespace
      AND a.attacl IS NOT NULL ORDER BY a.attrelid,a.attnum`);
    const defaults =
      await client.query(`SELECT defaclrole::text,defaclnamespace::text,defaclobjtype,defaclacl::text
      FROM pg_default_acl WHERE defaclnamespace IN (0,'api_next'::regnamespace)
      ORDER BY defaclrole,defaclnamespace,defaclobjtype`);
    const extensions = await client.query(`SELECT extname,extversion,n.nspname AS schema,
        pg_has_role(current_user,extowner,'USAGE') AS effective_owner
      FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY extname`);
    const special = await client.query(`SELECT 'text search parser' AS kind,count(*)::int AS count
        FROM pg_ts_parser WHERE prsnamespace='api_next'::regnamespace
      UNION ALL SELECT 'text search template',count(*)::int FROM pg_ts_template WHERE tmplnamespace='api_next'::regnamespace`);
    const capacity = await client.query(`SELECT
      current_setting('max_locks_per_transaction')::int AS max_locks_per_transaction,
      current_setting('max_connections')::int AS max_connections,
      current_setting('max_prepared_transactions')::int AS max_prepared_transactions`);
    const defaultReview = await client.query(
      `SELECT
      CASE WHEN d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) THEN 'operator'
        WHEN d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=$1) THEN 'runtime' ELSE 'other' END AS owner_role,
      CASE WHEN d.defaclnamespace=0 THEN 'global' ELSE 'api_next' END AS scope,
      d.defaclobjtype AS object_type,
      CASE WHEN a.grantee=0 THEN 'PUBLIC'
        WHEN a.grantee=(SELECT oid FROM pg_roles WHERE rolname=current_user) THEN 'operator'
        WHEN a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1) THEN 'runtime' ELSE 'other' END AS grantee_role,
      a.privilege_type AS privilege,a.is_grantable AS grant_option
      FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclnamespace IN (0,'api_next'::regnamespace)
      ORDER BY owner_role,scope,object_type,grantee_role,privilege,grant_option`,
      [runtimeRole ?? null],
    );
    await client.query("ROLLBACK");
    return {
      observed_at: new Date().toISOString(),
      ledger_matches_0109: true,
      schema: {
        can_create_objects: schema.rows[0]?.can_create_objects,
        effective_owner: schema.rows[0]?.effective_owner,
      },
      owners: owners.map(({ class: kind, rows }) => ({
        kind,
        count: rows.length,
        not_effectively_owned: rows
          .filter((row) => row.effective_owner !== true)
          .map((row) => ({ identity: row.identity, owner_fingerprint: hash(row.owner_id) })),
      })),
      ownership_sha256: hash(owners),
      schema_acl_sha256: hash(schema.rows),
      acl_count: acls.rows.length,
      acl_sha256: hash(acls.rows),
      acl_summary: [...new Set(acls.rows.map((row) => row.kind))].map((kind) => ({
        kind,
        entries: acls.rows.filter((row) => row.kind === kind).length,
        public_entries: acls.rows.filter((row) => row.kind === kind && row.grantee === "0").length,
      })),
      column_acl_count: columns.rows.length,
      column_acl_sha256: hash(columns.rows),
      default_acl_count: defaults.rows.length,
      default_acl_sha256: hash(defaults.rows),
      extensions: extensions.rows,
      extensions_sha256: hash(extensions.rows),
      special_classes: special.rows,
      lock_capacity: capacity.rows[0],
      default_acl_review: defaultReview.rows,
      provider_target_verified: false,
      execution_authorized: false,
    };
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error("inplace_catalog_inventory_unproven");
  }
}

if (import.meta.main) {
  let client: Client | undefined;
  let runtimeClient: Client | undefined;
  try {
    if (Bun.argv.length !== 3 || Bun.argv[2] !== "--read-only") throw new Error();
    const raw = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
    if (!raw) throw new Error();
    client = new Client({
      connectionString: normalizePostgresConnectionString(raw),
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    const runtime = process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
    let runtimeRole: string | undefined;
    if (runtime) {
      runtimeClient = new Client({
        connectionString: normalizePostgresConnectionString(runtime),
        connectionTimeoutMillis: 10_000,
      });
      await runtimeClient.connect();
      // Provider connection usernames may include a branch suffix. Use the SQL
      // identity, not URL spelling, when attributing default grants.
      const identity = await runtimeClient.query(
        "SELECT session_user AS role, current_database() AS database",
      );
      if (identity.rows[0]?.database !== "postgres") throw new Error();
      runtimeRole = identity.rows[0].role;
      await runtimeClient.end();
      runtimeClient = undefined;
    }
    console.log(JSON.stringify(await observeInplaceInventory(client, runtimeRole)));
  } catch {
    console.error("inplace_catalog_inventory_unproven");
    process.exitCode = 1;
  } finally {
    await runtimeClient?.end().catch(() => undefined);
    await client?.end().catch(() => undefined);
  }
}
