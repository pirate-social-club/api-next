import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { VideoOutcomeStore } from "@pirate/application/use-cases/video-outcomes";
import { VideoOutcomeV1 } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

export function makeControlPlaneVideoOutcomeStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): VideoOutcomeStore {
  return {
    claim: Effect.fn("VideoOutcomeStore.claim")(function* (accountId: string) {
      const db = yield* ControlPlaneDb;
      // The payload leaves this scope only after COMMIT is acknowledged. A lost
      // acknowledgment may lose the notice permanently; never replay a winner.
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const result = yield* tx.execute<{ outcome: unknown }>({
            label: "video-outcome.claim",
            text: `WITH candidate AS (
              SELECT s.submission_id, s.actor_user_id,
                     CASE s.status WHEN 'blocked' THEN 'policy_block'
                       ELSE 'processing_failure' END AS kind,
                     t.song_community_id, p.song_post_id
                FROM media_post_submissions s
                LEFT JOIN media_video_reservation_song_plans p
                  ON p.reservation_id=s.audio_reservation_id
                LEFT JOIN media_song_canonical_timings t
                  ON t.song_post_id=p.song_post_id AND t.audio_revision=p.audio_revision
                 AND t.canonical_audio_sha256=p.canonical_audio_sha256
                 AND t.duration_samples=p.song_duration_samples
               WHERE s.actor_user_id=$1 AND s.media_kind='video'
                 AND s.video_revision>0 AND s.current_immutable_ref IS NOT NULL
                 AND (s.status='blocked' OR (s.status='processing_failed'
                   AND s.retryable IS FALSE
                   AND s.video_state_snapshot->>'reconciliationRequired' IS DISTINCT FROM 'true'))
                 AND NOT EXISTS (SELECT 1 FROM media_publication_projections pub
                   WHERE pub.submission_id=s.submission_id)
                 AND NOT EXISTS (SELECT 1 FROM media_video_outcome_claims c
                   WHERE c.submission_id=s.submission_id)
               ORDER BY s.updated_at, s.submission_id
               LIMIT 1 FOR UPDATE OF s SKIP LOCKED
            ), winner AS (
              INSERT INTO media_video_outcome_claims (submission_id, actor_user_id, kind)
              SELECT submission_id, actor_user_id, kind FROM candidate
              ON CONFLICT (submission_id) DO NOTHING
              RETURNING submission_id
            ) SELECT jsonb_build_object(
              'submission_id',c.submission_id,'kind',c.kind,
              'song',CASE WHEN c.song_post_id IS NULL THEN NULL ELSE
                jsonb_build_object('community_id',c.song_community_id,'post_id',c.song_post_id) END
            ) AS outcome FROM candidate c JOIN winner USING(submission_id)`,
            values: [accountId],
            readonly: false,
          });
          if (result.rows.length === 0) return null;
          return Schema.decodeUnknownSync(VideoOutcomeV1, { onExcessProperty: "error" })(
            result.rows[0]?.outcome,
          );
        }),
      );
    }, Effect.provide(layer)),
  };
}
