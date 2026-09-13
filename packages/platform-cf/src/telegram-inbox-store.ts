import type { IncomingUpdate, TelegramStore } from "@pirate/application/telegram";
import type { TelegramDatabase } from "./telegram-database.ts";
import { lockLiveInbox } from "./telegram-liveness.ts";

export function makeTelegramInboxStore(
  db: TelegramDatabase,
): Pick<
  TelegramStore,
  | "acceptUpdate"
  | "claimInbox"
  | "inboxLive"
  | "finishInbox"
  | "pendingWork"
  | "reserveUsage"
  | "admitCommand"
  | "admitMinute"
  | "reserveNotice"
  | "claimChat"
  | "releaseChat"
  | "deferInbox"
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
        lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE inbox_id=$1 AND attempts<5 AND next_attempt_at<=clock_timestamp()
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
            chatToken: null,
          }
        : null;
    },
    async inboxLive(item) {
      const rows = await db.query(
        `SELECT 1 FROM community_telegram_inbox i
        JOIN community_telegram_integrations g USING (community_id)
        WHERE i.inbox_id=$1 AND i.attempt=$2 AND i.state='processing' AND i.payload IS NOT NULL
          AND i.bot_epoch=$3 AND g.bot_epoch=$3
          AND i.lease_expires_at > clock_timestamp()`,
        [item.id, item.attempt, item.botEpoch],
      );
      return rows.length > 0;
    },
    async finishInbox(item, error) {
      await db.transaction(async (query) => {
        // The completion itself is fenced: a refused reply or an expired claim
        // must never be finished as completed with no user-visible result.
        if (
          !(await lockLiveInbox(query, {
            communityId: item.communityId,
            epoch: item.botEpoch,
            inboxId: item.id,
            attempt: item.attempt,
            chatToken: item.chatToken ?? null,
          }))
        )
          return;
        await query(
          `UPDATE community_telegram_inbox SET state=CASE WHEN $3::text IS NULL THEN 'completed' WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,
          payload=CASE WHEN $3::text IS NULL OR attempts>=5 THEN NULL ELSE payload END,attempt=NULL,lease_expires_at=NULL,last_error=$3,
          next_attempt_at=clock_timestamp()+interval '1 minute' WHERE inbox_id=$1 AND attempt=$2 AND state='processing'`,
          [item.id, item.attempt, error],
        );
      });
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
    admitCommand(communityId, epoch, userId, key, limits) {
      return db.transaction(async (query) => {
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
        for (const subject of subjects) {
          await query(
            "INSERT INTO community_telegram_usage(community_id,usage_day,subject) VALUES($1,(clock_timestamp() AT TIME ZONE 'UTC')::date,$2) ON CONFLICT DO NOTHING",
            [communityId, subject],
          );
        }
        const rows = await query(
          "SELECT subject,commands FROM community_telegram_usage WHERE community_id=$1 AND usage_day=(clock_timestamp() AT TIME ZONE 'UTC')::date AND subject=ANY($2::text[]) FOR UPDATE",
          [communityId, subjects],
        );
        if (
          rows.some(
            (row) =>
              Number(row.commands) + 1 >
              (row.subject === "community" ? limits.community : limits.user),
          )
        )
          return false;
        await query(
          "UPDATE community_telegram_usage SET commands=commands+1 WHERE community_id=$1 AND usage_day=(clock_timestamp() AT TIME ZONE 'UTC')::date AND subject=ANY($2::text[])",
          [communityId, subjects],
        );
        await query(
          "INSERT INTO community_telegram_usage_reservations(community_id,bot_epoch,reservation_key) VALUES($1,$2,$3)",
          [communityId, epoch, key],
        );
        return true;
      });
    },
    admitMinute(communityId, epoch, chatId, userId, key, limits) {
      return db.transaction(async (query) => {
        // The integration row serializes concurrent admission, so two
        // simultaneous messages cannot both observe a below-limit count.
        const integration = await query(
          "SELECT community_id FROM community_telegram_integrations WHERE community_id=$1 AND bot_epoch=$2 FOR UPDATE",
          [communityId, epoch],
        );
        if (integration.length === 0) return false;
        const eventKey = `minute:${key}`;
        const previous = await query(
          "SELECT 1 FROM community_telegram_usage_reservations WHERE community_id=$1 AND bot_epoch=$2 AND reservation_key=$3",
          [communityId, epoch, eventKey],
        );
        if (previous.length > 0) return true;
        const scopes = [
          { prefix: `minute:user:${userId}`, limit: limits.user },
          { prefix: `minute:chat:${chatId}`, limit: limits.chat },
          { prefix: "minute:community", limit: limits.community },
        ];
        for (const scope of scopes) {
          const rows = await query(
            `SELECT count(*)::int AS used FROM community_telegram_usage_reservations
            WHERE community_id=$1 AND bot_epoch=$2 AND starts_with(reservation_key, $3 || ':')
              AND created_at > clock_timestamp() - make_interval(secs=>$4)`,
            [communityId, epoch, scope.prefix, limits.windowSeconds],
          );
          if (Number(rows[0]?.used ?? 0) >= scope.limit) return false;
        }
        await query(
          "INSERT INTO community_telegram_usage_reservations(community_id,bot_epoch,reservation_key) VALUES($1,$2,$3)",
          [communityId, epoch, eventKey],
        );
        for (const scope of scopes) {
          await query(
            "INSERT INTO community_telegram_usage_reservations(community_id,bot_epoch,reservation_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [communityId, epoch, `${scope.prefix}:${eventKey}`],
          );
        }
        return true;
      });
    },
    reserveNotice(communityId, epoch, chatId, userId, reason, windowSeconds) {
      return db.transaction(async (query) => {
        const integration = await query(
          "SELECT community_id FROM community_telegram_integrations WHERE community_id=$1 AND bot_epoch=$2 FOR UPDATE",
          [communityId, epoch],
        );
        if (integration.length === 0) return false;
        const bucket = await query(
          "SELECT floor(extract(epoch FROM clock_timestamp())/$1)::bigint AS bucket",
          [windowSeconds],
        );
        const prefix = `notice:${reason}:${String(bucket[0]?.bucket ?? "0")}`;
        const keys = [
          `${prefix}:user:${userId}`,
          `${prefix}:chat:${chatId}`,
          `${prefix}:community`,
        ];
        const existing = await query(
          "SELECT 1 FROM community_telegram_usage_reservations WHERE community_id=$1 AND bot_epoch=$2 AND reservation_key=ANY($3::text[])",
          [communityId, epoch, keys],
        );
        if (existing.length > 0) return false;
        for (const key of keys)
          await query(
            "INSERT INTO community_telegram_usage_reservations(community_id,bot_epoch,reservation_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [communityId, epoch, key],
          );
        return true;
      });
    },
    claimChat(communityId, epoch, chatId, minIntervalSeconds) {
      return db.transaction(async (query) => {
        const token = crypto.randomUUID();
        const rows = await query(
          `INSERT INTO community_telegram_chat_leases(community_id,bot_epoch,chat_id,lease_token,lease_expires_at,next_allowed_at)
          VALUES($1,$2,$3,$4,clock_timestamp()+interval '5 minutes',clock_timestamp()+make_interval(secs=>$5))
          ON CONFLICT(community_id,bot_epoch,chat_id) DO UPDATE
          SET lease_token=EXCLUDED.lease_token,lease_expires_at=EXCLUDED.lease_expires_at,next_allowed_at=EXCLUDED.next_allowed_at
          WHERE community_telegram_chat_leases.next_allowed_at<=clock_timestamp()
            AND (community_telegram_chat_leases.lease_expires_at IS NULL OR community_telegram_chat_leases.lease_expires_at<clock_timestamp())
          RETURNING lease_token`,
          [communityId, epoch, chatId, token, minIntervalSeconds],
        );
        return rows[0] ? String(rows[0].lease_token) : null;
      });
    },
    async releaseChat(communityId, epoch, chatId, token) {
      await db.query(
        "UPDATE community_telegram_chat_leases SET lease_token=NULL,lease_expires_at=NULL WHERE community_id=$1 AND bot_epoch=$2 AND chat_id=$3 AND lease_token=$4",
        [communityId, epoch, chatId, token],
      );
    },
    async deferInbox(item, delaySeconds, reason) {
      await db.query(
        `UPDATE community_telegram_inbox SET state='pending',attempts=GREATEST(attempts-1,0),attempt=NULL,lease_expires_at=NULL,last_error=$4,next_attempt_at=clock_timestamp()+make_interval(secs=>$3)
        WHERE inbox_id=$1 AND attempt=$2 AND state='processing'`,
        [item.id, item.attempt, delaySeconds, reason],
      );
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
    async saveConversation(communityId, userId, inputId, prompt, answer, fence) {
      return db.transaction(async (query) => {
        if (!(await lockLiveInbox(query, fence))) return false;
        await query(
          `INSERT INTO community_telegram_conversations(community_id,telegram_user_id,input_id,prompt,answer)
          SELECT $1,$2,$3,$4,$5 FROM community_telegram_integrations WHERE community_id=$1 AND record->'policy'->>'remember_conversations'='true'
          ON CONFLICT(community_id,input_id) DO NOTHING`,
          [communityId, userId, inputId, prompt, answer],
        );
        return true;
      });
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
      // Stage deletion is guarded by the terminal inbox state: a handler
      // committing a stage holds the inbox share lock, so an in-flight stage
      // cannot match, and concurrent cleanup runs are safe by the condition.
      await db.query(
        `DELETE FROM community_telegram_provider_stages AS stage
        USING community_telegram_inbox AS inbox
        WHERE stage.inbox_id=inbox.inbox_id
          AND stage.issued_at<clock_timestamp()-interval '24 hours'
          AND inbox.state IN ('completed','failed','cancelled')`,
      );
      await db.query(
        "DELETE FROM community_telegram_usage WHERE usage_day<(clock_timestamp() AT TIME ZONE 'UTC')::date-7",
      );
      // Minute admission events age out with the retention window that bounds
      // replay; notice cooldowns are kept long enough to audit refusals.
      await db.query(
        "DELETE FROM community_telegram_usage_reservations WHERE reservation_key LIKE 'minute:%' AND created_at<clock_timestamp()-interval '24 hours'",
      );
      await db.query(
        "DELETE FROM community_telegram_usage_reservations WHERE reservation_key LIKE 'notice:%' AND created_at<clock_timestamp()-interval '7 days'",
      );
      await db.query(
        `DELETE FROM community_telegram_chat_leases
        WHERE next_allowed_at<clock_timestamp()-interval '24 hours'
          AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp()-interval '24 hours')`,
      );
      // Deduplication tombstones outlive content. Replayed update IDs never regenerate replies.
    },
  };
}
