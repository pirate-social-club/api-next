import { TelegramFailure, type TelegramStore, telegramLocale } from "@pirate/application/telegram";
import type { TelegramDatabase } from "./telegram-database.ts";

export function makeTelegramLanguageStore(
  db: TelegramDatabase,
): Pick<TelegramStore, "learnerLanguageContext" | "saveLearnerLanguage"> {
  return {
    async learnerLanguageContext(sender) {
      const rows = await db.query(
        `SELECT c.display_name, p.locale, p.explicit, a.ui_locale, a.study_helper_language,
          EXISTS(SELECT 1 FROM telegram_study_conversations t
            JOIN study_sessions_v2 s ON s.session_id=t.state->>'sessionId'
            WHERE t.community_id=i.community_id AND t.bot_id=i.bot_id AND t.telegram_user_id=$3
              AND t.bot_epoch=i.bot_epoch AND (t.state->>'grantRevision')::bigint=g.revision
              AND s.account_id=g.account_id AND s.persona_id=g.persona_id
              AND persona.persona_id IS NOT NULL AND binding.persona_id IS NOT NULL
              AND s.status='active' AND s.expires_at>clock_timestamp())
          -- A restricted practice identity resumes without any linked-account grant.
          OR (g.revision IS NULL AND EXISTS(SELECT 1 FROM telegram_study_conversations t
            JOIN study_sessions_v2 s ON s.session_id=t.state->>'sessionId'
            JOIN telegram_restricted_learners l ON l.telegram_user_id=t.telegram_user_id AND l.account_id=s.account_id
              AND (l.local_bot_id IS NULL OR l.local_bot_id=t.bot_id)
            JOIN telegram_restricted_study_personas r ON r.account_id=s.account_id
              AND r.community_id=t.community_id AND r.persona_id=s.persona_id
            JOIN users learner ON learner.user_id=l.account_id AND learner.status='active'
            WHERE t.community_id=i.community_id AND t.bot_id=i.bot_id AND t.telegram_user_id=$3
              AND t.bot_epoch=i.bot_epoch AND (t.state->>'grantRevision')::bigint=0
              AND s.status='active' AND s.expires_at>clock_timestamp())) AS resume_available
         FROM community_telegram_integrations i JOIN communities c USING(community_id)
         LEFT JOIN telegram_interface_preferences p ON p.community_id=i.community_id AND p.bot_id=i.bot_id AND p.telegram_user_id=$3
         LEFT JOIN telegram_bot_grants g ON g.community_id=i.community_id AND g.bot_id=i.bot_id AND g.telegram_user_id=$3 AND g.active
         LEFT JOIN telegram_account_associations identity ON identity.telegram_user_id=g.telegram_user_id AND identity.account_id=g.account_id
         LEFT JOIN users u ON u.user_id=identity.account_id AND u.status='active'
         LEFT JOIN personas persona ON persona.persona_id=g.persona_id AND persona.account_id=u.user_id AND persona.status='active'
         LEFT JOIN persona_community_bindings binding ON binding.persona_id=persona.persona_id AND binding.account_id=u.user_id AND binding.community_id=i.community_id
         LEFT JOIN account_language_preferences a ON a.account_id=u.user_id AND binding.persona_id IS NOT NULL
         WHERE i.community_id=$1 AND i.bot_id=$2 AND i.bot_epoch=$4 AND c.status='active'`,
        [sender.communityId, sender.botId, sender.telegramUserId, sender.epoch],
      );
      const row = rows[0];
      if (!row) throw new TelegramFailure({ reason: "unavailable" });
      const locale = telegramLocale(row.locale);
      return {
        preference: locale === null ? null : { locale, explicit: row.explicit === true },
        accountLocale: typeof row.ui_locale === "string" ? row.ui_locale : null,
        helperLanguage:
          typeof row.study_helper_language === "string" ? row.study_helper_language : null,
        communityName: String(row.display_name).slice(0, 200),
        resumeAvailable: row.resume_available === true,
      };
    },
    async saveLearnerLanguage(sender, inboxId, locale, explicit) {
      await db.transaction(async (query) => {
        const current = await query(
          "SELECT 1 FROM community_telegram_integrations WHERE community_id=$1 AND bot_id=$2 AND bot_epoch=$3 FOR UPDATE",
          [sender.communityId, sender.botId, sender.epoch],
        );
        if (!current.length) throw new TelegramFailure({ reason: "unavailable" });
        await query(
          `INSERT INTO telegram_interface_preferences AS preference (community_id,bot_id,telegram_user_id,locale,explicit,received_at)
           SELECT $1,$2,$4,$6,$7,created_at FROM community_telegram_inbox
             WHERE inbox_id=$5 AND community_id=$1 AND bot_epoch=$3
           ON CONFLICT(community_id,bot_id,telegram_user_id) DO UPDATE
             SET locale=EXCLUDED.locale,explicit=EXCLUDED.explicit,received_at=EXCLUDED.received_at
           WHERE (EXCLUDED.explicit AND NOT preference.explicit)
             OR (EXCLUDED.explicit=preference.explicit AND EXCLUDED.received_at>=preference.received_at)`,
          [
            sender.communityId,
            sender.botId,
            sender.epoch,
            sender.telegramUserId,
            inboxId,
            locale,
            explicit,
          ],
        );
      });
    },
  };
}
