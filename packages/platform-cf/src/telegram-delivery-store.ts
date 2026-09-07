import {
  type DeliveryRecord,
  TelegramFailure,
  type TelegramStore,
} from "@pirate/application/telegram";
import type { TelegramDelivery } from "@pirate/contracts";
import type { TelegramDatabase, TelegramRow } from "./telegram-database.ts";
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

export function makeTelegramDeliveryStore(
  db: TelegramDatabase,
): Pick<
  TelegramStore,
  | "enqueueDelivery"
  | "claimDelivery"
  | "finishDelivery"
  | "holdDelivery"
  | "listDeliveries"
  | "resolveDelivery"
> {
  return {
    async enqueueDelivery(record) {
      await db.query(
        `INSERT INTO community_telegram_deliveries(delivery_id,community_id,bot_epoch,chat_id,kind,post_id,desired,desired_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
        ON CONFLICT(delivery_id) DO UPDATE SET desired=EXCLUDED.desired,desired_hash=EXCLUDED.desired_hash,
          state=CASE WHEN community_telegram_deliveries.state IN ('sending','uncertain','cancelled') THEN community_telegram_deliveries.state
            WHEN community_telegram_deliveries.confirmed_hash IS NOT DISTINCT FROM EXCLUDED.desired_hash THEN community_telegram_deliveries.state ELSE 'pending' END,
          next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE community_telegram_deliveries.state NOT IN ('sending','uncertain','cancelled')
          AND community_telegram_deliveries.desired_hash IS DISTINCT FROM EXCLUDED.desired_hash`,
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
        const attempt = crypto.randomUUID();
        const claimed = await query(
          `UPDATE community_telegram_deliveries SET state='sending',attempt=$2,attempt_count=attempt_count+1,
          lease_expires_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp()
          WHERE delivery_id=$1 AND next_attempt_at<=clock_timestamp() AND attempt_count<10 RETURNING attempt_count`,
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
          attempt=NULL,lease_expires_at=NULL,last_error=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE delivery_id=$1 AND attempt=$2 AND state='sending'`,
          [
            record.id,
            record.attempt,
            confirmed === null ? null : JSON.stringify(confirmed),
            hash,
            outcome.messageId,
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
      const rows = await db.query(
        `SELECT * FROM community_telegram_deliveries WHERE community_id=$1 AND ($2::text IS NULL OR delivery_id<$2)
        ORDER BY delivery_id DESC LIMIT 51`,
        [communityId, before ?? null],
      );
      const items = rows.slice(0, 50).map((row) => view(delivery(row)));
      return { items, next_cursor: rows.length > 50 ? (items.at(-1)?.id ?? null) : null };
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
        if (record.state !== "uncertain" && record.state !== "failed")
          throw new TelegramFailure({ reason: "conflict" });
        if (resolution === "confirmed" && (!messageId || !record.desired))
          throw new TelegramFailure({ reason: "invalid" });
        const result = await query(
          `UPDATE community_telegram_deliveries SET state=$3,
          message_id=CASE WHEN $3='delivered' THEN $4 ELSE message_id END,
          confirmed=CASE WHEN $3='delivered' THEN desired ELSE confirmed END,
          confirmed_hash=CASE WHEN $3='delivered' THEN desired_hash ELSE confirmed_hash END,
          attempt=NULL,attempt_count=0,last_error=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE community_id=$1 AND delivery_id=$2 RETURNING *`,
          [
            communityId,
            id,
            resolution === "confirmed"
              ? "delivered"
              : resolution === "cancel"
                ? "cancelled"
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
