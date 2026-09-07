import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import {
  configureTelegramBots,
  processTelegramDelivery,
  processTelegramInbox,
  reconcileTelegramPublication,
  type TelegramServices,
} from "@pirate/application/telegram";
import type { Layer } from "effect";
import { makeTelegramApi } from "./telegram-api.ts";
import { makeTelegramAssistantProviders } from "./telegram-assistant-providers.ts";
import { makeTelegramCredentialVault } from "./telegram-credential-vault.ts";
import { makeControlPlaneTelegramStore } from "./telegram-store.ts";

export interface TelegramBindings {
  readonly TELEGRAM_ENABLED?: string;
  readonly TELEGRAM_PUBLIC_ORIGIN?: string;
  readonly TELEGRAM_WEBHOOK_ORIGIN?: string;
  readonly TELEGRAM_CREDENTIAL_ACTIVE_VERSION?: string;
  readonly TELEGRAM_CREDENTIAL_KEYS_JSON?: string;
  readonly TELEGRAM_QUEUE?: {
    send(body: { kind: "inbox" | "delivery"; id: string }): Promise<void>;
  };
}

export async function makeTelegramServices(
  bindings: TelegramBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): Promise<TelegramServices | null> {
  if (bindings.TELEGRAM_ENABLED !== "true") return null;
  if (
    !bindings.TELEGRAM_PUBLIC_ORIGIN ||
    !bindings.TELEGRAM_WEBHOOK_ORIGIN ||
    !bindings.TELEGRAM_CREDENTIAL_ACTIVE_VERSION ||
    !bindings.TELEGRAM_CREDENTIAL_KEYS_JSON ||
    !bindings.TELEGRAM_QUEUE
  )
    throw new Error("Telegram configuration incomplete");
  let keys: Record<string, string>;
  try {
    const value: unknown = JSON.parse(bindings.TELEGRAM_CREDENTIAL_KEYS_JSON);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.values(value).every((entry) => typeof entry === "string")
    )
      throw new Error();
    keys = value as Record<string, string>;
  } catch {
    throw new Error("Telegram credential key ring invalid");
  }
  const queue = bindings.TELEGRAM_QUEUE;
  return {
    store: makeControlPlaneTelegramStore(runtime, bindings.TELEGRAM_PUBLIC_ORIGIN),
    api: makeTelegramApi(fetch),
    providers: makeTelegramAssistantProviders(fetch),
    vault: await makeTelegramCredentialVault({
      activeVersion: bindings.TELEGRAM_CREDENTIAL_ACTIVE_VERSION,
      keys,
    }),
    publicOrigin: bindings.TELEGRAM_PUBLIC_ORIGIN,
    webhookOrigin: bindings.TELEGRAM_WEBHOOK_ORIGIN,
    now: Date.now,
    wake: (work) => queue.send(work),
  };
}

export async function runTelegramMaintenance(services: TelegramServices) {
  await configureTelegramBots(services);
  await services.store.cleanup();
  for (const candidate of await services.store.publicationCandidates())
    await reconcileTelegramPublication(services, candidate.communityId, candidate.postId);
  for (const work of await services.store.pendingWork()) await services.wake(work);
}

export async function consumeTelegramWork(services: TelegramServices, body: unknown) {
  if (
    !body ||
    typeof body !== "object" ||
    !("kind" in body) ||
    !("id" in body) ||
    typeof body.id !== "string" ||
    body.id.length > 128
  )
    throw new Error("Invalid Telegram work item");
  if (body.kind === "inbox") await processTelegramInbox(services, body.id);
  else if (body.kind === "delivery") await processTelegramDelivery(services, body.id);
  else throw new Error("Invalid Telegram work item");
}
