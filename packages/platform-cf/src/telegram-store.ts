import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import type { TelegramStore } from "@pirate/application/telegram";
import type { Layer } from "effect";
import { makeControlPlanePublicPostSlugStore } from "./public-post-slug-repository.ts";
import { makeControlPlaneRewardProjectionStore } from "./reward-projection-repository.ts";
import { makeTelegramDatabase } from "./telegram-database.ts";
import { makeTelegramDeliveryStore } from "./telegram-delivery-store.ts";
import { makeTelegramInboxStore } from "./telegram-inbox-store.ts";
import { makeTelegramPublicContentStore } from "./telegram-public-content-store.ts";
import { makeTelegramSettingsStore } from "./telegram-settings-store.ts";
import { makeTelegramSetupStore } from "./telegram-setup-store.ts";

export function makeControlPlaneTelegramStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  publicOrigin: string,
): TelegramStore {
  const db = makeTelegramDatabase(runtime);
  return {
    ...makeTelegramSettingsStore(db),
    ...makeTelegramDeliveryStore(db),
    ...makeTelegramInboxStore(db),
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
