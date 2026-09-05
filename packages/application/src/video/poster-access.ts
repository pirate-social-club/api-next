import { InternalError, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import {
  authorizeVideoAccess,
  type VideoAccessAuthorizationServices,
} from "./access-authorization.ts";

export interface VideoPosterAccessServices extends VideoAccessAuthorizationServices {
  readonly resolvePoster: (
    input: Readonly<{ postId: string; communityId: string; artifactRef: string }>,
  ) => Effect.Effect<Readonly<{ artifactRef: string; etag: string }> | null, unknown>;
}

/** Internal serving descriptor, never a JSON response exposing the artifact locator.
 * Authorize first; transport must not intercept ETags before this call.
 */
export const getVideoPosterAccess = Effect.fn("getVideoPosterAccess")(function* (
  input: Readonly<{ postId: string; viewerUserId?: string; ifNoneMatch?: string }>,
  services: VideoPosterAccessServices,
) {
  const { location, video } = yield* authorizeVideoAccess(input, services);
  if (video.thumbnail.status !== "ready")
    return yield* new NotFound({ message: "Video not found" });
  const poster = yield* services
    .resolvePoster({ ...location, artifactRef: video.thumbnail.artifact_ref })
    .pipe(Effect.mapError(() => new InternalError({ message: "Video delivery unavailable" })));
  if (poster === null) return yield* new NotFound({ message: "Video not found" });
  if (
    poster.artifactRef !== video.thumbnail.artifact_ref ||
    !/^"[\x21\x23-\x7e]{1,128}"$/u.test(poster.etag)
  )
    return yield* new InternalError({ message: "Video delivery unavailable" });
  const matches =
    input.ifNoneMatch?.split(",").some((value) => {
      const tag = value.trim();
      return tag === "*" || tag.replace(/^W\//u, "") === poster.etag;
    }) ?? false;
  return {
    status: matches ? (304 as const) : (200 as const),
    artifactRef: poster.artifactRef,
    etag: poster.etag,
    cacheControl: "private, no-cache" as const,
  };
});
