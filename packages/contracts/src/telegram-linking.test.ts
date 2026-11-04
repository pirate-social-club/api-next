import { expect, test } from "bun:test";
import { telegramLinkingRegistry } from "./telegram-linking.ts";

test("every private Telegram linking ceremony requires the browser session policy", () => {
  expect(Object.keys(telegramLinkingRegistry)).toHaveLength(8);
  for (const endpoint of Object.values(telegramLinkingRegistry)) {
    expect(endpoint.auth.policy.kind).toBe("user");
    expect(endpoint.auth.browserSessionOnly).toBe(true);
  }
});
