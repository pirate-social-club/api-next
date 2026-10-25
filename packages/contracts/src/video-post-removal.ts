import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, Conflict, InternalError, NotFound, RateLimited } from "./errors.ts";

export const VideoPostDeletionReceipt = Schema.Struct({
  object: Schema.Literal("video_post_deletion"),
  community_id: Schema.NonEmptyString,
  post_id: Schema.NonEmptyString,
  status: Schema.Literal("deleted"),
});
export type VideoPostDeletionReceipt = typeof VideoPostDeletionReceipt.Type;

/** Monotonic removal of this author's public Post. The immutable target is its
 * own idempotency identity; repeating DELETE cannot create another removal. */
export const DeleteVideoPost = endpoint({
  method: "DELETE",
  path: "/posts/:postId/video",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    path: Schema.Struct({ postId: Schema.NonEmptyString.check(Schema.isMaxLength(512)) }),
  },
  response: VideoPostDeletionReceipt,
  errors: [AuthError, BadRequest, Conflict, InternalError, NotFound, RateLimited],
});
