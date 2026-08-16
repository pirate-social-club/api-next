import { type FollowCommunity, MembershipRequired, NotFound } from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import { CommunityRepositoryError, type FollowDocument, type M2Actor } from "../../ports.ts";
import { type CommunityServices, isMember, isUsableId } from "./services.ts";

export type FollowCommunityInput = Readonly<{
  readonly communityId: string;
  readonly actor: M2Actor;
  readonly body?: Schema.Schema.Type<(typeof FollowCommunity.request)["body"]>;
}>;

export const followCommunity = Effect.fn("followCommunity")(function* (
  input: FollowCommunityInput,
  services: CommunityServices,
): Effect.fn.Return<FollowDocument, MembershipRequired | NotFound> {
  if (!isUsableId(input.communityId) || !isUsableId(input.actor.userId)) {
    return yield* new NotFound({ message: "Community not found" });
  }

  const preview = yield* services.communityStore
    .getPreview({ communityId: input.communityId, viewerUserId: input.actor.userId })
    .pipe(Effect.mapError(() => new NotFound({ message: "Community not found" })));
  if (preview === null) return yield* new NotFound({ message: "Community not found" });

  const status = yield* services.communityStore
    .membershipStatus({ communityId: input.communityId, userId: input.actor.userId })
    .pipe(Effect.mapError(() => new NotFound({ message: "Community not found" })));
  if (!isMember(status)) {
    return yield* new MembershipRequired({ message: "Community membership is required" });
  }

  return yield* services.communityStore
    .follow({ communityId: input.communityId, actor: input.actor })
    .pipe(
      Effect.mapError((error) =>
        error instanceof CommunityRepositoryError && error.reason === "membership-required"
          ? new MembershipRequired({ message: "Community membership is required" })
          : new NotFound({ message: "Community not found" }),
      ),
    );
});
