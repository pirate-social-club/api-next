import {
  getVideoPlaybackAccess,
  type VideoPlaybackAccessServices,
} from "@pirate/application/video/playback-access";
import { AuthError, CreateVideoPlaybackAccess } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { type DecodedRequest, withEndpointResult } from "./transport.ts";

export function makeVideoPlaybackHandler(services: VideoPlaybackAccessServices) {
  return async (request: DecodedRequest) => {
    const principal = request.principal;
    if (principal !== null && principal.kind !== "user" && principal.kind !== "admin")
      throw new AuthError({ message: "Authorization failed" });
    const { postId } = Schema.decodeUnknownSync(CreateVideoPlaybackAccess.request.path)(
      request.params,
    );
    const body = await Effect.runPromise(
      getVideoPlaybackAccess(
        {
          postId,
          ...(principal === null ? {} : { viewerUserId: principal.subject }),
          // Never fall back to a caller-selected forwarding header or a shared anonymous key.
          trustedSource: request.edgeClientIp ?? "",
        },
        services,
      ),
    );
    return withEndpointResult(body, 200, { "cache-control": "private, no-store" });
  };
}
