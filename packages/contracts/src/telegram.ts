import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RateLimited,
} from "./errors.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Text = Schema.String.check(Schema.isMaxLength(4000));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100000 }));
const Path = Schema.Struct({ communityId: Id });
const Fence = { expected_revision: Revision, idempotency_key: Id };
const errors = [
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RateLimited,
];

export const CommunityAssistantPolicy = Schema.Struct({
  enabled: Schema.Boolean,
  model: Schema.String.check(Schema.isMaxLength(200)),
  instructions: Text,
  voice_enabled: Schema.Boolean,
  voice_id: Schema.String.check(Schema.isMaxLength(128)),
  voice_model: Schema.String.check(Schema.isMaxLength(128)),
  voice_reply_mode: Schema.Literals(["match_input", "always", "on_request"]),
  user_daily_messages: Limit,
  community_daily_messages: Limit,
  daily_speech_characters: Limit,
  remember_conversations: Schema.Boolean,
});
export type CommunityAssistantPolicy = Schema.Schema.Type<typeof CommunityAssistantPolicy>;

export const TelegramCredentialStatus = Schema.Struct({
  status: Schema.Literals(["missing", "valid", "invalid"]),
  checked_at: Schema.NullOr(Schema.String),
});

export const TelegramIntegration = Schema.Struct({
  community_id: Id,
  revision: Revision,
  status: Schema.Literals(["disconnected", "configuring", "ready", "error"]),
  bot_username: Schema.NullOr(Schema.String),
  channel: Schema.NullOr(
    Schema.Struct({ title: Schema.String, username: Schema.NullOr(Schema.String) }),
  ),
  automatic_publishing: Schema.Boolean,
  assistant: CommunityAssistantPolicy,
  openrouter: TelegramCredentialStatus,
  elevenlabs: TelegramCredentialStatus,
  last_error: Schema.NullOr(Schema.String),
});
export type TelegramIntegration = Schema.Schema.Type<typeof TelegramIntegration>;

export const TelegramDelivery = Schema.Struct({
  id: Id,
  kind: Schema.Literals(["publication", "reply", "voice", "setup"]),
  post_id: Schema.NullOr(Id),
  state: Schema.Literals([
    "pending",
    "sending",
    "delivered",
    "failed",
    "uncertain",
    "withdrawn",
    "cancelled",
  ]),
  attempt_count: Revision,
  last_error: Schema.NullOr(Schema.String),
  created_at: Schema.String,
});
export type TelegramDelivery = Schema.Schema.Type<typeof TelegramDelivery>;
export const TelegramChannelSetup = Schema.Struct({
  id: Id,
  state: Schema.Literals(["pending", "selected", "completed", "expired"]),
  deep_link: Schema.NullOr(Schema.String),
  channel_title: Schema.NullOr(Schema.String),
  expires_at: Schema.String,
});
export type TelegramChannelSetup = Schema.Schema.Type<typeof TelegramChannelSetup>;

export const GetCommunityTelegram = endpoint({
  method: "GET",
  path: "/communities/:communityId/telegram",
  auth: Auth.user(),
  request: { path: Path },
  response: TelegramIntegration,
  errors,
});
export const ConnectCommunityTelegram = endpoint({
  method: "POST",
  path: "/communities/:communityId/telegram/connect",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    path: Path,
    body: Schema.Struct({ ...Fence, token: Schema.NonEmptyString.check(Schema.isMaxLength(512)) }),
  },
  response: TelegramIntegration,
  errors,
});
export const UpdateCommunityTelegram = endpoint({
  method: "POST",
  path: "/communities/:communityId/telegram/settings",
  auth: Auth.user(),
  request: {
    path: Path,
    body: Schema.Struct({
      ...Fence,
      automatic_publishing: Schema.Boolean,
      assistant: CommunityAssistantPolicy,
    }),
  },
  response: TelegramIntegration,
  errors,
});
export const DisconnectCommunityTelegram = endpoint({
  method: "POST",
  path: "/communities/:communityId/telegram/disconnect",
  auth: Auth.user({ browserSessionOnly: true }),
  request: { path: Path, body: Schema.Struct(Fence) },
  response: TelegramIntegration,
  errors,
});
export const SetCommunityAssistantCredential = endpoint({
  method: "POST",
  path: "/communities/:communityId/telegram/credentials",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    path: Path,
    body: Schema.Struct({
      ...Fence,
      provider: Schema.Literals(["openrouter", "elevenlabs"]),
      key: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
    }),
  },
  response: TelegramIntegration,
  errors,
});
export const ListCommunityAssistantModels = endpoint({
  method: "GET",
  path: "/communities/:communityId/telegram/models",
  auth: Auth.user(),
  request: { path: Path },
  response: Schema.Struct({
    items: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  }),
  errors,
});
export const ListCommunityAssistantVoices = endpoint({
  method: "GET",
  path: "/communities/:communityId/telegram/voices",
  auth: Auth.user(),
  request: { path: Path },
  response: Schema.Struct({
    items: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  }),
  errors,
});
export const CreateTelegramChannelSetup = endpoint({
  method: "POST",
  path: "/communities/:communityId/telegram/channel-setup",
  auth: Auth.user({ browserSessionOnly: true }),
  request: { path: Path, body: Schema.Struct(Fence) },
  response: TelegramChannelSetup,
  errors,
});
export const GetTelegramChannelSetup = endpoint({
  method: "GET",
  path: "/communities/:communityId/telegram/channel-setup/:setupId",
  auth: Auth.user(),
  request: { path: Schema.Struct({ communityId: Id, setupId: Id }) },
  response: TelegramChannelSetup,
  errors,
});
export const ConfirmTelegramChannelSetup = endpoint({
  method: "POST",
  path: "/communities/:communityId/telegram/channel-setup/:setupId/confirm",
  auth: Auth.user({ browserSessionOnly: true }),
  request: { path: Schema.Struct({ communityId: Id, setupId: Id }), body: Schema.Struct(Fence) },
  response: TelegramIntegration,
  errors,
});
export const PublishCommunityTelegramPosts = endpoint({
  method: "POST",
  path: "/communities/:communityId/telegram/publications",
  auth: Auth.user(),
  request: {
    path: Path,
    body: Schema.Struct({ ...Fence, post_ids: Schema.Array(Id).check(Schema.isMaxLength(20)) }),
  },
  response: Schema.Struct({ queued: Revision }),
  errors,
});
export const ListCommunityTelegramDeliveries = endpoint({
  method: "GET",
  path: "/communities/:communityId/telegram/deliveries",
  auth: Auth.user(),
  request: { path: Path, query: Schema.Struct({ before: Schema.optional(Id) }) },
  response: Schema.Struct({
    items: Schema.Array(TelegramDelivery),
    next_cursor: Schema.NullOr(Id),
  }),
  errors,
});
export const ResolveCommunityTelegramDelivery = endpoint({
  method: "POST",
  path: "/communities/:communityId/telegram/deliveries/:deliveryId/resolve",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    path: Schema.Struct({ communityId: Id, deliveryId: Id }),
    body: Schema.Struct({
      ...Fence,
      resolution: Schema.Literals(["confirmed", "not_sent", "cancel"]),
      message_id: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
  },
  response: TelegramDelivery,
  errors,
});

/** Telegram owns this callback credential; no browser session is exchanged. */
export const ReceiveTelegramUpdate = endpoint({
  method: "POST",
  path: "/telegram/bots/:webhookId/updates",
  auth: Auth.public(),
  request: {
    path: Schema.Struct({ webhookId: Id }),
    headers: Schema.Struct({
      "x-telegram-bot-api-secret-token": Schema.NonEmptyString.check(Schema.isMaxLength(256)),
    }),
    body: Schema.Struct({
      update_id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      message: Schema.optional(Schema.Unknown),
      callback_query: Schema.optional(Schema.Unknown),
      my_chat_member: Schema.optional(Schema.Unknown),
    }),
  },
  response: Schema.Struct({ ok: Schema.Literal(true) }),
  errors,
});

export const telegramRegistry = {
  GetCommunityTelegram,
  ConnectCommunityTelegram,
  UpdateCommunityTelegram,
  DisconnectCommunityTelegram,
  SetCommunityAssistantCredential,
  ListCommunityAssistantModels,
  ListCommunityAssistantVoices,
  CreateTelegramChannelSetup,
  GetTelegramChannelSetup,
  ConfirmTelegramChannelSetup,
  PublishCommunityTelegramPosts,
  ListCommunityTelegramDeliveries,
  ResolveCommunityTelegramDelivery,
  ReceiveTelegramUpdate,
};
