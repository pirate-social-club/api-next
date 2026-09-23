/**
 * Staging-main render-host grant and no-match claim gate. The owner connection
 * comes from the operator secret path; the managed host URL stays in a 0600
 * private file. No command prints either connection string.
 */
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { claimHostRenderAttempt } from "../scripts/song-video-render-host.ts";

const schema = "api_next";
const selected = [
  "media_song_video_render_attempts",
  "media_song_video_render_plans",
  "media_post_submissions",
  "media_video_reservation_song_plans",
  "media_video_revisions",
  "media_immutable_objects",
  "media_song_video_masters",
  "media_song_video_accepted_masters",
  "media_publication_projections",
  "media_song_canonical_timings",
] as const;
const updated = ["media_song_video_render_attempts", "media_song_canonical_timings"] as const;
const inserted = ["media_song_video_masters", "media_song_video_accepted_masters"] as const;
const expected = [
  "schema:api_next:USAGE",
  ...selected.map((table) => `table:${table}:SELECT`),
  ...updated.map((table) => `table:${table}:UPDATE`),
  ...inserted.map((table) => `table:${table}:INSERT`),
  "column:media_immutable_objects.etag:UPDATE",
].sort();
const roleName = process.argv[3];
const mode = process.argv[2];
const fail = (message: string): never => { throw new Error(message); };
const safeRole = (): string => {
  if (typeof roleName !== "string" || !/^pscale_api_[a-z0-9]+$/u.test(roleName)) {
    throw new Error("managed role name is invalid");
  }
  return roleName;
};
const pgUrl = (raw: string) => {
  const url = new URL(raw);
  if (url.searchParams.get("sslrootcert") === "system") url.searchParams.delete("sslrootcert");
  url.searchParams.set("options", "-c search_path=api_next");
  return url.toString();
};
const ownerUrl = () => {
  const raw = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  if (!raw) throw new Error("operator database URL is unavailable");
  return pgUrl(raw);
};
const connect = async (url: string) => {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function ownerCheck(client: Client) {
  const rows = (await client.query<{ object: string; owner: string; current_user: string }>(
    `SELECT 'schema' AS object, pg_get_userbyid(n.nspowner) AS owner, current_user
       FROM pg_namespace n WHERE n.nspname=$1
     UNION ALL
     SELECT c.relname, pg_get_userbyid(c.relowner), current_user
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind IN ('r','p')`,
    [schema, selected],
  )).rows;
  if (rows.length !== selected.length + 1 || rows.some((row) => row.owner !== row.current_user)) {
    fail("operator login does not own every reviewed grant target");
  }
  console.log(JSON.stringify({ status: "owner_verified", objects: rows.map((row) => row.object) }));
}

async function readback(client: Client, role: string) {
  const attrs = (await client.query<{
    rolname: string; rolsuper: boolean; rolinherit: boolean; rolcreatedb: boolean;
    rolcreaterole: boolean; rolreplication: boolean; rolbypassrls: boolean;
    rolcanlogin: boolean; memberships: string[]; owned_objects: number;
    database_create: boolean; schema_create: boolean;
  }>(
    `SELECT r.rolname,r.rolsuper,r.rolinherit,r.rolcreatedb,r.rolcreaterole,
            r.rolreplication,r.rolbypassrls,r.rolcanlogin,
            (SELECT coalesce(json_agg(p.rolname ORDER BY p.rolname),'[]'::json)
               FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid
              WHERE m.member=r.oid) AS memberships,
            (SELECT count(*)::int FROM pg_class c WHERE c.relowner=r.oid) AS owned_objects,
            has_database_privilege(r.rolname,current_database(),'CREATE') AS database_create,
            has_schema_privilege(r.rolname,$2,'CREATE') AS schema_create
       FROM pg_roles r WHERE r.rolname=$1`,
    [role, schema],
  )).rows;
  if (attrs.length !== 1) fail("managed role is absent from staging main");
  const a = attrs[0]!;
  if (!a.rolcanlogin || !a.rolinherit || a.rolsuper || a.rolcreatedb || a.rolcreaterole ||
      a.rolreplication || a.rolbypassrls || a.database_create || a.schema_create ||
      a.owned_objects !== 0 || a.memberships.length !== 0) fail("managed role has broad authority");
  const grants = (await client.query<{ grant: string }>(
    `WITH target AS (SELECT oid FROM pg_roles WHERE rolname=$1),
       acl AS (
         SELECT 'schema:'||n.nspname||':'||x.privilege_type AS grant
           FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,'{}'::aclitem[])) x
          WHERE n.nspname=$2 AND x.grantee=(SELECT oid FROM target)
         UNION ALL
         SELECT 'table:'||c.relname||':'||x.privilege_type
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,'{}'::aclitem[])) x
          WHERE n.nspname=$2 AND c.relkind IN ('r','p') AND x.grantee=(SELECT oid FROM target)
         UNION ALL
         SELECT 'column:'||c.relname||'.'||a.attname||':'||x.privilege_type
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
           CROSS JOIN LATERAL aclexplode(coalesce(a.attacl,'{}'::aclitem[])) x
          WHERE n.nspname=$2 AND x.grantee=(SELECT oid FROM target)
       ) SELECT grant FROM acl ORDER BY grant`,
    [role, schema],
  )).rows.map((row) => row.grant);
  if (JSON.stringify(grants) !== JSON.stringify(expected)) {
    console.log(JSON.stringify({ status: "grant_mismatch", expected, actual: grants }));
    fail("managed role grants differ from the reviewed list");
  }
  const extras = (await client.query<{ table_name: string; privilege: string }>(
    `SELECT c.relname AS table_name, p.privilege
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
      WHERE n.nspname=$2 AND c.relkind IN ('r','p')
        AND has_table_privilege($1,c.oid,p.privilege)
        AND NOT EXISTS (SELECT 1 FROM pg_class c2
          WHERE c2.oid=c.oid AND ('table:'||c2.relname||':'||p.privilege)=ANY($3::text[]))`,
    [role, schema, expected],
  )).rows;
  if (extras.length) fail("managed role has effective table privileges outside the reviewed list");
  console.log(JSON.stringify({ status: "grants_verified", role, grants, attributes: a }));
}

async function grant(client: Client, role: string) {
  await client.query("BEGIN");
  try {
    await ownerCheck(client);
    const q = quote(role);
    await client.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${q}`);
    await client.query(`GRANT SELECT ON ${selected.map((table) => `${quote(schema)}.${quote(table)}`).join(",")} TO ${q}`);
    await client.query(`GRANT UPDATE ON ${updated.map((table) => `${quote(schema)}.${quote(table)}`).join(",")} TO ${q}`);
    await client.query(`GRANT UPDATE (etag) ON ${quote(schema)}.media_immutable_objects TO ${q}`);
    await client.query(`GRANT INSERT ON ${inserted.map((table) => `${quote(schema)}.${quote(table)}`).join(",")} TO ${q}`);
    await readback(client, role);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function claim(url: string) {
  const client = await connect(url);
  const planId = "song-video-plan:qualification-main-no-match-20260923-01";
  try {
    const existing = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${quote(schema)}.media_song_video_render_plans WHERE plan_id=$1`, [planId],
    );
    if (existing.rows[0]?.n !== "0") fail("the no-match plan already exists");
    const digest = async () => (await client.query<{ n: string; digest: string }>(
      `SELECT count(*)::text AS n,md5(coalesce(string_agg(t::text,E'\\n' ORDER BY attempt_id),'')) AS digest
         FROM ${quote(schema)}.media_song_video_render_attempts t`,
    )).rows[0];
    const before = await digest();
    const result = await claimHostRenderAttempt(client, { planId, claimId: "song-video-render-host-main-no-match-20260923-01" });
    const after = await digest();
    if (result !== null || JSON.stringify(before) !== JSON.stringify(after)) fail("no-match claim changed render attempts");
    console.log(JSON.stringify({ status: "not_claimed", planId, before, after, r2_calls: 0, provider_calls: 0 }));
  } finally {
    await client.end();
  }
}

if (mode === "owner-check" || mode === "grant" || mode === "readback") {
  const client = await connect(ownerUrl());
  try {
    if (mode === "owner-check") await ownerCheck(client);
    else if (mode === "grant") await grant(client, safeRole());
    else await readback(client, safeRole());
  } finally { await client.end(); }
} else if (mode === "claim") {
  const dir = process.env.QUAL_PRIVATE_DIR;
  if (!dir) fail("private credential directory is required");
  await claim((await readFile(`${dir}/main-host.url`, "utf8")).trim());
} else fail("usage: main-role-gate.ts owner-check|grant|readback|claim [managed-role]");
