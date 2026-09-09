import {
  type BadRequest,
  type InternalError,
  type ListPostComments,
  NotFound,
} from "@pirate/contracts";
import { Effect, type Schema } from "effect";

export type CommentThreadPage = Schema.Schema.Type<typeof ListPostComments.response>;
export type CommentThreadInput = Readonly<{
  postId: string;
  viewerUserId: string;
  parentCommentId?: string;
  cursor?: string;
}>;
export interface CommentThreadStore {
  readonly list: (
    input: CommentThreadInput,
  ) => Effect.Effect<CommentThreadPage, BadRequest | NotFound | InternalError>;
}
export const listPostComments = Effect.fn("listPostComments")(function* (
  input: CommentThreadInput,
  store: CommentThreadStore,
) {
  if (!input.viewerUserId.trim()) return yield* new NotFound({ message: "Post not found" });
  return yield* store.list(input);
});
