import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { VideoPlaybackAccessServices } from "@pirate/application/video/playback-access";
import { Effect, type Layer, Schema } from "effect";

const Row = Schema.Struct({
  provider_video_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
});

/** Called only after the common eligibility check; an opaque ref is not itself authority. */
export function makeVideoPlaybackAuthority(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VideoPlaybackAccessServices["resolveApprovedPlayback"] {
  const resolve = Effect.fn("resolveVideoPlaybackAuthority")(function* (
    input: Parameters<VideoPlaybackAccessServices["resolveApprovedPlayback"]>[0],
  ) {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute({
      label: "video-playback.resolve-authority",
      readonly: true,
      text: `SELECT s.provider_video_id FROM media_publication_projections p
        JOIN media_video_stream_ingests s ON s.operation_id=p.operation_id
          AND s.state='ready' AND s.source_sha256=p.canonical_video_sha256
        JOIN media_video_rights r ON r.submission_id=p.submission_id
        JOIN media_video_enrichment_outbox e ON e.operation_id=p.operation_id
          AND e.submission_id=p.submission_id AND e.post_id=p.post_id
          AND e.enrichment_kind='stream' AND e.state='ready'
        WHERE (
          (r.rights_basis='original' AND p.song_video_plan_id IS NULL AND EXISTS (
            SELECT 1 FROM media_video_revisions v
             WHERE v.operation_id=p.operation_id AND v.submission_id=p.submission_id
               AND v.community_id=p.community_id AND v.video_revision=p.video_revision
               AND v.immutable_ref=p.video_asset_ref AND v.canonical_sha256=p.canonical_video_sha256))
          OR
          (r.rights_basis='derivative' AND EXISTS (
            SELECT 1 FROM media_song_video_accepted_masters a
              JOIN media_song_video_masters m
                ON m.master_revision_id=a.master_revision_id AND m.plan_id=a.plan_id
             WHERE a.plan_id=p.song_video_plan_id
               AND a.master_revision_id=p.song_video_master_revision_id
               AND m.verified_object_key=p.video_asset_ref
               AND m.master_sha256=p.canonical_video_sha256))
        )
          AND p.post_id=$1 AND p.community_id=$2 AND p.media_kind='video' AND s.provider_video_id=$3`,
      values: [input.postId, input.communityId, input.playbackRef],
    });
    if (result.rows.length !== 1) return null;
    const row = yield* Effect.try(() => Schema.decodeUnknownSync(Row)(result.rows[0]));
    return { providerVideoId: row.provider_video_id };
  });
  return (input) => resolve(input).pipe(Effect.provide(runtime));
}
