import { expect, test } from "bun:test";
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
  const providers = makeTelegramAssistantProviders(
    (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
  );
  await expect(
    providers.complete("key", "model", [{ role: "user", content: "hello" }]),
  ).rejects.toMatchObject({ reason: "uncertain" });
});
