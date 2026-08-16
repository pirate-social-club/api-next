import { BadRequest, CastPostVote, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import type { M2Actor } from "../../ports.ts";
import {
  type ContentUseCaseServices,
  decodeBody,
  mapContentFailure,
  validateIdentifier,
} from "./common.ts";

export type CastPostVoteInput = Readonly<{
  readonly postId: string;
  readonly actor: M2Actor;
  readonly body: unknown;
}>;

export const castPostVote = Effect.fn("castPostVote")(function* (
  input: CastPostVoteInput,
  services: ContentUseCaseServices,
) {
  yield* validateIdentifier(input.postId, "Invalid post identifier");
  if (input.actor.userId.length === 0 || input.actor.userId.trim() !== input.actor.userId) {
    return yield* new BadRequest({ message: "Invalid actor" });
  }
  const body = yield* decodeBody(CastPostVote.request.body, input.body);
  const location = yield* services.contentStore
    .resolvePost({ postId: input.postId })
    .pipe(Effect.mapError(mapContentFailure));
  if (location === null) return yield* new NotFound({ message: "Post not found" });
  return yield* services.contentStore
    .castPostVote({
      communityId: location.communityId,
      postId: location.postId,
      actor: input.actor,
      body,
    })
    .pipe(Effect.mapError(mapContentFailure));
});
