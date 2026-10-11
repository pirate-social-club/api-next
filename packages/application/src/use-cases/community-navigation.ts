import { BadRequest, type InternalError, type NavigationCommunityV1 } from "@pirate/contracts";
import { Effect } from "effect";

export interface CommunityNavigationStore {
  popular: (limit: number) => Effect.Effect<readonly NavigationCommunityV1[], InternalError>;
  moderated: (
    accountId: string,
    cursor?: string,
  ) => Effect.Effect<readonly NavigationCommunityV1[], BadRequest | InternalError>;
}

export const listPopularCommunities = Effect.fn("listPopularCommunities")(function* (
  input: { limit?: string },
  store: CommunityNavigationStore,
) {
  const limit = input.limit === undefined ? 20 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    return yield* new BadRequest({ message: "Invalid community list limit" });
  return {
    object: "popular_community_list" as const,
    ranked_by: "members" as const,
    items: yield* store.popular(limit),
  };
});

export const listMyModerationCommunities = Effect.fn("listMyModerationCommunities")(function* (
  accountId: string,
  input: { cursor?: string },
  store: CommunityNavigationStore,
) {
  const rows = yield* store.moderated(accountId, input.cursor);
  const items = rows.slice(0, 100);
  return {
    object: "moderation_community_page" as const,
    capability: "moderation.view" as const,
    items,
    next_cursor: rows.length > 100 ? (items.at(-1)?.community_id ?? null) : null,
  };
});
