import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import type { TelegramStore } from "@pirate/application/telegram";
import { Effect, type Layer } from "effect";
import { makeControlPlanePublicPostSlugStore } from "./public-post-slug-repository.ts";
import { makeControlPlaneRewardProjectionStore } from "./reward-projection-repository.ts";
import { makeTelegramDatabase } from "./telegram-database.ts";
import { makeTelegramDeliveryStore } from "./telegram-delivery-store.ts";
import { makeTelegramInboxStore } from "./telegram-inbox-store.ts";
import { makeTelegramPublicContentStore } from "./telegram-public-content-store.ts";
import { makeTelegramPublicationPoster } from "./telegram-publication-media.ts";
import { makeTelegramSettingsStore } from "./telegram-settings-store.ts";
import { makeTelegramSetupStore } from "./telegram-setup-store.ts";
import { makeTelegramStageStore } from "./telegram-stage-store.ts";
import { makeVideoPublicationAuthorization } from "./video-access-authorization.ts";
import { makeTelegramVideoSource } from "./video-post-source-authority.ts";
import { makeVideoPosterAuthority } from "./video-poster-authority.ts";

export function makeControlPlaneTelegramStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  publicOrigin: string,
): TelegramStore {
  const db = makeTelegramDatabase(runtime);
  const authorizePoster = makeVideoPublicationAuthorization(runtime);
  const resolvePosterAuthority = makeVideoPosterAuthority(runtime);
  const videoSource = makeTelegramVideoSource(db);
  const publicationPoster = makeTelegramPublicationPoster({
    authorize: (postId, communityId) => Effect.runPromise(authorizePoster({ postId, communityId })),
    posterArtifactRef: async (postId, communityId) => {
      const rows = await db.query(
        "SELECT poster_artifact_ref FROM media_publication_projections WHERE community_id=$1 AND post_id=$2 AND media_kind='video'",
        [communityId, postId],
      );
      const value = rows[0]?.poster_artifact_ref;
      return typeof value === "string" && value.length > 0 ? value : null;
    },
    resolvePoster: (identity) => Effect.runPromise(resolvePosterAuthority(identity)),
  });
  return {
    publicationPoster,
    async publicationVideo(post) {
      const allowed = await Effect.runPromise(
        authorizePoster({ postId: post.id, communityId: post.communityId }),
      );
      return allowed ? videoSource(post) : null;
    },
    ...makeTelegramSettingsStore(db),
    ...makeTelegramDeliveryStore(db),
    ...makeTelegramInboxStore(db),
    ...makeTelegramStageStore(db),
    ...makeTelegramSetupStore(db),
    ...makeTelegramPublicContentStore({
      db,
      routes: makeControlPlanePublicPostSlugStore(runtime),
      rewards: makeControlPlaneRewardProjectionStore(runtime),
      publicOrigin,
    }),
    async startPrivateChat(communityId, epoch, userId) {
      await db.query(
        "INSERT INTO community_telegram_private_chats(community_id,bot_epoch,telegram_user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [communityId, epoch, userId],
      );
    },
    async privateChatStarted(communityId, epoch, userId) {
      return (
        (
          await db.query(
            "SELECT 1 FROM community_telegram_private_chats WHERE community_id=$1 AND bot_epoch=$2 AND telegram_user_id=$3",
            [communityId, epoch, userId],
          )
        ).length > 0
      );
    },
  };
}
