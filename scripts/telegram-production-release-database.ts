import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import {
  loadPostgresMigrations,
  migrationPlan,
  runPostgresMigrations,
} from "./postgres-migrations.ts";
import { sha256 } from "./public-post-http-release-core.ts";
import {
  TELEGRAM_RELEASE as policy,
  requireTelegram,
} from "./telegram-production-release-policy.ts";

/** The original nine missing grant sets, not a generic activation grant. */
export const TELEGRAM_GRANTS = [
  ["telegram_account_associations", ["INSERT", "UPDATE"], [true, true, true, true]],
  ["telegram_link_transactions", ["INSERT", "DELETE"], [true, true, true, true]],
  ["telegram_link_navigation", ["INSERT", "DELETE"], [true, true, true, true]],
  ["telegram_bot_grants", ["INSERT"], [true, true, true, false]],
  ["telegram_study_conversations", ["SELECT", "INSERT", "UPDATE"], [true, true, true, false]],
  ["telegram_interface_preferences", ["SELECT", "INSERT", "UPDATE"], [true, true, true, false]],
  ["telegram_restricted_learners", ["SELECT", "INSERT"], [true, true, false, false]],
  ["telegram_restricted_study_personas", ["SELECT", "INSERT"], [true, true, false, false]],
  ["study_learner_catalogue_decisions", ["SELECT"], [true, false, false, false]],
] as const;
const tableNames = [
  ...TELEGRAM_GRANTS.map(([name]) => name),
  "telegram_restricted_bot_affirmations",
];
const privileges = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
];
export const TELEGRAM_MATRIX_SQL = `SELECT required.table_name,
  COALESCE(c.relkind IN ('r','p'),false) AS table_exists,
  COALESCE(has_schema_privilege($1::name,n.oid,'USAGE'),false) AS schema_usage,
  COALESCE(pg_has_role($1::name,c.relowner,'USAGE'),false) AS owner_equivalent,
  ARRAY[${privileges.map((p) => `COALESCE(has_table_privilege($1::name,c.oid,'${p}'),false)`).join(",")} ] AS table_privileges,
  ARRAY[${["SELECT", "INSERT", "UPDATE", "REFERENCES"].map((p) => `COALESCE(has_any_column_privilege($1::name,c.oid,'${p}'),false)`).join(",")} ] AS column_privileges,
  COALESCE(has_table_privilege($1::name,c.oid,'${privileges.map((p) => `${p} WITH GRANT OPTION`).join(",")}'),false)
    OR COALESCE(has_any_column_privilege($1::name,c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION'),false) AS can_delegate
 FROM unnest($2::text[]) required(table_name)
 LEFT JOIN pg_namespace n ON n.nspname='api_next'
 LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=required.table_name
 ORDER BY required.table_name`;
export function assertTelegramMatrix(
  rows: readonly Record<string, unknown>[],
  after: boolean,
  beforeMigration = false,
) {
  requireTelegram(rows.length === tableNames.length, "complete-ten-table-envelope-required");
  for (const name of tableNames) {
    const matching = rows.filter((r) => r.table_name === name),
      row = matching[0];
    const grant = TELEGRAM_GRANTS.find(([table]) => table === name);
    const expected = grant ? [...grant[2]] : [false, false, false, false];
    if (!after && grant)
      for (const privilege of grant[1]) expected[privileges.indexOf(privilege)] = false;
    requireTelegram(
      matching.length === 1 &&
        row &&
        row.table_exists === !(beforeMigration && name === "study_learner_catalogue_decisions") &&
        row.schema_usage === true &&
        row.owner_equivalent === false &&
        row.can_delegate === false &&
        isDeepStrictEqual(row.table_privileges, [...expected, false, false, false, false]) &&
        isDeepStrictEqual(row.column_privileges, [expected[0], expected[1], expected[2], false]),
      "telegram-privilege-envelope-differs",
    );
  }
}
export async function telegramMigrations() {
  const migrations = await loadPostgresMigrations();
  requireTelegram(
    migrations.length === policy.database.ledger &&
      migrations.at(-1)?.version === policy.database.migration &&
      migrations.at(-1)?.checksum === policy.database.migrationSha256,
    "fixed-334-migration-set-required",
  );
  return migrations;
}
export async function assertTelegramLedger(db: pg.Client, count: 333 | 334) {
  const expected = migrationPlan(await telegramMigrations()).slice(0, count);
  const actual = (
    await db.query(
      'SELECT version,checksum FROM api_next.schema_migrations ORDER BY version COLLATE "C"',
    )
  ).rows;
  requireTelegram(isDeepStrictEqual(actual, expected), "full-contiguous-migration-prefix-differs");
  return { count, sha256: sha256(expected.map((r) => `${r.version}:${r.checksum}`).join("\n")) };
}
/** Caller supplies only the maintained injected URL, or an explicitly disposable local fixture. */
export async function telegramDatabase<T>(
  url: string,
  role: string,
  readOnly: boolean,
  action: (db: pg.Client) => Promise<T>,
) {
  const db = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
    options: `-c search_path=api_next,pg_catalog -c transaction_timeout=170000${readOnly ? " -c default_transaction_read_only=on" : ""}`,
  });
  try {
    await db.connect();
    await db.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await db.query("SET LOCAL lock_timeout='3s'");
    const row = (
      await db.query(`SELECT current_user::text AS current_role,session_user::text AS session_role,
      current_database() AS database,current_schema() AS schema,rolsuper,rolbypassrls
      FROM pg_roles WHERE rolname=current_user`)
    ).rows[0];
    requireTelegram(
      row?.current_role === role &&
        row.session_role === role &&
        row.database === policy.database.name &&
        row.schema === policy.database.schema &&
        row.rolsuper === false &&
        row.rolbypassrls === false,
      "actual-database-principal-refused",
    );
    return await action(db);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}
export async function telegramPrivileges(db: pg.Client) {
  return (await db.query(TELEGRAM_MATRIX_SQL, [policy.database.runtime, tableNames])).rows;
}
export async function assertTelegramFunctions(db: pg.Client) {
  const rows = (
    await db.query(
      `WITH required(signature,want_execute,want_definer) AS (VALUES
    ('api_next.provision_account_participation_owner_v1(text)',true,true),
    ('api_next.guard_study_learner_catalogue_decision()',false,false))
    SELECT required.*,p.oid IS NOT NULL AS present,p.prosecdef,
      pg_has_role($1::name,p.proowner,'USAGE') AS owner_equivalent,
      has_function_privilege($1::name,p.oid,'EXECUTE') AS can_execute,
      has_function_privilege($1::name,p.oid,'EXECUTE WITH GRANT OPTION') AS can_delegate
    FROM required LEFT JOIN pg_proc p ON p.oid=to_regprocedure(required.signature) ORDER BY signature`,
      [policy.database.runtime],
    )
  ).rows;
  requireTelegram(
    rows.length === 2 &&
      rows.every(
        (r) =>
          r.present === true &&
          r.owner_equivalent === false &&
          r.prosecdef === r.want_definer &&
          r.can_execute === r.want_execute &&
          r.can_delegate === false,
      ),
    "telegram-function-authority-refused",
  );
  return rows;
}
export async function telegramRowLocks(db: pg.Client, requireAllowed = true) {
  // PostgreSQL requires SELECT plus UPDATE on at least one column for FOR UPDATE.
  // Observe that authority read-only; acquiring a row lock is a separate effect.
  const rows = (
    await db.query(
      `SELECT required.table_name, COALESCE(c.relkind IN ('r','p'),false) AS table_exists,
      COALESCE(has_table_privilege(current_user,c.oid,'SELECT'),false) AS can_select,
      COALESCE(has_any_column_privilege(current_user,c.oid,'UPDATE'),false) AS any_update
      FROM unnest($1::text[]) required(table_name) LEFT JOIN pg_namespace n ON n.nspname='api_next'
      LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=required.table_name ORDER BY required.table_name`,
      [TELEGRAM_ROW_LOCK_TABLES],
    )
  ).rows;
  requireTelegram(
    rows.length === TELEGRAM_ROW_LOCK_TABLES.length && rows.every((r) => r.table_exists === true),
    "telegram-row-lock-authority-refused",
  );
  if (requireAllowed) assertTelegramRowLockAuthority(rows);
  return rows;
}
export const TELEGRAM_ROW_LOCK_TABLES = [
  "account_streak_clocks",
  "communities",
  "community_role_assignments",
  "community_telegram_deliveries",
  "community_telegram_integrations",
  "community_telegram_setups",
  "community_telegram_usage",
  "media_post_submissions",
  "media_publication_projections",
  "persona_community_bindings",
  "personas",
  "posts",
  "study_session_items_v2",
  "study_sessions_v2",
  "study_spoken_answer_commands",
  "telegram_account_associations",
  "telegram_bot_grants",
  "telegram_link_navigation",
  "telegram_link_transactions",
  "telegram_study_conversations",
  "users",
] as const;
export function assertTelegramRowLockAuthority(rows: readonly Record<string, unknown>[]) {
  requireTelegram(
    rows.length === TELEGRAM_ROW_LOCK_TABLES.length &&
      TELEGRAM_ROW_LOCK_TABLES.every((table) => {
        const matches = rows.filter((r) => r.table_name === table),
          row = matches[0];
        return (
          matches.length === 1 &&
          row?.table_exists === true &&
          row.can_select === true &&
          row.any_update === true
        );
      }),
    "telegram-complete-row-lock-authority-refused",
  );
}
export function assertTelegramGlobalInventory(
  integrations: readonly Record<string, unknown>[],
  work: readonly Record<string, unknown>[],
  allowed: readonly { bot_id: string; bot_epoch: string }[],
) {
  requireTelegram(
    allowed.length <= 1 &&
      integrations.length <= 1 &&
      work.length < 21 &&
      integrations.every(
        (r) =>
          r.community_id === policy.canary.community &&
          r.assistant_enabled === false &&
          r.automatic_since === null &&
          r.record_revision === r.revision &&
          r.record_bot_epoch === r.bot_epoch &&
          allowed.some((a) => a.bot_id === r.bot_id && a.bot_epoch === r.bot_epoch),
      ) &&
      work.every(
        (r) =>
          r.community_id === policy.canary.community &&
          allowed.some((a) => a.bot_epoch === r.bot_epoch) &&
          integrations.some((i) => i.bot_epoch === r.bot_epoch),
      ),
    "global-telegram-bot-or-work-inventory-unreviewed",
  );
}
export async function telegramGlobalInventory(
  db: pg.Client,
  allowed: readonly { bot_id: string; bot_epoch: string }[],
) {
  const integrations = (
    await db.query(`SELECT community_id,revision::text AS revision,bot_id,bot_epoch,
    record->>'revision' AS record_revision,record->>'botEpoch' AS record_bot_epoch,record->>'status' AS status,
    COALESCE((record->'study'->>'enabled')::boolean,false) AS study_enabled,
    COALESCE((record->'policy'->>'enabled')::boolean,false) AS assistant_enabled,
    record->>'automaticSince' AS automatic_since FROM api_next.community_telegram_integrations ORDER BY community_id LIMIT 2`)
  ).rows;
  const work = (
    await db.query(`SELECT 'inbox' AS kind,community_id,bot_epoch,state,count(*)::integer AS count
    FROM api_next.community_telegram_inbox WHERE state IN ('pending','processing') GROUP BY community_id,bot_epoch,state
    UNION ALL SELECT 'delivery',community_id,bot_epoch,state,count(*)::integer FROM api_next.community_telegram_deliveries
    WHERE state IN ('pending','sending','uncertain','failed') GROUP BY community_id,bot_epoch,state
    ORDER BY kind,community_id,bot_epoch,state LIMIT 21`)
  ).rows;
  assertTelegramGlobalInventory(integrations, work, allowed);
  return { integrations, work };
}
export async function applyTelegramMigration(ownerUrl: string, assertBound: () => void) {
  await telegramDatabase(ownerUrl, policy.database.owner, true, (db) =>
    assertTelegramLedger(db, 333),
  );
  const migrations = await telegramMigrations();
  assertBound();
  const result = await runPostgresMigrations({
    connectionString: ownerUrl,
    migrations,
    expectedLedger: migrationPlan(migrations).slice(0, 333),
  });
  requireTelegram(
    !result.dryRun && isDeepStrictEqual(result.result.applied, [policy.database.migration]),
    "migration-result-unresolved",
  );
}
export async function applyTelegramGrants(ownerUrl: string, assertBound: () => void) {
  return telegramDatabase(ownerUrl, policy.database.owner, false, async (db) => {
    await assertTelegramLedger(db, 334);
    assertTelegramMatrix(await telegramPrivileges(db), false);
    await assertTelegramFunctions(db);
    assertBound();
    for (const [table, additions] of TELEGRAM_GRANTS)
      await db.query(
        `GRANT ${additions.join(",")} ON TABLE api_next.${table} TO "${policy.database.runtime}"`,
      );
    assertTelegramMatrix(await telegramPrivileges(db), true);
    assertBound();
    // The caller's durable attempt already exists. A lost COMMIT reply is never replayed.
    await db.query("COMMIT");
  });
}

export async function telegramRecoveryWork(db: pg.Client) {
  const integration = (
    await db.query(
      `SELECT bot_id,bot_epoch,revision,record->>'revision' AS record_revision,
    COALESCE((record->'study'->>'enabled')::boolean,false) AS study_enabled
    FROM api_next.community_telegram_integrations WHERE community_id=$1`,
      [policy.canary.community],
    )
  ).rows;
  const active = (
    await db.query(
      `SELECT 'inbox' AS kind,state,count(*)::integer AS count FROM api_next.community_telegram_inbox
    WHERE community_id=$1 AND state IN ('pending','processing') GROUP BY state UNION ALL
    SELECT 'delivery',state,count(*)::integer FROM api_next.community_telegram_deliveries WHERE community_id=$1
    AND state IN ('pending','sending','uncertain','failed') GROUP BY state ORDER BY kind,state`,
      [policy.canary.community],
    )
  ).rows;
  return { integration, active };
}
/** One transaction, separately journaled from either Worker upload. */
export async function pauseTelegramStudyIntent(
  db: pg.Client,
  attempt: (before: Awaited<ReturnType<typeof telegramRecoveryWork>>) => void,
  assertBound: () => void,
) {
  await db.query("SELECT community_id FROM api_next.communities WHERE community_id=$1 FOR UPDATE", [
    policy.canary.community,
  ]);
  attempt(await telegramRecoveryWork(db));
  assertBound();
  await db.query(
    `UPDATE api_next.community_telegram_integrations SET revision=revision+1,
    record=jsonb_set(jsonb_set(record,'{study,enabled}','false'::jsonb,false),'{revision}',to_jsonb(revision+1),false),
    updated_at=clock_timestamp() WHERE community_id=$1 AND COALESCE((record->'study'->>'enabled')::boolean,false)`,
    [policy.canary.community],
  );
  const after = await telegramRecoveryWork(db);
  requireTelegram(
    after.integration.every(
      (r) => r.study_enabled === false && r.record_revision === String(r.revision),
    ),
    "study-intent-not-paused-consistently",
  );
  assertBound();
  await db.query("COMMIT");
  return after;
}
