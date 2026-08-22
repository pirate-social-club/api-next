import { ClearPostVote, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import type { M2Actor } from "../../ports.ts";
import {
  type ContentUseCaseServices,
  canonicalBodyHash,
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
  yield* validateIdentifier(body.idempotency_key, "Invalid idempotency key");
  const location = yield* services.contentStore
    .resolvePost({ postId: input.postId })
    .pipe(Effect.mapError(mapContentFailure));
  if (location === null) return yield* new NotFound({ message: "Post not found" });
  const requestHash = yield* canonicalBodyHash({
    endpoint: "/posts/:postId/clear_vote",
    community_id: location.communityId,
    post_id: location.postId,
    body,
  });
  const replay = yield* services.contentStore
    .replayClearPostVote({
      communityId: location.communityId,
      postId: location.postId,
      actor: input.actor,
      idempotencyKey: body.idempotency_key,
      requestHash,
    })
    .pipe(Effect.mapError(mapContentFailure));
  if (replay !== null) return replay;
  yield* services.contentStore
    .checkVoteAuthority({
      communityId: location.communityId,
      postId: location.postId,
      actor: input.actor,
    })
    .pipe(Effect.mapError(mapContentFailure));
  return yield* services.contentStore
    .clearPostVote({
      communityId: location.communityId,
      postId: location.postId,
      actor: input.actor,
      body,
      requestHash,
    })
    .pipe(Effect.mapError(mapContentFailure));
});
