import {
  type CommentNavigationStore,
  resolveCommentNavigation,
} from "@pirate/application/use-cases/comment-navigation";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { type EndpointHandler, withEndpointResult } from "./transport.ts";

export const makeCommentNavigationHandler =
  (store: CommentNavigationStore): EndpointHandler =>
  async (request) => {
    if (request.principal?.kind !== "user" && request.principal?.kind !== "admin")
      throw new AuthError({ message: "Authentication required" });
    const { commentId } = request.params as { commentId: string };
    const body = await Effect.runPromise(
      resolveCommentNavigation({ viewerUserId: request.principal.subject, commentId }, store),
    );
    return withEndpointResult(body, 200, { "cache-control": "private, no-store" });
  };
