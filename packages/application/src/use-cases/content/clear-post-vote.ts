import { ClearPostVote, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import type { M2Actor } from "../../ports.ts";
import {
  type ContentUseCaseServices,
  decodeBody,
  mapContentFailure,
  validateHumanDirectActor,
  validateIdentifier,
} from "./common.ts";

export type ClearPostVoteInput = Readonly<{
  readonly postId: string;
  readonly actor: M2Actor;
  readonly body?: unknown;
}>;

export const clearPostVote = Effect.fn("clearPostVote")(function* (
  input: ClearPostVoteInput,
  services: ContentUseCaseServices,
) {
  yield* validateIdentifier(input.postId, "Invalid post identifier");
  yield* validateHumanDirectActor(input.actor);
  const body = yield* decodeBody(ClearPostVote.request.body, input.body ?? {});
  const location = yield* services.contentStore
    .resolvePost({ postId: input.postId })
    .pipe(Effect.mapError(mapContentFailure));
  if (location === null) return yield* new NotFound({ message: "Post not found" });
  return yield* services.contentStore
    .clearPostVote({
      communityId: location.communityId,
      postId: location.postId,
      actor: input.actor,
      body,
    })
    .pipe(Effect.mapError(mapContentFailure));
});
