import { expect, test } from "bun:test";
import {
  telegramBindingsFixture,
  telegramConfigurationFixture,
} from "../../testing/src/telegram-configuration-fixture.ts";
import {
  decodeTelegramConfiguration,
  decodeTelegramCredentials,
} from "./telegram-configuration.ts";

test("compact configuration carries feature intent without credentials", () => {
  expect(decodeTelegramConfiguration(telegramBindingsFixture)).toEqual(
    telegramConfigurationFixture,
  );
  expect(decodeTelegramCredentials(telegramBindingsFixture).login_client_secret).toBe(
    "fixture-secret",
  );
});
test("missing, malformed and old top-level configuration cannot enable Telegram", () => {
  for (const value of [undefined, "", "{", "[]", "null", "x".repeat(16_385)])
    expect(() => decodeTelegramConfiguration({ TELEGRAM_CONFIG_JSON: value })).toThrow(
      "configuration missing or invalid",
    );
  expect(() => decodeTelegramConfiguration({})).toThrow();
});
test("strict configuration rejects ambiguous flags, unknown fields and secret placement", () => {
  for (const change of [
    { version: 2 },
    { enabled: "true" },
    { linking_enabled: undefined },
    { login_client_secret: "never-log-this" },
    { credential_keys: { v1: "never-log-this" } },
    { enabled: false },
    { public_origin: "http://pirate.example.invalid" },
    { webhook_origin: "https://user:password@api.example.invalid" },
    { login_client_id: "not-numeric" },
    { login_redirect_uri: "https://pirate.example.invalid/?code=secret" },
  ]) {
    const input = JSON.stringify({ ...telegramConfigurationFixture, ...change });
    expect(() => decodeTelegramConfiguration({ TELEGRAM_CONFIG_JSON: input })).toThrow(
      "Telegram compact configuration missing or invalid",
    );
  }
});
test("practice requires a bounded, distinct explicit catalogue", () => {
  for (const ids of [
    [],
    ["same", "same"],
    Array.from({ length: 9 }, (_, i) => String(i)),
    ["x".repeat(129)],
  ])
    expect(() =>
      decodeTelegramConfiguration({
        TELEGRAM_CONFIG_JSON: JSON.stringify({
          ...telegramConfigurationFixture,
          practice_enabled: true,
          practice_community_id: "community",
          practice_post_ids: ids,
        }),
      }),
    ).toThrow();
  expect(
    decodeTelegramConfiguration({
      TELEGRAM_CONFIG_JSON: JSON.stringify({
        ...telegramConfigurationFixture,
        practice_enabled: true,
        practice_community_id: "community",
        practice_post_ids: ["song"],
      }),
    }).practice_post_ids,
  ).toEqual(["song"]);
});
test("credential errors never contain the input or schema diagnostics", () => {
  for (const value of [
    undefined,
    "never-log-this",
    '{"version":1,"credential_keys":{"v1":42},"login_client_secret":"never-log-this"}',
    '{"version":2,"credential_keys":{}}',
  ]) {
    try {
      decodeTelegramCredentials({ TELEGRAM_SECRETS_JSON: value });
      throw Error("invalid credentials admitted");
    } catch (error) {
      expect(String(error)).toBe("Error: Telegram compact credentials missing or invalid");
    }
  }
});
