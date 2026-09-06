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
        JOIN media_video_rights r ON r.submission_id=p.submission_id AND r.rights_basis='original'
        JOIN media_video_revisions v ON v.operation_id=p.operation_id AND v.submission_id=p.submission_id
          AND v.community_id=p.community_id AND v.video_revision=p.video_revision
          AND v.immutable_ref=p.video_asset_ref AND v.canonical_sha256=p.canonical_video_sha256
        WHERE p.post_id=$1 AND p.community_id=$2 AND p.media_kind='video' AND s.provider_video_id=$3`,
      values: [input.postId, input.communityId, input.playbackRef],
    });
    if (result.rows.length !== 1) return null;
    const row = yield* Effect.try(() => Schema.decodeUnknownSync(Row)(result.rows[0]));
    return { providerVideoId: row.provider_video_id };
  });
  return (input) => resolve(input).pipe(Effect.provide(runtime));
}
