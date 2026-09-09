import { Schema } from "effect";
import { AgeLockedResourceV1 } from "./age-access.ts";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, NotFound } from "./errors.ts";
import { PublicPersonaV1 } from "./personas.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
export const CommentThreadItemV1 = Schema.Struct({
  comment_id: Id,
  parent_comment_id: Schema.NullOr(Id),
  body: Schema.String,
  author_persona: Schema.NullOr(PublicPersonaV1),
  depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
  reply_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.Literal("published"),
  content_rating: Schema.Literals(["general", "adult_18"]),
  created_at: Schema.String,
});

/** Lists immediate children oldest first. Omit parent_comment_id for roots.
 * Cursor is the last returned row's opaque ID, scoped to this post and parent.
 * Rating-inaccessible comments use the content-free age-locked projection.
 */
export const ListPostComments = endpoint({
  method: "GET",
  path: "/posts/:postId/comments",
  auth: Auth.userOrAdmin(),
  request: {
    path: Schema.Struct({ postId: Id }),
    query: Schema.Struct({ parent_comment_id: Schema.optional(Id), cursor: Schema.optional(Id) }),
  },
  response: Schema.Struct({
    items: Schema.Array(Schema.Union([CommentThreadItemV1, AgeLockedResourceV1])),
    next_cursor: Schema.NullOr(Id),
  }),
  errors: [AuthError, BadRequest, NotFound, InternalError],
});
