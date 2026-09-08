import { createHash } from "node:crypto";
import type { Client } from "pg";
import { scanResetDependencyClosureInTransaction } from "./staging-persona-dependency-scan";
import { validateStagingResetArtifacts } from "./staging-persona-reset-plan";

// Root objects only. Indexes, table row types, array types, owned sequences and
// TOAST objects are removed with their parents. Never DROP OWNED or the schema.
const rootsQuery = `WITH target AS (
  SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1
), roots AS (
  SELECT 1 AS phase, 'pg_class' AS class, r.oid::text AS id,
    pg_catalog.format('%I.%I', $1, r.relname) AS identity,
    pg_catalog.pg_has_role(r.relowner, 'USAGE') AS owned,
    pg_catalog.format('DROP %s IF EXISTS %I.%I CASCADE',
      CASE r.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE'
        WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE' END, $1, r.relname) AS statement
    FROM pg_catalog.pg_class r WHERE r.relnamespace=(SELECT oid FROM target)
      AND r.relkind IN ('r','p','v','m','f')
  UNION ALL
  SELECT 2, 'pg_proc', p.oid::text,
    pg_catalog.format('%I.%I(%s)', $1, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)),
    pg_catalog.pg_has_role(p.proowner, 'USAGE'),
    pg_catalog.format('DROP %s IF EXISTS %I.%I(%s) CASCADE',
      CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
      $1, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid))
    FROM pg_catalog.pg_proc p WHERE p.pronamespace=(SELECT oid FROM target)
  UNION ALL
  SELECT 3, 'pg_type', t.oid::text, pg_catalog.format('%I.%I', $1, t.typname),
    pg_catalog.pg_has_role(t.typowner, 'USAGE'),
    pg_catalog.format('DROP %s IF EXISTS %I.%I CASCADE',
      CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, $1, t.typname)
    FROM pg_catalog.pg_type t WHERE t.typnamespace=(SELECT oid FROM target)
      AND t.typtype IN ('c','d','e','r')
      AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend d
        WHERE d.classid='pg_catalog.pg_type'::regclass AND d.objid=t.oid AND d.deptype='i')
  UNION ALL
  SELECT 4, 'pg_class', r.oid::text, pg_catalog.format('%I.%I', $1, r.relname),
    pg_catalog.pg_has_role(r.relowner, 'USAGE'),
    pg_catalog.format('DROP SEQUENCE IF EXISTS %I.%I CASCADE', $1, r.relname)
    FROM pg_catalog.pg_class r WHERE r.relnamespace=(SELECT oid FROM target) AND r.relkind='S'
      AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend d
        WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=r.oid
          AND d.refclassid='pg_catalog.pg_class'::regclass AND d.deptype IN ('a','i'))
) SELECT * FROM roots ORDER BY phase, class, id LIMIT 50001`;

// Refuse classes not implemented by this planner, even when closure stays local.
const unsupportedQuery = `SELECT
  (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace=$1::regnamespace
    AND relkind NOT IN ('r','p','v','m','f','S','i','I','c')) +
  (SELECT count(*) FROM pg_catalog.pg_type t WHERE typnamespace=$1::regnamespace
    AND typtype NOT IN ('c','d','e','r') AND NOT EXISTS (
      SELECT FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_type'::regclass
        AND d.objid=t.oid AND d.deptype='i')) +
  (SELECT count(*) FROM pg_catalog.pg_operator WHERE oprnamespace=$1::regnamespace) +
  (SELECT count(*) FROM pg_catalog.pg_opclass WHERE opcnamespace=$1::regnamespace) +
  (SELECT count(*) FROM pg_catalog.pg_opfamily WHERE opfnamespace=$1::regnamespace) +
  (SELECT count(*) FROM pg_catalog.pg_collation WHERE collnamespace=$1::regnamespace) +
  (SELECT count(*) FROM pg_catalog.pg_conversion WHERE connamespace=$1::regnamespace) +
  (SELECT count(*) FROM pg_catalog.pg_ts_config WHERE cfgnamespace=$1::regnamespace) +
  (SELECT count(*) FROM pg_catalog.pg_ts_dict WHERE dictnamespace=$1::regnamespace) +
  (SELECT count(*) FROM pg_catalog.pg_ts_parser WHERE prsnamespace=$1::regnamespace) +
  (SELECT count(*) FROM pg_catalog.pg_ts_template WHERE tmplnamespace=$1::regnamespace) +
  (SELECT count(*) FROM pg_catalog.pg_event_trigger WHERE evtenabled <> 'D')
  AS unsupported`;

type RemovalRoot = Readonly<{
  phase: number;
  class: string;
  id: string;
  identity: string;
  owned: boolean;
  statement: string;
}>;

/** Re-query after cascades; never consume a saved list as execution authority. */
export async function listResetRemovalRoots(admin: Pick<Client, "query">, schema: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) throw new Error("removal_plan_schema");
  const roots = await admin.query<RemovalRoot>(rootsQuery, [schema]);
  if (roots.rows.length > 50000 || roots.rows.some((root) => root.owned !== true)) {
    throw new Error("removal_plan_ownership_unproven");
  }
  return roots.rows;
}

/**
 * Read-only candidate plan inside a caller-owned transaction; no DROP is issued.
 * Pinned bytes are validated before the first query. This is NOT an execution
 * receipt. A future executor must re-scan each phase in its fenced transaction:
 * cascades may remove later roots, and a serialized plan must never be replayed.
 */
export async function inspectStagingRemovalPlan(
  admin: Pick<Client, "query">,
  artifacts: Parameters<typeof validateStagingResetArtifacts>[0],
  schema = "api_next",
) {
  const release = validateStagingResetArtifacts(artifacts);
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) throw new Error("removal_plan_schema");
  const closure = await scanResetDependencyClosureInTransaction(admin, schema);
  await assertSupportedResetObjects(admin, schema);
  const roots = await listResetRemovalRoots(admin, schema);
  return Object.freeze({
    source_sha: release.sourceSha,
    closure,
    roots: Object.freeze(roots.map((root) => Object.freeze(root))),
    roots_sha256: createHash("sha256").update(JSON.stringify(roots)).digest("hex"),
    execution_authorized: false,
  });
}

export async function assertSupportedResetObjects(
  admin: Pick<Client, "query">,
  schema = "api_next",
) {
  const unsupported = await admin.query(unsupportedQuery, [schema]);
  if (Number(unsupported.rows[0]?.unsupported) !== 0)
    throw new Error("removal_plan_unsupported_objects");
}
