import { expect, test } from "bun:test";
import { acceptTelegramUpdate, processTelegramDelivery } from "./delivery.ts";
import { getTelegramSettings, setAssistantCredential } from "./settings.ts";
import {
  DEFAULT_ASSISTANT_POLICY,
  type DeliveryRecord,
  type IntegrationRecord,
  TelegramFailure,
  type TelegramServices,
  type TelegramStore,
} from "./types.ts";

const integration: IntegrationRecord = {
  communityId: "community",
  revision: 1,
  botEpoch: "epoch",
  botId: "123",
  botUsername: "fixture_bot",
  botToken: "encrypted-token",
  webhookId: "hook",
  webhookSecret: "hash:secret",
  status: "ready",
  channelId: "-123",
  channelTitle: "Channel",
  channelUsername: null,
  automaticSince: null,
  policy: DEFAULT_ASSISTANT_POLICY,
  credentials: {
    openrouter: {
      ciphertext: "encrypted-key",
      status: "valid",
      checkedAt: "2026-09-08T00:00:00.000Z",
    },
  },
  lastError: null,
};

function services(methods: Partial<TelegramStore>): TelegramServices {
  // Unspecified test operations fail loudly, preventing unnoticed provider or storage work.
  const missing = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        throw new Error(`Unexpected operation: ${String(property)}`);
      },
    },
  );
  return {
    store: new Proxy(methods, {
      get: (target, property) => Reflect.get(target, property) ?? Reflect.get(missing, property),
    }) as TelegramStore,
    api: missing as TelegramServices["api"],
    providers: missing as TelegramServices["providers"],
    vault: {
      ...missing,
      hash: async (value: string) => `hash:${value}`,
      token: () => "opaque",
    } as TelegramServices["vault"],
    publicOrigin: "https://pirate.example.invalid",
    webhookOrigin: "https://api.example.invalid",
    now: () => 0,
    wake: async () => {},
  };
}

test("settings redact every secret and check ownership before reading", async () => {
  const allowed = services({ owner: async () => {}, integration: async () => integration });
  const result = await getTelegramSettings(allowed, "community", "owner");
  expect(result.openrouter.status).toBe("valid");
  expect(JSON.stringify(result)).not.toContain("encrypted");
  expect(JSON.stringify(result)).not.toContain("hash:secret");
  const denied = services({
    owner: async () => {
      throw new TelegramFailure({ reason: "unauthorized" });
    },
  });
  await expect(getTelegramSettings(denied, "community", "viewer")).rejects.toMatchObject({
    reason: "unauthorized",
  });
});

test("wrong webhook secret never persists an update", async () => {
  const service = services({ byWebhook: async () => integration });
  await expect(
    acceptTelegramUpdate(service, "hook", "wrong", { update_id: 1 }),
  ).rejects.toMatchObject({ reason: "unauthorized" });
});

test("webhook acknowledges only after durable acceptance, even if queue notification fails", async () => {
  let accepted = false;
  const service = services({
    byWebhook: async () => integration,
    acceptUpdate: async () => {
      accepted = true;
      return "inbox";
    },
  });
  service.wake = async () => {
    expect(accepted).toBe(true);
    throw new Error("queue unavailable");
  };
  expect(await acceptTelegramUpdate(service, "hook", "secret", { update_id: 1 })).toEqual({
    ok: true,
  });
  service.store.acceptUpdate = async () => {
    throw new Error("database unavailable");
  };
  await expect(acceptTelegramUpdate(service, "hook", "secret", { update_id: 2 })).rejects.toThrow(
    "database unavailable",
  );
});

test("credential replay avoids another provider validation and stale revisions cannot write", async () => {
  const service = services({
    owner: async () => {},
    integration: async () => integration,
    commandReplay: async () => ({ replay: true }),
  });
  const command = {
    communityId: "community",
    accountId: "owner",
    expected_revision: 0,
    idempotency_key: "command",
    provider: "openrouter" as const,
    key: "fixture-secret",
  };
  expect((await setAssistantCredential(service, command)).revision).toBe(1);
  service.store.commandReplay = async () => null;
  await expect(setAssistantCredential(service, command)).rejects.toMatchObject({
    reason: "conflict",
  });
});

const voiceDelivery: DeliveryRecord = {
  id: "voice-delivery",
  communityId: "community",
  botEpoch: "epoch",
  chatId: "123",
  kind: "voice",
  postId: null,
  state: "pending",
  desired: { kind: "voice", text: "The answer", media: null, buttons: [] },
  desiredHash: "answer",
  confirmed: null,
  confirmedHash: null,
  messageId: null,
  attempt: "attempt",
  attemptCount: 1,
  lastError: null,
  createdAt: "2026-09-08T00:00:00Z",
};

test("speech failure reserves usage first and fails only the separate voice delivery", async () => {
  let reserved = false;
  let finished = false;
  const service = services({
    claimDelivery: async () => voiceDelivery,
    integration: async () => ({
      ...integration,
      policy: { ...integration.policy, voice_enabled: true },
      credentials: {
        elevenlabs: {
          ciphertext: "encrypted-speech",
          status: "valid",
          checkedAt: "2026-09-08T00:00:00Z",
        },
      },
    }),
    reserveUsage: async (_community, _epoch, _user, key, _policy, characters) => {
      expect(key).toBe("speech:voice-delivery:attempt");
      expect(characters).toBe(10);
      reserved = true;
      return true;
    },
    finishDelivery: async (delivery, outcome) => {
      expect(delivery.id).toBe("voice-delivery");
      expect(outcome).toEqual({ kind: "rejected", code: "preparation_failed", retryAfter: 60 });
      finished = true;
    },
  });
  service.vault.open = async (ciphertext) =>
    ciphertext === "encrypted-token"
      ? JSON.stringify({ token: "fixture-token", secret: "fixture-secret" })
      : "fixture-speech-key";
  service.providers = {
    ...service.providers,
    synthesize: async () => {
      expect(reserved).toBe(true);
      throw new Error("Fixture speech outage");
    },
  };
  await processTelegramDelivery(service, "voice-delivery");
  expect(finished).toBe(true);
});

test("rotated bot epochs fence already claimed work before provider access", async () => {
  let held = false;
  const service = services({
    claimDelivery: async () => voiceDelivery,
    integration: async () => ({ ...integration, botEpoch: "replacement" }),
    holdDelivery: async (_delivery, code) => {
      expect(code).toBe("integration_changed");
      held = true;
    },
  });
  await processTelegramDelivery(service, "voice-delivery");
  expect(held).toBe(true);
});
