import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { VideoAccessAuthorizationServices } from "@pirate/application/video/access-authorization";
import { Effect, type Layer } from "effect";

/** No evidence fields leave this query. Both delivery paths use the same live policy. */
const authorizePublication = Effect.fn("authorizeVideoPublication")(function* (
  input: Readonly<{ postId: string; communityId: string; viewerUserId?: string }>,
) {
  const db = yield* ControlPlaneDb;
  const result = yield* db.execute<{ allowed: boolean }>({
    label: "video-access.authorize-publication",
    text: `SELECT EXISTS (
      SELECT 1 FROM posts p
      JOIN communities c ON c.community_id=p.community_id AND c.status='active'
      JOIN media_publication_projections pub
        ON pub.post_id=p.post_id AND pub.community_id=p.community_id AND pub.media_kind='video'
      JOIN media_post_submissions s
        ON s.submission_id=pub.submission_id AND s.operation_id=pub.operation_id
       AND s.community_id=pub.community_id AND s.post_id=pub.post_id
       AND s.media_kind='video' AND s.video_intent='original_audio' AND s.status='published'
       AND s.creation_revision=pub.creation_revision AND s.video_revision=pub.video_revision
      JOIN media_video_publication_decisions d
        ON d.submission_id=pub.submission_id AND d.creation_revision=pub.creation_revision
       AND d.video_revision=pub.video_revision AND d.analysis_revision=pub.analysis_revision
      JOIN media_video_rights r ON r.submission_id=pub.submission_id AND r.rights_basis='original'
      WHERE p.post_id=$1 AND p.community_id=$2 AND p.post_type='video' AND p.status='published'
        AND (p.visibility='public' OR (p.visibility='members_only' AND EXISTS (
          SELECT 1 FROM community_memberships m
          WHERE m.community_id=p.community_id AND m.user_id=$3 AND m.status='member'
        )))
        AND can_account_view_content_rating_v1($3,p.content_rating)
        AND can_account_view_content_rating_v1($3,d.effective_content_rating)
        AND (d.outcome='publish' OR (d.outcome='review' AND EXISTS (
          SELECT 1 FROM media_video_review_holds h
          WHERE h.submission_id=pub.submission_id AND h.creation_revision=pub.creation_revision
            AND h.status='approved'
        )))
        AND NOT EXISTS (
          SELECT 1 FROM media_video_review_holds h
          WHERE h.submission_id=pub.submission_id AND h.creation_revision=pub.creation_revision
            AND h.status<>'approved'
        )
    ) AS allowed`,
    values: [input.postId, input.communityId, input.viewerUserId ?? null],
    readonly: true,
  });
  return result.rows.length === 1 && result.rows[0]?.allowed === true;
});

export function makeVideoPublicationAuthorization(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VideoAccessAuthorizationServices["authorizePublication"] {
  return (input) => authorizePublication(input).pipe(Effect.provide(layer));
}
