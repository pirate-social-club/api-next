import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import {
  ProfileActivityReference,
  type ProfileActivityStore,
} from "@pirate/application/use-cases/profile-activity";
import { InternalError, NotFound } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

const readable = `p.status='published' AND p.post_type IN ('text','song') AND community.status='active'
  AND can_account_view_content_rating_v1($2,p.content_rating)
  AND (p.visibility='public' OR (p.visibility='members_only' AND EXISTS (
    SELECT 1 FROM community_memberships member WHERE member.community_id=p.community_id
      AND member.user_id=$2 AND member.status='member')))`;
const visibleAncestors = `(c.parent_comment_id IS NULL OR (WITH RECURSIVE ancestors AS (
  SELECT parent.comment_id,parent.parent_comment_id,parent.status,parent.content_rating,1 AS hops
  FROM comments parent WHERE parent.community_id=c.community_id AND parent.post_id=c.post_id
    AND parent.comment_id=c.parent_comment_id
  UNION ALL SELECT parent.comment_id,parent.parent_comment_id,parent.status,parent.content_rating,ancestor.hops+1
  FROM comments parent JOIN ancestors ancestor ON parent.comment_id=ancestor.parent_comment_id
  WHERE parent.community_id=c.community_id AND parent.post_id=c.post_id AND ancestor.hops<8
) SELECT COALESCE(bool_and(status='published'
  AND can_account_view_content_rating_v1($2,content_rating))
  AND bool_or(parent_comment_id IS NULL),false) FROM ancestors))`;

export const profileActivityStatements = {
  persona: `SELECT persona.persona_id FROM personas persona JOIN users account ON account.user_id=persona.account_id
    WHERE persona.persona_id=$1 AND persona.status='active' AND account.status='active'
    AND public_persona_projection(persona.persona_id) IS NOT NULL`,
  list: `WITH activity AS (
    SELECT 'post'::text AS kind,p.post_id AS activity_id,p.created_at AS at,p.community_id,p.post_id,NULL::jsonb AS comment
    FROM posts p WHERE p.author_persona_id=$1
    UNION ALL
    SELECT 'comment',c.comment_id,c.created_at,c.community_id,c.post_id,
      jsonb_build_object('comment_id',c.comment_id,'parent_comment_id',c.parent_comment_id,
        'body',c.body,'author_persona',public_persona_projection(c.author_persona_id),'depth',c.depth,
        'reply_count',(SELECT COUNT(*) FROM comments reply WHERE reply.community_id=c.community_id
          AND reply.post_id=c.post_id AND reply.parent_comment_id=c.comment_id AND reply.status='published'
          AND can_account_view_content_rating_v1($2,reply.content_rating)),
        'status','published','content_rating',c.content_rating,'created_at',c.created_at)
    FROM comments c WHERE c.author_persona_id=$1 AND c.status='published'
      AND can_account_view_content_rating_v1($2,c.content_rating) AND ${visibleAncestors}
  ) SELECT activity.kind,activity.activity_id,
    to_char(activity.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_at,
    activity.community_id,activity.post_id,alias.slug AS post_slug,activity.comment,
    p.title AS post_title,community.display_name AS community_name
  FROM activity JOIN posts p USING (community_id,post_id)
    JOIN communities community USING (community_id)
    LEFT JOIN post_slug_aliases alias ON alias.post_id=p.post_id
  WHERE ${readable} AND ($3='overview' OR activity.kind=CASE $3 WHEN 'posts' THEN 'post' ELSE 'comment' END)
    AND ($4::timestamptz IS NULL OR (activity.at,activity.activity_id,activity.kind)<($4::timestamptz,$5::text,$6::text))
  ORDER BY activity.at DESC,activity.activity_id DESC,activity.kind DESC LIMIT 21`,
} as const;

export function makeControlPlaneProfileActivityStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): ProfileActivityStore {
  return {
    list: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            const persona = yield* tx.execute({
              label: "profile-activity.persona",
              text: profileActivityStatements.persona,
              values: [input.personaId],
              readonly: true,
            });
            if (persona.rows.length !== 1)
              return yield* new NotFound({ message: "Profile not found" });
            const result = yield* tx.execute({
              label: "profile-activity.list",
              text: profileActivityStatements.list,
              values: [
                input.personaId,
                input.viewerId ?? null,
                input.surface,
                input.cursor?.at ?? null,
                input.cursor?.id ?? null,
                input.cursor?.kind ?? null,
              ],
              readonly: true,
            });
            return yield* Schema.decodeUnknownEffect(Schema.Array(ProfileActivityReference))(
              result.rows,
            );
          }),
        );
      }).pipe(
        Effect.provide(runtime),
        Effect.mapError((error) =>
          error instanceof NotFound
            ? error
            : new InternalError({ message: "Profile activity could not be loaded", cause: error }),
        ),
      ),
  };
}
