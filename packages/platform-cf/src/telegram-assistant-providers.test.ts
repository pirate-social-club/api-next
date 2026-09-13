import { expect, test } from "bun:test";
import {
  DEFAULT_ASSISTANT_POLICY,
  processTelegramInbox,
  type TelegramServices,
} from "@pirate/application/telegram";
import { makeTelegramAssistantProviders } from "./telegram-assistant-providers.ts";

test("transport loss after a provider request is classified uncertain", async () => {
  const providers = makeTelegramAssistantProviders((async () => {
    throw new TypeError("network unavailable");
  }) as unknown as typeof fetch);
  await expect(
    providers.complete("key", "model", [{ role: "user", content: "hello" }]),
  ).rejects.toMatchObject({ reason: "uncertain" });
});

test("a provider error response remains a definite failure", async () => {
  const providers = makeTelegramAssistantProviders((async () =>
    Response.json(
      { error: { message: "provider failed" } },
      { status: 500 },
    )) as unknown as typeof fetch);
  await expect(
    providers.complete("key", "model", [{ role: "user", content: "hello" }]),
  ).rejects.toMatchObject({ reason: "unavailable" });
});

test("a successful response with an unusable body is classified uncertain", async () => {
  for (const body of [
    "not json",
    JSON.stringify({ choices: [{}] }),
    JSON.stringify({ choices: [{ message: null }] }),
    JSON.stringify({ choices: [{ message: { content: 7 } }] }),
    JSON.stringify({ choices: null }),
  ]) {
    const providers = makeTelegramAssistantProviders(
      (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    );
    await expect(
      providers.complete("key", "model", [{ role: "user", content: "hello" }]),
    ).rejects.toMatchObject({ reason: "uncertain" });
  }
});

test("an unusable completion body issues once and yields the uncertain fallback", async () => {
  let requests = 0;
  const providers = makeTelegramAssistantProviders((async () => {
    requests += 1;
    return Response.json({ choices: [{}] });
  }) as unknown as typeof fetch);
  const stages = new Map<string, string>();
  const replies: { id: string; text: string }[] = [];
  const finishes: (string | null)[] = [];
  const item = {
    id: "input",
    communityId: "fixture",
    botEpoch: "epoch",
    attempt: "attempt-1",
    update: {
      update_id: 1,
      message: {
        chat: { id: 7, type: "private" },
        from: { id: 7, is_bot: false },
        text: "Tell me about the community",
      },
    },
  };
  const service = {
    store: {
      integration: async () => ({
        communityId: "fixture",
        botEpoch: "epoch",
        status: "ready",
        botId: "123",
        channelId: null,
        policy: {
          ...DEFAULT_ASSISTANT_POLICY,
          enabled: true,
          model: "fixture-model",
          remember_conversations: false,
        },
        credentials: {
          openrouter: { ciphertext: "sealed", status: "valid", checkedAt: "2026-09-08T00:00:00Z" },
        },
      }),
      claimInbox: async () => item,
      inboxLive: async () => true,
      claimChat: async () => "lease",
      releaseChat: async () => {},
      privateChatStarted: async () => true,
      publicPosts: async () => [],
      history: async () => [],
      reserveUsage: async () => true,
      enqueueInboxReply: async (delivery: { id: string; desired: { text: string } | null }) => {
        if (delivery.desired !== null)
          replies.push({ id: delivery.id, text: delivery.desired.text });
        return true;
      },
      beginProviderStage: async (input: { stage: string }) => {
        if (stages.get(input.stage) === "issued") return { kind: "uncertain" } as const;
        stages.set(input.stage, "issued");
        return { kind: "issued" } as const;
      },
      completeProviderStage: async () => true,
      failProviderStage: async () => true,
      finishInbox: async (_item: unknown, error: string | null) => {
        finishes.push(error);
      },
    },
    providers,
    vault: {
      hash: async (value: string) => `hash:${value}`,
      open: async () => "fixture-key",
    },
    publicOrigin: "https://pirate.example.invalid",
    webhookOrigin: "https://api.example.invalid",
    now: () => 0,
    wake: async () => {},
  } as unknown as TelegramServices;
  await processTelegramInbox(service, "input");
  item.attempt = "attempt-2";
  await processTelegramInbox(service, "input");
  expect(requests).toBe(1);
  expect(stages.get("completion")).toBe("issued");
  expect(finishes).toEqual([null, null]);
  expect(replies.map((entry) => entry.text)).toEqual([
    "That request could not be completed. Please send it again in a moment.",
    "That request could not be completed. Please send it again in a moment.",
  ]);
});
