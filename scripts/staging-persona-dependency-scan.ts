import { createHash } from "node:crypto";
import type { Client } from "pg";

// Conservative object-level closure: column dependencies promote to their whole
// relation. INTERNAL/EXTENSION deletion promotes to the owning object as PG17
// specifies. Unknown classes, edge flavors, extensions and external objects fail.
const closureQuery = `WITH RECURSIVE
  edges AS MATERIALIZED (
    SELECT refclassid AS source_class, refobjid AS source_id, classid AS target_class, objid AS target_id
      FROM pg_catalog.pg_depend
    UNION ALL
    SELECT classid, objid, refclassid, refobjid FROM pg_catalog.pg_depend WHERE deptype IN ('i','e')
  ), closure(classid,objid) AS (
    SELECT 'pg_catalog.pg_namespace'::regclass::oid, oid FROM pg_catalog.pg_namespace WHERE nspname=$1
    UNION
    SELECT e.target_class,e.target_id FROM edges e JOIN closure c
      ON e.source_class=c.classid AND e.source_id=c.objid
  )
  SELECT c.classid::regclass::text AS object_class, c.objid::text AS object_id,
    identified.type AS object_type, identified.identity AS identity,
    CASE
      WHEN c.classid='pg_catalog.pg_namespace'::regclass
        THEN (SELECT nspname FROM pg_catalog.pg_namespace WHERE oid=c.objid)
      WHEN c.classid='pg_catalog.pg_class'::regclass THEN (
        SELECT CASE WHEN n.nspname='pg_toast' THEN (
          SELECT owner_ns.nspname FROM pg_catalog.pg_class owner_rel
            JOIN pg_catalog.pg_namespace owner_ns ON owner_ns.oid=owner_rel.relnamespace
            WHERE owner_rel.reltoastrelid=relation.oid OR owner_rel.reltoastrelid=(
              SELECT indrelid FROM pg_catalog.pg_index WHERE indexrelid=relation.oid)
        ) ELSE n.nspname END
        FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace n ON n.oid=relation.relnamespace
        WHERE relation.oid=c.objid)
      WHEN c.classid='pg_catalog.pg_constraint'::regclass THEN (
        SELECT n.nspname FROM pg_catalog.pg_constraint object JOIN pg_catalog.pg_namespace n
          ON n.oid=object.connamespace WHERE object.oid=c.objid)
      WHEN c.classid='pg_catalog.pg_rewrite'::regclass THEN (
        SELECT n.nspname FROM pg_catalog.pg_rewrite object JOIN pg_catalog.pg_class r ON r.oid=object.ev_class
          JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace WHERE object.oid=c.objid)
      WHEN c.classid='pg_catalog.pg_trigger'::regclass THEN (
        SELECT n.nspname FROM pg_catalog.pg_trigger object JOIN pg_catalog.pg_class r ON r.oid=object.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace WHERE object.oid=c.objid)
      WHEN c.classid='pg_catalog.pg_attrdef'::regclass THEN (
        SELECT n.nspname FROM pg_catalog.pg_attrdef object JOIN pg_catalog.pg_class r ON r.oid=object.adrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace WHERE object.oid=c.objid)
      WHEN c.classid='pg_catalog.pg_policy'::regclass THEN (
        SELECT n.nspname FROM pg_catalog.pg_policy object JOIN pg_catalog.pg_class r ON r.oid=object.polrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace WHERE object.oid=c.objid)
      WHEN c.classid='pg_catalog.pg_default_acl'::regclass THEN (
        SELECT n.nspname FROM pg_catalog.pg_default_acl object JOIN pg_catalog.pg_namespace n
          ON n.oid=object.defaclnamespace WHERE object.oid=c.objid)
      WHEN c.classid IN ('pg_catalog.pg_type'::regclass,'pg_catalog.pg_proc'::regclass,
        'pg_catalog.pg_collation'::regclass,'pg_catalog.pg_conversion'::regclass,
        'pg_catalog.pg_operator'::regclass,'pg_catalog.pg_opclass'::regclass,'pg_catalog.pg_opfamily'::regclass,
        'pg_catalog.pg_ts_config'::regclass,'pg_catalog.pg_ts_dict'::regclass,
        'pg_catalog.pg_ts_parser'::regclass,'pg_catalog.pg_ts_template'::regclass,
        'pg_catalog.pg_statistic_ext'::regclass) THEN identified.schema
      ELSE NULL
    END AS owning_schema,
    EXISTS (SELECT FROM pg_catalog.pg_depend d WHERE
      ((d.classid=c.classid AND d.objid=c.objid) OR (d.refclassid=c.classid AND d.refobjid=c.objid))
      AND d.deptype NOT IN ('n','a','i','e','x','P','S')) AS unknown_edge,
    ARRAY(SELECT d.classid::text || ':' || d.objid::text || ':' || d.objsubid::text || ':' ||
      d.refclassid::text || ':' || d.refobjid::text || ':' || d.refobjsubid::text || ':' || d.deptype::text
      FROM pg_catalog.pg_depend d WHERE
        (d.classid=c.classid AND d.objid=c.objid) OR (d.refclassid=c.classid AND d.refobjid=c.objid)
      ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype) AS dependencies
    FROM closure c CROSS JOIN LATERAL pg_catalog.pg_identify_object(c.classid,c.objid,0) identified
    ORDER BY c.classid,c.objid LIMIT 50001`;

/** Caller owns the transaction and target checks. No transaction control or DDL. */
export async function scanResetDependencyClosureInTransaction(
  admin: Pick<Client, "query">,
  schema = "api_next",
) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) throw new Error("dependency_scan_input");
  const result = await admin.query(closureQuery, [schema]);
  if (
    result.rows.length === 0 ||
    result.rows.length > 50000 ||
    result.rows.some((row) => row.owning_schema !== schema || row.unknown_edge !== false)
  ) {
    throw new Error("reset_dependency_closure_unproven");
  }
  return Object.freeze({
    scan_version: 1,
    object_count: result.rows.length,
    closure_sha256: createHash("sha256").update(JSON.stringify(result.rows)).digest("hex"),
    execution_authorized: false,
  });
}

/** Fresh idle trusted connection only. Snapshot-specific digest, not reset authority. */
export async function observeResetDependencyClosure(admin: Client, schema = "api_next") {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) throw new Error("dependency_scan_input");
  try {
    await admin.query("BEGIN READ ONLY");
    await admin.query("SET LOCAL statement_timeout = '10s'");
    await admin.query("SET LOCAL search_path = pg_catalog");
    const result = await scanResetDependencyClosureInTransaction(admin, schema);
    await admin.query("ROLLBACK");
    return result;
  } catch {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw new Error("reset_dependency_closure_unproven");
  }
}
