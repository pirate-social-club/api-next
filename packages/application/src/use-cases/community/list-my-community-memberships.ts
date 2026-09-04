import { BadRequest, InternalError, type ListMyCommunityMemberships } from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import { CommunityRepositoryError } from "../../ports.ts";
import { type CommunityServices, isUsableId } from "./services.ts";

export type ListMyCommunityMembershipsInput = Readonly<{
  readonly userId: string;
  readonly query: Schema.Schema.Type<(typeof ListMyCommunityMemberships.request)["query"]>;
}>;

export type ListMyCommunityMembershipsDocument = Schema.Schema.Type<
  typeof ListMyCommunityMemberships.response
>;

export const listMyCommunityMemberships = Effect.fn("listMyCommunityMemberships")(function* (
  input: ListMyCommunityMembershipsInput,
  services: CommunityServices,
): Effect.fn.Return<ListMyCommunityMembershipsDocument, BadRequest | InternalError> {
  if (!isUsableId(input.userId)) {
    return yield* new BadRequest({ message: "Invalid account reference" });
  }

  return yield* services.communityStore
    .listAccountMemberships(input)
    .pipe(
      Effect.mapError((error) =>
        error instanceof CommunityRepositoryError && error.reason === "invalid-cursor"
          ? new BadRequest({ message: "Invalid community membership cursor" })
          : new InternalError({ message: "Community membership lookup failed" }),
      ),
    );
});
