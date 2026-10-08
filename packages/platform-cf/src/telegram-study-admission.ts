import { type ControlPlaneTransaction, StudyV2CommandRejected } from "@pirate/application";
import {
  type TelegramStudyGrant,
  type TelegramStudyLease,
  TelegramStudyLeaseExpired,
} from "@pirate/application/telegram-study";
import { Effect } from "effect";
import type { StudyV2Admission } from "./study-v2-repository.ts";
import { TELEGRAM_STUDY_READY_SQL } from "./telegram-study-store.ts";

/** The restricted practice identity: bot ingress evidence, never a linked-account grant. */
const RESTRICTED_ACCEPTANCE_SQL = `
  SELECT chat.lease_until>clock_timestamp() AS lease_valid FROM telegram_restricted_study_personas s
  JOIN telegram_restricted_learners l USING(account_id)
  JOIN users u ON u.user_id=s.account_id
  JOIN communities c ON c.community_id=s.community_id
  JOIN community_telegram_integrations i ON i.community_id=s.community_id
  JOIN personas p ON p.persona_id=s.persona_id
  JOIN persona_community_bindings b ON b.persona_id=s.persona_id
  JOIN telegram_study_conversations chat ON chat.community_id=s.community_id
    AND chat.bot_id=$2 AND chat.telegram_user_id=l.telegram_user_id
  WHERE s.community_id=$1 AND l.telegram_user_id=$3 AND s.account_id=$4 AND s.persona_id=$5
    AND u.status='active' AND c.status='active'
    AND p.account_id=s.account_id AND p.status='active'
    AND b.account_id=s.account_id AND b.community_id=s.community_id
    AND i.record->>'status'='ready' AND i.record->>'botId'=$2
    AND i.record->>'botEpoch'=$6 AND chat.bot_epoch=$6
    AND chat.lease_token=$7
    AND EXISTS (SELECT 1 FROM community_telegram_private_chats started
      WHERE started.community_id=$1 AND started.bot_epoch=$6 AND started.telegram_user_id=$3)
  FOR SHARE OF s,l,p,b,chat`;

export function telegramStudyAdmission(
  lease: TelegramStudyLease,
  grant: TelegramStudyGrant,
  postIds: readonly string[],
): StudyV2Admission {
  const sender = lease.sender;
  return {
    practiceOnly: true,
    authorize: (transaction: ControlPlaneTransaction, input) =>
      Effect.gen(function* () {
        const refuse = () => new StudyV2CommandRejected({ reason: "not-found" });
        if (
          input.accountId !== grant.accountId ||
          (input.communityId !== undefined && input.communityId !== sender.communityId) ||
          (input.personaId !== undefined && input.personaId !== grant.personaId)
        )
          return yield* refuse();
        // Match reconnect and revoke lock ordering; hold consent through acceptance.
        yield* transaction.execute({
          label: "telegram-study.community-lock",
          text: "SELECT community_id FROM communities WHERE community_id=$1 AND status='active' FOR SHARE",
          values: [sender.communityId],
          readonly: false,
        });
        yield* transaction.execute({
          label: "telegram-study.bot-lock",
          text: "SELECT community_id FROM community_telegram_integrations WHERE community_id=$1 FOR SHARE",
          values: [sender.communityId],
          readonly: false,
        });
        yield* transaction.execute({
          label: "telegram-study.account-lock",
          text: "SELECT user_id FROM users WHERE user_id=$1 AND status='active' FOR SHARE",
          values: [grant.accountId],
          readonly: false,
        });
        const authority = yield* transaction.execute<{ readonly lease_valid: boolean }>(
          grant.restricted
            ? {
                label: "telegram-study.restricted-acceptance",
                text: RESTRICTED_ACCEPTANCE_SQL,
                values: [
                  sender.communityId,
                  sender.botId,
                  sender.telegramUserId,
                  grant.accountId,
                  grant.personaId,
                  sender.epoch,
                  lease.token,
                ],
                readonly: false,
              }
            : {
                label: "telegram-study.acceptance",
                text: `
        SELECT g.revision, chat.lease_until>clock_timestamp() AS lease_valid FROM telegram_bot_grants g
        JOIN telegram_account_associations a USING(telegram_user_id)
        JOIN users u ON u.user_id=g.account_id
        JOIN communities c USING(community_id)
        JOIN community_telegram_integrations i USING(community_id)
        JOIN personas p USING(persona_id)
        JOIN persona_community_bindings b USING(persona_id)
        JOIN telegram_study_conversations chat ON chat.community_id=g.community_id
          AND chat.bot_id=g.bot_id AND chat.telegram_user_id=g.telegram_user_id
        WHERE g.community_id=$1 AND g.bot_id=$2 AND g.telegram_user_id=$3
          AND g.account_id=$4 AND g.persona_id=$5 AND g.revision=$6 AND g.active
          AND a.account_id=g.account_id AND u.status='active' AND c.status='active'
          AND p.account_id=g.account_id AND p.status='active'
          AND b.account_id=g.account_id AND b.community_id=g.community_id
          AND i.record->>'status'='ready' AND i.record->>'botId'=g.bot_id
          AND i.record->>'botEpoch'=$7 AND chat.bot_epoch=$7
          AND chat.lease_token=$8
          AND EXISTS (SELECT 1 FROM community_telegram_private_chats started
            WHERE started.community_id=$1 AND started.bot_epoch=$7 AND started.telegram_user_id=$3)
        FOR SHARE OF g,a,p,b,chat`,
                values: [
                  sender.communityId,
                  sender.botId,
                  sender.telegramUserId,
                  grant.accountId,
                  grant.personaId,
                  grant.revision,
                  sender.epoch,
                  lease.token,
                ],
                readonly: false,
              },
        );
        if (authority.rows.length !== 1) return yield* refuse();
        if (authority.rows[0]?.lease_valid !== true) return yield* new TelegramStudyLeaseExpired();
        if (input.personaId !== undefined) {
          if (!input.postId || !postIds.includes(input.postId)) return yield* refuse();
          const ready = yield* transaction.execute({
            label: "telegram-study.ready-at-acceptance",
            text: `${TELEGRAM_STUDY_READY_SQL} FOR SHARE OF p,publication,submission`,
            values: [sender.communityId, [input.postId]],
            readonly: false,
          });
          if (ready.rows.length !== 1) return yield* refuse();
        }
        if (input.personaId === undefined) {
          const session = yield* transaction.execute({
            label: "telegram-study.session-binding",
            text: `
          SELECT session_id FROM study_sessions_v2 WHERE session_id=$1 AND account_id=$2
            AND persona_id=$3 AND community_id=$4 AND telegram_practice_only
            AND (status='completed' OR expires_at>clock_timestamp()) FOR SHARE`,
            values: [input.sessionId, grant.accountId, grant.personaId, sender.communityId],
            readonly: false,
          });
          if (session.rows.length !== 1) return yield* refuse();
        }
      }),
  };
}
