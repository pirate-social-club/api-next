import { expect, test } from "bun:test";
import type { PublicSongAssetBonusProjection } from "@pirate/application";
import { Effect } from "effect";
import { makeTelegramPublicContentStore } from "./telegram-public-content-store.ts";

test("song discovery excludes expired and exhausted bonuses despite stale active projections", async () => {
  const bonus: PublicSongAssetBonusProjection = {
    qualificationPolicies: null,
    offerId: "current",
    legId: "leg",
    communityId: "community",
    postId: "song",
    offerStatus: "active",
    legStatus: "active",
    chainId: 1,
    tokenAddress: "token",
    tokenDecimals: 6,
    tokenSymbol: "UNIT",
    assetPolicyVersion: "1",
    amountPerClaimAtomic: 1000000n,
    maxClaims: 10,
    claimedCount: 0,
    availableInventoryAtomic: 10000000n,
    viewerState: null,
    viewerCreditId: null,
    viewerCreditState: null,
  };
  let expired = false;
  let exhausted = false;
  let publicRoute = true;
  const store = makeTelegramPublicContentStore({
    publicOrigin: "https://pirate.example.invalid",
    db: {
      query: async (sql) =>
        sql.includes("song_reward_offers")
          ? expired
            ? []
            : [{ offer_id: "current" }]
          : [
              {
                post_id: "song",
                community_id: "community",
                title: "Song",
                body: "Public song",
                post_type: "song",
                status: "published",
                visibility: "public",
                content_rating: "general",
                community_status: "active",
              },
            ],
      transaction: async () => {
        throw new Error("Unexpected transaction");
      },
    },
    routes: {
      getCanonicalRouteByPostId: () =>
        Effect.succeed(
          publicRoute
            ? {
                alias: {
                  slug: "song",
                  postId: "song",
                  slugPolicyVersion: "post-slug-v1",
                  createdAt: "2026-09-08T00:00:00Z",
                },
                post: {
                  postId: "song",
                  communityId: "community",
                  status: "published",
                  postType: "song",
                  visibility: "public",
                  contentRating: "general",
                },
                community: { communityId: "community", status: "active" },
                viewer: {
                  userId: undefined,
                  isMember: false,
                  ratingViewAllowed: true,
                  canRead: true,
                },
                canonicalPath: "/posts/song",
              }
            : null,
        ),
    },
    rewards: {
      listPublicSongAssetBonuses: () =>
        Effect.succeed([
          { ...bonus, availableInventoryAtomic: exhausted ? 0n : bonus.availableInventoryAtomic },
        ]),
      findPublicSongPool: () => Effect.succeed(null),
    },
  });
  expect((await store.publicPosts("community"))[0]?.rewardText).toContain("1 UNIT bonus available");
  expired = true;
  expect((await store.publicPosts("community"))[0]?.rewardText).toBeNull();
  expired = false;
  exhausted = true;
  expect((await store.publicPosts("community"))[0]?.rewardText).toBeNull();
  publicRoute = false;
  expect(await store.publicPosts("community")).toEqual([]);
});
