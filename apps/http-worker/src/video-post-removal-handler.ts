import {
  removeOwnVideoPost,
  type VideoPostRemovalStore,
} from "@pirate/application/use-cases/video-post-removal";
import { AuthError, DeleteVideoPost } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { type EndpointHandler, withEndpointResult } from "./transport.ts";

export function makeVideoPostRemovalHandler(store: VideoPostRemovalStore): EndpointHandler {
  return async (request) => {
    const principal = request.principal;
    if (principal === null || (principal.kind !== "user" && principal.kind !== "admin"))
      throw new AuthError({ message: "Authentication required" });
    const { postId } = Schema.decodeUnknownSync(DeleteVideoPost.request.path)(request.params);
    const result = await Effect.runPromise(
      removeOwnVideoPost({ accountId: principal.subject, postId }, store),
    );
    return withEndpointResult(result, 200, { "cache-control": "private, no-store" });
  };
}
