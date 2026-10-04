import { expect, spyOn, test } from "bun:test";
import type { TelegramServices } from "@pirate/application/telegram";
import type { TelegramLinkServices } from "@pirate/application/telegram-linking";
import { ControlPlaneDb } from "@pirate/platform-cf/postgres";
import { makeTelegramLinkServices } from "@pirate/platform-cf/telegram-linking-runtime";
import { Effect, Layer } from "effect";
import { TELEGRAM_ACTIVATION_TABLES } from "../../../packages/platform-cf/src/telegram-activation-privileges.ts";
import { makeTelegramServices } from "../../../packages/platform-cf/src/telegram-runtime.ts";
import { makeRecoveringTelegramHandlers } from "./telegram-setup-cache.ts";
import type { DecodedRequest, EndpointHandler } from "./transport.ts";

type ControlPlaneStatement = Parameters<ControlPlaneDb["Service"]["execute"]>[0];

function required(handlers: Readonly<Record<string, EndpointHandler>>, id: string) {
  const handler = handlers[id];
  if (!handler) throw Error("fixture handler missing");
  return handler;
}

const request: DecodedRequest = {
  principal: { kind: "user", subject: "learner" },
  params: {},
  query: {},
  body: undefined,
  telegramLinkBrowser: { sessionHash: "session" },
};
const complete = {
  TELEGRAM_ENABLED: "true",
  TELEGRAM_PUBLIC_ORIGIN: "https://pirate.example.invalid",
  TELEGRAM_WEBHOOK_ORIGIN: "https://api.example.invalid",
  TELEGRAM_CREDENTIAL_ACTIVE_VERSION: "v1",
  TELEGRAM_CREDENTIAL_KEYS_JSON: JSON.stringify({ v1: "a".repeat(43) }),
  TELEGRAM_QUEUE: { send: async () => {} },
  TELEGRAM_LINKING_ENABLED: "true",
  TELEGRAM_LOGIN_CLIENT_ID: "123",
  TELEGRAM_LOGIN_CLIENT_SECRET: "fixture-secret",
  TELEGRAM_LOGIN_REDIRECT_URI: "https://pirate.example.invalid/telegram/link/callback",
};
const healthy = () =>
  TELEGRAM_ACTIVATION_TABLES.map(([table_name, expected_delete]) => ({
    runtime_role: "restricted_executor",
    table_name,
    expected_delete,
    expected_truncate: false,
    schema_usage: true,
    table_exists: true,
    owner_equivalent: false,
    can_select: true,
    can_insert: true,
    can_update: true,
    can_delete: expected_delete,
    can_truncate: false,
  }));

for (const failure of ["query", "permission"] as const) {
  test(`HTTP Telegram recovers from ${failure} failure without rebuilding API composition`, async () => {
    let time = 0,
      broken = true,
      checks = 0;
    const execute = <R = unknown>(statement: ControlPlaneStatement) => {
      if (statement.text.includes("current_user")) {
        checks++;
        if (broken && failure === "query") return Effect.die("credential must not be logged");
        const rows = healthy();
        if (broken && rows[0]) rows[0].can_delete = false;
        return Effect.succeed({ rows: rows as unknown as readonly R[], rowCount: rows.length });
      }
      return Effect.succeed({ rows: [] as readonly R[], rowCount: 0 });
    };
    const runtime = Layer.succeed(ControlPlaneDb, {
      execute,
      withTransaction: (use) => use({ execute }),
    });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const handlers = makeRecoveringTelegramHandlers({
        chat: () => makeTelegramServices(complete, runtime),
        linking: (chat) => makeTelegramLinkServices(complete, runtime, chat),
        now: () => time,
      });
      expect(checks).toBe(0);
      await expect(required(handlers, "GetMyTelegramLinks")(request)).rejects.toMatchObject({
        _tag: "ProviderUnavailable",
      });
      expect(checks).toBe(1);
      broken = false;
      time = 29_999;
      await expect(required(handlers, "GetMyTelegramLinks")(request)).rejects.toMatchObject({
        _tag: "ProviderUnavailable",
      });
      expect(checks).toBe(1);
      time = 30_000;
      const result = await required(handlers, "GetMyTelegramLinks")(request);
      expect(result).toMatchObject({ body: { telegram_user_ids: [], grants: [] } });
      expect(checks).toBe(3); // Fresh admission for both service constructors.
      await required(
        handlers,
        "GetMyTelegramLinks",
      )({
        ...request,
        principal: { kind: "user", subject: "second-learner" },
      });
      expect(checks).toBe(3);
      expect(log.mock.calls[0]?.[1]).toEqual(
        failure === "query"
          ? { category: "query_failed" }
          : { category: "permission_refused", table: "telegram_account_associations" },
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("credential must not");
    } finally {
      log.mockRestore();
    }
  });
}

test("concurrent requests refuse unavailable setup instead of sharing request I/O or multiplying it", async () => {
  const pending = Promise.withResolvers<TelegramServices | null>();
  let calls = 0;
  const handlers = makeRecoveringTelegramHandlers({
    chat: () => {
      calls++;
      return pending.promise;
    },
    linking: async () => null,
  });
  const first = required(handlers, "GetCommunityTelegram")(request);
  await expect(required(handlers, "GetCommunityTelegram")(request)).rejects.toMatchObject({
    _tag: "ProviderUnavailable",
  });
  expect(calls).toBe(1);
  pending.resolve(null);
  await expect(first).rejects.toMatchObject({ _tag: "ProviderUnavailable" });
  await expect(required(handlers, "GetCommunityTelegram")(request)).rejects.toMatchObject({
    _tag: "ProviderUnavailable",
  });
  expect(calls).toBe(1);
});

test("linking retries independently after chat has already been admitted", async () => {
  let time = 0,
    chatCalls = 0,
    linkCalls = 0;
  const chat = {} as TelegramServices;
  const linked = {
    store: { list: async () => ({ telegram_user_ids: [], grants: [] }) },
  } as unknown as TelegramLinkServices;
  const handlers = makeRecoveringTelegramHandlers({
    chat: async () => {
      chatCalls++;
      return chat;
    },
    linking: async (value) => {
      expect(value).toBe(chat);
      return ++linkCalls === 1 ? null : linked;
    },
    now: () => time,
  });
  await expect(required(handlers, "GetMyTelegramLinks")(request)).rejects.toMatchObject({
    _tag: "ProviderUnavailable",
  });
  time = 30_000;
  await expect(required(handlers, "GetMyTelegramLinks")(request)).resolves.toMatchObject({
    body: { grants: [] },
  });
  expect(chatCalls).toBe(1);
  expect(linkCalls).toBe(2);
});

test("disabled flags do not query the database even after multiple retry windows", async () => {
  let calls = 0,
    time = 0;
  const execute = <R = unknown>() => {
    calls++;
    return Effect.succeed({ rows: [] as readonly R[], rowCount: 0 });
  };
  const runtime = Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: (use) => use({ execute }),
  });
  const handlers = makeRecoveringTelegramHandlers({
    chat: () => makeTelegramServices({ TELEGRAM_ENABLED: "false" }, runtime),
    linking: (chat) =>
      makeTelegramLinkServices({ TELEGRAM_LINKING_ENABLED: "false" }, runtime, chat),
    now: () => time,
  });
  for (time = 0; time <= 60_000; time += 30_000) {
    await expect(required(handlers, "GetMyTelegramLinks")(request)).rejects.toMatchObject({
      _tag: "ProviderUnavailable",
    });
  }
  expect(calls).toBe(0);
});
