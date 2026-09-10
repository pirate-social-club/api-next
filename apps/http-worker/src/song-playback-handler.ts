import {
  getSongPlaybackAccess,
  type SongPlaybackServices,
} from "@pirate/application/use-cases/content/song-playback";
import { AuthError, CreateSongPlaybackAccess } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { type DecodedRequest, withEndpointResult } from "./transport.ts";
export function makeSongPlaybackHandler(services: SongPlaybackServices) {
  return async (request: DecodedRequest) => {
    const principal = request.principal;
    if (principal !== null && principal.kind !== "user" && principal.kind !== "admin")
      throw new AuthError({ message: "Authorization failed" });
    const { postId } = Schema.decodeUnknownSync(CreateSongPlaybackAccess.request.path)(
      request.params,
    );
    const body = await Effect.runPromise(
      getSongPlaybackAccess(
        {
          postId,
          ...(principal === null ? {} : { viewerUserId: principal.subject }),
          trustedSource: request.edgeClientIp ?? "",
        },
        services,
      ),
    );
    return withEndpointResult(body, 200, { "cache-control": "private, no-store" });
  };
}
