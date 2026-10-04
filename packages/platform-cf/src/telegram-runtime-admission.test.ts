import { expect, spyOn, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import type { TelegramServices } from "@pirate/application/telegram";
import { Effect, Layer } from "effect";
import {
  disabledTelegramConfiguration,
  telegramBindingsFixture,
  telegramConfigurationFixture,
} from "../../testing/src/telegram-configuration-fixture.ts";
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
  ...telegramBindingsFixture,
  TELEGRAM_CONFIG_JSON: JSON.stringify({ ...telegramConfigurationFixture, linking_enabled: false }),
};
test("disabled HTTP, jobs and linking setup never touch the database", async () => {
  const f = fixture();
  expect(
    await makeTelegramServices({ TELEGRAM_CONFIG_JSON: disabledTelegramConfiguration }, f.runtime),
  ).toBeNull();
  expect(
    await makeTelegramLinkServices(
      { TELEGRAM_CONFIG_JSON: disabledTelegramConfiguration },
      f.runtime,
      null,
    ),
  ).toBeNull();
  expect(f.calls).toEqual([]);
});
test("runtime setup refuses the actual executor before bot/provider construction", async () => {
  const f = fixture();
  expect(await makeTelegramServices(complete, f.runtime)).toBeNull();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.readonly).toBe(true);
  expect(f.calls[0]?.text).toContain("current_user");
  const inert = {} as TelegramServices;
  expect(await makeTelegramLinkServices(telegramBindingsFixture, f.runtime, inert)).toBeNull();
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

test("setup failures produce only fixed diagnostics and leave Telegram unavailable", async () => {
  const f = fixture();
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await makeTelegramServices(complete, f.runtime)).toBeNull();
    expect(
      await makeTelegramServices(
        { ...complete, TELEGRAM_SECRETS_JSON: "secret malformed key" },
        f.runtime,
      ),
    ).toBeNull();
    expect(
      await makeTelegramLinkServices(
        { TELEGRAM_CONFIG_JSON: "invalid", TELEGRAM_SECRETS_JSON: "secret" },
        f.runtime,
        null,
      ),
    ).toBeNull();
    expect(log.mock.calls).toEqual([
      [
        "Telegram chat setup unavailable; chat operations disabled",
        { category: "permission_refused" },
      ],
      ["Telegram chat setup unavailable; chat operations disabled", { category: "configuration" }],
      [
        "Telegram linking setup unavailable; linking operations disabled",
        { category: "configuration" },
      ],
    ]);
  } finally {
    log.mockRestore();
  }
});

test("chat and linking query failures never log database errors or connection details", async () => {
  const execute = (_statement: ControlPlaneStatement) =>
    Effect.die("postgres://fixture-user:fixture-password@fixture-host; fixture-bot-secret");
  const runtime = Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: (use) => use({ execute }),
  });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await makeTelegramServices(complete, runtime)).toBeNull();
    expect(
      await makeTelegramLinkServices(telegramBindingsFixture, runtime, {} as TelegramServices),
    ).toBeNull();
    expect(log.mock.calls).toEqual([
      ["Telegram chat setup unavailable; chat operations disabled", { category: "query_failed" }],
      [
        "Telegram linking setup unavailable; linking operations disabled",
        { category: "query_failed" },
      ],
    ]);
  } finally {
    log.mockRestore();
  }
});
