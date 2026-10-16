import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { VideoDetailStore } from "@pirate/application/use-cases/content/video-detail";
import { InternalError, PublicPostRouteResultV1, videoPostDetailPath } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { postFromRow } from "./content-repository.ts";
import {
  videoPostProjectionFromRow,
  videoPostProjectionJoins,
  videoPostProjectionSelect,
} from "./video-post-projection.ts";

/** One statement, including literal alias resolution, guard and all projection facts. */
export const READ_VIDEO_DETAIL_SNAPSHOT_V1 = `WITH selected_identity AS MATERIALIZED (
  SELECT p.post_id FROM posts p WHERE $1='post_id' AND p.post_id=$2
  UNION ALL
  SELECT a.post_id FROM post_slug_aliases a WHERE $1='alias' AND a.slug=$2
), selected AS MATERIALIZED (
  SELECT p.*, a.slug AS selected_alias, a.slug_policy_version AS selected_policy
  FROM selected_identity identity JOIN posts p ON p.post_id=identity.post_id
  LEFT JOIN post_slug_aliases a ON a.post_id=p.post_id
), classified AS MATERIALIZED (
  SELECT p.*,
   CASE WHEN p.post_type<>'video' THEN 'not_video'
     WHEN $1='alias' AND (p.selected_alias<>p.post_id OR p.selected_policy NOT IN ('post-slug-v1','video-receipt-exact-v1')) THEN 'not_found'
     WHEN NOT COALESCE(access.non_age_allowed,FALSE) THEN 'not_found'
     WHEN NOT COALESCE(access.age_allowed,FALSE) THEN 'age_locked'
     ELSE 'content' END AS detail_kind
  FROM selected p LEFT JOIN LATERAL video_detail_access_v1($3,p.post_id) access ON TRUE
)
SELECT p.detail_kind, p.post_id,
 CASE WHEN p.detail_kind='content' THEN to_jsonb(p) || jsonb_build_object(
   'author_persona',video_detail_persona_v1(p.author_persona_id),
   'video_caption',video_fields.video_caption) END AS post_row,
 CASE WHEN p.detail_kind='content' THEN to_jsonb(video_fields) END AS video_row,
 CASE WHEN p.detail_kind='content' THEN jsonb_build_object(
   'upvote_count',(SELECT count(*) FROM post_votes v WHERE v.post_id=p.post_id AND v.community_id=p.community_id AND v.vote_value=1),
   'downvote_count',(SELECT count(*) FROM post_votes v WHERE v.post_id=p.post_id AND v.community_id=p.community_id AND v.vote_value=-1),
   'comment_count',(SELECT count(*) FROM comments c WHERE c.post_id=p.post_id AND c.community_id=p.community_id AND c.status='published'),
   'viewer_vote',(SELECT v.vote_value FROM post_votes v WHERE v.post_id=p.post_id AND v.community_id=p.community_id AND v.user_id=$3),
   'viewer_is_author',COALESCE(p.author_user_id=$3,FALSE)) END AS engagement
FROM classified p
LEFT JOIN LATERAL (SELECT ${videoPostProjectionSelect.replace("origin_post.author_persona_id AS", "(video_detail_persona_v1(origin_post.author_persona_id)->>'persona_id') AS").replace("song_post.author_persona_id AS", "(video_detail_persona_v1(song_post.author_persona_id)->>'persona_id') AS")}
FROM (SELECT 1) projection_anchor
${videoPostProjectionJoins.replace("AND video_projection.media_kind = 'video'", "AND video_projection.media_kind = 'video' AND p.idempotency_key='video-publication:'||video_projection.operation_id")}
WHERE p.detail_kind='content') video_fields ON TRUE`;

const Row = Schema.Record(Schema.String, Schema.Unknown);
export function makeControlPlaneVideoDetailStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): VideoDetailStore {
  return {
    read: Effect.fn("VideoDetailStore.read")(
      function* (input: Parameters<VideoDetailStore["read"]>[0]) {
        const db = yield* ControlPlaneDb;
        const rows = yield* db.execute<Record<string, unknown>>({
          label: "video-detail.snapshot.v1",
          text: READ_VIDEO_DETAIL_SNAPSHOT_V1,
          values: [input.selector.kind, input.selector.value, input.viewerUserId ?? null],
          readonly: true,
        });
        if (rows.rows.length === 0) return { kind: "not_found" as const };
        if (rows.rows.length !== 1)
          return yield* new InternalError({
            message: "Video detail unavailable",
            cause: new Error("Ambiguous video detail snapshot"),
          });
        const row = rows.rows[0];
        if (row?.detail_kind === "not_video") return { kind: "not_video" as const };
        if (row?.detail_kind === "not_found") return { kind: "not_found" as const };
        if (typeof row?.post_id === "string" && videoPostDetailPath(row.post_id) === null)
          return { kind: "not_found" as const };
        if (row?.detail_kind === "age_locked")
          return {
            kind: "result" as const,
            result: {
              kind: "age_locked" as const,
              locked: {
                kind: "age_locked" as const,
                content_rating: "adult_18" as const,
                next_action: { kind: "verify_minimum_age" as const, minimum_age: 18 as const },
              },
            },
          };
        if (row?.detail_kind !== "content")
          return yield* new InternalError({
            message: "Video detail unavailable",
            cause: new Error("Invalid video detail classification"),
          });
        const postRow = yield* Schema.decodeUnknownEffect(Row)(row.post_row);
        const videoRow = yield* Schema.decodeUnknownEffect(Row)(row.video_row);
        const engagement = yield* Schema.decodeUnknownEffect(Row)(row.engagement);
        const post = postFromRow(postRow);
        const video = videoPostProjectionFromRow(videoRow);
        if (
          post === null ||
          video === null ||
          post.post_type !== "video" ||
          post.id !== row.post_id ||
          (input.selector.kind === "post_id" && post.id !== input.selector.value)
        )
          return yield* new InternalError({
            message: "Video detail unavailable",
            cause: new Error("Malformed eligible video detail projection"),
          });
        const result = yield* Schema.decodeUnknownEffect(PublicPostRouteResultV1, {
          onExcessProperty: "error",
        })({
          kind: "content",
          post_id: post.id,
          route: null,
          content: {
            post,
            video,
            thread_snapshot: null,
            ...engagement,
            like_count: 0,
            viewer_reaction_kinds: [],
            resolved_locale: input.locale ?? "en",
            translation_state: "policy_blocked",
            machine_translated: false,
            source_hash: null,
          },
        });
        return { kind: "result" as const, result };
      },
      Effect.provide(runtime),
      Effect.mapError((cause) => new InternalError({ message: "Video detail unavailable", cause })),
    ),
  };
}
