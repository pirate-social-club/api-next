import { BadRequest, InternalError, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import type { ContentStoreService } from "../ports.ts";

export interface VideoAccessAuthorizationServices {
  readonly contentStore: Pick<ContentStoreService, "resolvePost" | "getPost">;
  /** Fresh durable publication, policy and hold check, never projection defaults. */
  readonly authorizePublication: (
    input: Readonly<{ postId: string; communityId: string; viewerUserId?: string }>,
  ) => Effect.Effect<boolean, unknown>;
}

/** Shared by playback and poster access, including conditional poster requests. */
export const authorizeVideoAccess = Effect.fn("authorizeVideoAccess")(function* (
  input: Readonly<{ postId: string; viewerUserId?: string }>,
  services: VideoAccessAuthorizationServices,
) {
  if (
    !input.postId.trim() ||
    input.postId.trim() !== input.postId ||
    input.postId.length > 512 ||
    input.postId.includes("\u0000")
  )
    return yield* new BadRequest({ message: "Invalid post identifier" });
  const location = yield* services.contentStore
    .resolvePost({ postId: input.postId })
    .pipe(Effect.mapError(() => new InternalError({ message: "Video delivery unavailable" })));
  if (location === null || location.postId !== input.postId)
    return yield* new NotFound({ message: "Video not found" });
  const result = yield* services.contentStore
    .getPost({ ...location, viewerUserId: input.viewerUserId ?? "public-post-anonymous" })
    .pipe(Effect.mapError(() => new InternalError({ message: "Video delivery unavailable" })));
  if (
    result === null ||
    !("post" in result) ||
    result.post.id !== input.postId ||
    result.post.community !== location.communityId ||
    result.post.post_type !== "video" ||
    result.post.status !== "published" ||
    result.video?.soundtrack.kind !== "original_audio"
  )
    return yield* new NotFound({ message: "Video not found" });
  const allowed = yield* services
    .authorizePublication({
      ...location,
      ...(input.viewerUserId === undefined ? {} : { viewerUserId: input.viewerUserId }),
    })
    .pipe(Effect.mapError(() => new InternalError({ message: "Video delivery unavailable" })));
  if (!allowed) return yield* new NotFound({ message: "Video not found" });
  return { location, video: result.video };
});
