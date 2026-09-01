export type PostgresTestQueryClient = {
  readonly query: (text: string) => Promise<unknown>;
};

let baselineSql: Promise<string> | undefined;
let resetSql: Promise<string> | undefined;

function loadBaselineSql(): Promise<string> {
  baselineSql ??= Bun.file(new URL("../../../db/postgres/schema.sql", import.meta.url)).text();
  return baselineSql;
}

function loadResetSql(): Promise<string> {
  resetSql ??= Bun.file(new URL("../../../db/postgres/test-reset.sql", import.meta.url)).text();
  return resetSql;
}

async function applyAtomically(
  client: PostgresTestQueryClient,
  sql: Promise<string>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(await sql);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the operation failure when connection cleanup also fails.
    }
    throw error;
  }
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

/** Restores baseline data and sequence state without rebuilding schema objects. */
export async function resetPostgresTestBaseline(client: PostgresTestQueryClient): Promise<void> {
  await applyAtomically(client, loadResetSql());
}

const catalogFingerprintSql = `
SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(object_definition, E'\\n' ORDER BY object_definition), '')) AS fingerprint
  FROM (
    SELECT 'relation:' || relation.relkind::text || ':' || relation.relname AS object_definition
      FROM pg_catalog.pg_class AS relation
     WHERE relation.relnamespace = pg_catalog.current_schema()::regnamespace
       AND relation.relkind = ANY (ARRAY['r', 'p', 'v', 'm', 'S', 'f']::"char"[])
    UNION ALL
    SELECT 'attribute:' || relation.relname || ':' || attribute.attnum || ':' || attribute.attname || ':' ||
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || ':' || attribute.attnotnull || ':' ||
           COALESCE(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid), '')
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      LEFT JOIN pg_catalog.pg_attrdef AS default_value
        ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
     WHERE relation.relnamespace = pg_catalog.current_schema()::regnamespace
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
    UNION ALL
    SELECT 'constraint:' || relation.relname || ':' || constraint_row.conname || ':' ||
           pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
     WHERE constraint_row.connamespace = pg_catalog.current_schema()::regnamespace
    UNION ALL
    SELECT 'index:' || pg_catalog.pg_get_indexdef(index_row.indexrelid)
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS relation ON relation.oid = index_row.indrelid
     WHERE relation.relnamespace = pg_catalog.current_schema()::regnamespace
    UNION ALL
    SELECT 'trigger:' || relation.relname || ':' || pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
      FROM pg_catalog.pg_trigger AS trigger_row
      JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
     WHERE relation.relnamespace = pg_catalog.current_schema()::regnamespace
       AND NOT trigger_row.tgisinternal
    UNION ALL
    SELECT 'routine:' || pg_catalog.pg_get_functiondef(routine.oid)
      FROM pg_catalog.pg_proc AS routine
     WHERE routine.pronamespace = pg_catalog.current_schema()::regnamespace
    UNION ALL
    SELECT 'type:' || type_row.typname || ':' || type_row.typtype::text || ':' ||
           type_row.typcategory::text
      FROM pg_catalog.pg_type AS type_row
     WHERE type_row.typnamespace = pg_catalog.current_schema()::regnamespace
       AND type_row.typrelid = 0
  ) AS catalog_objects`;

/** Fingerprints persistent objects in the currently selected schema. */
export async function postgresTestSchemaCatalogFingerprint(
  client: PostgresTestQueryClient,
): Promise<string> {
  const result = (await client.query(catalogFingerprintSql)) as {
    readonly rows?: readonly { readonly fingerprint?: unknown }[];
  };
  const fingerprint = result.rows?.[0]?.fingerprint;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw new Error("PostgreSQL test schema catalog fingerprint was unavailable");
  }
  return fingerprint;
}
