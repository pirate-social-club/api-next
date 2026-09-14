import { createHash } from "node:crypto";
import type { Client } from "pg";

type Postgres18NotNullConstraint = Readonly<{
  relname: unknown;
  attname: unknown;
  conname: unknown;
  convalidated: unknown;
  conenforced: unknown;
  condeferrable: unknown;
  condeferred: unknown;
  conislocal: unknown;
  coninhcount: unknown;
  connoinherit: unknown;
  conparentid: unknown;
  conkey: unknown;
  attisdropped: unknown;
  attnotnull: unknown;
  definition: unknown;
}>;

function generatedNotNullName(name1: string, name2: string, suffix = ""): string | null {
  if (!/^[a-z_][a-z0-9_$]*$/u.test(name1) || !/^[a-z_][a-z0-9_$]*$/u.test(name2)) return null;
  const label = `not_null${suffix}`;
  const available = 63 - label.length - 2;
  let name1Length = Math.ceil(available / 2);
  let name2Length = available - name1Length;
  if (name1.length < name1Length) name2Length += name1Length - name1.length;
  else if (name2.length < name2Length) name1Length += name2Length - name2.length;
  return `${name1.slice(0, name1Length)}_${name2.slice(0, name2Length)}_${label}`;
}

function isCanonicalPostgres18NotNull(row: Postgres18NotNullConstraint): boolean {
  if (typeof row.relname !== "string" || typeof row.attname !== "string") return false;
  if (typeof row.conname !== "string" || typeof row.definition !== "string") return false;
  const generatedName = Array.from({ length: 1_000 }, (_, suffix) =>
    generatedNotNullName(
      row.relname as string,
      row.attname as string,
      suffix === 0 ? "" : `${suffix}`,
    ),
  ).includes(row.conname);
  return (
    generatedName &&
    row.convalidated === true &&
    row.conenforced === true &&
    row.condeferrable === false &&
    row.condeferred === false &&
    row.conislocal === true &&
    Number(row.coninhcount) === 0 &&
    row.connoinherit === false &&
    Number(row.conparentid) === 0 &&
    Array.isArray(row.conkey) &&
    row.conkey.length === 1 &&
    row.attisdropped === false &&
    row.attnotnull === true &&
    row.definition === `NOT NULL ${row.attname}`
  );
}

/** Structural comparison for the supported reset classes, excluding ACL/owner
 * facts which have separate exact checks. No application rows are returned.
 * Reference must be measured from the pinned baseline in an isolated database.
 */
export async function readResetSchemaShape(admin: Pick<Client, "query">) {
  const version = Number(
    (await admin.query("SHOW server_version_num")).rows[0]?.server_version_num,
  );
  if (!Number.isSafeInteger(version) || version < 170000 || version >= 190000) {
    throw new Error("reset_baseline_shape_unsupported");
  }
  const unsupported = await admin.query(`SELECT
    (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace='api_next'::regnamespace AND prokind NOT IN ('f','p')) +
    (SELECT count(*) FROM pg_catalog.pg_type WHERE typnamespace='api_next'::regnamespace AND typtype IN ('r','m')) AS count`);
  if (Number(unsupported.rows[0]?.count) !== 0) throw new Error("reset_baseline_shape_unsupported");
  // PostgreSQL 18 mirrors ordinary column NOT NULL attributes as contype `n`
  // rows while 17 does not. Reject every noncanonical row before omitting
  // those mirrors: attnotnull below records the portable semantic fact, while
  // an explicit name or altered validation/enforcement state is unsupported.
  if (version >= 180000) {
    const notNullConstraints = await admin.query<Postgres18NotNullConstraint>(`SELECT
      r.relname,a.attname,c.conname,c.convalidated,c.conenforced,c.condeferrable,c.condeferred,
      c.conislocal,c.coninhcount,c.connoinherit,c.conparentid,c.conkey,
      a.attisdropped,a.attnotnull,pg_catalog.pg_get_constraintdef(c.oid) AS definition
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class r ON r.oid=c.conrelid
      LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid
        AND array_length(c.conkey,1)=1 AND a.attnum=c.conkey[1]
      WHERE c.connamespace='api_next'::regnamespace AND c.contype='n'
      AND coalesce(r.relname,'')<>'schema_migrations'`);
    if (notNullConstraints.rows.some((row) => !isCanonicalPostgres18NotNull(row))) {
      throw new Error("reset_baseline_shape_unsupported");
    }
  }
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
      AND coalesce(r.relname,'')<>'schema_migrations' AND c.contype<>'n'`,
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
