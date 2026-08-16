import { type GetJoinEligibility, InternalError, NotFound } from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import { CommunityRepositoryError, type JoinEligibilityDocument } from "../../ports.ts";
import { type CommunityServices, isUsableId } from "./services.ts";

export type GetJoinEligibilityInput = Readonly<{
  readonly communityId: string;
  readonly userId: string;
}>;

export type GetJoinEligibilityDocument = Schema.Schema.Type<typeof GetJoinEligibility.response>;

export const getJoinEligibility = Effect.fn("getJoinEligibility")(function* (
  input: GetJoinEligibilityInput,
  services: CommunityServices,
): Effect.fn.Return<GetJoinEligibilityDocument, InternalError | NotFound> {
  if (!isUsableId(input.communityId) || !isUsableId(input.userId)) {
    return yield* new NotFound({ message: "Community not found" });
  }

  const eligibility = yield* services.communityStore
    .getJoinEligibility(input)
    .pipe(
      Effect.mapError((error) =>
        error instanceof CommunityRepositoryError && error.reason === "not-found"
          ? new NotFound({ message: "Community not found" })
          : new InternalError({ message: "Community eligibility lookup failed" }),
      ),
    );
  if (eligibility === null) return yield* new NotFound({ message: "Community not found" });
  return eligibility satisfies JoinEligibilityDocument;
});
