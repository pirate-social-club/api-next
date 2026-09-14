import { expect, test } from "bun:test";
import { processTelegramInbox } from "./chat.ts";
import { acceptTelegramUpdate, processTelegramDelivery, telegramPublication } from "./delivery.ts";
import { getTelegramSettings, setAssistantCredential } from "./settings.ts";
import {
  DEFAULT_ASSISTANT_POLICY,
  type DeliveryIntent,
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
      {
        inboxLive: async () => true,
        admitMinute: async () => true,
        reserveNotice: async () => true,
        enqueueInboxReply: async (record: DeliveryIntent) => {
          if (!methods.enqueueDelivery) throw new Error("Unexpected operation: enqueueInboxReply");
          await methods.enqueueDelivery(record);
          return true;
        },
        ...methods,
      },
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
  desired: { kind: "voice", text: "", speech: "The answer", media: null, buttons: [] },
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

test("a voice reply keeps the answer as synthesis input with an empty caption", async () => {
  const harness = voiceServices(
    async () => true,
    async () => {},
  );
  const queued: DeliveryRecord[] = [];
  harness.service.store.enqueueInboxReply = async (record) => {
    queued.push(record as unknown as DeliveryRecord);
    return true;
  };
  await processTelegramInbox(harness.service, "inbox");
  const voice = queued.find((entry) => entry.kind === "voice");
  const text = queued.find((entry) => entry.kind === "reply");
  expect(text?.desired?.text).toBe("Fixture answer");
  expect(voice?.desired?.text).toBe("");
  expect(voice?.desired?.speech).toBe("Fixture answer");
  if (!voice?.desired) throw new Error("Missing voice delivery");

  const spoken: string[] = [];
  let reservedCharacters = -1;
  harness.service.store.claimDelivery = async () => ({
    ...(voice as DeliveryRecord),
    confirmed: null,
    confirmedHash: null,
    messageId: null,
    attempt: "delivery-attempt",
    attemptCount: 1,
    lastError: null,
  });
  harness.service.store.reserveUsage = async (
    _community,
    _epoch,
    _user,
    _key,
    _policy,
    characters,
  ) => {
    reservedCharacters = characters;
    return true;
  };
  harness.service.providers = {
    ...harness.service.providers,
    synthesize: async (_key, _policy, input) => {
      spoken.push(input);
      return new Uint8Array([1]);
    },
  };
  harness.service.api = {
    dispatch: async () => ({ kind: "confirmed", messageId: 42 }),
  } as unknown as TelegramServices["api"];
  harness.service.store.finishDelivery = async () => {};
  await processTelegramDelivery(harness.service, voice.id);
  expect(spoken).toEqual(["Fixture answer"]);
  expect(reservedCharacters).toBe("Fixture answer".length);
});

test("a long spoken answer is bounded before synthesis", async () => {
  const harness = voiceServices(
    async () => true,
    async () => {},
  );
  const queued: DeliveryRecord[] = [];
  harness.service.store.enqueueInboxReply = async (record) => {
    queued.push(record as unknown as DeliveryRecord);
    return true;
  };
  harness.service.providers = {
    ...harness.service.providers,
    complete: async () => "x".repeat(4500),
  };
  await processTelegramInbox(harness.service, "inbox");
  const voice = queued.find((entry) => entry.kind === "voice");
  expect(voice?.desired?.text).toBe("");
  expect(voice?.desired?.speech).toHaveLength(4000);
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
      return true;
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
      return true;
    },
    failProviderStage: async (input) => {
      stages.set(input.stage, { state: "failed", attempt: input.attempt });
      return true;
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
      return true;
    },
    beginProviderStage: async () => ({ kind: "issued" }) as const,
    completeProviderStage: async (input) => {
      stages.push(input.stage);
      await completeProviderStage(input);
      return true;
    },
    failProviderStage: async () => true,
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

test("a lease expiring during a provider call leaves the inbox for reclaim", async () => {
  let live = true;
  let completions = 0;
  const finished: (string | null)[] = [];
  const replies: string[] = [];
  const service = services({
    claimInbox: async () => voiceInboxItem(),
    integration: async () => assistantVoiceIntegration(),
    privateChatStarted: async () => true,
    claimChat: async () => "lease",
    releaseChat: async () => {},
    inboxLive: async () => live,
    publicPosts: async () => [],
    history: async () => [],
    reserveUsage: async () => true,
    enqueueInboxReply: async (delivery) => {
      if (delivery.desired !== null && "text" in delivery.desired)
        replies.push(delivery.desired.text as string);
      return true;
    },
    saveConversation: async () => true,
    beginProviderStage: async () => ({ kind: "issued" }) as const,
    completeProviderStage: async () => true,
    failProviderStage: async () => true,
    finishInbox: async (_item, error) => {
      finished.push(error);
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
    transcribe: async () => "Fixture transcript",
    complete: async () => {
      completions += 1;
      // The claim lease expires while the completion request is in flight.
      live = false;
      return "Fixture answer";
    },
  };
  await processTelegramInbox(service, "inbox");
  expect(completions).toBe(1);
  expect(replies).toEqual([]);
  expect(finished).toEqual([]);
});

test("a refused reply leaves the inbox item unfinished", async () => {
  const finished: (string | null)[] = [];
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
    claimChat: async () => "lease",
    releaseChat: async () => {},
    admitCommand: async () => true,
    publicPosts: async () => [],
    enqueueInboxReply: async () => false,
    finishInbox: async (_item, error) => {
      finished.push(error);
    },
  });
  await processTelegramInbox(service, "inbox");
  expect(finished).toEqual([]);
});

test("a burst refusal sends one denial notice until the cooldown expires", async () => {
  const notices: DeliveryIntent[] = [];
  let noticeAllowed = true;
  const service = services({
    claimInbox: async () => ({
      id: "inbox",
      communityId: "community",
      botEpoch: "epoch",
      attempt: "attempt",
      update: {
        update_id: 3,
        message: {
          chat: { id: 7, type: "private" },
          from: { id: 7, is_bot: false },
          text: "/songs",
        },
      },
    }),
    integration: async () => integration,
    privateChatStarted: async () => true,
    claimChat: async () => "lease",
    releaseChat: async () => {},
    admitMinute: async () => false,
    reserveNotice: async () => {
      const allowed = noticeAllowed;
      noticeAllowed = false;
      return allowed;
    },
    enqueueDelivery: async (delivery) => {
      notices.push(delivery);
    },
    finishInbox: async () => {},
  });
  await processTelegramInbox(service, "inbox");
  await processTelegramInbox(service, "inbox");
  expect(notices).toHaveLength(1);
  noticeAllowed = true;
  await processTelegramInbox(service, "inbox");
  expect(notices).toHaveLength(2);
});

test("an exhausted model budget is denied once per cooldown", async () => {
  const notices: DeliveryIntent[] = [];
  let noticeAllowed = true;
  const service = services({
    claimInbox: async () => ({
      id: "inbox",
      communityId: "community",
      botEpoch: "epoch",
      attempt: "attempt",
      update: {
        update_id: 4,
        message: {
          chat: { id: 7, type: "private" },
          from: { id: 7, is_bot: false },
          text: "Tell me about the community",
        },
      },
    }),
    integration: async () => ({
      ...integration,
      policy: { ...integration.policy, enabled: true, model: "fixture-model" },
    }),
    privateChatStarted: async () => true,
    claimChat: async () => "lease",
    releaseChat: async () => {},
    reserveUsage: async () => false,
    reserveNotice: async () => {
      const allowed = noticeAllowed;
      noticeAllowed = false;
      return allowed;
    },
    enqueueDelivery: async (delivery) => {
      notices.push(delivery);
    },
    finishInbox: async () => {},
  });
  await processTelegramInbox(service, "inbox");
  await processTelegramInbox(service, "inbox");
  expect(notices).toHaveLength(1);
  noticeAllowed = true;
  await processTelegramInbox(service, "inbox");
  expect(notices).toHaveLength(2);
});

function groupItem(text: string) {
  return {
    id: "group-inbox",
    communityId: "community",
    botEpoch: "epoch",
    attempt: "attempt",
    update: {
      update_id: 9,
      message: {
        chat: { id: -100123, type: "supergroup" },
        from: { id: 7, is_bot: false },
        text,
      },
    },
  };
}

function audioItem(attachment: Record<string, unknown>) {
  return {
    id: "inbox",
    communityId: "community",
    botEpoch: "epoch",
    attempt: "attempt",
    update: {
      update_id: 10,
      message: {
        chat: { id: 7, type: "private" },
        from: { id: 7, is_bot: false },
        audio: attachment,
      },
    },
  };
}

test("group /start gets private-chat guidance without assisted answers", async () => {
  const replies: DeliveryIntent[] = [];
  let commands = 0;
  const service = services({
    claimInbox: async () => groupItem("/start"),
    integration: async () => integration,
    admitCommand: async () => {
      commands += 1;
      return true;
    },
    enqueueDelivery: async (delivery) => {
      replies.push(delivery);
    },
    finishInbox: async () => {},
  });
  await processTelegramInbox(service, "group-inbox");
  expect(commands).toBe(1);
  expect(replies).toHaveLength(1);
  expect(replies[0]?.desired?.text).toContain("private chat");
  expect(replies[0]?.desired?.text).toContain(`@${integration.botUsername}`);
});

test("group messages that are not /start stay unanswered", async () => {
  const replies: DeliveryIntent[] = [];
  const service = services({
    claimInbox: async () => groupItem("hello bot"),
    integration: async () => integration,
    enqueueDelivery: async (delivery) => {
      replies.push(delivery);
    },
    finishInbox: async () => {},
  });
  await processTelegramInbox(service, "group-inbox");
  expect(replies).toEqual([]);
});

test("a throttled group /start answers with one cooldown-bounded notice", async () => {
  const replies: DeliveryIntent[] = [];
  let noticeAllowed = true;
  const service = services({
    claimInbox: async () => groupItem("/start"),
    integration: async () => integration,
    admitMinute: async () => false,
    reserveNotice: async () => {
      const allowed = noticeAllowed;
      noticeAllowed = false;
      return allowed;
    },
    enqueueDelivery: async (delivery) => {
      replies.push(delivery);
    },
    finishInbox: async () => {},
  });
  await processTelegramInbox(service, "group-inbox");
  await processTelegramInbox(service, "group-inbox");
  expect(replies).toHaveLength(1);
  expect(replies[0]?.desired?.text).toContain("Too many requests");
});

test("an audio attachment is transcribed through the bounded path", async () => {
  const replies: string[] = [];
  const transcriptions: Uint8Array[] = [];
  const service = services({
    claimInbox: async () =>
      audioItem({ file_id: "audio-file", duration: 240, file_size: 1_000_000 }),
    integration: async () => assistantVoiceIntegration(),
    privateChatStarted: async () => true,
    claimChat: async () => "lease",
    releaseChat: async () => {},
    inboxLive: async () => true,
    publicPosts: async () => [],
    history: async () => [],
    reserveUsage: async () => true,
    saveConversation: async () => true,
    beginProviderStage: async () => ({ kind: "issued" }) as const,
    completeProviderStage: async () => true,
    failProviderStage: async () => true,
    enqueueInboxReply: async (delivery) => {
      if (delivery.desired !== null && "text" in delivery.desired)
        replies.push(delivery.desired.text as string);
      return true;
    },
    finishInbox: async () => {},
  });
  service.vault.open = async (ciphertext) =>
    ciphertext === "encrypted-token"
      ? JSON.stringify({ token: "123:fixture", secret: "fixture-secret" })
      : "fixture-key";
  service.api = {
    downloadVoice: async () => new Uint8Array([1, 2, 3]),
  } as unknown as TelegramServices["api"];
  service.providers = {
    ...service.providers,
    transcribe: async (_key, bytes) => {
      transcriptions.push(bytes);
      return "Fixture transcript";
    },
    complete: async () => "Fixture answer",
  };
  await processTelegramInbox(service, "inbox");
  expect(transcriptions).toHaveLength(1);
  expect(replies).toContain("Fixture answer");
});

test("an oversized audio attachment is refused before download", async () => {
  const replies: string[] = [];
  let transcriptions = 0;
  const service = services({
    claimInbox: async () =>
      audioItem({ file_id: "audio-file", duration: 240, file_size: 6_000_000 }),
    integration: async () => assistantVoiceIntegration(),
    privateChatStarted: async () => true,
    claimChat: async () => "lease",
    releaseChat: async () => {},
    inboxLive: async () => true,
    publicPosts: async () => [],
    reserveUsage: async () => true,
    enqueueInboxReply: async (delivery) => {
      if (delivery.desired !== null && "text" in delivery.desired)
        replies.push(delivery.desired.text as string);
      return true;
    },
    finishInbox: async () => {},
  });
  service.vault.open = async () => "fixture-key";
  service.providers = {
    ...service.providers,
    transcribe: async () => {
      transcriptions += 1;
      return "Fixture transcript";
    },
  };
  await processTelegramInbox(service, "inbox");
  expect(transcriptions).toBe(0);
  expect(replies).toEqual([
    "Audio input is unavailable. Send a voice note or a text message instead.",
  ]);
});

test("a publication send attaches the authorized poster when bytes are available", async () => {
  const post = {
    id: "post",
    communityId: "community",
    title: "Public",
    body: "Body",
    kind: "video",
    url: "https://pirate.example.invalid/post",
    studyUrl: null,
    karaokeUrl: null,
    media: null,
    rewardText: null,
  };
  const delivery: DeliveryRecord = {
    id: "publication-delivery",
    communityId: "community",
    botEpoch: "epoch",
    chatId: "-10001",
    kind: "publication",
    postId: "post",
    state: "pending",
    desired: telegramPublication(post),
    desiredHash: `hash:${JSON.stringify(telegramPublication(post))}`,
    confirmed: null,
    confirmedHash: null,
    messageId: null,
    attempt: "attempt",
    attemptCount: 1,
    lastError: null,
    createdAt: "2026-09-08T00:00:00Z",
  };
  const dispatched: unknown[] = [];
  const poster = {
    artifactRef: "media://derived/key/poster.jpg",
    key: "video-analysis/op/v1/c1/a1/poster.jpg",
    sha256: "a",
    sourceSha256: "b",
    policyRevision: "1",
  };
  const service = services({
    claimDelivery: async () => ({
      ...delivery,
      desired: { ...telegramPublication(post), kind: "photo" as const, media: poster.artifactRef },
      desiredHash: `hash:${JSON.stringify({ ...telegramPublication(post), kind: "photo", media: poster.artifactRef })}`,
    }),
    integration: async () => ({ ...integration, channelId: "-10001" }),
    publicPosts: async () => [post],
    publicationPoster: async () => poster,
    finishDelivery: async () => {},
  });
  service.vault.open = async () => JSON.stringify({ token: "123:fixture", secret: "s" });
  service.posterBytes = async () => new Uint8Array([9, 9]);
  service.api = {
    dispatch: async (
      _token: string,
      _delivery: DeliveryRecord,
      _operation: "send" | "edit" | "delete",
      _audio: Uint8Array | undefined,
      photo: Readonly<{ bytes: Uint8Array; contentType: "image/jpeg" }> | undefined,
    ) => {
      dispatched.push(photo);
      return { kind: "confirmed", messageId: 5 };
    },
  } as unknown as TelegramServices["api"];
  await processTelegramDelivery(service, "publication-delivery");
  expect(dispatched).toEqual([{ bytes: new Uint8Array([9, 9]), contentType: "image/jpeg" }]);
});

test("a publication send without poster bytes stays text", async () => {
  const post = {
    id: "post",
    communityId: "community",
    title: "Public",
    body: "Body",
    kind: "video",
    url: "https://pirate.example.invalid/post",
    studyUrl: null,
    karaokeUrl: null,
    media: null,
    rewardText: null,
  };
  const delivery: DeliveryRecord = {
    id: "publication-delivery",
    communityId: "community",
    botEpoch: "epoch",
    chatId: "-10001",
    kind: "publication",
    postId: "post",
    state: "pending",
    desired: telegramPublication(post),
    desiredHash: `hash:${JSON.stringify(telegramPublication(post))}`,
    confirmed: null,
    confirmedHash: null,
    messageId: null,
    attempt: "attempt",
    attemptCount: 1,
    lastError: null,
    createdAt: "2026-09-08T00:00:00Z",
  };
  const dispatched: unknown[] = [];
  const service = services({
    claimDelivery: async () => delivery,
    integration: async () => ({ ...integration, channelId: "-10001" }),
    publicPosts: async () => [post],
    publicationPoster: async () => null,
    finishDelivery: async () => {},
  });
  service.vault.open = async () => JSON.stringify({ token: "123:fixture", secret: "s" });
  service.posterBytes = async () => new Uint8Array([9, 9]);
  service.api = {
    dispatch: async (
      _token: string,
      _delivery: DeliveryRecord,
      _operation: "send" | "edit" | "delete",
      _audio: Uint8Array | undefined,
      photo: Readonly<{ bytes: Uint8Array; contentType: "image/jpeg" }> | undefined,
    ) => {
      dispatched.push(photo);
      return { kind: "confirmed", messageId: 5 };
    },
  } as unknown as TelegramServices["api"];
  await processTelegramDelivery(service, "publication-delivery");
  expect(dispatched).toEqual([undefined]);
});

const publicationPost = {
  id: "post",
  communityId: "community",
  title: "Public",
  body: "Body",
  kind: "video",
  url: "https://pirate.example.invalid/post",
  studyUrl: null,
  karaokeUrl: null,
  media: null,
  rewardText: null,
};
const publicationPosterIdentity = {
  artifactRef: "media://derived/key/poster.jpg",
  key: "video-analysis/op/v1/c1/a1/poster.jpg",
  sha256: "a",
  sourceSha256: "b",
  policyRevision: "1",
};
const publicationPhotoMessage = {
  ...telegramPublication(publicationPost),
  kind: "photo" as const,
  media: publicationPosterIdentity.artifactRef,
};

function publicationFixture(state: "pending" | "delivered", messageId: number | null) {
  const dispatched: unknown[] = [];
  const finishes: unknown[][] = [];
  const delivery: DeliveryRecord = {
    id: "publication-delivery",
    communityId: "community",
    botEpoch: "epoch",
    chatId: "-10001",
    kind: "publication",
    postId: "post",
    state,
    desired: publicationPhotoMessage,
    desiredHash: `hash:${JSON.stringify(publicationPhotoMessage)}`,
    confirmed: state === "delivered" ? telegramPublication(publicationPost) : null,
    confirmedHash:
      state === "delivered" ? `hash:${JSON.stringify(telegramPublication(publicationPost))}` : null,
    messageId,
    attempt: "attempt",
    attemptCount: 1,
    lastError: null,
    createdAt: "2026-09-08T00:00:00Z",
  };
  const service = services({
    claimDelivery: async () => delivery,
    integration: async () => ({ ...integration, channelId: "-10001" }),
    publicPosts: async () => [publicationPost],
    publicationPoster: async () => publicationPosterIdentity,
    finishDelivery: async (...args) => {
      finishes.push(args);
    },
  });
  service.vault.open = async () => JSON.stringify({ token: "123:fixture", secret: "s" });
  service.api = {
    dispatch: async (
      _token: string,
      _delivery: DeliveryRecord,
      _operation: "send" | "edit" | "delete",
      _audio: Uint8Array | undefined,
      photo: Readonly<{ bytes: Uint8Array; contentType: "image/jpeg" }> | undefined,
    ) => {
      dispatched.push(photo);
      return { kind: "confirmed" as const, messageId: 31 };
    },
  } as unknown as TelegramServices["api"];
  return { service, dispatched, finishes };
}

test("a poster-less send records the text actually sent", async () => {
  const { service, dispatched, finishes } = publicationFixture("pending", null);
  service.posterBytes = async () => null;
  await processTelegramDelivery(service, "publication-delivery");
  expect(dispatched).toEqual([undefined]);
  expect(finishes).toHaveLength(1);
  const override = finishes[0]?.[3] as {
    message: { kind: string; media: string | null };
    hash: string;
  };
  expect(override.message.kind).toBe("text");
  expect(override.message.media).toBeNull();
  expect(override.hash).toContain("text");
});

test("a text message upgrades to the poster when bytes exist", async () => {
  const { service, dispatched, finishes } = publicationFixture("delivered", 31);
  service.posterBytes = async () => new Uint8Array([7]);
  await processTelegramDelivery(service, "publication-delivery");
  expect(dispatched).toEqual([{ bytes: new Uint8Array([7]), contentType: "image/jpeg" }]);
  expect(finishes).toHaveLength(1);
  expect(finishes[0]?.[3]).toBeUndefined();
});

test("a poster replacement without bytes retries instead of confirming a caption edit", async () => {
  const { service, dispatched, finishes } = publicationFixture("delivered", 31);
  service.posterBytes = async () => null;
  await processTelegramDelivery(service, "publication-delivery");
  expect(dispatched).toEqual([]);
  expect(finishes).toHaveLength(1);
  expect(finishes[0]?.[1]).toEqual({
    kind: "rejected",
    code: "publication_media_unavailable",
    retryAfter: 60,
  });
});
