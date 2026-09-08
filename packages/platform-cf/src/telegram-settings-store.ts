import {
  DEFAULT_ASSISTANT_POLICY,
  type IntegrationRecord,
  integrationView,
  TelegramFailure,
  type TelegramStore,
} from "@pirate/application/telegram";
import type { TelegramDatabase, TelegramQuery } from "./telegram-database.ts";

export function emptyTelegramIntegration(communityId: string): IntegrationRecord {
  return {
    communityId,
    revision: 0,
    botEpoch: "disconnected",
    botId: null,
    botUsername: null,
    botToken: null,
    webhookId: null,
    webhookSecret: null,
    status: "disconnected",
    channelId: null,
    channelTitle: null,
    channelUsername: null,
    automaticSince: null,
    policy: { ...DEFAULT_ASSISTANT_POLICY },
    credentials: {},
    lastError: null,
  };
}

export async function lockTelegramIntegration(
  query: TelegramQuery,
  communityId: string,
): Promise<IntegrationRecord> {
  // The community row also serializes the initial integration insert.
  const community = await query(
    "SELECT community_id FROM communities WHERE community_id=$1 AND status='active' FOR UPDATE",
    [communityId],
  );
  if (community.length === 0) throw new TelegramFailure({ reason: "not_found" });
  const rows = await query(
    "SELECT record FROM community_telegram_integrations WHERE community_id=$1 FOR UPDATE",
    [communityId],
  );
  return rows[0] ? (rows[0].record as IntegrationRecord) : emptyTelegramIntegration(communityId);
}

export function makeTelegramSettingsStore(
  db: TelegramDatabase,
): Pick<
  TelegramStore,
  | "owner"
  | "integration"
  | "byWebhook"
  | "saveIntegration"
  | "commandReplay"
  | "configureResult"
  | "configuredCandidates"
> {
  return {
    async owner(communityId, accountId) {
      const rows = await db.query(
        `SELECT 1 FROM community_role_assignments r JOIN communities c USING(community_id)
        WHERE r.community_id=$1 AND r.account_id=$2 AND r.role='owner' AND r.status='active' AND c.status='active'`,
        [communityId, accountId],
      );
      if (rows.length === 0) throw new TelegramFailure({ reason: "unauthorized" });
    },
    async integration(communityId) {
      const rows = await db.query(
        "SELECT record FROM community_telegram_integrations WHERE community_id=$1",
        [communityId],
      );
      return rows[0]
        ? (rows[0].record as IntegrationRecord)
        : emptyTelegramIntegration(communityId);
    },
    async byWebhook(webhookId) {
      const rows = await db.query(
        "SELECT i.record FROM community_telegram_integrations i JOIN communities c USING(community_id) WHERE i.webhook_id=$1 AND c.status='active'",
        [webhookId],
      );
      return rows[0] ? (rows[0].record as IntegrationRecord) : null;
    },
    async commandReplay(communityId, key, hash) {
      const rows = await db.query(
        "SELECT command_hash,result FROM community_telegram_commands WHERE community_id=$1 AND command_key=$2",
        [communityId, key],
      );
      if (!rows[0]) return null;
      if (rows[0].command_hash !== hash) throw new TelegramFailure({ reason: "conflict" });
      return rows[0].result;
    },
    saveIntegration(record, expected, key, hash, ownerId) {
      return db.transaction(async (query) => {
        const current = await lockTelegramIntegration(query, record.communityId);
        const owners = await query(
          "SELECT 1 FROM community_role_assignments WHERE community_id=$1 AND account_id=$2 AND role='owner' AND status='active' FOR SHARE",
          [record.communityId, ownerId],
        );
        if (!owners.length) throw new TelegramFailure({ reason: "unauthorized" });
        const replay = await query(
          "SELECT command_hash FROM community_telegram_commands WHERE community_id=$1 AND command_key=$2",
          [record.communityId, key],
        );
        if (replay[0]) {
          if (replay[0].command_hash !== hash) throw new TelegramFailure({ reason: "conflict" });
          return current;
        }
        if (current.revision !== expected) throw new TelegramFailure({ reason: "conflict" });
        const next = { ...record, revision: expected + 1 };
        await query(
          `INSERT INTO community_telegram_integrations(community_id,revision,bot_epoch,bot_id,webhook_id,record)
          VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(community_id) DO UPDATE SET revision=EXCLUDED.revision,
          bot_epoch=EXCLUDED.bot_epoch,bot_id=EXCLUDED.bot_id,webhook_id=EXCLUDED.webhook_id,record=EXCLUDED.record,updated_at=clock_timestamp()`,
          [
            next.communityId,
            next.revision,
            next.botEpoch,
            next.botId,
            next.webhookId,
            JSON.stringify(next),
          ],
        );
        await query(
          "INSERT INTO community_telegram_commands(community_id,command_key,command_hash,result) VALUES($1,$2,$3,$4::jsonb)",
          [next.communityId, key, hash, JSON.stringify(integrationView(next))],
        );
        if (current.botEpoch !== next.botEpoch) {
          await query(
            "UPDATE community_telegram_inbox SET state='cancelled',payload=NULL WHERE community_id=$1 AND bot_epoch<>$2 AND state IN ('pending','processing')",
            [next.communityId, next.botEpoch],
          );
          await query(
            "UPDATE community_telegram_deliveries SET state=CASE WHEN state='sending' THEN 'uncertain' ELSE 'cancelled' END,attempt=NULL,last_error='integration_changed' WHERE community_id=$1 AND bot_epoch<>$2 AND state IN ('pending','failed','sending')",
            [next.communityId, next.botEpoch],
          );
          await query("DELETE FROM community_telegram_conversations WHERE community_id=$1", [
            next.communityId,
          ]);
        }
        if (!next.policy.remember_conversations)
          await query("DELETE FROM community_telegram_conversations WHERE community_id=$1", [
            next.communityId,
          ]);
        return next;
      });
    },
    async configureResult(communityId, epoch, error) {
      await db.query(
        `UPDATE community_telegram_integrations SET record=jsonb_set(jsonb_set(record,'{status}',to_jsonb($3::text)),'{lastError}',$4::jsonb),updated_at=clock_timestamp()
        WHERE community_id=$1 AND bot_epoch=$2 AND record->>'status' IN ('configuring','error')`,
        [communityId, epoch, error === null ? "ready" : "error", JSON.stringify(error)],
      );
    },
    async configuredCandidates() {
      const rows =
        await db.query(`SELECT i.record FROM community_telegram_integrations i JOIN communities c USING(community_id)
        WHERE c.status='active' AND i.record->>'status' IN ('configuring','error') AND i.bot_id IS NOT NULL ORDER BY i.updated_at LIMIT 20`);
      return rows.map((row) => row.record as IntegrationRecord);
    },
  };
}
