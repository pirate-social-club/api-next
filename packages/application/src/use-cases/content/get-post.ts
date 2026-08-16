import { NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import type { M2Actor } from "../../ports.ts";
import { type ContentUseCaseServices, mapContentFailure, validateIdentifier } from "./common.ts";

export type GetPostInput = Readonly<{
  readonly postId: string;
  readonly viewer: M2Actor;
  readonly locale?: string;
}>;

export const getPost = Effect.fn("getPost")(function* (
  input: GetPostInput,
  services: ContentUseCaseServices,
) {
  yield* validateIdentifier(input.postId, "Invalid post identifier");
  if (input.viewer.userId.length === 0 || input.viewer.userId.trim() !== input.viewer.userId) {
    return yield* new NotFound({ message: "Post not found" });
  }
  const location = yield* services.contentStore
    .resolvePost({ postId: input.postId })
    .pipe(Effect.mapError(mapContentFailure));
  if (location === null) return yield* new NotFound({ message: "Post not found" });
  const document = yield* services.contentStore
    .getPost({
      communityId: location.communityId,
      postId: location.postId,
      viewerUserId: input.viewer.userId,
      ...(input.locale === undefined ? {} : { locale: input.locale }),
    })
    .pipe(Effect.mapError(mapContentFailure));
  if (document === null) return yield* new NotFound({ message: "Post not found" });
  return document;
});
