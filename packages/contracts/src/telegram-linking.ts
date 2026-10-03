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
const Token = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));
const TelegramId = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,15}$/u));
const Revision = Schema.Int.check(Schema.isGreaterThan(0));
const errors = [
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RateLimited,
];
const auth = Auth.user({ browserSessionOnly: true });
const path = Schema.Struct({ transactionId: Token });
export const TelegramLinkTransaction = Schema.Struct({
  id: Token,
  state: Schema.Literals(["pending", "exchanging", "verified", "completed", "failed", "cancelled"]),
  expires_at: Schema.String,
  community_id: Id,
  community_name: Schema.String,
  bot_id: TelegramId,
  bot_username: Schema.String,
  post_id: Id,
  telegram_user_id: Schema.NullOr(TelegramId),
});
export type TelegramLinkTransaction = Schema.Schema.Type<typeof TelegramLinkTransaction>;
export const TelegramLinkGrant = Schema.Struct({
  community_id: Id,
  bot_id: TelegramId,
  persona_id: Id,
  revision: Revision,
  telegram_user_id: TelegramId,
});
export type TelegramLinkGrant = Schema.Schema.Type<typeof TelegramLinkGrant>;
export const TelegramLinkAccount = Schema.Struct({
  telegram_user_ids: Schema.Array(TelegramId),
  grants: Schema.Array(TelegramLinkGrant),
});
export type TelegramLinkAccount = Schema.Schema.Type<typeof TelegramLinkAccount>;
export const GetMyTelegramLinks = endpoint({
  method: "GET",
  path: "/telegram/link/account",
  auth,
  response: TelegramLinkAccount,
  errors,
});
export const StartTelegramLink = endpoint({
  method: "POST",
  path: "/telegram/link/transactions",
  auth,
  request: { body: Schema.Struct({ navigation_reference: Token }) },
  response: Schema.Struct({
    transaction: TelegramLinkTransaction,
    authorization_url: Schema.String,
  }),
  errors,
});
export const GetTelegramLink = endpoint({
  method: "GET",
  path: "/telegram/link/transactions/:transactionId",
  auth,
  request: { path },
  response: TelegramLinkTransaction,
  errors,
});
export const VerifyTelegramLink = endpoint({
  method: "POST",
  path: "/telegram/link/transactions/:transactionId/verify",
  auth,
  request: {
    path,
    body: Schema.Struct({
      state: Token,
      code: Schema.NonEmptyString.check(Schema.isMaxLength(2048)),
    }),
  },
  response: TelegramLinkTransaction,
  errors,
});
export const ConfirmTelegramLink = endpoint({
  method: "POST",
  path: "/telegram/link/transactions/:transactionId/confirm",
  auth,
  request: { path, body: Schema.Struct({ persona_id: Id }) },
  response: TelegramLinkGrant,
  errors,
});
export const RevokeTelegramLinkGrant = endpoint({
  method: "POST",
  path: "/telegram/link/grants/revoke",
  auth,
  request: { body: Schema.Struct({ community_id: Id, bot_id: TelegramId }) },
  response: Schema.Struct({ revoked: Schema.Literal(true) }),
  errors,
});
export const UnlinkTelegramAccount = endpoint({
  method: "POST",
  path: "/telegram/link/association/unlink",
  auth,
  request: { body: Schema.Struct({ telegram_user_id: TelegramId }) },
  response: Schema.Struct({ unlinked: Schema.Literal(true) }),
  errors,
});
export const telegramLinkingRegistry = {
  GetMyTelegramLinks,
  StartTelegramLink,
  GetTelegramLink,
  VerifyTelegramLink,
  ConfirmTelegramLink,
  RevokeTelegramLinkGrant,
  UnlinkTelegramAccount,
};
