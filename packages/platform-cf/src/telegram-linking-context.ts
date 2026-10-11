import { type IntegrationRecord, TelegramFailure } from "@pirate/application/telegram";
import type { TelegramLinkBrowser } from "@pirate/application/telegram-linking";
import { TelegramLinkTransaction } from "@pirate/contracts";
import { Schema } from "effect";
import type { TelegramQuery, TelegramRow } from "./telegram-database.ts";
import { lockTelegramIntegration } from "./telegram-settings-store.ts";

export function refused(reason: TelegramFailure["reason"] = "conflict"): never {
  throw new TelegramFailure({ reason });
}
export async function lockAccount(query: TelegramQuery, accountId: string) {
  const rows = await query(
    "SELECT user_id FROM users WHERE user_id=$1 AND status='active' FOR UPDATE",
    [accountId],
  );
  if (!rows.length) refused("unauthorized");
}
export async function lockLinkBot(query: TelegramQuery, communityId: string) {
  const integration = await lockTelegramIntegration(query, communityId);
  if (integration.status !== "ready" || !integration.botId || !integration.botUsername)
    refused("unavailable");
  return integration;
}
export function currentBot(row: TelegramRow, integration: IntegrationRecord) {
  if (row.bot_id !== integration.botId || row.bot_epoch !== integration.botEpoch) refused();
}
export async function lockLinkTransaction(
  query: TelegramQuery,
  id: string,
  browser: TelegramLinkBrowser,
) {
  const values = [id, browser.accountId, browser.sessionHash, browser.browserHash];
  const target = await query(
    `SELECT community_id FROM telegram_link_transactions
    WHERE transaction_id=$1 AND account_id=$2 AND session_hash=$3 AND browser_hash=$4`,
    values,
  );
  if (!target[0]) refused("not_found");
  // Match reconnect's lock order: community, integration, account, transaction.
  const integration = await lockLinkBot(query, String(target[0].community_id));
  await lockAccount(query, browser.accountId);
  const rows = await query(
    `SELECT *, expires_at>clock_timestamp() AS valid
    FROM telegram_link_transactions WHERE transaction_id=$1 AND account_id=$2
      AND session_hash=$3 AND browser_hash=$4 FOR UPDATE`,
    values,
  );
  const row = rows[0];
  if (row?.valid !== true) refused();
  currentBot(row, integration);
  return row;
}
export async function transactionView(query: TelegramQuery, row: TelegramRow) {
  const bot = await query(
    `SELECT c.display_name,i.record->>'botUsername' AS username
    FROM communities c JOIN community_telegram_integrations i USING(community_id)
    WHERE c.community_id=$1`,
    [row.community_id],
  );
  return Schema.decodeUnknownSync(TelegramLinkTransaction)({
    id: row.transaction_id,
    state: row.state,
    expires_at: new Date(row.expires_at as string | Date).toISOString(),
    community_id: row.community_id,
    community_name: bot[0]?.display_name ?? "",
    bot_id: row.bot_id,
    bot_username: bot[0]?.username ?? "",
    post_id: row.post_id,
    telegram_user_id: row.telegram_user_id,
  });
}
