// Catalog digest for the tables the qualification writes or reads. Covers
// column definitions, constraints, indexes, triggers (timing, events,
// conditions) with the full definitions of their functions, and the song owner
// policy hash function. Read-only; prints per-object digests and a total, so a
// mismatch names what differs. Owner-independent: role names are excluded.
import { createHash } from "node:crypto";
import { Client } from "pg";

export const QUALIFICATION_TABLES = [
  "media_song_canonical_timings",
  "media_upload_reservations",
  "media_video_reservation_song_plans",
  "media_video_upload_parts",
  "media_post_submissions",
  "media_song_video_render_plans",
  "media_immutable_objects",
  "media_video_revisions",
  "media_video_analysis_outbox",
  "media_submission_command_replays",
  "media_song_video_render_attempts",
  "media_song_video_masters",
  "media_song_video_accepted_masters",
  "media_publication_projections",
  "posts",
  "song_owner_policies",
  "song_owner_policy_revisions",
  "communities",
  "community_memberships",
  "personas",
] as const;

const url = process.env.QUAL_DATABASE_URL ?? process.argv[2];
const schema = process.argv[3] ?? "api_next";
if (!url) throw new Error("QUAL_DATABASE_URL or a database URL argument is required");
const parsed = new URL(url);
const ssl = parsed.searchParams.has("sslrootcert") || parsed.hostname.endsWith("psdb.cloud");
parsed.search = "";
const client = new Client({ connectionString: parsed.toString(), ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}) });
await client.connect();
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Function bodies reference the schema only through search_path, but a
// definition prints its own schema qualifier; normalize it for comparison.
const normalize = (text: string) => text.replaceAll(`${schema}.`, "SCHEMA.");
try {
  await client.query("BEGIN READ ONLY");
  const digests: Record<string, string> = {};
  const missing: string[] = [];
  for (const table of QUALIFICATION_TABLES) {
    const oid = (
      await client.query<{ oid: string }>(
        `SELECT c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p')`,
        [schema, table],
      )
    ).rows[0]?.oid;
    if (oid === undefined) {
      missing.push(table);
      continue;
    }
    const columns = (
      await client.query(
        `SELECT a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
                a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_expr
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname`,
        [oid],
      )
    ).rows.map(({ attnum: _ignored, ...rest }) => rest);
    // PostgreSQL 18 also exposes NOT NULL as contype='n' constraints. Column
    // attnotnull above already captures the same invariant across PG 17/18;
    // including both forms would make an unchanged schema hash differently.
    const constraints = (
      await client.query(
        `SELECT conname,contype,pg_get_constraintdef(oid,true) AS def,condeferrable,condeferred
           FROM pg_constraint WHERE conrelid=$1::oid AND contype<>'n' ORDER BY conname`,
        [oid],
      )
    ).rows.map((row) => ({ ...row, def: normalize(row.def) }));
    const indexes = (
      await client.query(
        `SELECT c.relname,pg_get_indexdef(i.indexrelid) AS def
           FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
          WHERE i.indrelid=$1::oid ORDER BY c.relname`,
        [oid],
      )
    ).rows.map((row) => ({ ...row, def: normalize(row.def) }));
    const triggers = (
      await client.query(
        `SELECT t.tgname,pg_get_triggerdef(t.oid,true) AS def,t.tgenabled,
                pg_get_functiondef(t.tgfoid) AS function_def
           FROM pg_trigger t WHERE t.tgrelid=$1::oid AND NOT t.tgisinternal ORDER BY t.tgname`,
        [oid],
      )
    ).rows.map((row) => ({ ...row, def: normalize(row.def), function_def: normalize(row.function_def) }));
    digests[`table:${table}:columns`] = sha(columns);
    digests[`table:${table}:constraints`] = sha(constraints);
    digests[`table:${table}:indexes`] = sha(indexes);
    digests[`table:${table}:triggers`] = sha(triggers);
  }
  const hashFunction = (
    await client.query<{ def: string }>(
      `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$1 AND p.proname='song_owner_policy_hash_v1' ORDER BY p.oid`,
      [schema],
    )
  ).rows.map((row) => normalize(row.def));
  digests["function:song_owner_policy_hash_v1"] = sha(hashFunction);
  const ordered = Object.fromEntries(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b)));
  console.log(JSON.stringify({ schema, missing, total: sha(ordered), digests: ordered }));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
