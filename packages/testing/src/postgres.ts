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

const financialResetRelations = [
  "guest_owner_associations",
  "participation_eligibility_decisions",
  "megapot_owner_shares",
  "megapot_owner_snapshot_leaves",
  "megapot_owner_allocations",
  "reward_credit_persona_bindings",
  "reward_credit_recipient_selections",
] as const;

const financialResetRelationSql = financialResetRelations
  .map((relation) => `'${relation}'`)
  .join(",");

const beforeFinancialResetSql = (
  resetTargets: readonly string[],
  ownedVideoDatabase?: string,
) => `DO $owned_empty_financial_reset$
DECLARE
  schema_name TEXT := pg_catalog.current_schema();
  namespace_id OID;
  owner_id OID;
  relation_name TEXT;
  relation_id OID;
  outstanding_credit BOOLEAN;
  locked_oids OID[] := ARRAY[]::OID[];
  census_round INTEGER := 0;
  changed BOOLEAN;
  relation_row RECORD;
  video_custody BOOLEAN;
BEGIN
  -- Reset is a test-only owner operation. No runtime principal or production
  -- namespace receives the temporary guard exception.
  IF schema_name IS NULL OR ${ownedVideoDatabase === undefined
    ? `schema_name !~ '^(api_next_reuse_[a-z0-9_]{1,24}_[0-9a-f]{12}_[0-9]+|api_next_hns_observer_[0-9a-f]{32})$'`
    : `schema_name<>'api_next' OR pg_catalog.current_database()<>'${ownedVideoDatabase}'`}
  THEN RAISE EXCEPTION 'owned disposable PostgreSQL test schema required' USING ERRCODE='GP003'; END IF;
  SELECT n.oid,c.relowner INTO STRICT namespace_id,owner_id
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid
    WHERE n.nspname=schema_name AND c.relname='participation_owners' AND c.relkind='r'
      AND n.nspowner=c.relowner AND c.relowner=pg_catalog.to_regrole(current_user);
  ${ownedVideoDatabase === undefined ? "" : `
  -- This exact database is created and destroyed by the video harness. Never
  -- admit a normal api_next namespace from only caller configuration/ownership.
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()
      AND datdba=owner_id AND NOT datistemplate)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('api_next.owned_video_test_custody')
      AND relnamespace=namespace_id AND relowner=owner_id AND relkind='r')
  THEN RAISE EXCEPTION 'owned video database custody unavailable' USING ERRCODE='GP003'; END IF;
  SELECT count(*)=1 AND COALESCE(bool_and(
      custody_database_oid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
      AND custody_namespace_oid=namespace_id AND custody_role_oid=owner_id),FALSE)
    INTO STRICT video_custody FROM api_next.owned_video_test_custody;
  IF video_custody IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'owned video fixture marker mismatch' USING ERRCODE='GP003'; END IF;
  `}

  -- Same topology order as source migration/guest authority: first topology,
  -- then the complete reset table set. Owner DDL does not obey this advisory
  -- lock, so every current table is locked before checking outward CASCADE.
  PERFORM pg_catalog.pg_advisory_xact_lock(83000003,1);
  LOOP
    census_round:=census_round+1;
    changed:=FALSE;
    FOR relation_row IN SELECT c.oid,c.relname,c.relowner FROM pg_catalog.pg_class c
      WHERE c.relnamespace=namespace_id AND c.relkind IN('r','p')
        AND NOT(c.oid=ANY(locked_oids)) ORDER BY c.relname COLLATE "C"
    LOOP
      IF relation_row.relowner<>owner_id THEN
        RAISE EXCEPTION 'reset target must retain its owned fixture authority' USING ERRCODE='GP003'; END IF;
      -- ONLY avoids taking an outward inheritance lock before its rejection.
      EXECUTE pg_catalog.format('LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE',schema_name,relation_row.relname);
      IF pg_catalog.to_regclass(pg_catalog.format('%I.%I',schema_name,relation_row.relname))
        IS DISTINCT FROM relation_row.oid
      THEN RAISE EXCEPTION 'reset relation identity changed while locking' USING ERRCODE='GP003'; END IF;
      locked_oids:=pg_catalog.array_append(locked_oids,relation_row.oid);
      changed:=TRUE;
    END LOOP;
    -- A FK child committed during an earlier parent-lock wait is included on
    -- the next census. Every held parent blocks later FK/INHERIT attachment.
    EXIT WHEN NOT changed;
    IF census_round>=8 THEN
      RAISE EXCEPTION 'reset table custody did not stabilize' USING ERRCODE='GP003'; END IF;
  END LOOP;
  FOREACH relation_name IN ARRAY ARRAY[${resetTargets.map((relation) => `'${relation}'`).join(",")}] LOOP
    relation_id:=pg_catalog.to_regclass(pg_catalog.format('%I.%I',schema_name,relation_name));
    IF relation_id IS NULL OR NOT(relation_id=ANY(locked_oids)) OR NOT EXISTS(
      SELECT 1 FROM pg_catalog.pg_class WHERE oid=relation_id AND relnamespace=namespace_id
        AND relowner=owner_id AND relkind='r')
    THEN RAISE EXCEPTION 'complete tracked reset relation inventory required' USING ERRCODE='GP003'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint fk
    JOIN pg_catalog.pg_class parent ON parent.oid=fk.confrelid
    JOIN pg_catalog.pg_class child ON child.oid=fk.conrelid
    WHERE fk.contype='f' AND parent.relnamespace=namespace_id
      AND child.relnamespace<>namespace_id)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits inheritance
      JOIN pg_catalog.pg_class parent ON parent.oid=inheritance.inhparent
      JOIN pg_catalog.pg_class child ON child.oid=inheritance.inhrelid
      WHERE parent.relnamespace=namespace_id AND child.relnamespace<>namespace_id)
  THEN RAISE EXCEPTION 'test reset cannot cascade outside its owned schema' USING ERRCODE='GP003'; END IF;

  EXECUTE pg_catalog.format('SELECT %I.require_guest_practice_only_schema_phase_v1()',schema_name);
  EXECUTE pg_catalog.format('SELECT %I.require_disabled_owner_financial_inventory_private_v1()',schema_name);
  EXECUTE pg_catalog.format(
    'SELECT EXISTS(SELECT 1 FROM %I.reward_ledger_credits WHERE state<>''sent'' AND amount_atomic>paid_atomic)',
    schema_name
  ) INTO STRICT outstanding_credit;
  IF outstanding_credit THEN
    RAISE EXCEPTION 'test reset must preserve positive outstanding credits' USING ERRCODE='GP003';
  END IF;

  -- Attestation above checks native empty rows, exact statement guards, private
  -- function frames, RLS, and ACLs. Suspend only these seven named guards.
  FOREACH relation_name IN ARRAY ARRAY[${financialResetRelationSql}] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I DISABLE TRIGGER disabled_owner_financial_dml',schema_name,relation_name);
  END LOOP;
END;
$owned_empty_financial_reset$;`;

const restoreFinancialResetGuardsSql = `DO $restore_empty_financial_reset_guards$
DECLARE schema_name TEXT := pg_catalog.current_schema(); relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[${financialResetRelationSql}] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I ENABLE TRIGGER disabled_owner_financial_dml',schema_name,relation_name);
  END LOOP;
END;
$restore_empty_financial_reset_guards$;`;

const verifyFinancialResetSql = `DO $verify_empty_financial_reset$
DECLARE schema_name TEXT := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format('SELECT %I.require_guest_practice_only_schema_phase_v1()',schema_name);
  EXECUTE pg_catalog.format('SELECT %I.require_disabled_owner_financial_inventory_private_v1()',schema_name);
END;
$verify_empty_financial_reset$;`;

/** Builds a transaction-only reset for an owned, positively empty financial fixture. */
export function preparePostgresTestBaselineReset(
  sql: string, options: { readonly ownedVideoDatabase?: string } = {},
): string {
  // Closed harness-created database family only; this literal is checked against
  // actual current_database, database/schema/table owner and native fixture custody.
  if (options.ownedVideoDatabase !== undefined && !/^api_next_video_[0-9]{13}_[a-f0-9]{1,8}$/u.test(options.ownedVideoDatabase)) {
    throw new Error("Exact owned video fixture database required");
  }
  const truncateEnd = "RESTART IDENTITY CASCADE;";
  const first = sql.indexOf(truncateEnd);
  if (first < 0 || sql.indexOf(truncateEnd, first + truncateEnd.length) >= 0) {
    throw new Error("PostgreSQL test reset requires exactly one tracked TRUNCATE boundary");
  }
  const targets = sql.match(/^TRUNCATE TABLE\s+([\s\S]*?)RESTART IDENTITY CASCADE;/mu)?.[1];
  if (targets === undefined) throw new Error("Tracked PostgreSQL reset target list is unavailable");
  const resetTargets = targets.split(",").map((target) => {
    const name = target.trim().replace(/^"([a-z_][a-z0-9_]*)"$/u, "$1");
    if (!/^[a-z_][a-z0-9_]*$/u.test(name)) {
      throw new Error("Tracked PostgreSQL reset target is not a closed table identifier");
    }
    return name;
  });
  if (new Set(resetTargets).size !== resetTargets.length) {
    throw new Error("Tracked PostgreSQL reset target list repeats a relation");
  }
  const split = first + truncateEnd.length;
  return `${beforeFinancialResetSql(resetTargets, options.ownedVideoDatabase)}\n${sql.slice(0, split)}\n${restoreFinancialResetGuardsSql}\n${sql.slice(split)}\n${verifyFinancialResetSql}`;
}

/** Restores only a disposable, empty-financial baseline in one owner transaction. */
export async function resetPostgresTestBaseline(client: PostgresTestQueryClient): Promise<void> {
  await applyAtomically(client, loadResetSql().then(preparePostgresTestBaselineReset));
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
