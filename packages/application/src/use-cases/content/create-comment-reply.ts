import { BadRequest, CreateCommentReply, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import type { M2Actor } from "../../ports.ts";
import {
  type ContentUseCaseServices,
  canonicalBodyHash,
  decodeBody,
  mapContentFailure,
  validateHumanDirectActor,
  validateIdentifier,
  validPublicHumanDirectComment,
} from "./common.ts";

export type CreateCommentReplyInput = Readonly<{
  readonly parentCommentId: string;
  readonly actor: M2Actor;
  readonly body: unknown;
}>;

export const createCommentReply = Effect.fn("createCommentReply")(function* (
  input: CreateCommentReplyInput,
  services: ContentUseCaseServices,
) {
  yield* validateIdentifier(input.parentCommentId, "Invalid comment identifier");
  yield* validateHumanDirectActor(input.actor);
  const body = yield* decodeBody(CreateCommentReply.request.body, input.body);
  if (
    !validPublicHumanDirectComment(body) ||
    typeof body.body !== "string" ||
    body.body.trim().length === 0
  ) {
    return yield* new BadRequest({
      message: "Only public human body-only replies are supported",
    });
  }

  const location = yield* services.contentStore
    .resolveComment({ commentId: input.parentCommentId })
    .pipe(Effect.mapError(mapContentFailure));
  if (location === null) return yield* new NotFound({ message: "Comment not found" });
  const bodyHash = yield* canonicalBodyHash(body);
  return yield* services.contentStore
    .createCommentReply({
      communityId: location.communityId,
      postId: location.postId,
      parentCommentId: location.commentId,
      actor: input.actor,
      body,
      idempotencyBodyHash: bodyHash,
    })
    .pipe(Effect.mapError(mapContentFailure));
});
