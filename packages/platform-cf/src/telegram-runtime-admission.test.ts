import { expect, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import type { TelegramServices } from "@pirate/application/telegram";
import { Effect, Layer } from "effect";
import { makeTelegramLinkServices } from "./telegram-linking-runtime.ts";
import { makeTelegramServices } from "./telegram-runtime.ts";
import { makeTelegramStudyServices } from "./telegram-study-runtime.ts";

function fixture() {
  const calls: ControlPlaneStatement[] = [];
  const execute = <R = unknown>(statement: ControlPlaneStatement) => {
    calls.push(statement);
    return Effect.succeed({ rows: [] as readonly R[], rowCount: 0 });
  };
  return {
    calls,
    runtime: Layer.succeed(ControlPlaneDb, { execute, withTransaction: (use) => use({ execute }) }),
  };
}
const complete = {
  TELEGRAM_ENABLED: "true",
  TELEGRAM_PUBLIC_ORIGIN: "https://pirate.example.invalid",
  TELEGRAM_WEBHOOK_ORIGIN: "https://api.example.invalid",
  TELEGRAM_CREDENTIAL_ACTIVE_VERSION: "v1",
  TELEGRAM_CREDENTIAL_KEYS_JSON: "{}",
  TELEGRAM_QUEUE: { send: async () => {} },
};
test("disabled HTTP, jobs and linking setup never touch the database", async () => {
  const f = fixture();
  expect(await makeTelegramServices({ TELEGRAM_ENABLED: "false" }, f.runtime)).toBeNull();
  expect(
    await makeTelegramLinkServices({ TELEGRAM_LINKING_ENABLED: "false" }, f.runtime, null),
  ).toBeNull();
  expect(f.calls).toEqual([]);
});
test("runtime setup refuses the actual executor before bot/provider construction", async () => {
  const f = fixture();
  await expect(makeTelegramServices(complete, f.runtime)).rejects.toThrow(
    "privilege facts incomplete",
  );
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.readonly).toBe(true);
  expect(f.calls[0]?.text).toContain("current_user");
  const inert = {} as TelegramServices;
  await expect(
    makeTelegramLinkServices(
      {
        TELEGRAM_LINKING_ENABLED: "true",
        TELEGRAM_LOGIN_CLIENT_ID: "123",
        TELEGRAM_LOGIN_CLIENT_SECRET: "fixture-secret",
        TELEGRAM_LOGIN_REDIRECT_URI: "https://pirate.example.invalid/telegram/link/callback",
      },
      f.runtime,
      inert,
    ),
  ).rejects.toThrow("privilege facts incomplete");
  expect(f.calls).toHaveLength(2);
});
test("practice defaults off and cannot be activated in production", () => {
  const f = fixture(),
    inert = {} as TelegramServices;
  expect(makeTelegramStudyServices({}, f.runtime, inert)).toBeUndefined();
  expect(() =>
    makeTelegramStudyServices(
      { TELEGRAM_STUDY_PRACTICE_ENABLED: "true", API_NEXT_ENV: "production" },
      f.runtime,
      inert,
    ),
  ).toThrow("requires staging");
  expect(f.calls).toEqual([]);
});
