import { AuthError, GetVideoPoster } from "@pirate/contracts";
import {
  streamVideoPoster,
  type VideoPosterStreamServices,
} from "@pirate/platform-cf/video-poster-stream";
import { Effect, Schema } from "effect";
import { type DecodedRequest, withEndpointResult } from "./transport.ts";

/** Prepared handler, installed only with the coordinated registry/client release. */
export function makeVideoPosterHandler(services: VideoPosterStreamServices) {
  return async (request: DecodedRequest) => {
    const principal = request.principal;
    if (principal !== null && principal.kind !== "user" && principal.kind !== "admin") {
      throw new AuthError({ message: "Authorization failed" });
    }
    const { postId } = Schema.decodeUnknownSync(GetVideoPoster.request.path)(request.params);
    const headers = Schema.decodeUnknownSync(GetVideoPoster.request.headers)(request.headers ?? {});
    const response = await Effect.runPromise(
      streamVideoPoster(
        {
          postId,
          ...(principal === null ? {} : { viewerUserId: principal.subject }),
          ...(headers["if-none-match"] === undefined
            ? {}
            : { ifNoneMatch: headers["if-none-match"] }),
        },
        services,
      ),
    );
    // The ordinary transport validates this tagged result; no Response bypass.
    return withEndpointResult(response.body, response.status, response.headers);
  };
}
