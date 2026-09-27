import { Client } from "pg";
import { makeStudyGenerationWorkflowComposition } from "../apps/http-worker/src/study-generation-production-composition.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

type Source = {
  community_id: string;
  post_id: string;
  lyrics_revision: string;
  lyrics_sha256: string;
  profile_revision: string | null;
  spoken_count: string;
};

const readSource = async (client: Client, postId: string): Promise<Source> => {
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL search_path TO api_next, pg_catalog");
    const found = await client.query<Source>(
      `SELECT projection.community_id, projection.post_id,
              projection.lyrics_revision, lyrics.lyrics_sha256,
              (SELECT max(profile.language_profile_revision)::text
                 FROM study_language_profiles profile
                WHERE profile.community_id=projection.community_id
                  AND profile.post_id=projection.post_id
                  AND profile.lyrics_revision=projection.lyrics_revision
                  AND profile.source_hash=lyrics.lyrics_sha256) AS profile_revision,
              (SELECT count(DISTINCT exercise.exercise_review_key)::text
                 FROM study_exercise_versions exercise
                WHERE exercise.community_id=projection.community_id
                  AND exercise.post_id=projection.post_id
                  AND exercise.lyrics_revision=projection.lyrics_revision
                  AND exercise.exercise_type='say_it_back'
                  AND exercise.retired_at IS NULL) AS spoken_count
         FROM media_publication_projections projection
         JOIN media_post_submissions submission
           ON submission.submission_id=projection.submission_id
          AND submission.community_id=projection.community_id
          AND submission.post_id=projection.post_id
         JOIN media_song_lyrics_revisions lyrics
           ON lyrics.submission_id=submission.submission_id
          AND lyrics.lyrics_revision=projection.lyrics_revision
        WHERE projection.post_id=$1 AND projection.lyrics_status='ready'
          AND submission.status='published'
          AND submission.current_lyrics_revision=projection.lyrics_revision`,
      [postId],
    );
    if (found.rows.length !== 1 || Number(found.rows[0]?.spoken_count) < 1) {
      throw new Error("current published spoken source is missing or ambiguous");
    }
    return found.rows[0] as Source;
  } finally {
    await client.query("ROLLBACK");
  }
};

if (import.meta.main) {
  const postId = required("STUDY_BACKFILL_POST_ID");
  const url = new URL(normalizePostgresConnectionString(required("STUDY_BACKFILL_DATABASE_URL")));
  if (
    url.hostname !== required("STUDY_BACKFILL_EXPECTED_HOST") ||
    decodeURIComponent(url.pathname.slice(1)) !== required("STUDY_BACKFILL_EXPECTED_DATABASE") ||
    !decodeURIComponent(url.username).endsWith(required("STUDY_BACKFILL_EXPECTED_USER_SUFFIX"))
  )
    throw new Error("database branch pin mismatch");
  const apply = process.argv.includes("--apply");
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const before = await readSource(client, postId);
    if (before.profile_revision !== null) {
      await client.query("BEGIN READ ONLY");
      let weakUnits: number;
      try {
        await client.query("SET LOCAL search_path TO api_next, pg_catalog");
        const units = await client.query<{ weak_units: string }>(
          `SELECT count(*)::text AS weak_units FROM study_language_profile_units
            WHERE community_id=$1 AND post_id=$2 AND lyrics_revision=$3
              AND language_profile_revision=$4
              AND (mixed OR confidence IS NULL OR confidence < 0.8)`,
          [before.community_id, before.post_id, before.lyrics_revision, before.profile_revision],
        );
        weakUnits = Number(units.rows[0]?.weak_units);
      } finally {
        await client.query("ROLLBACK");
      }
      console.log(
        JSON.stringify({
          mode: apply ? "apply" : "preview",
          postId,
          profileRevision: Number(before.profile_revision),
          weakUnits,
          outcome: "already_accepted",
        }),
      );
    } else if (!apply) {
      console.log(
        JSON.stringify({
          mode: "preview",
          postId,
          spokenCount: Number(before.spoken_count),
          profile: "missing",
        }),
      );
    } else {
      const producer = makeStudyGenerationWorkflowComposition({
        CONTROL_PLANE: { connectionString: url.toString() },
        STUDY_GENERATION_ENABLED: "true",
        OPENROUTER_API_KEY: required("OPENROUTER_API_KEY"),
        STUDY_GENERATION_OPENROUTER_MODEL: required("STUDY_GENERATION_OPENROUTER_MODEL"),
      });
      const outcome = await producer.generateProfile({
        communityId: before.community_id,
        postId: before.post_id,
      });
      const after = await readSource(client, postId);
      if (
        outcome.lyricsRevision !== Number(before.lyrics_revision) ||
        outcome.sourceHash !== before.lyrics_sha256 ||
        after.lyrics_revision !== before.lyrics_revision ||
        after.lyrics_sha256 !== before.lyrics_sha256 ||
        Number(after.profile_revision) !== outcome.languageProfileRevision
      )
        throw new Error("profile source or readback mismatch");
      console.log(
        JSON.stringify({ mode: "apply", postId, profileRevision: outcome.languageProfileRevision }),
      );
    }
  } finally {
    await client.end();
  }
}
