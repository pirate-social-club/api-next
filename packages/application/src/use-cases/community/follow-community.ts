import { type FollowCommunity, InternalError, NotFound } from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import { CommunityRepositoryError, type FollowDocument, type M2Actor } from "../../ports.ts";
import { type CommunityServices, isUsableId } from "./services.ts";

export type FollowCommunityInput = Readonly<{
  readonly communityId: string;
  readonly actor: M2Actor;
  readonly body?: Schema.Schema.Type<(typeof FollowCommunity.request)["body"]>;
}>;

export const followCommunity = Effect.fn("followCommunity")(function* (
  input: FollowCommunityInput,
  services: CommunityServices,
): Effect.fn.Return<FollowDocument, InternalError | NotFound> {
  if (!isUsableId(input.communityId) || !isUsableId(input.actor.userId)) {
    return yield* new NotFound({ message: "Community not found" });
  }

  const preview = yield* services.communityStore
    .getPreview({ communityId: input.communityId, viewerUserId: input.actor.userId })
    .pipe(
      Effect.mapError((error) =>
        error instanceof CommunityRepositoryError && error.reason === "not-found"
          ? new NotFound({ message: "Community not found" })
          : new InternalError({ message: "Community preview lookup failed" }),
      ),
    );
  if (preview === null) return yield* new NotFound({ message: "Community not found" });

  return yield* services.communityStore
    .follow({ communityId: input.communityId, actor: input.actor })
    .pipe(
      Effect.mapError((error) =>
        error instanceof CommunityRepositoryError && error.reason === "not-found"
          ? new NotFound({ message: "Community not found" })
          : new InternalError({ message: "Community follow failed" }),
      ),
    );
});
