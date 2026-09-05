import { createHash } from "node:crypto";
import type { Client } from "pg";

// Catalog definitions, not statistics or application rows. TOAST relations and
// their indexes belong to their heap's namespace, not the shared pg_toast name.
const relationScope = `WITH target_relations AS (
  SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='api_next'::regnamespace
  UNION SELECT reltoastrelid FROM pg_catalog.pg_class
    WHERE relnamespace='api_next'::regnamespace AND reltoastrelid<>0
  UNION SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class r
    ON r.reltoastrelid=i.indrelid WHERE r.relnamespace='api_next'::regnamespace
)`;
const objectScope = `WITH RECURSIVE edges AS (
  SELECT refclassid AS source_class,refobjid AS source_id,classid AS target_class,objid AS target_id
    FROM pg_catalog.pg_depend
  UNION ALL SELECT classid,objid,refclassid,refobjid FROM pg_catalog.pg_depend WHERE deptype IN ('i','e')
), target_objects(classid,objid) AS (
  SELECT 'pg_catalog.pg_namespace'::regclass::oid, 'api_next'::regnamespace::oid
  UNION SELECT e.target_class,e.target_id FROM edges e JOIN target_objects t
    ON e.source_class=t.classid AND e.source_id=t.objid
)`;

const namespaceCatalogs = [
  ["pg_proc", "pronamespace"],
  ["pg_type", "typnamespace"],
  ["pg_operator", "oprnamespace"],
  ["pg_opclass", "opcnamespace"],
  ["pg_opfamily", "opfnamespace"],
  ["pg_collation", "collnamespace"],
  ["pg_conversion", "connamespace"],
  ["pg_ts_config", "cfgnamespace"],
  ["pg_ts_dict", "dictnamespace"],
  ["pg_ts_parser", "prsnamespace"],
  ["pg_ts_template", "tmplnamespace"],
  ["pg_statistic_ext", "stxnamespace"],
] as const;
const relationCatalogs = [
  ["pg_attribute", "attrelid"],
  ["pg_attrdef", "adrelid"],
  ["pg_index", "indexrelid"],
  ["pg_rewrite", "ev_class"],
  ["pg_trigger", "tgrelid"],
  ["pg_policy", "polrelid"],
  ["pg_sequence", "seqrelid"],
  ["pg_foreign_table", "ftrelid"],
] as const;

/** Same-database catalog digest. Never use it as a portable recovery fingerprint. */
export async function snapshotOutsideResetCatalog(admin: Pick<Client, "query">) {
  const queries: [string, string][] = [
    [
      "pg_class",
      `${relationScope} SELECT to_jsonb(o) - ARRAY[
      'relpages','reltuples','relallvisible','relallfrozen','relfrozenxid','relminmxid',
      'relhasindex','relhasrules','relhastriggers','relhassubclass'] AS fact
      FROM pg_catalog.pg_class o WHERE oid NOT IN (SELECT oid FROM target_relations)`,
    ],
    ...namespaceCatalogs.map(([table, namespace]): [string, string] => [
      table,
      `SELECT to_jsonb(o) AS fact FROM pg_catalog.${table} o WHERE ${namespace}<>'api_next'::regnamespace`,
    ]),
    ...relationCatalogs.map(([table, relation]): [string, string] => [
      table,
      `${relationScope} SELECT to_jsonb(o) AS fact FROM pg_catalog.${table} o
        WHERE ${relation} NOT IN (SELECT oid FROM target_relations)`,
    ]),
    [
      "pg_constraint",
      `SELECT to_jsonb(o) AS fact FROM pg_catalog.pg_constraint o
      WHERE connamespace<>'api_next'::regnamespace`,
    ],
    [
      "pg_enum",
      `SELECT to_jsonb(o) AS fact FROM pg_catalog.pg_enum o WHERE enumtypid NOT IN
      (SELECT oid FROM pg_catalog.pg_type WHERE typnamespace='api_next'::regnamespace)`,
    ],
    [
      "pg_range",
      `SELECT to_jsonb(o) AS fact FROM pg_catalog.pg_range o WHERE rngtypid NOT IN
      (SELECT oid FROM pg_catalog.pg_type WHERE typnamespace='api_next'::regnamespace)`,
    ],
    ...["pg_description", "pg_seclabel", "pg_init_privs"].map((table): [string, string] => [
      table,
      `${objectScope} SELECT to_jsonb(o) AS fact FROM pg_catalog.${table} o WHERE NOT EXISTS
        (SELECT FROM target_objects t WHERE t.classid=o.classoid AND t.objid=o.objoid)`,
    ]),
    [
      "pg_depend",
      `${objectScope} SELECT to_jsonb(o) AS fact FROM pg_catalog.pg_depend o WHERE
      NOT EXISTS (SELECT FROM target_objects t WHERE (t.classid=o.classid AND t.objid=o.objid)
        OR (t.classid=o.refclassid AND t.objid=o.refobjid))`,
    ],
    [
      "pg_shdepend",
      `${objectScope} SELECT to_jsonb(o) AS fact FROM pg_catalog.pg_shdepend o WHERE
      dbid<>(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()) OR
      NOT EXISTS (SELECT FROM target_objects t WHERE t.classid=o.classid AND t.objid=o.objid)`,
    ],
    // Schema ownership/ACL/default ACL and global objects must survive unchanged.
    ...[
      "pg_namespace",
      "pg_default_acl",
      "pg_extension",
      "pg_event_trigger",
      "pg_foreign_server",
      "pg_foreign_data_wrapper",
      "pg_publication",
      "pg_roles",
      "pg_auth_members",
      "pg_database",
    ].map((table): [string, string] => [
      table,
      `SELECT to_jsonb(o) AS fact FROM pg_catalog.${table} o`,
    ]),
  ];
  const digest = createHash("sha256");
  let count = 0;
  for (const [catalog, query] of queries) {
    const result = await admin.query(`${query} LIMIT 100001`);
    count += result.rows.length;
    if (count > 100_000) throw new Error("reset_outside_catalog_limit");
    const facts = result.rows.map((row) => JSON.stringify(row.fact)).sort();
    digest.update(JSON.stringify([catalog, facts]));
  }
  return Object.freeze({ version: 1, object_count: count, sha256: digest.digest("hex") });
}
