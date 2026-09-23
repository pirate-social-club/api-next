// Per-table content snapshot for the qualification run. For every base table
// in the schema: row count and an MD5 over the full rows ordered by primary key
// (or all columns when a table has no primary key). Read-only; prints JSON.
import { Client } from "pg";

const url = process.argv[2] ?? process.env.QUAL_DATABASE_URL;
const schema = process.argv[3] ?? "api_next";
if (!url) throw new Error("usage: table-snapshot.ts <database-url> [schema]");
const parsed = new URL(url);
const ssl = parsed.searchParams.has("sslrootcert") || parsed.hostname.endsWith("psdb.cloud");
parsed.search = "";
const client = new Client({ connectionString: parsed.toString(), ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}) });
await client.connect();
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const tables = (
    await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name`,
      [schema],
    )
  ).rows.map((row) => row.table_name);
  const snapshot: Record<string, { rows: number; md5: string }> = {};
  for (const table of tables) {
    const keys = (
      await client.query<{ column_name: string }>(
        `SELECT a.attname AS column_name
           FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
           JOIN pg_namespace n ON n.oid=c.relnamespace
           JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
           JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
          WHERE n.nspname=$1 AND c.relname=$2 AND i.indisprimary ORDER BY k.ord`,
        [schema, table],
      )
    ).rows.map((row) => ident(row.column_name));
    const order = keys.length > 0 ? keys.join(",") : "t::text";
    const result = await client.query<{ rows: string; md5: string | null }>(
      `SELECT count(*)::text AS rows,
              md5(coalesce(string_agg(t::text, E'\\n' ORDER BY ${order}), '')) AS md5
         FROM ${ident(schema)}.${ident(table)} t`,
    );
    snapshot[table] = { rows: Number(result.rows[0]?.rows ?? 0), md5: result.rows[0]?.md5 ?? "" };
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), schema, tables: snapshot }));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
