import type { TelegramStudyCataloguePage } from "@pirate/application/telegram-study";
import type { TelegramDatabase } from "./telegram-database.ts";
import { TelegramSetupFailure } from "./telegram-setup-diagnostics.ts";
import { TELEGRAM_STUDY_READY_BASE_SQL } from "./telegram-study-store.ts";

export async function assertTelegramCommunityCataloguePrivileges(db: TelegramDatabase) {
  const rows = await db
    .query(`SELECT current_user::text AS runtime_role,
    has_schema_privilege(current_user,n.oid,'USAGE') AS schema_usage,
    pg_has_role(current_user,c.relowner,'USAGE') AS owner_equivalent,
    has_table_privilege(current_user,c.oid,'SELECT') AS can_select,
    has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
    has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,
    has_table_privilege(current_user,c.oid,'DELETE') AS can_delete,
    has_table_privilege(current_user,c.oid,'TRUNCATE') AS can_truncate
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='api_next' AND c.relname='study_learner_catalogue_decisions' AND c.relkind='r'`)
    .catch(() => {
      throw new TelegramSetupFailure(
        "query_failed",
        "Telegram catalogue permission query unavailable",
      );
    });
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    typeof row.runtime_role !== "string" ||
    !row.runtime_role ||
    row.schema_usage !== true ||
    row.owner_equivalent !== false ||
    row.can_select !== true ||
    row.can_insert !== false ||
    row.can_update !== false ||
    row.can_delete !== false ||
    row.can_truncate !== false
  )
    throw new TelegramSetupFailure(
      "permission_refused",
      "Telegram catalogue requires a read-only serving role",
    );
}

/** Corpus readiness alone never authorizes learner exposure. The latest decision wins,
 * including a denial or a stale approval; an older approval cannot become a fallback. */
export const TELEGRAM_COMMUNITY_STUDY_READY_SQL = `${TELEGRAM_STUDY_READY_BASE_SQL}
  AND EXISTS (
    SELECT 1 FROM study_learner_catalogue_decisions decision
    WHERE decision.community_id=p.community_id AND decision.post_id=p.post_id
      AND decision.decision_revision=(SELECT max(latest.decision_revision)
        FROM study_learner_catalogue_decisions latest
        WHERE latest.community_id=p.community_id AND latest.post_id=p.post_id)
      AND decision.disposition='eligible' AND decision.policy_revision=$3
      AND decision.audio_revision=submission.audio_revision
      AND decision.lyrics_revision=submission.current_lyrics_revision
      AND decision.content_rating=p.content_rating AND decision.learner_band IS NULL
      AND decision.learning_language='en' AND decision.exercise_type='say_it_back'
      AND decision.language_profile_revision=(SELECT max(profile.language_profile_revision)
        FROM study_language_profiles profile WHERE profile.community_id=p.community_id
          AND profile.post_id=p.post_id AND profile.lyrics_revision=submission.current_lyrics_revision)
      AND decision.effective_at<=clock_timestamp()
  ) AND ($4::text IS NULL OR p.post_id COLLATE "C">$4 COLLATE "C")
    AND ($5::text IS NULL OR p.post_id=$5)
  ORDER BY p.post_id COLLATE "C" LIMIT 9`;

export function makeTelegramCommunityStudyCatalogue(db: TelegramDatabase, policyRevision: string) {
  return {
    async page(communityId: string, after?: string): Promise<TelegramStudyCataloguePage> {
      const rows = await db.query(TELEGRAM_COMMUNITY_STUDY_READY_SQL, [
        communityId,
        null,
        policyRevision,
        after ?? null,
        null,
      ]);
      const items = rows
        .slice(0, 8)
        .map((row) => ({ postId: String(row.post_id), title: String(row.title ?? "Song") }));
      return { items, nextCursor: rows.length > 8 ? (items.at(-1)?.postId ?? null) : null };
    },
    async ready(communityId: string, postId: string): Promise<boolean> {
      return (
        (
          await db.query(TELEGRAM_COMMUNITY_STUDY_READY_SQL, [
            communityId,
            null,
            policyRevision,
            null,
            postId,
          ])
        ).length === 1
      );
    },
  };
}
