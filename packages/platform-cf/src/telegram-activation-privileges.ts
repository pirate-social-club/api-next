import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import type { Layer } from "effect";
import { makeTelegramDatabase } from "./telegram-database.ts";
import { TelegramSetupFailure } from "./telegram-setup-diagnostics.ts";

export const TELEGRAM_ACTIVATION_TABLES = [
  ["telegram_account_associations", true],
  ["telegram_link_transactions", true],
  ["telegram_link_navigation", true],
  ["telegram_bot_grants", false],
  ["telegram_study_conversations", false],
] as const;

/** Schema-qualified, SELECT-only facts from the executor, including inherited access. */
export const TELEGRAM_ACTIVATION_PRIVILEGES_SQL = `SELECT
  current_user::text AS runtime_role, required.table_name, required.expected_delete,
  COALESCE(has_schema_privilege(current_user, n.oid, 'USAGE'), FALSE) AS schema_usage,
  COALESCE(c.relkind IN ('r','p'), FALSE) AS table_exists,
  COALESCE(pg_has_role(current_user, c.relowner, 'USAGE'), FALSE) AS owner_equivalent,
  COALESCE(has_table_privilege(current_user, c.oid, 'SELECT'), FALSE) AS can_select,
  COALESCE(has_table_privilege(current_user, c.oid, 'INSERT'), FALSE) AS can_insert,
  COALESCE(has_table_privilege(current_user, c.oid, 'UPDATE'), FALSE) AS can_update,
  COALESCE(has_table_privilege(current_user, c.oid, 'DELETE'), FALSE) AS can_delete,
  FALSE AS expected_truncate,
  COALESCE(has_table_privilege(current_user, c.oid, 'TRUNCATE'), FALSE) AS can_truncate
FROM (VALUES ('telegram_account_associations', TRUE),
             ('telegram_link_transactions', TRUE),
             ('telegram_link_navigation', TRUE),
             ('telegram_bot_grants', FALSE),
             ('telegram_study_conversations', FALSE)) AS required(table_name, expected_delete)
LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='api_next'
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=required.table_name`;

export function assertTelegramActivationPrivileges(rows: readonly Record<string, unknown>[]) {
  if (rows.length !== TELEGRAM_ACTIVATION_TABLES.length)
    throw new TelegramSetupFailure(
      "permission_refused",
      "Telegram activation privilege facts incomplete",
    );
  const role = rows[0]?.runtime_role;
  if (typeof role !== "string" || !role.length)
    throw new TelegramSetupFailure(
      "permission_refused",
      "Telegram activation executor identity missing",
    );
  for (const [table, expectedDelete] of TELEGRAM_ACTIVATION_TABLES) {
    const matches = rows.filter((row) => row.table_name === table);
    const row = matches[0];
    if (
      matches.length !== 1 ||
      !row ||
      row.runtime_role !== role ||
      row.expected_delete !== expectedDelete ||
      row.expected_truncate !== false ||
      row.schema_usage !== true ||
      row.table_exists !== true ||
      row.owner_equivalent !== false ||
      row.can_select !== true ||
      row.can_insert !== true ||
      row.can_update !== true ||
      row.can_delete !== expectedDelete ||
      row.can_truncate !== false
    )
      throw new TelegramSetupFailure(
        "permission_refused",
        `Telegram activation privilege admission refused: ${table}`,
        table,
      );
  }
  return role;
}

export async function assertTelegramRuntimePrivileges(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  const rows = await makeTelegramDatabase(runtime)
    .query(TELEGRAM_ACTIVATION_PRIVILEGES_SQL)
    .catch(() => {
      throw new TelegramSetupFailure("query_failed", "Telegram activation query unavailable");
    });
  return assertTelegramActivationPrivileges(rows);
}
