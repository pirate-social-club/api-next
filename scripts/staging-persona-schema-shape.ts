import { createHash } from "node:crypto";
import type { Client } from "pg";

/** Structural comparison for the supported reset classes, excluding ACL/owner
 * facts which have separate exact checks. No application rows are returned.
 * Reference must be measured from the pinned baseline in an isolated database.
 */
export async function readResetSchemaShape(admin: Pick<Client, "query">) {
  const unsupported = await admin.query(`SELECT
    (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace='api_next'::regnamespace AND prokind NOT IN ('f','p')) +
    (SELECT count(*) FROM pg_catalog.pg_type WHERE typnamespace='api_next'::regnamespace AND typtype IN ('r','m')) AS count`);
  if (Number(unsupported.rows[0]?.count) !== 0) throw new Error("reset_baseline_shape_unsupported");
  const queries = [
    `SELECT relname,relkind,relpersistence,relreplident,relrowsecurity,relforcerowsecurity,reloptions
      FROM pg_catalog.pg_class WHERE relnamespace='api_next'::regnamespace
      AND relkind IN ('r','p','v','m','f','S','c') AND relname<>'schema_migrations'`,
    `SELECT r.relname,a.attname,row_number() OVER (PARTITION BY r.oid ORDER BY a.attnum) AS position,
      pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull,a.attidentity,a.attgenerated,a.attstorage,a.attcompression,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression,
      CASE WHEN a.attcollation<>0 THEN a.attcollation::regcollation::text END AS collation
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class r ON r.oid=a.attrelid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE r.relnamespace='api_next'::regnamespace AND r.relkind IN ('r','p','v','m','f','c')
      AND r.relname<>'schema_migrations' AND a.attnum>0 AND NOT a.attisdropped`,
    `SELECT r.relname,c.conname,c.contype,c.condeferrable,c.condeferred,c.convalidated,
      pg_catalog.pg_get_constraintdef(c.oid) AS definition FROM pg_catalog.pg_constraint c
      LEFT JOIN pg_catalog.pg_class r ON r.oid=c.conrelid WHERE c.connamespace='api_next'::regnamespace
      AND coalesce(r.relname,'')<>'schema_migrations'`,
    `SELECT r.relname,pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
      i.indisvalid,i.indisready,i.indisclustered,i.indisreplident
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class r ON r.oid=i.indrelid
      WHERE r.relnamespace='api_next'::regnamespace AND r.relname<>'schema_migrations'`,
    `SELECT r.relname,t.tgname,t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid) AS definition
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class r ON r.oid=t.tgrelid
      WHERE r.relnamespace='api_next'::regnamespace AND NOT t.tgisinternal`,
    `SELECT r.relname,p.polname,p.polcmd,p.polpermissive,
      ARRAY(SELECT CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid) END
        FROM unnest(p.polroles) role_oid ORDER BY role_oid) AS roles,
      pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS using_expression,
      pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class r ON r.oid=p.polrelid
      WHERE r.relnamespace='api_next'::regnamespace`,
    `SELECT pg_catalog.pg_get_functiondef(oid) AS definition FROM pg_catalog.pg_proc
      WHERE pronamespace='api_next'::regnamespace AND prokind IN ('f','p')`,
    `SELECT r.relname,pg_catalog.pg_get_viewdef(r.oid) AS definition FROM pg_catalog.pg_class r
      WHERE r.relnamespace='api_next'::regnamespace AND r.relkind IN ('v','m')`,
    `SELECT t.typname,t.typtype,pg_catalog.format_type(t.typbasetype,t.typtypmod) AS base,
      t.typnotnull,t.typdefault, e.enumlabel,e.enumsortorder
      FROM pg_catalog.pg_type t LEFT JOIN pg_catalog.pg_enum e ON e.enumtypid=t.oid
      WHERE t.typnamespace='api_next'::regnamespace AND t.typtype IN ('d','e')`,
    `SELECT r.relname,pg_catalog.format_type(s.seqtypid,NULL) AS type,
      s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle
      FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class r ON r.oid=s.seqrelid
      WHERE r.relnamespace='api_next'::regnamespace`,
  ];
  const digest = createHash("sha256");
  let count = 0;
  for (const query of queries) {
    const result = await admin.query(`${query} LIMIT 50001`);
    count += result.rows.length;
    if (count > 50_000) throw new Error("reset_schema_shape_limit");
    digest.update(JSON.stringify(result.rows.map((row) => JSON.stringify(row)).sort()));
  }
  return { version: 1, object_count: count, sha256: digest.digest("hex") };
}
