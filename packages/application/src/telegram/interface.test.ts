import { expect, test } from "bun:test";
import type { TelegramStudyServices } from "../telegram-study.ts";
import { processTelegramInbox } from "./chat.ts";
import {
  resolveTelegramLocale,
  type TelegramLanguageContext,
  type TelegramLanguagePreference,
  telegramCatalogs,
  telegramLocale,
} from "./copy.ts";
import {
  DEFAULT_ASSISTANT_POLICY,
  type InboxRecord,
  type IntegrationRecord,
  type TelegramServices,
  type TelegramStore,
} from "./types.ts";

const context = (
  preference: TelegramLanguagePreference | null = null,
): TelegramLanguageContext => ({
  preference,
  communityName: "Music",
  accountLocale: null,
  helperLanguage: "zh-Hans",
  resumeAvailable: false,
});
const integration: IntegrationRecord = {
  communityId: "community",
  revision: 1,
  botEpoch: "epoch",
  botId: "123",
  botUsername: "fixture_bot",
  botToken: "ciphertext",
  webhookId: "hook",
  webhookSecret: "ciphertext",
  status: "ready",
  channelId: null,
  channelTitle: null,
  channelUsername: null,
  automaticSince: null,
  policy: DEFAULT_ASSISTANT_POLICY,
  credentials: {},
  lastError: null,
};

function fixture() {
  let sequence = 0;
  let current: InboxRecord;
  const preferences = new Map<string, TelegramLanguagePreference>();
  const deliveries: { text: string; keyboard?: unknown }[] = [];
  const started = new Set<string>();
  let writes = 0,
    reads = 0;
  const key = (sender: { communityId: string; botId: string; telegramUserId: string }) =>
    `${sender.communityId}:${sender.botId}:${sender.telegramUserId}`;
  const store: Partial<TelegramStore> = {
    claimInbox: async () => current,
    integration: async () => integration,
    learnerLanguageContext: async (sender) => {
      reads++;
      return context(preferences.get(key(sender)) ?? null);
    },
    saveLearnerLanguage: async (sender, _id, locale, explicit) => {
      writes++;
      if (!preferences.get(key(sender))?.explicit || explicit)
        preferences.set(key(sender), { locale, explicit });
    },
    startPrivateChat: async (_community, _epoch, user) => {
      started.add(user);
    },
    privateChatStarted: async (_community, _epoch, user) => started.has(user),
    enqueueDelivery: async (record) => {
      if (record.desired) deliveries.push(record.desired);
    },
    finishInbox: async (_inbox, error) => {
      expect(error).toBeNull();
    },
    publicPosts: async () => [],
  };
  const strict = <T extends object>(values: Partial<T>): T =>
    new Proxy(values, {
      get: (target, property) =>
        Reflect.get(target, property) ??
        (() => {
          throw Error(`Unexpected operation: ${String(property)}`);
        }),
    }) as T;
  const services: TelegramServices = {
    store: strict<TelegramStore>(store),
    vault: {
      hash: async (input) => input,
      token: () => "fixture",
      seal: async () => "ciphertext",
      open: async () => JSON.stringify({ token: "fixture-token", secret: "fixture-secret" }),
    },
    api: strict<TelegramServices["api"]>({ call: async <T>() => undefined as T }),
    providers: strict<TelegramServices["providers"]>({}),
    now: () => 1000,
    wake: async () => {},
    publicOrigin: "https://pirate.example.invalid",
    webhookOrigin: "https://api.example.invalid",
  };
  async function run(
    text: string,
    language?: string,
    callback = false,
    sender = 7,
    chat = sender,
    epoch = integration.botEpoch,
  ) {
    sequence++;
    const message = {
      message_id: sequence,
      chat: { id: chat, type: "private" },
      from: { id: sender, is_bot: false, ...(language ? { language_code: language } : {}) },
      text,
    };
    current = {
      id: String(sequence),
      communityId: integration.communityId,
      botEpoch: epoch,
      attempt: "attempt",
      update: {
        update_id: sequence,
        ...(callback
          ? { callback_query: { id: String(sequence), from: message.from, message, data: text } }
          : { message }),
      },
    };
    await processTelegramInbox({ ...services }, current.id);
    return deliveries.at(-1);
  }
  return { run, services, deliveries, preferences, counts: () => ({ writes, reads }) };
}

test.each([
  ["ru-RU", "ru"],
  ["ka-GE", "ka"],
  ["en-US", "en"],
] as const)("canonical Telegram language %s resolves", (tag, expected) =>
  expect(telegramLocale(tag)).toBe(expected),
);
test.each([undefined, "", "ru_Latn", "ru-Latn", "ka-Cyrl", "en-Cyrl", "fr", "x", " ru ", 7])(
  "unsupported/malformed language %j falls back safely",
  (tag) => expect(telegramLocale(tag)).toBeNull(),
);
test("explicit bot language wins over account and Telegram without binding helper preferences", () => {
  const choice = { ...context({ locale: "en", explicit: true }), accountLocale: "ka" };
  expect(resolveTelegramLocale(choice, "ru")).toBe("en");
  expect(resolveTelegramLocale({ ...choice, preference: null }, "ru")).toBe("ka");
  expect(resolveTelegramLocale(context({ locale: "ka", explicit: false }), undefined)).toBe("ka");
  expect(resolveTelegramLocale(context(), undefined)).toBe("en");
  expect(choice.helperLanguage).toBe("zh-Hans");
});
test("all catalogs preserve key and interpolation parameter parity", () => {
  const slots = (value: string) =>
    [...value.matchAll(/\{([A-Za-z]+)\}/gu)].map((match) => match[1]).sort();
  for (const locale of ["ru", "ka"] as const) {
    expect(Object.keys(telegramCatalogs[locale]).sort()).toEqual(
      Object.keys(telegramCatalogs.en).sort(),
    );
    for (const key of Object.keys(telegramCatalogs.en) as (keyof typeof telegramCatalogs.en)[]) {
      expect(slots(telegramCatalogs[locale][key])).toEqual(slots(telegramCatalogs.en[key]));
    }
  }
});
test.each(["ru", "ka"])(
  "first %s contact offers native picker and useful actions while practice is disabled",
  async (locale) => {
    const f = fixture();
    const welcome = await f.run("/start", locale);
    expect(welcome?.text).toContain("Music");
    expect(welcome?.text).not.toContain("Welcome");
    const keyboard = JSON.stringify(welcome?.keyboard);
    for (const name of [
      "English",
      "Русский",
      "ქართული",
      "tg-menu:songs",
      "tg-menu:help",
      "tg-menu:settings",
    ])
      expect(keyboard).toContain(name);
    expect(keyboard).not.toContain("tg-menu:study");
  },
);
test("manual English survives Russian suggestions, missing language, and a fresh services instance", async () => {
  const f = fixture();
  await f.run("/settings", "ru");
  expect((await f.run("tg-language:en", undefined, true))?.text).toBe("Interface language saved.");
  expect((await f.run("/help", "ru"))?.text).toContain("Use /songs");
  f.services.now = () => 2000;
  expect((await f.run("/settings"))?.text).toContain("Interface language: English");
  expect(f.preferences.get("community:123:7")).toEqual({ locale: "en", explicit: true });
});
test("pre-link language callbacks bypass lesson state and paid providers", async () => {
  const f = fixture();
  const fail = new Proxy(
    {},
    {
      get: () => () => {
        throw Error("Lesson state must not be touched");
      },
    },
  );
  f.services.study = { communityId: integration.communityId, store: fail } as TelegramStudyServices;
  const choice = await f.run("tg-language:ka", undefined, true);
  expect(choice?.text).toContain("შენახულია");
  expect(JSON.stringify(choice?.keyboard)).toContain("tg-menu:study");
  expect((await f.run("/preferences", "ru"))?.text).toContain("zh-Hans");
});
test("foreign-chat and obsolete-epoch callbacks cannot change language", async () => {
  const f = fixture();
  await f.run("tg-language:ru", undefined, true, 7, 8);
  expect(f.counts()).toEqual({ writes: 0, reads: 0 });
  const original = integration.botEpoch;
  integration.botEpoch = "rotated";
  try {
    await f.run("tg-language:ka", undefined, true, 7, 7, original);
    expect(f.counts()).toEqual({ writes: 0, reads: 0 });
    await f.run("tg-language:ka", undefined, true);
  } finally {
    integration.botEpoch = original;
  }
  // Stable identity remains the preference key, not ingress epoch.
  expect([...f.preferences.keys()]).toEqual(["community:123:7"]);
});
test("malformed picker callbacks never mutate preferences and discovery delivers once", async () => {
  const f = fixture();
  await f.run("/start", "ru");
  const writes = f.counts().writes;
  await f.run("tg-language:ka:other", undefined, true);
  expect(f.counts().writes).toBe(writes);
  const deliveries = f.deliveries.length;
  await f.run("tg-menu:songs", undefined, true);
  expect(f.deliveries.length).toBe(deliveries + 1);
  expect(f.deliveries.at(-1)?.text).toBe(telegramCatalogs.ru.noPublicSongs);
});
