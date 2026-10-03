import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import type { TelegramLinkStore } from "@pirate/application/telegram-linking";
import { TelegramLinkGrant } from "@pirate/contracts";
import { type Layer, Schema } from "effect";
import { makeTelegramDatabase, type TelegramQuery } from "./telegram-database.ts";
import {
  currentBot,
  lockAccount,
  lockLinkBot,
  lockLinkTransaction,
  refused,
  transactionView,
} from "./telegram-linking-context.ts";

const grantView = (row: Record<string, unknown>) =>
  Schema.decodeUnknownSync(TelegramLinkGrant)({ ...row, revision: Number(row.revision) });
export function makeControlPlaneTelegramLinkStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): TelegramLinkStore {
  const db = makeTelegramDatabase(runtime);
  const cancelPending = (query: TelegramQuery, accountId: string, communityId?: string) =>
    query(
      `UPDATE telegram_link_transactions SET state='cancelled',state_hash=NULL,secret_ciphertext=NULL
      WHERE account_id=$1 AND ($2::text IS NULL OR community_id=$2)
        AND state IN ('pending','exchanging','verified')`,
      [accountId, communityId ?? null],
    );
  return {
    async list(accountId) {
      const identities = await db.query(
        `SELECT a.telegram_user_id FROM telegram_account_associations a
        JOIN users u ON u.user_id=a.account_id WHERE a.account_id=$1 AND u.status='active' ORDER BY a.telegram_user_id`,
        [accountId],
      );
      const grants = await db.query(
        `SELECT g.* FROM telegram_bot_grants g JOIN telegram_account_associations a USING(telegram_user_id)
        JOIN users u ON u.user_id=g.account_id WHERE g.account_id=$1 AND a.account_id=$1 AND u.status='active' AND g.active
        ORDER BY g.community_id,g.bot_id,g.telegram_user_id`,
        [accountId],
      );
      return {
        telegram_user_ids: identities.map((row) => String(row.telegram_user_id)),
        grants: grants.map(grantView),
      };
    },
    createNavigation: (input) =>
      db.transaction(async (query) => {
        const integration = await lockLinkBot(query, input.communityId);
        currentBot({ bot_id: input.botId, bot_epoch: input.epoch }, integration);
        const content = await query(
          `SELECT 1 FROM posts WHERE community_id=$1 AND post_id=$2
        AND post_type='song' AND status='published' AND visibility='public'`,
          [input.communityId, input.postId],
        );
        if (!content.length) refused("not_found");
        // Only a private-chat sender may mint navigation after current /start.
        const started = await query(
          `SELECT 1 FROM community_telegram_private_chats
        WHERE community_id=$1 AND bot_epoch=$2 AND telegram_user_id=$3`,
          [input.communityId, input.epoch, input.telegramUserId],
        );
        if (!started.length) refused("unauthorized");
        await query(
          `INSERT INTO telegram_link_navigation(reference_hash,community_id,bot_id,bot_epoch,telegram_user_id,post_id)
        VALUES($1,$2,$3,$4,$5,$6)`,
          [
            input.referenceHash,
            input.communityId,
            input.botId,
            input.epoch,
            input.telegramUserId,
            input.postId,
          ],
        );
      }),
    start: (input) =>
      db.transaction(async (query) => {
        const navigation = await query(
          "SELECT * FROM telegram_link_navigation WHERE reference_hash=$1",
          [input.navigationHash],
        );
        if (!navigation[0]) refused("not_found");
        const bot = await lockLinkBot(query, String(navigation[0].community_id));
        await lockAccount(query, input.browser.accountId);
        const selected = await query(
          `SELECT *,expires_at>clock_timestamp() AS valid FROM telegram_link_navigation
        WHERE reference_hash=$1 FOR UPDATE`,
          [input.navigationHash],
        );
        const nav = selected[0];
        if (nav?.valid !== true || nav.cancelled !== false) refused();
        currentBot(nav, bot);
        const counts = await query(
          `SELECT count(*)::integer AS count FROM telegram_link_transactions
        WHERE account_id=$1 AND expires_at>clock_timestamp() AND state IN ('pending','exchanging','verified')`,
          [input.browser.accountId],
        );
        if (Number(counts[0]?.count) >= 3) refused("rate_limited");
        const rows = await query(
          `INSERT INTO telegram_link_transactions(
        transaction_id,account_id,session_hash,browser_hash,state_hash,secret_ciphertext,
        community_id,bot_id,bot_epoch,expected_telegram_user_id,post_id,state,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',
          LEAST(clock_timestamp()+INTERVAL '10 minutes',$12::timestamptz)) RETURNING *`,
          [
            input.id,
            input.browser.accountId,
            input.browser.sessionHash,
            input.browser.browserHash,
            input.stateHash,
            input.secretCiphertext,
            nav.community_id,
            nav.bot_id,
            nav.bot_epoch,
            nav.telegram_user_id,
            nav.post_id,
            nav.expires_at,
          ],
        );
        if (!rows[0]) refused("unavailable");
        return transactionView(query, rows[0]);
      }),
    async get(id, browser) {
      const rows = await db.query(
        `SELECT t.* FROM telegram_link_transactions t
        JOIN communities c USING(community_id) JOIN community_telegram_integrations i USING(community_id)
        JOIN users u ON u.user_id=t.account_id
        WHERE t.transaction_id=$1 AND t.account_id=$2 AND t.session_hash=$3 AND t.browser_hash=$4
          AND t.expires_at>clock_timestamp() AND c.status='active' AND u.status='active'
          AND i.record->>'status'='ready' AND i.record->>'botId'=t.bot_id AND i.record->>'botEpoch'=t.bot_epoch`,
        [id, browser.accountId, browser.sessionHash, browser.browserHash],
      );
      if (!rows[0]) refused("not_found");
      return transactionView(db.query, rows[0]);
    },
    claim: (id, browser, stateHash) =>
      db.transaction(async (query) => {
        const row = await lockLinkTransaction(query, id, browser);
        if (row.state !== "pending" || row.state_hash !== stateHash) refused();
        await query(
          "UPDATE telegram_link_transactions SET state='exchanging' WHERE transaction_id=$1",
          [id],
        );
        return String(row.secret_ciphertext);
      }),
    verified: (id, browser, telegramUserId) =>
      db.transaction(async (query) => {
        const row = await lockLinkTransaction(query, id, browser);
        if (row.state !== "exchanging" || row.expected_telegram_user_id !== telegramUserId)
          refused();
        const rows = await query(
          `UPDATE telegram_link_transactions SET state='verified',telegram_user_id=$2,
        state_hash=NULL,secret_ciphertext=NULL WHERE transaction_id=$1 RETURNING *`,
          [id, telegramUserId],
        );
        if (!rows[0]) refused("unavailable");
        return transactionView(query, rows[0]);
      }),
    async fail(id, browser) {
      await db.query(
        `UPDATE telegram_link_transactions SET state='failed',state_hash=NULL,secret_ciphertext=NULL
        WHERE transaction_id=$1 AND account_id=$2 AND session_hash=$3 AND browser_hash=$4 AND state='exchanging'`,
        [id, browser.accountId, browser.sessionHash, browser.browserHash],
      );
    },
    confirm: (id, browser, personaId) =>
      db.transaction(async (query) => {
        const row = await lockLinkTransaction(query, id, browser);
        const owned = await query(
          `SELECT p.persona_id FROM personas p JOIN persona_community_bindings b USING(persona_id)
        WHERE p.persona_id=$1 AND p.account_id=$2 AND p.status='active'
          AND b.account_id=$2 AND b.community_id=$3 FOR SHARE OF p,b`,
          [personaId, browser.accountId, row.community_id],
        );
        if (!owned.length) refused("unauthorized");
        if (row.state === "completed") {
          const replay = await query(
            `SELECT * FROM telegram_bot_grants WHERE community_id=$1 AND bot_id=$2
          AND telegram_user_id=$3 AND account_id=$4 AND persona_id=$5 AND revision=$6 AND active FOR SHARE`,
            [
              row.community_id,
              row.bot_id,
              row.telegram_user_id,
              browser.accountId,
              personaId,
              row.grant_revision,
            ],
          );
          if (!replay[0]) refused();
          return grantView(replay[0]);
        }
        if (row.state !== "verified") refused();
        await query(
          `INSERT INTO telegram_account_associations(telegram_user_id,account_id) VALUES($1,$2)
        ON CONFLICT DO NOTHING`,
          [row.telegram_user_id, browser.accountId],
        );
        const association = await query(
          `SELECT account_id FROM telegram_account_associations
        WHERE telegram_user_id=$1 FOR UPDATE`,
          [row.telegram_user_id],
        );
        if (association[0]?.account_id !== browser.accountId) refused();
        // A newly confirmed persona replaces this bot's previous consent with a new revision.
        const grants = await query(
          `INSERT INTO telegram_bot_grants(community_id,bot_id,telegram_user_id,account_id,persona_id,revision)
        VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(community_id,bot_id,telegram_user_id) DO UPDATE SET
          account_id=EXCLUDED.account_id,persona_id=EXCLUDED.persona_id,revision=telegram_bot_grants.revision+1,active=TRUE,consented_at=clock_timestamp()
        WHERE NOT telegram_bot_grants.active OR telegram_bot_grants.account_id=EXCLUDED.account_id RETURNING *`,
          [row.community_id, row.bot_id, row.telegram_user_id, browser.accountId, personaId],
        );
        if (!grants[0]) refused();
        await query(
          `UPDATE telegram_link_transactions SET state='completed',grant_revision=$2 WHERE transaction_id=$1`,
          [id, grants[0].revision],
        );
        // Fence other outstanding consent operations so older verifications cannot replace this choice.
        await query(
          `UPDATE telegram_link_transactions SET state='cancelled',state_hash=NULL,secret_ciphertext=NULL
        WHERE account_id=$1 AND community_id=$2 AND bot_id=$3 AND transaction_id<>$4
          AND state IN ('pending','exchanging','verified')`,
          [browser.accountId, row.community_id, row.bot_id, id],
        );
        return grantView(grants[0]);
      }),
    revoke: (browser, communityId, botId) =>
      db.transaction(async (query) => {
        await lockAccount(query, browser.accountId);
        await query(
          `UPDATE telegram_bot_grants SET active=FALSE,revision=revision+1
        WHERE account_id=$1 AND community_id=$2 AND bot_id=$3 AND active`,
          [browser.accountId, communityId, botId],
        );
        await cancelPending(query, browser.accountId, communityId);
      }),
    unlink: (browser, telegramUserId) =>
      db.transaction(async (query) => {
        await lockAccount(query, browser.accountId);
        const association = await query(
          "SELECT account_id FROM telegram_account_associations WHERE telegram_user_id=$1 FOR UPDATE",
          [telegramUserId],
        );
        if (association[0] && association[0].account_id !== browser.accountId) refused("not_found");
        // Retain the consent revision fence so unlink/relink cannot recreate an old grant revision.
        await query(
          "UPDATE telegram_bot_grants SET active=FALSE,revision=revision+1 WHERE account_id=$1 AND telegram_user_id=$2 AND active",
          [browser.accountId, telegramUserId],
        );
        await cancelPending(query, browser.accountId);
        await query(
          "DELETE FROM telegram_account_associations WHERE account_id=$1 AND telegram_user_id=$2",
          [browser.accountId, telegramUserId],
        );
      }),
    async resolveGrant(communityId, botId, epoch, telegramUserId) {
      const rows = await db.query(
        `SELECT g.account_id,g.persona_id,g.revision FROM telegram_bot_grants g
        JOIN telegram_account_associations a USING(telegram_user_id) JOIN users u ON u.user_id=g.account_id
        JOIN communities c USING(community_id) JOIN community_telegram_integrations i USING(community_id)
        JOIN personas p USING(persona_id) JOIN persona_community_bindings b USING(persona_id)
        WHERE g.community_id=$1 AND g.bot_id=$2 AND g.telegram_user_id=$3 AND g.active
          AND a.account_id=g.account_id AND u.status='active' AND c.status='active'
          AND p.account_id=g.account_id AND p.status='active' AND b.account_id=g.account_id AND b.community_id=g.community_id
          AND i.record->>'status'='ready' AND i.record->>'botId'=g.bot_id AND i.record->>'botEpoch'=$4
          AND EXISTS(SELECT 1 FROM community_telegram_private_chats s WHERE s.community_id=$1
            AND s.bot_epoch=$4 AND s.telegram_user_id=$3)`,
        [communityId, botId, telegramUserId, epoch],
      );
      if (!rows[0]) return null;
      return {
        accountId: String(rows[0].account_id),
        personaId: String(rows[0].persona_id),
        revision: Number(rows[0].revision),
      };
    },
    async cleanup() {
      await db.query(`DELETE FROM telegram_link_transactions WHERE transaction_id IN
        (SELECT transaction_id FROM telegram_link_transactions WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 500)`);
      await db.query(`DELETE FROM telegram_link_navigation WHERE reference_hash IN
        (SELECT reference_hash FROM telegram_link_navigation WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 500)`);
    },
  };
}
