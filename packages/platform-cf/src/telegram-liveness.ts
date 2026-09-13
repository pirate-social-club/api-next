import type { TelegramQuery } from "./telegram-database.ts";

export type InboxFence = {
  readonly communityId: string;
  readonly epoch: string;
  readonly inboxId: string;
  readonly attempt: string;
  readonly chatToken?: string | null;
};

/**
 * Serialize a durable write against retention cleanup, bot rotation and claim
 * supersession.
 *
 * Lock order is the integration epoch row, then the claiming inbox row, then
 * the chat lease row, which is the suffix of the communities -> integrations
 * order used by settings writes; cleanup takes only inbox rows and lease rows.
 * The write is refused when the claim's lease has expired, which also covers a
 * handler that stalled past its chat lease, and when a chat lease token is
 * provided but no longer owned by this handler. Callers revalidate under these
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
      AND lease_expires_at > clock_timestamp()
    FOR SHARE`,
    [fence.inboxId, fence.communityId, fence.epoch, fence.attempt],
  );
  if (inbox.length === 0) return false;
  if (fence.chatToken === undefined || fence.chatToken === null) return true;
  const lease = await query(
    `SELECT 1 FROM community_telegram_chat_leases
    WHERE community_id=$1 AND bot_epoch=$2 AND lease_token=$3 AND lease_expires_at > clock_timestamp()
    FOR SHARE`,
    [fence.communityId, fence.epoch, fence.chatToken],
  );
  return lease.length > 0;
}
