import type { TelegramServices } from "@pirate/application/telegram";
import type { TelegramLinkServices } from "@pirate/application/telegram-linking";
import { makeTelegramHandlers } from "./telegram-handlers.ts";
import { makeTelegramLinkingHandlers } from "./telegram-linking-handlers.ts";
import type { EndpointHandler } from "./transport.ts";

const retryDelayMs = 30_000;

function recoveringServices<A>(create: () => Promise<A | null>, now: () => number) {
  let services: A | null = null;
  let busy = false;
  let retryAt = 0;
  return async () => {
    if (services !== null) return services;
    // Do not share a database promise owned by another Worker request.
    if (busy || now() < retryAt) return null;
    busy = true;
    try {
      services = await create();
      return services;
    } finally {
      if (services === null) retryAt = now() + retryDelayMs;
      busy = false;
    }
  };
}

/** Cache only admitted service factories, never decoded requests or learner data. */
export function makeRecoveringTelegramHandlers(input: {
  readonly chat: () => Promise<TelegramServices | null>;
  readonly linking: (chat: TelegramServices) => Promise<TelegramLinkServices | null>;
  readonly now?: () => number;
}): Readonly<Record<string, EndpointHandler>> {
  const now = input.now ?? Date.now;
  const chat = recoveringServices(input.chat, now);
  const linking = recoveringServices(async () => {
    const services = await chat();
    return services === null ? null : input.linking(services);
  }, now);
  const handlers: Record<string, EndpointHandler> = {};
  for (const id of Object.keys(makeTelegramHandlers(null))) {
    handlers[id] = async (request) => {
      const handler = makeTelegramHandlers(await chat())[id];
      if (!handler) throw Error("Telegram handler missing");
      return handler(request);
    };
  }
  for (const id of Object.keys(makeTelegramLinkingHandlers(null))) {
    handlers[id] = async (request) => {
      const handler = makeTelegramLinkingHandlers(await linking())[id];
      if (!handler) throw Error("Telegram linking handler missing");
      return handler(request);
    };
  }
  return handlers;
}
