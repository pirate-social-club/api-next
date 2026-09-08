import type { RewardProjectionStore } from "@pirate/application";
import type { PublicTelegramPost, TelegramStore } from "@pirate/application/telegram";
import { formatTelegramAtomicAmount, telegramPublicContentAllowed } from "@pirate/domain/telegram";
import { Effect } from "effect";
import type { PublicPostSlugStore } from "./public-post-slug-repository.ts";
import type { TelegramDatabase } from "./telegram-database.ts";

export function makeTelegramPublicContentStore(input: {
  db: TelegramDatabase;
  routes: Pick<PublicPostSlugStore, "getCanonicalRouteByPostId">;
  rewards: Pick<RewardProjectionStore, "listPublicSongAssetBonuses" | "findPublicSongPool">;
  publicOrigin: string;
}): Pick<TelegramStore, "publicPosts" | "publicationCandidates"> {
  const origin = new URL(input.publicOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password)
    throw new Error("Invalid Telegram public origin");
  return {
    async publicPosts(communityId, postIds, kind) {
      const rows = await input.db.query(
        `SELECT p.post_id,p.community_id,p.title,p.body,p.post_type,p.status,p.visibility,p.content_rating,c.status AS community_status
        FROM posts p JOIN communities c USING(community_id) WHERE p.community_id=$1 AND p.status='published' AND p.visibility='public'
        AND p.content_rating='general' AND c.status='active' AND ($2::text[] IS NULL OR p.post_id=ANY($2))
        AND ($3::text IS NULL OR p.post_type=$3) ORDER BY p.created_at DESC,p.post_id DESC LIMIT 20`,
        [communityId, postIds && postIds.length > 0 ? postIds : null, kind ?? null],
      );
      const posts: PublicTelegramPost[] = [];
      for (const row of rows) {
        if (
          !telegramPublicContentAllowed({
            communityStatus: String(row.community_status),
            status: String(row.status),
            visibility: String(row.visibility),
            rating: row.content_rating as string | null,
          })
        )
          continue;
        const id = String(row.post_id);
        const route = await Effect.runPromise(
          input.routes.getCanonicalRouteByPostId({ postId: id }),
        );
        if (!route?.canonicalPath) continue;
        const url = new URL(route.canonicalPath, origin).href;
        const song = row.post_type === "song";
        const rewardParts: string[] = [];
        if (song) {
          const currentOffers = new Set(
            (
              await input.db.query(
                "SELECT offer_id FROM song_reward_offers WHERE community_id=$1 AND post_id=$2 AND status='active' AND starts_at<=clock_timestamp() AND ends_at>clock_timestamp()",
                [communityId, id],
              )
            ).map((offer) => String(offer.offer_id)),
          );
          const bonuses = await Effect.runPromise(
            input.rewards.listPublicSongAssetBonuses({ accountId: null, communityId, postId: id }),
          );
          for (const bonus of bonuses) {
            if (
              bonus.offerStatus === "active" &&
              currentOffers.has(bonus.offerId) &&
              bonus.legStatus === "active" &&
              bonus.claimedCount < bonus.maxClaims &&
              bonus.availableInventoryAtomic >= bonus.amountPerClaimAtomic
            ) {
              rewardParts.push(
                `${formatTelegramAtomicAmount(String(bonus.amountPerClaimAtomic), bonus.tokenDecimals)} ${bonus.tokenSymbol} bonus available, subject to eligibility and remaining inventory.`,
              );
            }
          }
          const pool = await Effect.runPromise(
            input.rewards.findPublicSongPool({ communityId, postId: id }),
          );
          if (
            pool?.offerStatus === "active" &&
            currentOffers.has(pool.offerId) &&
            pool.legStatus === "active" &&
            pool.drawing?.state === "entry_open" &&
            Date.parse(pool.drawing.entryCutoffAt) > Date.now()
          )
            rewardParts.push(
              "Song reward pool entries are open. See Pirate for activities and eligibility.",
            );
        }
        posts.push({
          id,
          communityId,
          title: String(row.title ?? ""),
          body: String(row.body ?? "").slice(0, 4000),
          kind: String(row.post_type),
          url,
          studyUrl: song ? `${url}/study` : null,
          karaokeUrl: song ? `${url}/karaoke` : null,
          media: null,
          rewardText: rewardParts.length ? rewardParts.join("\n") : null,
        });
      }
      return posts;
    },
    async publicationCandidates() {
      // Existing copies are always reconsidered, even after automatic sharing is disabled.
      // A bounded least-recently-checked scan also observes moderation changes and reward depletion.
      const rows =
        await input.db.query(`WITH candidates AS (SELECT p.community_id,p.post_id,d.delivery_id FROM posts p JOIN community_telegram_integrations i USING(community_id)
        LEFT JOIN community_telegram_deliveries d ON d.community_id=p.community_id AND d.post_id=p.post_id AND d.bot_epoch=i.bot_epoch AND d.kind='publication'
        WHERE i.record->>'status'='ready' AND i.record->>'channelId' IS NOT NULL
        AND (d.delivery_id IS NOT NULL OR (i.record->>'automaticSince' IS NOT NULL AND p.created_at>=(i.record->>'automaticSince')::timestamptz))
        ORDER BY d.updated_at ASC NULLS FIRST,p.created_at,p.post_id LIMIT 50),
        touched AS (UPDATE community_telegram_deliveries SET updated_at=clock_timestamp() WHERE delivery_id IN (SELECT delivery_id FROM candidates) RETURNING delivery_id)
        SELECT community_id,post_id FROM candidates`);
      return rows.map((row) => ({
        communityId: String(row.community_id),
        postId: String(row.post_id),
      }));
    },
  };
}
