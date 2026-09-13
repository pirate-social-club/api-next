import {
  type DeliveryIntent,
  type DeliveryRecord,
  type InboxFence,
  TelegramFailure,
  type TelegramStore,
} from "@pirate/application/telegram";
import type { TelegramDelivery } from "@pirate/contracts";
import type { TelegramDatabase, TelegramQuery, TelegramRow } from "./telegram-database.ts";
import { lockLiveInbox } from "./telegram-liveness.ts";
import { lockTelegramIntegration } from "./telegram-settings-store.ts";

function delivery(row: TelegramRow): DeliveryRecord {
  return {
    id: String(row.delivery_id),
    communityId: String(row.community_id),
    botEpoch: String(row.bot_epoch),
    chatId: String(row.chat_id),
    kind: row.kind as DeliveryRecord["kind"],
    postId: row.post_id as string | null,
    state: row.state as DeliveryRecord["state"],
    desired: row.desired as DeliveryRecord["desired"],
    desiredHash: row.desired_hash as string | null,
    confirmed: row.confirmed as DeliveryRecord["confirmed"],
    confirmedHash: row.confirmed_hash as string | null,
    messageId: row.message_id === null ? null : Number(row.message_id),
    attempt: row.attempt as string | null,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error as string | null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}
function view(record: DeliveryRecord): TelegramDelivery {
  return {
    id: record.id,
    kind: record.kind,
    post_id: record.postId,
    state: record.state,
    attempt_count: record.attemptCount,
    last_error: record.lastError,
    created_at: record.createdAt,
  };
}

async function insertDelivery(query: TelegramQuery, record: DeliveryIntent) {
  await query(
    `INSERT INTO community_telegram_deliveries(delivery_id,community_id,bot_epoch,chat_id,kind,post_id,desired,desired_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
    ON CONFLICT(delivery_id) DO UPDATE SET desired=EXCLUDED.desired,desired_hash=EXCLUDED.desired_hash,
      state=CASE WHEN community_telegram_deliveries.state IN ('sending','uncertain')
          THEN community_telegram_deliveries.state
        WHEN community_telegram_deliveries.confirmed_hash IS NOT DISTINCT FROM EXCLUDED.desired_hash
          THEN CASE WHEN community_telegram_deliveries.message_id IS NULL THEN 'withdrawn' ELSE 'delivered' END
        ELSE 'pending' END,
      attempt_count=CASE WHEN community_telegram_deliveries.state IN ('sending','uncertain')
        THEN community_telegram_deliveries.attempt_count ELSE 0 END,
      attempt=CASE WHEN community_telegram_deliveries.state IN ('sending','uncertain')
        THEN community_telegram_deliveries.attempt ELSE NULL END,
      lease_expires_at=CASE WHEN community_telegram_deliveries.state IN ('sending','uncertain')
        THEN community_telegram_deliveries.lease_expires_at ELSE NULL END,
      last_error=CASE WHEN community_telegram_deliveries.state IN ('sending','uncertain')
        THEN community_telegram_deliveries.last_error ELSE NULL END,
      next_attempt_at=CASE WHEN community_telegram_deliveries.state IN ('sending','uncertain')
        THEN community_telegram_deliveries.next_attempt_at ELSE clock_timestamp() END,
      updated_at=clock_timestamp()
    WHERE community_telegram_deliveries.desired_hash IS DISTINCT FROM EXCLUDED.desired_hash
      AND (community_telegram_deliveries.state NOT IN ('sending','uncertain','cancelled')
        OR community_telegram_deliveries.kind='publication')`,
    [
      record.id,
      record.communityId,
      record.botEpoch,
      record.chatId,
      record.kind,
      record.postId,
      record.desired === null ? null : JSON.stringify(record.desired),
      record.desiredHash,
    ],
  );
}

const deliveryCursorPattern =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}(?::?\d{2})?)?\|[^|]+$/;

function parseDeliveryCursor(value: string | undefined): { createdAt: string; id: string } | null {
  if (value === undefined) return null;
  if (!deliveryCursorPattern.test(value)) throw new TelegramFailure({ reason: "invalid" });
  const separator = value.indexOf("|");
  return { createdAt: value.slice(0, separator), id: value.slice(separator + 1) };
}

export function makeTelegramDeliveryStore(
  db: TelegramDatabase,
): Pick<
  TelegramStore,
  | "enqueueDelivery"
  | "enqueueInboxReply"
  | "claimDelivery"
  | "finishDelivery"
  | "holdDelivery"
  | "listDeliveries"
  | "resolveDelivery"
> {
  return {
    async enqueueDelivery(record) {
      await insertDelivery(db.query.bind(db), record);
    },
    async enqueueInboxReply(record, fence) {
      return db.transaction(async (query) => {
        // The gate locks the epoch and claim rows before the insert, so the
        // reply is either durable before cleanup or rotation invalidates the
        // item, or it is refused after observing the invalidation.
        if (!(await lockLiveInbox(query, fence))) return false;
        await insertDelivery(query, record);
        return true;
      });
    },
    claimDelivery(id) {
      return db.transaction(async (query) => {
        const rows = await query(
          "SELECT * FROM community_telegram_deliveries WHERE delivery_id=$1 FOR UPDATE",
          [id],
        );
        if (!rows[0]) return null;
        const record = delivery(rows[0]);
        if (record.state === "sending") {
          await query(
            "UPDATE community_telegram_deliveries SET state='uncertain',attempt=NULL,last_error='lease_expired' WHERE delivery_id=$1 AND lease_expires_at<clock_timestamp()",
            [id],
          );
          return null;
        }
        if (record.state !== "pending" && record.state !== "failed") return null;
        if (record.attemptCount >= 10 && (record.state === "failed" || record.lastError !== null)) {
          // Exhausted work must stay visible to operator recovery, including
          // pending rows written before retry counts were scoped to revisions.
          await query(
            "UPDATE community_telegram_deliveries SET state='failed',next_attempt_at='infinity',last_error=COALESCE(last_error,'retry_limit_reached'),updated_at=clock_timestamp() WHERE delivery_id=$1",
            [id],
          );
          return null;
        }
        const attempt = crypto.randomUUID();
        // A pending row without an error may carry the former lifetime count
        // from successful revisions; its current operation starts at attempt one.
        const claimed = await query(
          `UPDATE community_telegram_deliveries SET state='sending',attempt=$2,
          intended=desired,intended_hash=desired_hash,
          attempt_count=CASE WHEN state='pending' AND last_error IS NULL THEN 1 ELSE attempt_count+1 END,
          lease_expires_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp()
          WHERE delivery_id=$1 AND next_attempt_at<=clock_timestamp() AND (attempt_count<10 OR (state='pending' AND last_error IS NULL)) RETURNING attempt_count`,
          [id, attempt],
        );
        return claimed[0]
          ? { ...record, attempt, attemptCount: Number(claimed[0].attempt_count) }
          : null;
      });
    },
    async finishDelivery(record, outcome, operation) {
      if (outcome.kind === "confirmed") {
        const confirmed = operation === "delete" ? null : record.desired;
        const hash = operation === "delete" ? null : record.desiredHash;
        await db.query(
          `UPDATE community_telegram_deliveries SET confirmed=$3::jsonb,confirmed_hash=$4,message_id=$5,
          state=CASE WHEN desired_hash IS DISTINCT FROM $4::text THEN 'pending' WHEN $5::bigint IS NULL THEN 'withdrawn' ELSE 'delivered' END,
          intended=NULL,intended_hash=NULL,
          attempt=NULL,attempt_count=0,lease_expires_at=NULL,last_error=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE delivery_id=$1 AND attempt=$2 AND state='sending'`,
          [
            record.id,
            record.attempt,
            confirmed === null ? null : JSON.stringify(confirmed),
            hash,
            operation === "delete" ? null : outcome.messageId,
          ],
        );
      } else {
        const retryable = outcome.kind === "rejected" && outcome.retryAfter !== null;
        await db.query(
          `UPDATE community_telegram_deliveries SET state=$3,attempt=NULL,lease_expires_at=NULL,last_error=$4,
          next_attempt_at=CASE WHEN $5::int IS NULL THEN 'infinity'::timestamptz ELSE clock_timestamp()+make_interval(secs=>$5::int) END,
          updated_at=clock_timestamp() WHERE delivery_id=$1 AND attempt=$2 AND state='sending'`,
          [
            record.id,
            record.attempt,
            outcome.kind === "uncertain" ? "uncertain" : "failed",
            outcome.code,
            retryable ? Math.min(outcome.retryAfter ?? 60, 86400) : null,
          ],
        );
      }
    },
    async holdDelivery(record, code) {
      await db.query(
        `UPDATE community_telegram_deliveries SET state=$3,attempt=NULL,lease_expires_at=NULL,last_error=$4,
        next_attempt_at='infinity',updated_at=clock_timestamp() WHERE delivery_id=$1 AND attempt=$2 AND state='sending'`,
        [record.id, record.attempt, code === "publication_changed" ? "failed" : "uncertain", code],
      );
    },
    async listDeliveries(communityId, before) {
      // Operator recovery is publication-only, ordered by creation time with
      // the delivery id as a stable tiebreak. The cursor carries the raw
      // database timestamp so pagination cannot skip rows that share a
      // millisecond, unlike the former hashed-id ordering.
      const cursor = parseDeliveryCursor(before);
      const rows = await db.query(
        `SELECT *,created_at::text AS created_at_cursor FROM community_telegram_deliveries
        WHERE community_id=$1 AND kind='publication'
          AND ($2::timestamptz IS NULL OR (created_at, delivery_id) < ($2::timestamptz, $3::text))
        ORDER BY created_at DESC, delivery_id DESC LIMIT 51`,
        [communityId, cursor?.createdAt ?? null, cursor?.id ?? ""],
      );
      const page = rows.slice(0, 50);
      const items = page.map((row) => view(delivery(row)));
      const last = page.at(-1);
      return {
        items,
        next_cursor:
          rows.length > 50 && last !== undefined
            ? `${String(last.created_at_cursor)}|${String(last.delivery_id)}`
            : null,
      };
    },
    resolveDelivery(communityId, id, resolution, command, messageId) {
      return db.transaction(async (query) => {
        const integration = await lockTelegramIntegration(query, communityId);
        const owners = await query(
          "SELECT 1 FROM community_role_assignments WHERE community_id=$1 AND account_id=$2 AND role='owner' AND status='active' FOR SHARE",
          [communityId, command.ownerId],
        );
        if (!owners.length) throw new TelegramFailure({ reason: "unauthorized" });
        const replay = await query(
          "SELECT command_hash,result FROM community_telegram_commands WHERE community_id=$1 AND command_key=$2",
          [communityId, command.key],
        );
        if (replay[0]) {
          if (replay[0].command_hash !== command.hash)
            throw new TelegramFailure({ reason: "conflict" });
          return replay[0].result as TelegramDelivery;
        }
        if (integration.revision !== command.revision)
          throw new TelegramFailure({ reason: "conflict" });
        const rows = await query(
          "SELECT * FROM community_telegram_deliveries WHERE community_id=$1 AND delivery_id=$2 FOR UPDATE",
          [communityId, id],
        );
        if (!rows[0]) throw new TelegramFailure({ reason: "not_found" });
        const record = delivery(rows[0]);
        // Operator recovery is scoped to channel publications. Private reply,
        // voice and setup deliveries are automation-owned and are not exposed
        // through the resolution contract.
        if (record.kind !== "publication") throw new TelegramFailure({ reason: "not_found" });
        if (record.state !== "uncertain" && record.state !== "failed")
          throw new TelegramFailure({ reason: "conflict" });
        // Resolution confirms or discards the operation's pinned revision,
        // not a newer desired payload that arrived while it was in flight.
        // Cancellation is likewise scoped to the pinned revision: when the
        // live desired state differs, the row returns to pending so the newer
        // edit or withdrawal can be claimed instead of being stranded.
        const intended = rows[0].intended ?? null;
        if (resolution === "confirmed" && intended !== null && !messageId)
          throw new TelegramFailure({ reason: "invalid" });
        const result = await query(
          `UPDATE community_telegram_deliveries SET
          state=CASE WHEN desired_hash IS DISTINCT FROM intended_hash THEN 'pending'
            WHEN $3='cancelled' THEN 'cancelled'
            ELSE $3 END,
          message_id=CASE WHEN $3='cancelled' THEN message_id WHEN $3='delivered' THEN $4 ELSE NULL END,
          confirmed=CASE WHEN $3='cancelled' THEN confirmed WHEN $3='delivered' THEN intended ELSE NULL END,
          confirmed_hash=CASE WHEN $3='cancelled' THEN confirmed_hash WHEN $3='delivered' THEN intended_hash ELSE NULL END,
          intended=NULL,intended_hash=NULL,
          attempt=NULL,attempt_count=0,lease_expires_at=NULL,last_error=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE community_id=$1 AND delivery_id=$2 RETURNING *`,
          [
            communityId,
            id,
            resolution === "cancel"
              ? "cancelled"
              : intended === null
                ? "withdrawn"
                : resolution === "confirmed"
                  ? "delivered"
                  : "pending",
            messageId ?? null,
          ],
        );
        if (!result[0]) throw new TelegramFailure({ reason: "conflict" });
        const response = view(delivery(result[0]));
        await query(
          "INSERT INTO community_telegram_commands(community_id,command_key,command_hash,result) VALUES($1,$2,$3,$4::jsonb)",
          [communityId, command.key, command.hash, JSON.stringify(response)],
        );
        return response;
      });
    },
  };
}
