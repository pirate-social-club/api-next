import type { IncomingUpdate, TelegramStore } from "@pirate/application/telegram";
import type { TelegramDatabase } from "./telegram-database.ts";

export function makeTelegramInboxStore(
  db: TelegramDatabase,
): Pick<
  TelegramStore,
  | "acceptUpdate"
  | "claimInbox"
  | "finishInbox"
  | "pendingWork"
  | "reserveUsage"
  | "history"
  | "saveConversation"
  | "cleanup"
> {
  return {
    async acceptUpdate(integration, update) {
      const id = crypto.randomUUID();
      const rows = await db.query(
        `INSERT INTO community_telegram_inbox(inbox_id,community_id,bot_epoch,update_id,payload)
        SELECT $1,$2,$3,$4,$5::jsonb FROM community_telegram_integrations WHERE community_id=$2 AND bot_epoch=$3
        ON CONFLICT(community_id,bot_epoch,update_id) DO UPDATE SET update_id=EXCLUDED.update_id RETURNING inbox_id`,
        [
          id,
          integration.communityId,
          integration.botEpoch,
          update.update_id,
          JSON.stringify(update),
        ],
      );
      return String(rows[0]?.inbox_id ?? id);
    },
    async claimInbox(id) {
      const attempt = crypto.randomUUID();
      const rows = await db.query(
        `UPDATE community_telegram_inbox SET state='processing',attempt=$2,attempts=attempts+1,
        lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE inbox_id=$1 AND attempts<5 AND next_attempt_at<=clock_timestamp()
        AND (state='pending' OR (state='processing' AND lease_expires_at<clock_timestamp()))
        RETURNING community_id,bot_epoch,payload`,
        [id, attempt],
      );
      const row = rows[0];
      return row
        ? {
            id,
            communityId: String(row.community_id),
            botEpoch: String(row.bot_epoch),
            update: row.payload as IncomingUpdate,
            attempt,
          }
        : null;
    },
    async finishInbox(item, error) {
      await db.query(
        `UPDATE community_telegram_inbox SET state=CASE WHEN $3::text IS NULL THEN 'completed' WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,
        payload=CASE WHEN $3::text IS NULL OR attempts>=5 THEN NULL ELSE payload END,attempt=NULL,lease_expires_at=NULL,last_error=$3,
        next_attempt_at=clock_timestamp()+interval '1 minute' WHERE inbox_id=$1 AND attempt=$2 AND state='processing'`,
        [item.id, item.attempt, error],
      );
    },
    async pendingWork() {
      const rows =
        await db.query(`(SELECT 'inbox' AS kind,inbox_id AS id FROM community_telegram_inbox
        WHERE attempts<5 AND next_attempt_at<=clock_timestamp() AND (state='pending' OR (state='processing' AND lease_expires_at<clock_timestamp())) ORDER BY next_attempt_at LIMIT 50)
        UNION ALL (SELECT 'delivery' AS kind,delivery_id AS id FROM community_telegram_deliveries
        WHERE (state IN ('pending','failed') AND attempt_count<10 AND next_attempt_at<=clock_timestamp()) OR (state='sending' AND lease_expires_at<clock_timestamp()) ORDER BY next_attempt_at LIMIT 50)`);
      return rows.map((row) => ({ kind: row.kind as "inbox" | "delivery", id: String(row.id) }));
    },
    reserveUsage(communityId, epoch, userId, key, policy, speechCharacters) {
      return db.transaction(async (query) => {
        // One row serializes community and per-user budgets in a fixed lock order.
        const integration = await query(
          "SELECT community_id FROM community_telegram_integrations WHERE community_id=$1 AND bot_epoch=$2 FOR UPDATE",
          [communityId, epoch],
        );
        if (integration.length === 0) return false;
        const previous = await query(
          "SELECT 1 FROM community_telegram_usage_reservations WHERE community_id=$1 AND bot_epoch=$2 AND reservation_key=$3",
          [communityId, epoch, key],
        );
        if (previous.length > 0) return true;
        const subjects = ["community", `user:${userId}`];
        const messages = speechCharacters === 0 ? 1 : 0;
        for (const subject of subjects) {
          await query(
            "INSERT INTO community_telegram_usage(community_id,usage_day,subject) VALUES($1,(clock_timestamp() AT TIME ZONE 'UTC')::date,$2) ON CONFLICT DO NOTHING",
            [communityId, subject],
          );
        }
        const rows = await query(
          "SELECT subject,messages,speech_characters FROM community_telegram_usage WHERE community_id=$1 AND usage_day=(clock_timestamp() AT TIME ZONE 'UTC')::date AND subject=ANY($2::text[]) FOR UPDATE",
          [communityId, subjects],
        );
        if (
          rows.some(
            (row) =>
              Number(row.messages) + messages >
                (row.subject === "community"
                  ? policy.community_daily_messages
                  : policy.user_daily_messages) ||
              Number(row.speech_characters) + speechCharacters > policy.daily_speech_characters,
          )
        )
          return false;
        await query(
          "UPDATE community_telegram_usage SET messages=messages+$3,speech_characters=speech_characters+$4 WHERE community_id=$1 AND usage_day=(clock_timestamp() AT TIME ZONE 'UTC')::date AND subject=ANY($2::text[])",
          [communityId, subjects, messages, speechCharacters],
        );
        await query(
          "INSERT INTO community_telegram_usage_reservations(community_id,bot_epoch,reservation_key) VALUES($1,$2,$3)",
          [communityId, epoch, key],
        );
        return true;
      });
    },
    async history(communityId, userId) {
      const rows = await db.query(
        `SELECT prompt,answer FROM community_telegram_conversations WHERE community_id=$1 AND telegram_user_id=$2
        AND created_at>clock_timestamp()-interval '24 hours' ORDER BY created_at DESC LIMIT 6`,
        [communityId, userId],
      );
      return [...rows].reverse().flatMap((row) => [
        { role: "user" as const, content: String(row.prompt) },
        { role: "assistant" as const, content: String(row.answer) },
      ]);
    },
    async saveConversation(communityId, userId, inputId, prompt, answer) {
      await db.query(
        `INSERT INTO community_telegram_conversations(community_id,telegram_user_id,input_id,prompt,answer)
        SELECT $1,$2,$3,$4,$5 FROM community_telegram_integrations WHERE community_id=$1 AND record->'policy'->>'remember_conversations'='true'
        ON CONFLICT(community_id,input_id) DO NOTHING`,
        [communityId, userId, inputId, prompt, answer],
      );
    },
    async cleanup() {
      await db.query(
        "UPDATE community_telegram_deliveries SET desired=NULL,desired_hash=NULL,confirmed=NULL,confirmed_hash=NULL,state='cancelled',attempt=NULL WHERE kind IN ('reply','voice','setup') AND created_at<clock_timestamp()-interval '24 hours' AND (desired IS NOT NULL OR confirmed IS NOT NULL)",
      );
      await db.query(
        "DELETE FROM community_telegram_conversations WHERE created_at<clock_timestamp()-interval '24 hours'",
      );
      await db.query(
        "UPDATE community_telegram_inbox SET payload=NULL,state=CASE WHEN state IN ('pending','processing') THEN 'failed' ELSE state END WHERE payload IS NOT NULL AND created_at<clock_timestamp()-interval '24 hours'",
      );
      await db.query(
        "DELETE FROM community_telegram_setups WHERE expires_at<clock_timestamp()-interval '1 day'",
      );
      await db.query(
        "DELETE FROM community_telegram_usage WHERE usage_day<(clock_timestamp() AT TIME ZONE 'UTC')::date-7",
      );
      // Deduplication tombstones outlive content. Replayed update IDs never regenerate replies.
    },
  };
}
