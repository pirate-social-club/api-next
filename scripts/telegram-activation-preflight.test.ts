import { expect, test } from "bun:test";
import { telegramActivationBinding } from "./telegram-activation-preflight.ts";

const source = (chat: unknown, linking: unknown) =>
  JSON.stringify({
    vars: { TELEGRAM_ENABLED: "true" },
    env: { staging: { vars: { TELEGRAM_ENABLED: chat, TELEGRAM_LINKING_ENABLED: linking } } },
  });
test("either selected HTTP flag requires admission; both off do not", () => {
  expect(telegramActivationBinding(source("false", "false"), "staging", true)).toBe(false);
  expect(telegramActivationBinding(source("true", "false"), "staging", true)).toBe(true);
  expect(telegramActivationBinding(source("false", "true"), "staging", true)).toBe(true);
  expect(telegramActivationBinding(source("false", undefined), "staging", false)).toBe(false);
});
test("flags do not inherit root defaults and malformed configurations fail closed", () => {
  for (const value of [undefined, true, "TRUE", 1])
    expect(() => telegramActivationBinding(source(value, "false"), "staging", true)).toThrow();
  expect(() => telegramActivationBinding(source("false", undefined), "staging", true)).toThrow();
  expect(() => telegramActivationBinding(source("false", "false"), "prod", true)).toThrow();
});
