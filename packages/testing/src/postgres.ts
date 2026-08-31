export type PostgresTestQueryClient = {
  readonly query: (text: string) => Promise<unknown>;
};

let baselineSql: Promise<string> | undefined;

function loadBaselineSql(): Promise<string> {
  baselineSql ??= Bun.file(new URL("../../../db/postgres/schema.sql", import.meta.url)).text();
  return baselineSql;
}

/** Applies the tracked baseline to the isolated schema already selected by the caller. */
export async function applyPostgresTestBaseline(client: PostgresTestQueryClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`DO $baseline_search_path$
DECLARE
  target_schema TEXT := current_schema();
BEGIN
  IF target_schema IS NULL THEN
    RAISE EXCEPTION 'PostgreSQL test baseline requires a current schema';
  END IF;
  PERFORM pg_catalog.set_config(
    'search_path',
    pg_catalog.format('%I, pg_temp', target_schema),
    true
  );
END;
$baseline_search_path$;`);
    await client.query(await loadBaselineSql());
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the baseline failure when connection cleanup also fails.
    }
    throw error;
  }
}
