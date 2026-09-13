import type { TelegramQuery } from "./telegram-database.ts";

export type InboxFence = {
  readonly communityId: string;
  readonly epoch: string;
  readonly inboxId: string;
  readonly attempt: string;
};

/**
 * Serialize a durable write against retention cleanup and bot rotation.
 *
 * Lock order is the integration epoch row, then the claiming inbox row, which
 * is the suffix of the communities -> integrations order used by settings
 * writes; cleanup takes only the inbox row. Callers revalidate under these
 * locks and only then write, so persistence either commits before invalidation
 * or observes invalidation and is refused. External provider calls happen
 * outside these locks and stay classified uncertain when a fence trips.
 */
export async function lockLiveInbox(query: TelegramQuery, fence: InboxFence): Promise<boolean> {
  const integration = await query(
    "SELECT 1 FROM community_telegram_integrations WHERE community_id=$1 AND bot_epoch=$2 FOR SHARE",
    [fence.communityId, fence.epoch],
  );
  if (integration.length === 0) return false;
  const inbox = await query(
    `SELECT 1 FROM community_telegram_inbox
    WHERE inbox_id=$1 AND community_id=$2 AND bot_epoch=$3 AND attempt=$4
      AND state='processing' AND payload IS NOT NULL
    FOR SHARE`,
    [fence.inboxId, fence.communityId, fence.epoch, fence.attempt],
  );
  return inbox.length > 0;
}
