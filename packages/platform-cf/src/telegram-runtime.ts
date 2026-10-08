import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import {
  configureTelegramBots,
  processTelegramDelivery,
  processTelegramInbox,
  reconcileTelegramPublication,
  type TelegramServices,
} from "@pirate/application/telegram";
import type { Layer } from "effect";
import { assertTelegramRuntimePrivileges } from "./telegram-activation-privileges.ts";
import { makeTelegramApi } from "./telegram-api.ts";
import { makeTelegramAssistantProviders } from "./telegram-assistant-providers.ts";
import {
  decodeTelegramConfiguration,
  decodeTelegramCredentials,
  type TelegramConfigurationBindings,
} from "./telegram-configuration.ts";
import { makeTelegramCredentialVault } from "./telegram-credential-vault.ts";
import { logTelegramSetupFailure } from "./telegram-setup-diagnostics.ts";
import { makeControlPlaneTelegramStore } from "./telegram-store.ts";
import {
  makeTelegramStudyServices,
  type TelegramPracticeBindings,
} from "./telegram-study-runtime.ts";

export interface TelegramBindings
  extends TelegramConfigurationBindings,
    Omit<
      TelegramPracticeBindings,
      | "TELEGRAM_STUDY_PRACTICE_ENABLED"
      | "TELEGRAM_STUDY_PRACTICE_COMMUNITY_ID"
      | "TELEGRAM_STUDY_PRACTICE_POST_IDS_JSON"
    > {
  readonly TELEGRAM_QUEUE?: {
    send(body: { kind: "inbox" | "delivery"; id: string }): Promise<void>;
  };
}

async function buildTelegramServices(
  bindings: TelegramBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): Promise<TelegramServices | null> {
  const config = decodeTelegramConfiguration(bindings);
  if (!config.enabled) return null;
  const credentials = decodeTelegramCredentials(bindings);
  if (
    !config.public_origin ||
    !config.webhook_origin ||
    !config.credential_active_version ||
    !bindings.TELEGRAM_QUEUE
  )
    throw new Error("Telegram configuration incomplete");
  const keys = credentials.credential_keys;
  await assertTelegramRuntimePrivileges(runtime);
  const queue = bindings.TELEGRAM_QUEUE;
  const services: TelegramServices = {
    store: makeControlPlaneTelegramStore(runtime, config.public_origin),
    api: makeTelegramApi(fetch),
    providers: makeTelegramAssistantProviders(fetch),
    vault: await makeTelegramCredentialVault({
      activeVersion: config.credential_active_version,
      keys,
    }),
    publicOrigin: config.public_origin,
    webhookOrigin: config.webhook_origin,
    interfaceLocales: config.interface_locales ?? ["en"],
    now: Date.now,
    wake: (work) => queue.send(work),
  };
  const study = makeTelegramStudyServices(
    {
      ...bindings,
      TELEGRAM_STUDY_PRACTICE_ENABLED: String(config.practice_enabled),
      ...(config.practice_community_id === undefined
        ? {}
        : { TELEGRAM_STUDY_PRACTICE_COMMUNITY_ID: config.practice_community_id }),
      TELEGRAM_STUDY_PRACTICE_POST_IDS_JSON: JSON.stringify(config.practice_post_ids ?? []),
    },
    runtime,
    services,
  );
  return study === undefined ? services : { ...services, study };
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

export async function makeTelegramServices(
  bindings: TelegramBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): Promise<TelegramServices | null> {
  try {
    return await buildTelegramServices(bindings, runtime);
  } catch (error) {
    logTelegramSetupFailure("chat", error);
    return null;
  }
}
