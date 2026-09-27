import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";

export type MissingStudyProfile = Readonly<{
  communityId: string;
  postId: string;
  lyricsRevision: number;
  sourceHash: string;
}>;

/** Observe only committed, current, published lyrics with spoken Study content. */
export const makeStudyProfileCoverageStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) => ({
  nextMissing: (): Promise<MissingStudyProfile | null> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const found = yield* db.withTransaction((tx) =>
          tx.execute<{
            community_id: string;
            post_id: string;
            lyrics_revision: string;
            lyrics_sha256: string;
          }>({
            label: "study-profile-coverage.next-missing",
            text: `SELECT projection.community_id, projection.post_id,
                          projection.lyrics_revision, lyrics.lyrics_sha256
                     FROM media_publication_projections projection
                     JOIN media_post_submissions submission
                       ON submission.submission_id=projection.submission_id
                      AND submission.community_id=projection.community_id
                      AND submission.post_id=projection.post_id
                     JOIN media_song_lyrics_revisions lyrics
                       ON lyrics.submission_id=submission.submission_id
                      AND lyrics.lyrics_revision=projection.lyrics_revision
                    WHERE projection.lyrics_status='ready'
                      AND submission.status='published'
                      AND submission.current_lyrics_revision=projection.lyrics_revision
                      AND EXISTS (
                        SELECT 1 FROM study_exercise_versions exercise
                         WHERE exercise.community_id=projection.community_id
                           AND exercise.post_id=projection.post_id
                           AND exercise.lyrics_revision=projection.lyrics_revision
                           AND exercise.exercise_type='say_it_back'
                           AND exercise.retired_at IS NULL
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM study_language_profiles profile
                         WHERE profile.community_id=projection.community_id
                           AND profile.post_id=projection.post_id
                           AND profile.lyrics_revision=projection.lyrics_revision
                           AND profile.source_hash=lyrics.lyrics_sha256
                      )
                    ORDER BY md5(projection.post_id || date_trunc('minute', clock_timestamp())::text)
                    LIMIT 1`,
            values: [],
            readonly: true,
          }),
        );
        const row = found.rows[0];
        if (row === undefined) return null;
        const lyricsRevision = Number(row.lyrics_revision);
        if (!Number.isSafeInteger(lyricsRevision) || lyricsRevision < 1) {
          throw new TypeError("invalid current lyrics revision");
        }
        return {
          communityId: row.community_id,
          postId: row.post_id,
          lyricsRevision,
          sourceHash: row.lyrics_sha256,
        };
      }).pipe(Effect.provide(runtime)),
    ),
});
