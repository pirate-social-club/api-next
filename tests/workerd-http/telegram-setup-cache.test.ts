import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import { Effect, Layer } from "effect";
import { expect, test, vi } from "vitest";
import { makeRecoveringTelegramHandlers } from "../../apps/http-worker/src/telegram-setup-cache.ts";
import { createHttpWorker } from "../../apps/http-worker/src/transport.ts";
import { TELEGRAM_ACTIVATION_TABLES } from "../../packages/platform-cf/src/telegram-activation-privileges.ts";
import { makeTelegramLinkServices } from "../../packages/platform-cf/src/telegram-linking-runtime.ts";
import { makeTelegramServices } from "../../packages/platform-cf/src/telegram-runtime.ts";
import { telegramBindingsFixture } from "../../packages/testing/src/telegram-configuration-fixture.ts";

for (const failure of ["query", "permission"] as const) {
  test(`native HTTP requests recover Telegram ${failure} failure within the same composition`, async () => {
    let time = 0,
      broken = true,
      checks = 0;
    const execute = <R = unknown>(statement: ControlPlaneStatement) => {
      if (statement.text.includes("current_user")) {
        checks++;
        if (broken && failure === "query") return Effect.die("redacted-fixture-credential");
        const rows = TELEGRAM_ACTIVATION_TABLES.map(([table_name, expected_delete]) => ({
          runtime_role: "restricted_executor",
          table_name,
          expected_delete,
          expected_truncate: false,
          schema_usage: true,
          table_exists: true,
          owner_equivalent: false,
          can_select: true,
          can_insert: true,
          can_update: true,
          can_delete: expected_delete,
          can_truncate: false,
        }));
        if (broken && rows[0]) rows[0].can_delete = false;
        return Effect.succeed({ rows: rows as unknown as readonly R[], rowCount: rows.length });
      }
      return Effect.succeed({ rows: [] as readonly R[], rowCount: 0 });
    };
    const runtime = Layer.succeed(ControlPlaneDb, {
      execute,
      withTransaction: (use) => use({ execute }),
    });
    const bindings = telegramBindingsFixture;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = createHttpWorker({
        config: { corsOrigin: "https://pirate.example.invalid" },
        authenticate: () => ({ kind: "user", subject: "learner" }),
        authorize: () => {},
        handlers: makeRecoveringTelegramHandlers({
          chat: () => makeTelegramServices(bindings, runtime),
          linking: (chat) => makeTelegramLinkServices(bindings, runtime, chat),
          now: () => time,
        }),
      });
      const url = "https://pirate.example.invalid/telegram/link/account";
      const options = { headers: { cookie: "__Host-pirate_session=fixture-session" } };
      expect((await app.request("https://pirate.example.invalid/health")).status).toBe(200);
      expect(checks).toBe(0);
      expect((await app.request(url, options)).status).toBe(502);
      broken = false;
      time = 29_999;
      expect((await app.request(url, options)).status).toBe(502);
      expect(checks).toBe(1);
      expect((await app.request("https://pirate.example.invalid/health")).status).toBe(200);
      time = 30_000;
      const response = await app.request(url, options);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ telegram_user_ids: [], grants: [] });
      expect(checks).toBe(3);
      expect((await app.request(url, options)).status).toBe(200);
      expect(checks).toBe(3);
      expect(log.mock.calls[0]?.[1]).toEqual(
        failure === "query"
          ? { category: "query_failed" }
          : { category: "permission_refused", table: "telegram_account_associations" },
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("redacted-fixture-credential");
    } finally {
      log.mockRestore();
    }
  });
}

test("native HTTP leaves unrelated routes available for missing or malformed compact settings", async () => {
  let checks = 0;
  const execute = <R = unknown>(_statement: ControlPlaneStatement) => {
    checks++;
    return Effect.succeed({ rows: [] as readonly R[], rowCount: 0 });
  };
  const runtime = Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: (use) => use({ execute }),
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const value of [
      undefined,
      "secret-looking-invalid-input",
      '{"version":1,"enabled":"true"}',
    ]) {
      const bindings = { TELEGRAM_CONFIG_JSON: value };
      const app = createHttpWorker({
        config: { corsOrigin: "https://pirate.example.invalid" },
        authenticate: () => ({ kind: "user", subject: "learner" }),
        authorize: () => {},
        handlers: makeRecoveringTelegramHandlers({
          chat: () => makeTelegramServices(bindings, runtime),
          linking: (chat) => makeTelegramLinkServices(bindings, runtime, chat),
        }),
      });
      expect((await app.request("https://pirate.example.invalid/health")).status).toBe(200);
      expect(
        (
          await app.request("https://pirate.example.invalid/telegram/link/account", {
            headers: { cookie: "__Host-pirate_session=fixture-session" },
          })
        ).status,
      ).toBe(502);
      expect((await app.request("https://pirate.example.invalid/health")).status).toBe(200);
    }
    expect(checks).toBe(0);
    expect(log.mock.calls).toHaveLength(3);
    expect(
      log.mock.calls.every((call) => JSON.stringify(call[1]) === '{"category":"configuration"}'),
    ).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-looking-invalid-input");
  } finally {
    log.mockRestore();
  }
});
