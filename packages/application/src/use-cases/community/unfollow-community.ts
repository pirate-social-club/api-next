import { NotFound, type UnfollowCommunity } from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import type { M2Actor, UnfollowDocument } from "../../ports.ts";
import { type CommunityServices, isUsableId } from "./services.ts";

export type UnfollowCommunityInput = Readonly<{
  readonly communityId: string;
  readonly actor: M2Actor;
  readonly body?: Schema.Schema.Type<(typeof UnfollowCommunity.request)["body"]>;
}>;

export const unfollowCommunity = Effect.fn("unfollowCommunity")(function* (
  input: UnfollowCommunityInput,
  services: CommunityServices,
): Effect.fn.Return<UnfollowDocument, NotFound> {
  if (!isUsableId(input.communityId) || !isUsableId(input.actor.userId)) {
    return yield* new NotFound({ message: "Community not found" });
  }

  const preview = yield* services.communityStore
    .getPreview({ communityId: input.communityId, viewerUserId: input.actor.userId })
    .pipe(Effect.mapError(() => new NotFound({ message: "Community not found" })));
  if (preview === null) return yield* new NotFound({ message: "Community not found" });

  return yield* services.communityStore
    .unfollow({ communityId: input.communityId, actor: input.actor })
    .pipe(Effect.mapError(() => new NotFound({ message: "Community not found" })));
});
