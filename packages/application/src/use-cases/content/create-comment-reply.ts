import { BadRequest } from "@pirate/contracts";
import { Effect } from "effect";
import type { M2Actor } from "../../ports.ts";
import {
  type ContentUseCaseServices,
  validateHumanDirectActor,
  validateIdentifier,
} from "./common.ts";

export type CreateCommentReplyInput = Readonly<{
  readonly parentCommentId: string;
  readonly actor: M2Actor;
  readonly body: unknown;
}>;

export const createCommentReply = Effect.fn("createCommentReply")(function* (
  input: CreateCommentReplyInput,
  _services: ContentUseCaseServices,
) {
  yield* validateIdentifier(input.parentCommentId, "Invalid comment identifier");
  yield* validateHumanDirectActor(input.actor);
  return yield* new BadRequest({
    message: "Comment replies are unavailable until the Order 6 runtime lane lands",
  });
});
