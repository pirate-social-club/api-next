import { expect, test } from "bun:test";
import { TelegramFailure, type TelegramServices } from "@pirate/application/telegram";
import { makeTelegramHandlers } from "./telegram-handlers.ts";

test("credential handlers retain authenticated owner and routed community despite extra body fields", async () => {
  const checked: string[][] = [];
  const services = {
    store: {
      owner: async (communityId: string, accountId: string) => {
        checked.push([communityId, accountId]);
        throw new TelegramFailure({ reason: "unauthorized" });
      },
    },
  } as unknown as TelegramServices;
  const handlers = makeTelegramHandlers(services);
  for (const endpoint of [
    "ConnectCommunityTelegram",
    "UpdateCommunityTelegram",
    "SetCommunityAssistantCredential",
  ]) {
    await expect(
      Promise.resolve().then(() =>
        handlers[endpoint]?.({
          principal: { kind: "user", subject: "authenticated-viewer" },
          params: { communityId: "routed-community" },
          query: {},
          body: {
            expected_revision: 0,
            idempotency_key: "command",
            accountId: "forged-owner",
            communityId: "forged-community",
            token: "fixture-token",
            provider: "openrouter",
            key: "fixture-key",
          },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "AuthError" });
  }
  expect(checked).toEqual(
    Array.from({ length: 3 }, () => ["routed-community", "authenticated-viewer"]),
  );
});
