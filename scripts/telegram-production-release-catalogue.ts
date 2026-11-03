import type pg from "pg";
import { TELEGRAM_STUDY_READY_BASE_SQL } from "../packages/platform-cf/src/telegram-study-store.ts";
import { sha256 } from "./public-post-http-release-core.ts";
import { type TelegramFile, telegramJson } from "./telegram-production-release-admission.ts";
import {
  TELEGRAM_RELEASE as policy,
  requireTelegram,
} from "./telegram-production-release-policy.ts";

interface CatalogueAcceptance {
  readonly kind: "telegram-production-song-policy-acceptance-v1";
  readonly accepted: true;
  readonly actor_role: "workspace_owner";
  readonly community: typeof policy.canary.community;
  readonly post: typeof policy.canary.post;
  readonly policy: typeof policy.canary.policy;
  readonly learner_band: null;
  readonly helper_translation: false;
  readonly corpus_sha256: string;
  readonly lyrics_sha256: typeof policy.canary.lyricsSha256;
  readonly audio_sha256: typeof policy.canary.audioSha256;
}
export function catalogueAcceptance(file: TelegramFile) {
  const value = telegramJson<CatalogueAcceptance>(file);
  requireTelegram(
    value.kind === "telegram-production-song-policy-acceptance-v1" &&
      value.accepted === true &&
      value.actor_role === "workspace_owner" &&
      value.community === policy.canary.community &&
      value.post === policy.canary.post &&
      value.policy === policy.canary.policy &&
      value.learner_band === null &&
      value.helper_translation === false &&
      /^[a-f0-9]{64}$/u.test(value.corpus_sha256) &&
      value.lyrics_sha256 === policy.canary.lyricsSha256 &&
      value.audio_sha256 === policy.canary.audioSha256,
    "separate-song-and-policy-acceptance-required",
  );
  return value;
}
export async function telegramCorpus(db: pg.Client) {
  const args = [policy.canary.community, [policy.canary.post]];
  const ready = (await db.query(TELEGRAM_STUDY_READY_BASE_SQL, args)).rows;
  requireTelegram(
    ready.length === 1 && ready[0].post_id === policy.canary.post,
    "canary-corpus-not-ready",
  );
  const song = (
    await db.query(
      `SELECT submission.audio_revision,submission.current_lyrics_revision AS lyrics_revision,
    lyrics.lyrics_sha256,lyrics.canonical_audio_sha256 AS audio_sha256,
    (SELECT max(language_profile_revision) FROM study_language_profiles profile
      WHERE profile.community_id=p.community_id AND profile.post_id=p.post_id
        AND profile.lyrics_revision=submission.current_lyrics_revision) AS profile_revision
    FROM posts p JOIN media_publication_projections publication USING(community_id,post_id)
    JOIN media_post_submissions submission ON submission.submission_id=publication.submission_id
    JOIN media_song_lyrics_revisions lyrics ON lyrics.submission_id=submission.submission_id
      AND lyrics.lyrics_revision=submission.current_lyrics_revision
    WHERE p.community_id=$1 AND p.post_id=$2`,
      [policy.canary.community, policy.canary.post],
    )
  ).rows;
  const row = song[0];
  requireTelegram(
    song.length === 1 &&
      row.audio_revision === policy.canary.audioRevision &&
      row.lyrics_revision === policy.canary.lyricsRevision &&
      row.profile_revision === policy.canary.profileRevision &&
      row.lyrics_sha256 === policy.canary.lyricsSha256 &&
      row.audio_sha256 === policy.canary.audioSha256,
    "canary-content-revisions-changed",
  );
  const exercises = (
    await db.query(
      `SELECT DISTINCT exercise_review_key COLLATE "C" AS exercise_review_key,
    encode(sha256(convert_to(presentation->>'reference_text','UTF8')),'hex') AS reference_sha256,
    char_length(presentation->>'reference_text') AS reference_chars
    FROM study_exercise_versions WHERE community_id=$1 AND post_id=$2 AND audio_revision=$3
      AND lyrics_revision=$4 AND retired_at IS NULL AND exercise_type='say_it_back'
      AND learning_language='en' AND learner_band IS NULL AND target_language IS NULL
    ORDER BY exercise_review_key COLLATE "C"`,
      [
        policy.canary.community,
        policy.canary.post,
        policy.canary.audioRevision,
        policy.canary.lyricsRevision,
      ],
    )
  ).rows;
  requireTelegram(
    exercises.length === 22 &&
      exercises.every(
        (r) =>
          typeof r.reference_sha256 === "string" &&
          r.reference_chars > 0 &&
          r.reference_chars <= 2000,
      ),
    "reviewed-22-exercise-corpus-changed",
  );
  return {
    ...row,
    exercise_count: exercises.length,
    corpus_sha256: sha256(JSON.stringify(exercises)),
  };
}
export async function telegramPracticeReadiness(
  db: pg.Client,
  reference: TelegramFile,
  now: number,
) {
  const proof = telegramJson<{
    kind: string;
    accepted: boolean;
    reviewer_role: string;
    community: string;
    bot_id: string;
    bot_epoch: string;
    webhook_live: boolean;
    observed_at: string;
  }>(reference);
  const observed = Date.parse(proof.observed_at);
  requireTelegram(
    proof.kind === "telegram-production-channel-readiness-v1" &&
      proof.accepted === true &&
      proof.reviewer_role === "independent_reviewer" &&
      proof.community === policy.canary.community &&
      proof.webhook_live === true &&
      Number.isFinite(observed) &&
      observed <= now &&
      now - observed <= 300_000,
    "fresh-production-bot-webhook-readiness-required",
  );
  const rows = (
    await db.query(
      `SELECT bot_id,bot_epoch,record->>'status' AS status,
    record->'study'->>'botId' AS study_bot_id,record->'study'->>'enabled' AS study_enabled
    FROM api_next.community_telegram_integrations WHERE community_id=$1`,
      [policy.canary.community],
    )
  ).rows;
  requireTelegram(
    rows.length === 1 &&
      rows[0].bot_id === proof.bot_id &&
      rows[0].bot_epoch === proof.bot_epoch &&
      rows[0].status === "ready" &&
      rows[0].study_enabled === "true" &&
      rows[0].study_bot_id === proof.bot_id,
    "current-bot-owner-study-intent-required",
  );
  return { bot_id: proof.bot_id, bot_epoch: proof.bot_epoch, study_enabled: true };
}
export async function telegramDecision(db: pg.Client) {
  return (
    await db.query(
      `SELECT decision_revision,policy_revision,disposition,audio_revision,lyrics_revision,
    language_profile_revision,content_rating,learner_band,learning_language,exercise_type,reviewer_role,
    review_evidence_sha256,effective_at<=clock_timestamp() AS effective
    FROM api_next.study_learner_catalogue_decisions WHERE community_id=$1 AND post_id=$2 ORDER BY decision_revision`,
      [policy.canary.community, policy.canary.post],
    )
  ).rows;
}
/** Transaction and durable attempt belong to the caller. No automatic next revision or scheduling. */
export async function appendTelegramCanary(
  db: pg.Client,
  acceptanceFile: TelegramFile,
  assertBound: () => void,
) {
  const accepted = catalogueAcceptance(acceptanceFile);
  await db.query("SELECT community_id FROM api_next.communities WHERE community_id=$1 FOR UPDATE", [
    policy.canary.community,
  ]);
  await db.query(
    "SELECT post_id FROM api_next.posts WHERE community_id=$1 AND post_id=$2 FOR UPDATE",
    [policy.canary.community, policy.canary.post],
  );
  const corpus = await telegramCorpus(db);
  requireTelegram(corpus.corpus_sha256 === accepted.corpus_sha256, "accepted-corpus-changed");
  requireTelegram(
    (await telegramDecision(db)).length === 0,
    "canary-decision-already-exists-reconcile-only",
  );
  assertBound();
  await db.query(
    `INSERT INTO api_next.study_learner_catalogue_decisions
    (community_id,post_id,decision_revision,policy_revision,disposition,audio_revision,lyrics_revision,
     language_profile_revision,content_rating,learner_band,learning_language,exercise_type,reviewer_role,
     review_evidence_sha256,effective_at)
    VALUES($1,$2,1,$3,'eligible',1,1,1,'general',NULL,'en','say_it_back','workspace_owner',$4,clock_timestamp())`,
    [policy.canary.community, policy.canary.post, policy.canary.policy, acceptanceFile.sha256],
  );
  const decisions = await telegramDecision(db);
  requireTelegram(
    decisions.length === 1 &&
      decisions[0].decision_revision === 1 &&
      decisions[0].effective === true &&
      decisions[0].review_evidence_sha256 === acceptanceFile.sha256,
    "canary-insert-unverified",
  );
  assertBound();
  await db.query("COMMIT");
}
