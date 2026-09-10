import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { SongPlaybackServices } from "@pirate/application/use-cases/content/song-playback";
import { Effect, type Layer, Schema } from "effect";

const Row = Schema.Struct({ immutable_ref: Schema.String });
/** Bind the current visible post to its approved publication and sealed audio revision. */
export const authorizeSongPlayback = Effect.fn("authorizeSongPlayback")(function* (input: {
  postId: string;
  viewerUserId?: string;
}) {
  const db = yield* ControlPlaneDb;
  const result = yield* db.execute({
    label: "song-playback.authorize",
    readonly: true,
    text: `SELECT audio.immutable_ref FROM posts p
      JOIN communities c ON c.community_id=p.community_id AND c.status='active'
      JOIN media_publication_projections pub ON pub.post_id=p.post_id AND pub.community_id=p.community_id AND pub.media_kind='song'
      JOIN media_post_submissions s ON s.submission_id=pub.submission_id AND s.operation_id=pub.operation_id
        AND s.community_id=pub.community_id AND s.post_id=pub.post_id AND s.media_kind='song' AND s.status='published'
        AND s.creation_revision=pub.creation_revision AND s.audio_revision=pub.audio_revision
        AND s.current_decision_revision=pub.decision_revision
      JOIN media_publication_decisions d ON d.submission_id=pub.submission_id AND d.operation_id=pub.operation_id
        AND d.community_id=pub.community_id AND d.decision_revision=pub.decision_revision AND d.outcome='allow'
        AND d.creation_revision=pub.creation_revision AND d.audio_revision=pub.audio_revision
        AND d.analysis_revision=pub.analysis_revision AND d.canonical_audio_sha256=pub.canonical_audio_sha256
      JOIN media_audio_revisions audio ON audio.submission_id=pub.submission_id AND audio.operation_id=pub.operation_id
        AND audio.community_id=pub.community_id AND audio.audio_revision=pub.audio_revision
        AND audio.canonical_sha256=pub.canonical_audio_sha256 AND audio.immutable_ref=pub.audio_asset_ref
      JOIN media_immutable_objects sealed ON sealed.immutable_ref=audio.immutable_ref
        AND sealed.community_id=audio.community_id AND sealed.canonical_sha256=audio.canonical_sha256
        AND sealed.content_type=audio.content_type AND sealed.size_bytes=audio.size_bytes
      WHERE p.post_id=$1 AND p.post_type='song' AND p.status='published'
        AND (p.visibility='public' OR (p.visibility='members_only' AND EXISTS (
          SELECT 1 FROM community_memberships m WHERE m.community_id=p.community_id AND m.user_id=$2 AND m.status='member')))
        AND can_account_view_content_rating_v1($2,p.content_rating)
        AND can_account_view_content_rating_v1($2,pub.content_rating)
        AND audio.content_type LIKE 'audio/%'`,
    values: [input.postId, input.viewerUserId ?? null],
  });
  if (result.rows.length !== 1) return null;
  const row = yield* Effect.try(() => Schema.decodeUnknownSync(Row)(result.rows[0]));
  return { immutableRef: row.immutable_ref };
});
export function makeSongPlaybackAuthority(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): SongPlaybackServices["authorize"] {
  return (input) => authorizeSongPlayback(input).pipe(Effect.provide(runtime));
}
