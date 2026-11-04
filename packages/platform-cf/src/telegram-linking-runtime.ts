import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import type { TelegramServices } from "@pirate/application/telegram";
import type { TelegramLinkServices } from "@pirate/application/telegram-linking";
import type { Layer } from "effect";
import { assertTelegramRuntimePrivileges } from "./telegram-activation-privileges.ts";
import {
  decodeTelegramConfiguration,
  decodeTelegramCredentials,
  type TelegramConfigurationBindings,
} from "./telegram-configuration.ts";
import { makeControlPlaneTelegramLinkStore } from "./telegram-linking-repository.ts";
import { makeTelegramOidcClient } from "./telegram-oidc.ts";
import { logTelegramSetupFailure } from "./telegram-setup-diagnostics.ts";

export type TelegramLinkBindings = TelegramConfigurationBindings;
async function buildTelegramLinkServices(
  bindings: TelegramLinkBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  telegram: TelegramServices | null,
): Promise<TelegramLinkServices | null> {
  const config = decodeTelegramConfiguration(bindings);
  if (!config.linking_enabled) return null;
  const credentials = decodeTelegramCredentials(bindings);
  if (
    !telegram ||
    !config.login_client_id ||
    !credentials.login_client_secret ||
    !config.login_redirect_uri
  )
    throw new Error("Telegram login configuration incomplete");
  await assertTelegramRuntimePrivileges(runtime);
  return {
    store: makeControlPlaneTelegramLinkStore(runtime),
    vault: telegram.vault,
    oidc: makeTelegramOidcClient({
      clientId: config.login_client_id,
      clientSecret: credentials.login_client_secret,
      redirectUri: config.login_redirect_uri,
    }),
  };
}

export async function makeTelegramLinkServices(
  bindings: TelegramLinkBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  telegram: TelegramServices | null,
): Promise<TelegramLinkServices | null> {
  try {
    return await buildTelegramLinkServices(bindings, runtime, telegram);
  } catch (error) {
    logTelegramSetupFailure("linking", error);
    return null;
  }
}
