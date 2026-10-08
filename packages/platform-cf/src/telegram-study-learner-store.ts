import type {
  TelegramStudyEnrollment,
  TelegramStudyGrant,
  TelegramStudyLease,
  TelegramStudySender,
} from "@pirate/application/telegram-study";
import type { TelegramDatabase } from "./telegram-database.ts";
import { currentBot, lockLinkBot } from "./telegram-linking-context.ts";

/** Spec 006 section 2.1: the only account-age assertion this path may record. */
const MINIMUM_AGE_ATTESTATION = ["minimum-age-attestation-v1", 16, true] as const;
const identifier = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const neutralLabel = () =>
  `Learner ${100000 + ((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 900000)}`;
const restricted = (accountId: string, personaId: string): TelegramStudyGrant => ({
  accountId,
  personaId,
  revision: 0,
  restricted: true,
});

export interface TelegramStudyLearnerStore {
  /** Reads the sender's existing practice identity for this community; never creates one. */
  resolve(sender: TelegramStudySender): Promise<TelegramStudyGrant | null>;
  enroll(lease: TelegramStudyLease, affirmed: boolean): Promise<TelegramStudyEnrollment>;
}

/**
 * Restricted Telegram practice identity (Specs 006, 014 and 026, phase one). One private
 * learner account per numeric Telegram user and one neutral study persona per community,
 * issued from authenticated bot ingress without sign-in, a wallet provider or profile data.
 *
 * A sender who already has an independently associated Pirate account, but no grant for
 * this bot, gets an isolated practice owner for this bot alone instead. Only the existence
 * of the association is consulted; the associated account is never read or written.
 */
export function makeTelegramStudyLearnerStore(
  db: TelegramDatabase,
  communityId: string,
): TelegramStudyLearnerStore {
  return {
    async resolve(sender) {
      if (sender.communityId !== communityId) return null;
      const rows = await db.query(
        `SELECT s.account_id,s.persona_id FROM telegram_restricted_learners l
        JOIN telegram_restricted_study_personas s USING(account_id)
        JOIN users u ON u.user_id=l.account_id JOIN personas p ON p.persona_id=s.persona_id
        JOIN persona_community_bindings b ON b.persona_id=s.persona_id
        JOIN communities c ON c.community_id=s.community_id
        JOIN community_telegram_integrations i ON i.community_id=s.community_id
        WHERE l.telegram_user_id=$3 AND s.community_id=$1 AND u.status='active' AND c.status='active'
          AND (l.local_bot_id IS NULL OR l.local_bot_id=$2)
          AND p.account_id=s.account_id AND p.status='active'
          AND b.account_id=s.account_id AND b.community_id=s.community_id
          AND i.record->>'status'='ready' AND i.record->>'botId'=$2 AND i.record->>'botEpoch'=$4
          AND EXISTS(SELECT 1 FROM community_telegram_private_chats started WHERE started.community_id=$1
            AND started.bot_epoch=$4 AND started.telegram_user_id=$3)
        ORDER BY l.local_bot_id NULLS FIRST LIMIT 1`,
        [sender.communityId, sender.botId, sender.telegramUserId, sender.epoch],
      );
      const row = rows[0];
      return row ? restricted(String(row.account_id), String(row.persona_id)) : null;
    },
    enroll: (lease, affirmed) =>
      db.transaction(async (query) => {
        const sender = lease.sender;
        if (sender.communityId !== communityId) return "unavailable";
        // Match reconnect and revoke lock ordering: community, then integration.
        const bot = await lockLinkBot(query, sender.communityId);
        currentBot({ bot_id: sender.botId, bot_epoch: sender.epoch }, bot);
        // Only the current private-chat sender holding this conversation may enroll.
        const chat = await query(
          `SELECT 1 FROM telegram_study_conversations chat
          WHERE chat.community_id=$1 AND chat.bot_id=$2 AND chat.telegram_user_id=$3 AND chat.bot_epoch=$4
            AND chat.lease_token=$5 AND chat.lease_until>clock_timestamp()
            AND EXISTS(SELECT 1 FROM community_telegram_private_chats started WHERE started.community_id=$1
              AND started.bot_epoch=$4 AND started.telegram_user_id=$3)
          FOR SHARE OF chat`,
          [sender.communityId, sender.botId, sender.telegramUserId, sender.epoch, lease.token],
        );
        if (!chat.length) return "unavailable";
        // Concurrent first use from any bot converges on one reservation.
        await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 26000014))", [
          sender.telegramUserId,
        ]);
        // Whatever identity this sender already uses here is kept, so progress resumes even
        // if an account is linked or unlinked later. It is never replaced by a sibling.
        const existing = await query(
          `SELECT s.account_id,s.persona_id,p.status='active' AND u.status='active' AS usable
          FROM telegram_restricted_learners l JOIN telegram_restricted_study_personas s USING(account_id)
          JOIN personas p USING(persona_id) JOIN users u ON u.user_id=l.account_id
          WHERE l.telegram_user_id=$1 AND s.community_id=$2
            AND (l.local_bot_id IS NULL OR l.local_bot_id=$3)
          ORDER BY l.local_bot_id NULLS FIRST LIMIT 1`,
          [sender.telegramUserId, sender.communityId, sender.botId],
        );
        if (existing[0])
          return existing[0].usable === true
            ? restricted(String(existing[0].account_id), String(existing[0].persona_id))
            : "unavailable";
        // Every sender answers the age question once per community, so the question never
        // tells a bot owner whether an account or an association already exists.
        if (!affirmed) return "age_required";
        // An associated account must not gain a second promotable account. Its sender gets
        // an isolated owner for this bot.
        const associated = await query(
          "SELECT 1 FROM telegram_account_associations WHERE telegram_user_id=$1",
          [sender.telegramUserId],
        );
        const localBotId = associated.length ? sender.botId : null;
        const learners = await query(
          `SELECT l.account_id,u.status FROM telegram_restricted_learners l
          JOIN users u ON u.user_id=l.account_id
          WHERE l.telegram_user_id=$1 AND l.local_bot_id IS NOT DISTINCT FROM $2 FOR UPDATE OF u`,
          [sender.telegramUserId, localBotId],
        );
        let accountId: string;
        if (learners[0]) {
          if (learners[0].status !== "active") return "unavailable";
          accountId = String(learners[0].account_id);
        } else {
          accountId = identifier("usr");
          // The account row provisions its reserved first persona; no handle or credential exists.
          await query("INSERT INTO users(user_id,status) VALUES($1,'active')", [accountId]);
          await query(
            `INSERT INTO account_minimum_age_attestations(account_id,version,minimum_age,affirmed)
            VALUES($1,$2,$3,$4)`,
            [accountId, ...MINIMUM_AGE_ATTESTATION],
          );
          await query(
            `INSERT INTO telegram_restricted_learners(
              account_id,telegram_user_id,local_bot_id,affirmed_community_id,affirmed_bot_id,affirmed_bot_epoch)
            VALUES($1,$2,$3,$4,$5,$6)`,
            [
              accountId,
              sender.telegramUserId,
              localBotId,
              sender.communityId,
              sender.botId,
              sender.epoch,
            ],
          );
        }
        // The ordinary persona limits: ten lifetime slots, three additional per rolling day.
        const capacity = await query(
          `SELECT count(*)::integer AS slots,
            (count(*) FILTER (WHERE NOT persona.is_first_persona
              AND assignment.created_at>clock_timestamp()-interval '24 hours'))::integer AS recent,
            (COALESCE(max(assignment.hd_wallet_index),-1)+1)::text AS next_index
          FROM persona_wallet_assignments assignment JOIN personas persona USING(persona_id)
          WHERE assignment.account_id=$1 AND assignment.chain_account_kind='evm'`,
          [accountId],
        );
        const index = Number(capacity[0]?.next_index);
        if (
          Number(capacity[0]?.slots) >= 10 ||
          Number(capacity[0]?.recent) >= 3 ||
          !Number.isSafeInteger(index) ||
          index < 0
        )
          return "unavailable";
        const personaId = identifier("persona");
        await query(
          "INSERT INTO personas(persona_id,account_id,status,is_first_persona) VALUES($1,$2,'active',false)",
          [personaId, accountId],
        );
        // A neutral pseudonym; no Telegram profile data is copied.
        await query(
          "INSERT INTO persona_profiles(persona_id,revision,display_name) VALUES($1,1,$2)",
          [personaId, neutralLabel()],
        );
        // Reserves the ordinary wallet slot for later promotion; no provider is called.
        await query(
          `INSERT INTO persona_wallet_assignments(
            assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,reservation_idempotency_key)
          VALUES($1,$2,$3,'evm',$4,'pending',$5)`,
          [
            identifier("persona_wallet"),
            personaId,
            accountId,
            index,
            `telegram-study-${personaId}`,
          ],
        );
        await query(
          `INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source)
          VALUES($1,$2,$3,'activity_participation')`,
          [personaId, accountId, sender.communityId],
        );
        await query(
          "INSERT INTO telegram_restricted_study_personas(account_id,community_id,persona_id) VALUES($1,$2,$3)",
          [accountId, sender.communityId, personaId],
        );
        return restricted(accountId, personaId);
      }),
  };
}
