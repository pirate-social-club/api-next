import { TelegramFailure } from "@pirate/application/telegram";
import {
  emptyTelegramStudyState,
  TelegramStudyState,
  type TelegramStudyStore,
} from "@pirate/application/telegram-study";
import { Schema } from "effect";
import type { TelegramDatabase } from "./telegram-database.ts";
import { currentBot, lockLinkBot } from "./telegram-linking-context.ts";

export const TELEGRAM_STUDY_READY_SQL = `SELECT p.post_id,publication.title
FROM posts p JOIN communities c USING(community_id)
JOIN media_publication_projections publication USING(community_id,post_id)
JOIN media_post_submissions submission ON submission.submission_id=publication.submission_id
WHERE p.community_id=$1 AND p.post_id=ANY($2::text[])
  AND p.post_type='song' AND p.status='published' AND p.visibility='public'
  AND p.content_rating='general' AND c.status='active' AND publication.lyrics_status='ready'
  AND EXISTS(SELECT 1 FROM media_song_stems WHERE submission_id=publication.submission_id AND slot='instrumental_audio')
  AND EXISTS(SELECT 1 FROM media_song_stems WHERE submission_id=publication.submission_id AND slot='vocal_audio')
  AND (SELECT count(DISTINCT exercise.exercise_review_key)
    FROM study_exercise_versions exercise
    JOIN localization_lyrics_revision_lines membership
      ON membership.community_id=exercise.community_id AND membership.post_id=exercise.post_id
      AND membership.lyrics_revision=exercise.lyrics_revision AND membership.lyric_line_id=exercise.lyric_line_id
    JOIN study_language_profile_units unit
      ON unit.community_id=exercise.community_id AND unit.post_id=exercise.post_id
      AND unit.lyrics_revision=exercise.lyrics_revision AND unit.study_unit_id=exercise.study_unit_id
    WHERE exercise.community_id=p.community_id AND exercise.post_id=p.post_id
      AND exercise.audio_revision=submission.audio_revision
      AND exercise.lyrics_revision=submission.current_lyrics_revision
      AND exercise.retired_at IS NULL AND exercise.exercise_type='say_it_back'
      AND exercise.learning_language='en' AND exercise.learner_band IS NULL AND exercise.target_language IS NULL
      AND unit.language_profile_revision=(SELECT max(profile.language_profile_revision)
        FROM study_language_profiles profile WHERE profile.community_id=p.community_id
          AND profile.post_id=p.post_id AND profile.lyrics_revision=exercise.lyrics_revision)
      AND unit.dominant_language='en' AND unit.confidence>=0.8 AND NOT unit.vocable_only AND NOT unit.proper_name_only
  )>=4
  AND NOT EXISTS (
    SELECT 1 FROM study_exercise_versions exercise
    LEFT JOIN study_language_profile_units unit ON unit.community_id=exercise.community_id
      AND unit.post_id=exercise.post_id AND unit.lyrics_revision=exercise.lyrics_revision
      AND unit.study_unit_id=exercise.study_unit_id
      AND unit.language_profile_revision=(SELECT max(profile.language_profile_revision)
        FROM study_language_profiles profile WHERE profile.community_id=p.community_id
          AND profile.post_id=p.post_id AND profile.lyrics_revision=exercise.lyrics_revision)
    WHERE exercise.community_id=p.community_id AND exercise.post_id=p.post_id
      AND exercise.audio_revision=submission.audio_revision AND exercise.lyrics_revision=submission.current_lyrics_revision
      AND exercise.retired_at IS NULL AND exercise.exercise_type='say_it_back'
      AND exercise.learner_band IS NULL AND exercise.target_language IS NULL
      AND (exercise.learning_language<>'en' OR unit.dominant_language IS DISTINCT FROM 'en'
        OR unit.vocable_only OR unit.proper_name_only OR unit.confidence IS NULL OR unit.confidence<0.8)
  ) ORDER BY array_position($2::text[],p.post_id) LIMIT 8`;

export function makeTelegramStudyStore(
  db: TelegramDatabase,
  communityId: string,
  postIds: readonly string[],
): TelegramStudyStore {
  const catalogue = async (community: string) =>
    community !== communityId
      ? []
      : (await db.query(TELEGRAM_STUDY_READY_SQL, [community, postIds])).map((row) => ({
          postId: String(row.post_id),
          title: String(row.title ?? "Song"),
        }));
  return {
    catalogue,
    ready: async (community, postId) =>
      (await catalogue(community)).some((row) => row.postId === postId),
    claim: (sender, token) =>
      db.transaction(async (query) => {
        if (sender.communityId !== communityId) return null;
        const bot = await lockLinkBot(query, sender.communityId);
        currentBot({ bot_id: sender.botId, bot_epoch: sender.epoch }, bot);
        await query(
          `INSERT INTO telegram_study_conversations(community_id,bot_id,telegram_user_id,bot_epoch,state)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
          [
            sender.communityId,
            sender.botId,
            sender.telegramUserId,
            sender.epoch,
            JSON.stringify(emptyTelegramStudyState()),
          ],
        );
        const rows = await query(
          `SELECT state,bot_epoch,lease_until>clock_timestamp() AS busy
        FROM telegram_study_conversations WHERE community_id=$1 AND bot_id=$2 AND telegram_user_id=$3 FOR UPDATE`,
          [sender.communityId, sender.botId, sender.telegramUserId],
        );
        const row = rows[0];
        if (!row) throw new TelegramFailure({ reason: "unavailable" });
        if (row.busy === true && row.bot_epoch === sender.epoch) return null;
        let state = Schema.decodeUnknownSync(TelegramStudyState)(row.state);
        if (row.bot_epoch !== sender.epoch)
          state = {
            ...emptyTelegramStudyState(),
            sessionId: state.sessionId,
            grantRevision: state.grantRevision,
          };
        await query(
          `UPDATE telegram_study_conversations SET bot_epoch=$4,state=$5::jsonb,
        lease_token=$6,lease_until=clock_timestamp()+interval '120 seconds',revision=revision+1,updated_at=clock_timestamp()
        WHERE community_id=$1 AND bot_id=$2 AND telegram_user_id=$3`,
          [
            sender.communityId,
            sender.botId,
            sender.telegramUserId,
            sender.epoch,
            JSON.stringify(state),
            token,
          ],
        );
        return { sender, token, state };
      }),
    async save(lease, state) {
      Schema.decodeUnknownSync(TelegramStudyState)(state);
      const rows = await db.query(
        `UPDATE telegram_study_conversations SET state=$6::jsonb,revision=revision+1,updated_at=clock_timestamp()
        WHERE community_id=$1 AND bot_id=$2 AND telegram_user_id=$3 AND bot_epoch=$4
          AND lease_token=$5 AND lease_until>clock_timestamp() RETURNING revision`,
        [
          lease.sender.communityId,
          lease.sender.botId,
          lease.sender.telegramUserId,
          lease.sender.epoch,
          lease.token,
          JSON.stringify(state),
        ],
      );
      if (rows.length !== 1) throw new TelegramFailure({ reason: "conflict" });
    },
    async release(lease) {
      await db.query(
        `UPDATE telegram_study_conversations SET lease_token=NULL,lease_until=NULL
        WHERE community_id=$1 AND bot_id=$2 AND telegram_user_id=$3 AND bot_epoch=$4 AND lease_token=$5`,
        [
          lease.sender.communityId,
          lease.sender.botId,
          lease.sender.telegramUserId,
          lease.sender.epoch,
          lease.token,
        ],
      );
    },
    async promptMessageId(id) {
      const rows = await db.query(
        "SELECT message_id FROM community_telegram_deliveries WHERE delivery_id=$1 AND state='delivered'",
        [id],
      );
      const raw = rows[0]?.message_id;
      const value = typeof raw === "string" && /^[1-9][0-9]{0,15}$/u.test(raw) ? Number(raw) : raw;
      return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
    },
    cleanup: () => cleanupTelegramStudyConversations(db),
    async expired(id) {
      const rows = await db.query(
        "SELECT expires_at<=clock_timestamp() AND status='active' AS expired FROM study_sessions_v2 WHERE session_id=$1",
        [id],
      );
      return rows.length !== 1 || rows[0]?.expired === true;
    },
  };
}

/** Ordinary Telegram maintenance also runs this when practice is disabled. */
export async function cleanupTelegramStudyConversations(db: TelegramDatabase) {
  await db.query(
    `UPDATE telegram_study_conversations SET state=$1::jsonb,lease_token=NULL,lease_until=NULL
    WHERE (community_id,bot_id,telegram_user_id) IN (
      SELECT community_id,bot_id,telegram_user_id FROM telegram_study_conversations
      WHERE updated_at<clock_timestamp()-interval '24 hours'
        AND (lease_until IS NULL OR lease_until<clock_timestamp()) AND state<>$1::jsonb
      ORDER BY updated_at LIMIT 500 FOR UPDATE SKIP LOCKED
    )`,
    [JSON.stringify(emptyTelegramStudyState())],
  );
}
