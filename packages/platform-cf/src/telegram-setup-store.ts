import {
  type SetupRecord,
  TelegramFailure,
  type TelegramStore,
} from "@pirate/application/telegram";
import type { TelegramDatabase } from "./telegram-database.ts";
import { lockTelegramIntegration } from "./telegram-settings-store.ts";

export function makeTelegramSetupStore(
  db: TelegramDatabase,
): Pick<
  TelegramStore,
  "createSetup" | "setup" | "setupByToken" | "bindSetup" | "selectSetup" | "confirmSetup"
> {
  return {
    async createSetup(record) {
      await db.query(
        `INSERT INTO community_telegram_setups(setup_id,community_id,bot_epoch,token_hash,record,expires_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(setup_id) DO NOTHING`,
        [
          record.id,
          record.communityId,
          record.botEpoch,
          record.tokenHash,
          JSON.stringify(record),
          record.expiresAt,
        ],
      );
    },
    async setup(communityId, id) {
      const rows = await db.query(
        "SELECT record,expires_at>clock_timestamp() AS live FROM community_telegram_setups WHERE community_id=$1 AND setup_id=$2",
        [communityId, id],
      );
      if (!rows[0]) return null;
      const record = rows[0].record as SetupRecord;
      return rows[0].live || record.state === "completed"
        ? record
        : { ...record, state: "expired" };
    },
    async setupByToken(communityId, hash) {
      const rows = await db.query(
        `SELECT s.record FROM community_telegram_setups s JOIN community_telegram_integrations i USING(community_id,bot_epoch)
        WHERE s.community_id=$1 AND s.token_hash=$2 AND s.expires_at>clock_timestamp() AND s.record->>'state'='pending'`,
        [communityId, hash],
      );
      return rows[0] ? (rows[0].record as SetupRecord) : null;
    },
    async bindSetup(id, userId, chatId) {
      const rows = await db.query(
        `UPDATE community_telegram_setups SET record=jsonb_set(jsonb_set(record,'{telegramUserId}',to_jsonb($2::text)),'{privateChatId}',to_jsonb($3::text))
        WHERE setup_id=$1 AND expires_at>clock_timestamp() AND record->>'state'='pending'
        AND (record->>'telegramUserId' IS NULL OR (record->>'telegramUserId'=$2 AND record->>'privateChatId'=$3)) RETURNING setup_id`,
        [id, userId, chatId],
      );
      return rows.length > 0;
    },
    async selectSetup(input) {
      await db.query(
        `UPDATE community_telegram_setups SET record=record || $7::jsonb
        WHERE community_id=$1 AND bot_epoch=$2 AND record->>'requestId'=$3 AND record->>'telegramUserId'=$4 AND record->>'privateChatId'=$5
        AND expires_at>clock_timestamp() AND record->>'state'='pending' AND $6::text LIKE '-%'`,
        [
          input.communityId,
          input.epoch,
          String(input.requestId),
          input.userId,
          input.chatId,
          input.channelId,
          JSON.stringify({
            state: "selected",
            channelId: input.channelId,
            channelTitle: input.title,
            channelUsername: input.username,
          }),
        ],
      );
    },
    confirmSetup(communityId, ownerId, setupId, revision) {
      return db.transaction(async (query) => {
        const integration = await lockTelegramIntegration(query, communityId);
        const owners = await query(
          "SELECT 1 FROM community_role_assignments WHERE community_id=$1 AND account_id=$2 AND role='owner' AND status='active' FOR SHARE",
          [communityId, ownerId],
        );
        if (!owners.length) throw new TelegramFailure({ reason: "unauthorized" });
        const rows = await query(
          "SELECT record FROM community_telegram_setups WHERE community_id=$1 AND setup_id=$2 AND expires_at>clock_timestamp() FOR UPDATE",
          [communityId, setupId],
        );
        const setup = rows[0]?.record as SetupRecord | undefined;
        if (!setup || setup.ownerId !== ownerId || setup.botEpoch !== integration.botEpoch)
          throw new TelegramFailure({ reason: "not_found" });
        if (setup.state === "completed") return integration;
        if (integration.revision !== revision || setup.state !== "selected" || !setup.channelId)
          throw new TelegramFailure({ reason: "conflict" });
        const next = {
          ...integration,
          revision: revision + 1,
          channelId: setup.channelId,
          channelTitle: setup.channelTitle,
          channelUsername: setup.channelUsername,
          automaticSince: null,
        };
        await query(
          "UPDATE community_telegram_integrations SET revision=$2,record=$3::jsonb,updated_at=clock_timestamp() WHERE community_id=$1",
          [communityId, next.revision, JSON.stringify(next)],
        );
        await query(
          "UPDATE community_telegram_setups SET record=jsonb_set(record,'{state}','\"completed\"') WHERE setup_id=$1",
          [setupId],
        );
        return next;
      });
    },
  };
}
