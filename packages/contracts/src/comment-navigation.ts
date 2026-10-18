import { Schema } from "effect";
import { AgeLockedResourceV1 } from "./age-access.ts";
import { Auth } from "./auth.ts";
import { CommentThreadItemV1 } from "./comment-thread.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, NotFound } from "./errors.ts";
import { PostDetailNavigationPathV1, videoPostDetailPath } from "./post-navigation.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
export const CommentNavigationWindowV1 = Schema.Struct({
  parent_comment_id: Schema.NullOr(Id),
  branch_comment_id: Id,
  items: Schema.Array(Schema.Union([CommentThreadItemV1, AgeLockedResourceV1])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  earlier_items_omitted: Schema.Boolean,
  next_cursor: Schema.NullOr(Id),
});
export const AvailableCommentNavigationV1 = Schema.Struct({
  kind: Schema.Literal("available"),
  post_id: Id,
  community_id: Id,
  post_path: PostDetailNavigationPathV1,
  target_comment_id: Id,
  ancestor_comment_ids: Schema.Array(Id).check(Schema.isMaxLength(8)),
  windows: Schema.Array(CommentNavigationWindowV1).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(9),
  ),
}).check(
  Schema.makeFilter(
    (value) =>
      !value.post_path.startsWith("/post/") ||
      videoPostDetailPath(value.post_id) === value.post_path,
  ),
);
export const ResolveCommentNavigationV1 = endpoint({
  method: "GET",
  path: "/comments/:commentId/location",
  auth: Auth.userOrAdmin(),
  request: { path: Schema.Struct({ commentId: Id }) },
  response: Schema.Union([AvailableCommentNavigationV1, AgeLockedResourceV1]),
  errors: [AuthError, BadRequest, NotFound, InternalError],
});
