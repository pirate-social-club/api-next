import {
  type CommentThreadStore,
  listPostComments,
} from "@pirate/application/use-cases/content/comment-thread";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { type EndpointHandler, withEndpointResult } from "./transport.ts";

export const makeCommentThreadHandler =
  (store: CommentThreadStore): EndpointHandler =>
  async (request) => {
    if (!request.principal) throw new AuthError({ message: "Authentication required" });
    const path = request.params as { postId: string };
    const query = request.query as { parent_comment_id?: string; cursor?: string };
    const body = await Effect.runPromise(
      listPostComments(
        {
          postId: path.postId,
          viewerUserId: request.principal.subject,
          ...(query.parent_comment_id === undefined
            ? {}
            : { parentCommentId: query.parent_comment_id }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        },
        store,
      ),
    );
    return withEndpointResult(body, 200, { "cache-control": "private, no-store" });
  };
