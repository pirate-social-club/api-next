import { AsyncLocalStorage } from "node:async_hooks";
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
    send(
      body: { kind: "inbox" | "delivery"; id: string },
      options?: { delaySeconds?: number },
    ): Promise<void>;
  };
}

/**
 * `defer` continues work after the current response. A Worker that supplies it processes an
 * accepted update and sends its reply itself; the queue then only recovers interrupted work.
 */
export interface TelegramRuntimeOptions {
  readonly defer?: (work: () => Promise<unknown>) => boolean;
}

type TelegramWork = { kind: "inbox" | "delivery"; id: string };
type TelegramWorkQueue = {
  send(body: TelegramWork, options?: { delaySeconds?: number }): Promise<void>;
};
/** True while this Worker is processing an update it accepted itself. */
const inlineUpdate = new AsyncLocalStorage<true>();
/**
 * Background work is cut off about 30 seconds after the response. The inbox lease lasts two
 * minutes, so a queue message delayed just past it re-drives an interrupted update without
 * waiting for the scheduled scanner. For a finished update it finds nothing to claim.
 */
const INTERRUPTED_UPDATE_BACKSTOP_SECONDS = 130;

/**
 * Without `defer`, work goes to the queue. With it, the caller's own Worker does the work:
 * a stored update is processed after the response, and the replies it stores are sent at
 * once. Anything else, such as a publication, is still queued. The queue remains the
 * fallback, and the scheduled scanner recovers anything interrupted.
 */
export function makeTelegramWake(input: {
  readonly queue: TelegramWorkQueue;
  readonly defer: TelegramRuntimeOptions["defer"];
  readonly inbox: (id: string) => Promise<void>;
  readonly delivery: (id: string) => Promise<void>;
}): (work: TelegramWork) => Promise<void> {
  const { queue, defer } = input;
  if (defer === undefined) return (work) => queue.send(work);
  return async (work) => {
    if (work.kind === "delivery") {
      // Only replies produced by an update being handled here are sent here. A request
      // that enqueues many messages must not wait for each of them to be sent.
      if (inlineUpdate.getStore() !== true) {
        await queue.send(work);
        return;
      }
      try {
        await input.delivery(work.id);
      } catch {
        await queue.send(work);
      }
      return;
    }
    const started = Date.now();
    // Timing only, never ids or content: recovery by the scanner must not hide a slow path.
    const record = (outcome: "handled" | "failed") =>
      console.info("telegram.inline_update", { outcome, elapsed_ms: Date.now() - started });
    const run = () =>
      inlineUpdate.run(true, () =>
        input.inbox(work.id).then(
          () => record("handled"),
          () => record("failed"),
        ),
      );
    if (!defer(run)) {
      await queue.send(work);
      return;
    }
    try {
      await queue.send(work, { delaySeconds: INTERRUPTED_UPDATE_BACKSTOP_SECONDS });
    } catch {
      /* The scheduled scanner still recovers an interrupted update. */
    }
  };
}

async function buildTelegramServices(
  bindings: TelegramBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: TelegramRuntimeOptions,
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
    wake: makeTelegramWake({
      queue,
      defer: options.defer,
      inbox: (id) => processTelegramInbox(services, id),
      delivery: (id) => processTelegramDelivery(services, id),
    }),
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
  options: TelegramRuntimeOptions = {},
): Promise<TelegramServices | null> {
  try {
    return await buildTelegramServices(bindings, runtime, options);
  } catch (error) {
    logTelegramSetupFailure("chat", error);
    return null;
  }
}
