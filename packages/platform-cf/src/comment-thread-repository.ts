import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type {
  CommentThreadInput,
  CommentThreadPage,
  CommentThreadStore,
} from "@pirate/application/use-cases/content/comment-thread";
import { BadRequest, InternalError, ListPostComments, NotFound } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
const PAGE_SIZE = 20;
const unavailable = () => new InternalError({ message: "Comments unavailable" });

export const readCommentThread = Effect.fn("readCommentThread")(function* (
  input: CommentThreadInput,
) {
  const db = yield* ControlPlaneDb;
  return yield* db
    .withTransaction((transaction) =>
      Effect.gen(function* () {
        // Authorization and comment projection share one transaction. Never trust a
        // previously returned public feed as permission to read this thread.
        const access = yield* transaction.execute<Row>({
          label: "comments.thread.access",
          text: `SELECT p.community_id FROM posts p JOIN communities community USING (community_id)
        WHERE p.post_id = $1 AND p.status = 'published' AND community.status = 'active'
          AND can_account_view_content_rating_v1($2, p.content_rating)
          AND (p.visibility = 'public' OR (p.visibility = 'members_only' AND EXISTS (
            SELECT 1 FROM community_memberships m WHERE m.community_id = p.community_id
              AND m.user_id = $2 AND m.status = 'member')))`,
          values: [input.postId, input.viewerUserId],
          readonly: true,
        });
        if (access.rows.length === 0) return yield* new NotFound({ message: "Post not found" });
        if (access.rows.length !== 1 || typeof access.rows[0]?.community_id !== "string")
          return yield* unavailable();
        const communityId = access.rows[0].community_id;
        const parent = input.parentCommentId ?? null;
        if (parent !== null) {
          // Every ancestor must remain visible. Guessing an ID must not recover a
          // child of a hidden, removed, adult-locked or foreign-post parent.
          const ancestry = yield* transaction.execute<Row>({
            label: "comments.thread.parent",
            text: `WITH RECURSIVE ancestors AS (
          SELECT comment_id, parent_comment_id, status, content_rating, 0 AS hops
          FROM comments WHERE community_id = $1 AND post_id = $2 AND comment_id = $3
          UNION ALL
          SELECT c.comment_id, c.parent_comment_id, c.status, c.content_rating, a.hops + 1
          FROM comments c JOIN ancestors a ON c.comment_id = a.parent_comment_id
          WHERE c.community_id = $1 AND c.post_id = $2 AND a.hops < 8
        ) SELECT (COUNT(*) > 0 AND bool_and(status = 'published'
          AND can_account_view_content_rating_v1($4, content_rating))
          AND bool_or(parent_comment_id IS NULL)) AS allowed FROM ancestors`,
            values: [communityId, input.postId, parent, input.viewerUserId],
            readonly: true,
          });
          if (ancestry.rows[0]?.allowed !== true)
            return yield* new NotFound({ message: "Comment not found" });
        }
        if (input.cursor !== undefined) {
          const cursor = yield* transaction.execute<Row>({
            label: "comments.thread.cursor",
            text: `SELECT comment_id FROM comments WHERE community_id = $1 AND post_id = $2
          AND parent_comment_id IS NOT DISTINCT FROM $3::text AND comment_id = $4`,
            values: [communityId, input.postId, parent, input.cursor],
            readonly: true,
          });
          if (cursor.rows.length !== 1)
            return yield* new BadRequest({ message: "Invalid comment cursor" });
        }
        const rows = yield* transaction.execute<Row>({
          label: "comments.thread.list",
          text: `SELECT c.comment_id, c.created_at, CASE
        WHEN NOT can_account_view_content_rating_v1($5, c.content_rating) THEN
          jsonb_build_object('kind','age_locked','content_rating','adult_18',
            'next_action',jsonb_build_object('kind','verify_minimum_age','minimum_age',18))
        ELSE jsonb_build_object('comment_id',c.comment_id,'parent_comment_id',c.parent_comment_id,
          'body',c.body,'author_persona',public_persona_projection(c.author_persona_id),
          'depth',c.depth,'reply_count',(SELECT COUNT(*) FROM comments reply
            WHERE reply.community_id = c.community_id AND reply.post_id = c.post_id
              AND reply.parent_comment_id = c.comment_id AND reply.status = 'published'),
          'status','published','content_rating',c.content_rating,'created_at',c.created_at)
        END AS item
        FROM comments c WHERE c.community_id = $1 AND c.post_id = $2
          AND c.parent_comment_id IS NOT DISTINCT FROM $3::text AND c.status = 'published'
          AND ($4::text IS NULL OR (c.created_at,c.comment_id) > (
            SELECT created_at,comment_id FROM comments WHERE community_id = $1 AND post_id = $2 AND comment_id = $4))
        ORDER BY c.created_at, c.comment_id LIMIT 21`,
          values: [communityId, input.postId, parent, input.cursor ?? null, input.viewerUserId],
          readonly: true,
        });
        const page = rows.rows.slice(0, PAGE_SIZE);
        const document = {
          items: page.map((row) => row.item),
          next_cursor: rows.rows.length > PAGE_SIZE ? page.at(-1)?.comment_id : null,
        };
        return yield* Effect.try({
          try: () => Schema.decodeUnknownSync(ListPostComments.response)(document),
          catch: unavailable,
        });
      }),
    )
    .pipe(
      Effect.catch((error) =>
        error instanceof BadRequest || error instanceof NotFound || error instanceof InternalError
          ? Effect.fail(error)
          : Effect.fail(unavailable()),
      ),
    );
});

export function makeCommentThreadStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CommentThreadStore {
  return {
    list: (input): Effect.Effect<CommentThreadPage, BadRequest | NotFound | InternalError> =>
      readCommentThread(input).pipe(
        Effect.provide(runtime),
        Effect.mapError((error) =>
          error instanceof BadRequest || error instanceof NotFound || error instanceof InternalError
            ? error
            : unavailable(),
        ),
      ),
  };
}
