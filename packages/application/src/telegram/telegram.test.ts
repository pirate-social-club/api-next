import { expect, test } from "bun:test";
import { processTelegramInbox } from "./chat.ts";
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
    store: new Proxy(
      { inboxLive: async () => true, ...methods },
      {
        get: (target, property) => Reflect.get(target, property) ?? Reflect.get(missing, property),
      },
    ) as TelegramStore,
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

test("channel membership changes record readiness only for the configured channel", async () => {
  const writes: { chatId: string; error: string | null }[] = [];
  const membership = async (
    chatId: number,
    status: string,
    rights: Record<string, unknown> = {},
  ) => {
    const finished: (string | null)[] = [];
    const service = services({
      claimInbox: async () => ({
        id: "inbox",
        communityId: "community",
        botEpoch: "epoch",
        attempt: "attempt",
        update: {
          update_id: 1,
          my_chat_member: {
            chat: { id: chatId, type: "channel" },
            new_chat_member: {
              status,
              user: { id: 123, is_bot: true },
              ...rights,
            },
          },
        },
      }),
      integration: async () => ({ ...integration, channelId: "-123", botId: "123" }),
      channelMembership: async (_community, _epoch, changedChatId, error) => {
        writes.push({ chatId: changedChatId, error });
      },
      finishInbox: async (_item, error) => {
        finished.push(error);
      },
    });
    await processTelegramInbox(service, "inbox");
    expect(finished).toEqual([null]);
  };
  await membership(-123, "left");
  expect(writes).toEqual([{ chatId: "-123", error: "channel_membership_lost" }]);
  await membership(-123, "administrator", { can_post_messages: false });
  expect(writes[1]).toEqual({ chatId: "-123", error: "channel_rights_reduced" });
  await membership(-999, "left");
  expect(writes).toHaveLength(2);
});

test("setup permission failures reply with an actionable instruction", async () => {
  const texts: string[] = [];
  const service = services({
    claimInbox: async () => ({
      id: "inbox",
      communityId: "community",
      botEpoch: "epoch",
      attempt: "attempt",
      update: {
        update_id: 1,
        message: {
          chat: { id: 7, type: "private" },
          from: { id: 7, is_bot: false },
          chat_shared: { chat_id: -100, request_id: 1 },
        },
      },
    }),
    integration: async () => ({ ...integration, botToken: "encrypted-token", botId: "123" }),
    privateChatStarted: async () => true,
    claimChat: async () => "setup-lease",
    releaseChat: async () => {},
    admitCommand: async () => true,
    selectSetup: async () => {
      throw new Error("A failed permission check must not select a channel");
    },
    enqueueDelivery: async (delivery) => {
      if (delivery.desired !== null && "text" in delivery.desired)
        texts.push(delivery.desired.text as string);
    },
    finishInbox: async () => {},
  });
  service.api = {
    call: async (_token: string, method: string, params: Record<string, unknown>) => {
      if (method === "getChat") return { type: "channel", title: "Fixture channel" };
      if (params.user_id === "123")
        return {
          status: "administrator",
          can_post_messages: false,
          can_edit_messages: true,
          can_delete_messages: true,
        };
      return { status: "administrator" };
    },
  } as unknown as TelegramServices["api"];
  service.vault.open = async () =>
    JSON.stringify({ token: "123:fixture", secret: "fixture-secret" });
  await processTelegramInbox(service, "inbox");
  expect(texts).toEqual(["The bot needs post, edit and delete message rights in that channel."]);
});

test("a stale channel selection is reported instead of confirmed", async () => {
  const run = async (selected: boolean) => {
    const texts: string[] = [];
    const service = services({
      claimInbox: async () => ({
        id: "inbox",
        communityId: "community",
        botEpoch: "epoch",
        attempt: "attempt",
        update: {
          update_id: 1,
          message: {
            chat: { id: 7, type: "private" },
            from: { id: 7, is_bot: false },
            chat_shared: { chat_id: -100, request_id: 1 },
          },
        },
      }),
      integration: async () => ({ ...integration, botToken: "encrypted-token", botId: "123" }),
      privateChatStarted: async () => true,
      claimChat: async () => "selection-lease",
      releaseChat: async () => {},
      admitCommand: async () => true,
      selectSetup: async () => selected,
      enqueueDelivery: async (delivery) => {
        if (delivery.desired !== null && "text" in delivery.desired)
          texts.push(delivery.desired.text as string);
      },
      finishInbox: async () => {},
    });
    service.api = {
      call: async (_token: string, method: string) =>
        method === "getChat"
          ? { type: "channel", title: "Fixture channel" }
          : {
              status: "administrator",
              can_post_messages: true,
              can_edit_messages: true,
              can_delete_messages: true,
            },
    } as unknown as TelegramServices["api"];
    service.vault.open = async () =>
      JSON.stringify({ token: "123:fixture", secret: "fixture-secret" });
    await processTelegramInbox(service, "inbox");
    return texts[0];
  };
  expect(await run(true)).toContain("Return to community settings");
  expect(await run(false)).toContain("already used or has expired");
});

test("command replies are admitted once and throttled when the budget is spent", async () => {
  const keys: string[] = [];
  const texts: string[] = [];
  const run = async (allowed: boolean) => {
    const service = services({
      claimInbox: async () => ({
        id: "inbox",
        communityId: "community",
        botEpoch: "epoch",
        attempt: "attempt",
        update: {
          update_id: 1,
          message: {
            chat: { id: 7, type: "private" },
            from: { id: 7, is_bot: false },
            text: "/songs",
          },
        },
      }),
      integration: async () => integration,
      privateChatStarted: async () => true,
      claimChat: async () => "command-lease",
      releaseChat: async () => {},
      admitCommand: async (_community, _epoch, _user, key) => {
        keys.push(key);
        return allowed;
      },
      reserveUsage: async () => {
        throw new Error("Command replies must not charge the model budget");
      },
      publicPosts: async () => [],
      enqueueDelivery: async (delivery) => {
        if (delivery.desired !== null && "text" in delivery.desired)
          texts.push(delivery.desired.text as string);
      },
      finishInbox: async () => {},
    });
    await processTelegramInbox(service, "inbox");
  };
  await run(true);
  expect(keys).toEqual(["command:inbox"]);
  expect(texts[0]).toContain("No public songs are available yet.");
  await run(false);
  expect(keys).toEqual(["command:inbox", "command:inbox"]);
  expect(texts[1]).toBe("Too many requests. Please try again in a few minutes.");
});

test("a paced chat is deferred without spending an attempt and re-woken", async () => {
  const deferred: { id: string; delay: number; reason: string }[] = [];
  const wakes: { id: string; delay: number | undefined }[] = [];
  let handled = false;
  const service = services({
    claimInbox: async () => ({
      id: "inbox",
      communityId: "community",
      botEpoch: "epoch",
      attempt: "attempt",
      update: {
        update_id: 1,
        message: {
          chat: { id: 7, type: "private" },
          from: { id: 7, is_bot: false },
          text: "/songs",
        },
      },
    }),
    claimChat: async (_community, _epoch, chatId, seconds) => {
      expect(chatId).toBe("7");
      expect(seconds).toBe(1);
      return null;
    },
    deferInbox: async (item, delay, reason) => {
      deferred.push({ id: item.id, delay, reason });
    },
    integration: async () => {
      handled = true;
      return integration;
    },
    finishInbox: async () => {
      handled = true;
    },
  });
  service.wake = async (work, options) => {
    wakes.push({ id: work.id, delay: options?.delaySeconds });
  };
  await processTelegramInbox(service, "inbox");
  expect(deferred).toEqual([{ id: "inbox", delay: 1, reason: "chat_paced" }]);
  expect(wakes).toEqual([{ id: "inbox", delay: 1 }]);
  expect(handled).toBe(false);
});

test("a leased chat releases its lease after processing", async () => {
  const released: string[] = [];
  const service = services({
    claimInbox: async () => ({
      id: "inbox",
      communityId: "community",
      botEpoch: "epoch",
      attempt: "attempt",
      update: {
        update_id: 1,
        message: {
          chat: { id: 7, type: "private" },
          from: { id: 7, is_bot: false },
          text: "/songs",
        },
      },
    }),
    integration: async () => integration,
    privateChatStarted: async () => true,
    claimChat: async () => "leased-token",
    releaseChat: async (_community, _epoch, _chatId, token) => {
      released.push(token);
    },
    admitCommand: async () => true,
    publicPosts: async () => [],
    enqueueDelivery: async () => {},
    finishInbox: async () => {},
  });
  await processTelegramInbox(service, "inbox");
  expect(released).toEqual(["leased-token"]);
});

test("inbox replay reuses durable provider stages instead of repeating billable work", async () => {
  const assistantIntegration: IntegrationRecord = {
    ...integration,
    botToken: "encrypted-token",
    policy: {
      ...DEFAULT_ASSISTANT_POLICY,
      enabled: true,
      voice_enabled: true,
      model: "fixture-model",
    },
    credentials: {
      openrouter: {
        ciphertext: "encrypted-openrouter",
        status: "valid",
        checkedAt: "2026-09-08T00:00:00Z",
      },
      elevenlabs: {
        ciphertext: "encrypted-elevenlabs",
        status: "valid",
        checkedAt: "2026-09-08T00:00:00Z",
      },
    },
  };
  const stages = new Map<
    string,
    { state: "issued" | "completed" | "failed"; result?: string; attempt: string }
  >();
  const replies: { text: string | undefined; kind: string }[] = [];
  const finished: (string | null)[] = [];
  let transcriptionCalls = 0;
  let completionCalls = 0;
  let saveAttempts = 0;
  let attempt = "attempt-1";
  const inboxItem = () => ({
    id: "inbox",
    communityId: "community",
    botEpoch: "epoch",
    attempt,
    update: {
      update_id: 1,
      message: {
        chat: { id: 7, type: "private" },
        from: { id: 7, is_bot: false },
        voice: { file_id: "voice-file", duration: 1, file_size: 1 },
      },
    },
  });
  const service = services({
    claimInbox: async () => inboxItem(),
    integration: async () => assistantIntegration,
    finishInbox: async (_item, error) => {
      finished.push(error);
    },
    privateChatStarted: async () => true,
    claimChat: async () => "replay-lease",
    releaseChat: async () => {},
    publicPosts: async () => [],
    history: async () => [],
    reserveUsage: async () => true,
    enqueueDelivery: async (delivery) => {
      replies.push({
        text:
          delivery.desired === null || !("text" in delivery.desired)
            ? undefined
            : (delivery.desired.text as string),
        kind: delivery.kind,
      });
    },
    saveConversation: async () => {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error("Fixture interruption after reply enqueue");
    },
    beginProviderStage: async (input) => {
      const existing = stages.get(input.stage);
      if (!existing) {
        stages.set(input.stage, { state: "issued", attempt: input.attempt });
        return { kind: "issued" } as const;
      }
      if (existing.state === "completed")
        return { kind: "completed", result: existing.result ?? "" } as const;
      if (existing.state === "failed") {
        stages.set(input.stage, { state: "issued", attempt: input.attempt });
        return { kind: "issued" } as const;
      }
      return { kind: "uncertain" } as const;
    },
    completeProviderStage: async (input) => {
      stages.set(input.stage, {
        state: "completed",
        result: input.result,
        attempt: input.attempt,
      });
    },
    failProviderStage: async (input) => {
      stages.set(input.stage, { state: "failed", attempt: input.attempt });
    },
  });
  service.vault.open = async (ciphertext) => {
    if (ciphertext === "encrypted-token")
      return JSON.stringify({ token: "123:fixture", secret: "fixture-secret" });
    return ciphertext === "encrypted-openrouter" ? "openrouter-key" : "elevenlabs-key";
  };
  service.api = {
    downloadVoice: async () => new Uint8Array([1, 2, 3]),
  } as unknown as TelegramServices["api"];
  service.providers = {
    ...service.providers,
    transcribe: async () => {
      transcriptionCalls += 1;
      return "Fixture transcript";
    },
    complete: async () => {
      completionCalls += 1;
      return `Fixture answer ${completionCalls}`;
    },
  };
  await processTelegramInbox(service, "inbox");
  expect(finished).toEqual(["processing_failed"]);
  const firstAnswer = replies.find((entry) => entry.kind === "reply")?.text;
  attempt = "attempt-2";
  await processTelegramInbox(service, "inbox");
  expect(finished).toEqual(["processing_failed", null]);
  expect(transcriptionCalls).toBe(1);
  expect(completionCalls).toBe(1);
  expect(replies.filter((entry) => entry.kind === "reply").map((entry) => entry.text)).toEqual([
    firstAnswer,
    firstAnswer,
  ]);
});

function assistantVoiceIntegration(): IntegrationRecord {
  return {
    ...integration,
    botToken: "encrypted-token",
    policy: {
      ...DEFAULT_ASSISTANT_POLICY,
      enabled: true,
      voice_enabled: true,
      model: "fixture-model",
    },
    credentials: {
      openrouter: {
        ciphertext: "encrypted-openrouter",
        status: "valid",
        checkedAt: "2026-09-08T00:00:00Z",
      },
      elevenlabs: {
        ciphertext: "encrypted-elevenlabs",
        status: "valid",
        checkedAt: "2026-09-08T00:00:00Z",
      },
    },
  };
}

function voiceInboxItem() {
  return {
    id: "inbox",
    communityId: "community",
    botEpoch: "epoch",
    attempt: "attempt",
    update: {
      update_id: 1,
      message: {
        chat: { id: 7, type: "private" },
        from: { id: 7, is_bot: false },
        voice: { file_id: "voice-file", duration: 1, file_size: 1 },
      },
    },
  };
}

function voiceServices(
  inboxLive: () => Promise<boolean>,
  completeProviderStage: (input: { stage: string }) => Promise<void>,
) {
  const replies: string[] = [];
  const saved: number[] = [];
  const stages: string[] = [];
  let completions = 0;
  const service = services({
    claimInbox: async () => voiceInboxItem(),
    integration: async () => assistantVoiceIntegration(),
    privateChatStarted: async () => true,
    claimChat: async () => "lease",
    releaseChat: async () => {},
    inboxLive,
    publicPosts: async () => [],
    history: async () => [],
    reserveUsage: async () => true,
    enqueueDelivery: async (delivery) => {
      if (delivery.desired !== null && "text" in delivery.desired)
        replies.push(delivery.desired.text as string);
    },
    saveConversation: async () => {
      saved.push(1);
    },
    beginProviderStage: async () => ({ kind: "issued" }) as const,
    completeProviderStage: async (input) => {
      stages.push(input.stage);
      await completeProviderStage(input);
    },
    failProviderStage: async () => {},
    finishInbox: async () => {},
  });
  service.vault.open = async (ciphertext) => {
    if (ciphertext === "encrypted-token")
      return JSON.stringify({ token: "123:fixture", secret: "fixture-secret" });
    return ciphertext === "encrypted-openrouter" ? "openrouter-key" : "elevenlabs-key";
  };
  service.api = {
    downloadVoice: async () => new Uint8Array([1, 2, 3]),
  } as unknown as TelegramServices["api"];
  service.providers = {
    ...service.providers,
    transcribe: async () => "Fixture transcript",
    complete: async () => {
      completions += 1;
      return "Fixture answer";
    },
  };
  return {
    service,
    replies,
    saved,
    stages,
    completions: () => completions,
  };
}

test("cleanup during a provider call fences the reply, conversation and stage commit", async () => {
  let live = true;
  const harness = voiceServices(
    async () => live,
    async () => {},
  );
  harness.service.providers = {
    ...harness.service.providers,
    complete: async () => {
      live = false;
      return "Fixture answer";
    },
  };
  await processTelegramInbox(harness.service, "inbox");
  expect(harness.stages).toEqual(["transcription"]);
  expect(harness.replies).toEqual([]);
  expect(harness.saved).toEqual([]);
});

test("rotation before reply persistence fences the published reply and conversation", async () => {
  let live = true;
  const harness = voiceServices(
    async () => live,
    async (input) => {
      if (input.stage === "completion") live = false;
    },
  );
  await processTelegramInbox(harness.service, "inbox");
  expect(harness.stages).toEqual(["transcription", "completion"]);
  expect(harness.completions()).toBe(1);
  expect(harness.replies).toEqual([]);
  expect(harness.saved).toEqual([]);
});
