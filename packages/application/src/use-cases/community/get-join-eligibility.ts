import { type GetJoinEligibility, NotFound } from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import type { JoinEligibilityDocument } from "../../ports.ts";
import { type CommunityServices, isUsableId } from "./services.ts";

export type GetJoinEligibilityInput = Readonly<{
  readonly communityId: string;
  readonly userId: string;
}>;

export type GetJoinEligibilityDocument = Schema.Schema.Type<typeof GetJoinEligibility.response>;

export const getJoinEligibility = Effect.fn("getJoinEligibility")(function* (
  input: GetJoinEligibilityInput,
  services: CommunityServices,
): Effect.fn.Return<GetJoinEligibilityDocument, NotFound> {
  if (!isUsableId(input.communityId) || !isUsableId(input.userId)) {
    return yield* new NotFound({ message: "Community not found" });
  }

  const eligibility = yield* services.communityStore
    .getJoinEligibility(input)
    .pipe(Effect.mapError(() => new NotFound({ message: "Community not found" })));
  if (eligibility === null) return yield* new NotFound({ message: "Community not found" });
  return eligibility satisfies JoinEligibilityDocument;
});
