import { expect, test } from "bun:test";
import { telegramConfigurationFixture } from "../packages/testing/src/telegram-configuration-fixture.ts";
import { telegramActivationBinding } from "./telegram-activation-preflight.ts";

const source = (enabled: boolean, linking: boolean, practice = false) =>
  JSON.stringify({
    vars: { TELEGRAM_CONFIG_JSON: JSON.stringify(telegramConfigurationFixture) },
    env: {
      staging: {
        vars: {
          TELEGRAM_CONFIG_JSON: JSON.stringify({
            ...telegramConfigurationFixture,
            enabled,
            linking_enabled: linking,
            practice_enabled: practice,
            practice_community_id: "community",
            practice_post_ids: ["song"],
          }),
        },
      },
    },
  });
test("compact feature intent still requires serving-role admission", () => {
  expect(telegramActivationBinding(source(false, false), "staging", true)).toBe(false);
  expect(telegramActivationBinding(source(true, false), "staging", true)).toBe(true);
  expect(telegramActivationBinding(source(true, true), "staging", true)).toBe(true);
  expect(telegramActivationBinding(source(true, false, true), "staging", false)).toBe(true);
  expect(() => telegramActivationBinding(source(false, true), "staging", true)).toThrow();
  expect(() => telegramActivationBinding(source(true, true), "staging", false)).toThrow();
});
test("root configuration never substitutes for missing environment configuration", () => {
  expect(() => telegramActivationBinding(source(false, false), "prod", true)).toThrow();
  for (const value of [undefined, true, "{", "[]", '{"enabled":"true"}']) {
    const invalid = JSON.stringify({ env: { staging: { vars: { TELEGRAM_CONFIG_JSON: value } } } });
    expect(() => telegramActivationBinding(invalid, "staging", true)).toThrow();
  }
});
