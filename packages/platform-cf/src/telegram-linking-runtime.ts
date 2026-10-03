import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import type { TelegramServices } from "@pirate/application/telegram";
import type { TelegramLinkServices } from "@pirate/application/telegram-linking";
import type { Layer } from "effect";
import { makeControlPlaneTelegramLinkStore } from "./telegram-linking-repository.ts";
import { makeTelegramOidcClient } from "./telegram-oidc.ts";

export interface TelegramLinkBindings {
  readonly TELEGRAM_LINKING_ENABLED?: string;
  readonly TELEGRAM_LOGIN_CLIENT_ID?: string;
  readonly TELEGRAM_LOGIN_CLIENT_SECRET?: string;
  readonly TELEGRAM_LOGIN_REDIRECT_URI?: string;
}
export function makeTelegramLinkServices(
  bindings: TelegramLinkBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  telegram: TelegramServices | null,
): TelegramLinkServices | null {
  if (bindings.TELEGRAM_LINKING_ENABLED !== "true") return null;
  if (
    !telegram ||
    !bindings.TELEGRAM_LOGIN_CLIENT_ID ||
    !bindings.TELEGRAM_LOGIN_CLIENT_SECRET ||
    !bindings.TELEGRAM_LOGIN_REDIRECT_URI
  )
    throw new Error("Telegram login configuration incomplete");
  return {
    store: makeControlPlaneTelegramLinkStore(runtime),
    vault: telegram.vault,
    oidc: makeTelegramOidcClient({
      clientId: bindings.TELEGRAM_LOGIN_CLIENT_ID,
      clientSecret: bindings.TELEGRAM_LOGIN_CLIENT_SECRET,
      redirectUri: bindings.TELEGRAM_LOGIN_REDIRECT_URI,
    }),
  };
}
