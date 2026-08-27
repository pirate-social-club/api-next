import type { PlatformPirateHandleStore } from "@pirate/application/use-cases/handles/platform-pirate-rename";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { makePlatformPirateHandleHandlers } from "../../apps/http-worker/src/platform-pirate-handle-handlers.ts";
import { createHttpWorker } from "../../apps/http-worker/src/transport.ts";

const store: PlatformPirateHandleStore = {
  checkAvailability: (input) =>
    Effect.succeed(
      input.desiredLabel === "captain-workerd"
        ? { kind: "available" as const }
        : { kind: "unavailable" as const },
    ),
  rename: () => Effect.succeed({ kind: "stale_platform_handle" }),
};

const app = createHttpWorker({
  config: { corsOrigin: "https://app.pirate.test" },
  handlers: makePlatformPirateHandleHandlers(store),
  authenticate: () => ({ kind: "user", subject: "account-workerd-platform-handle" }),
  authorize: () => undefined,
});

const browserHeaders = {
  cookie: "__Host-pirate_session=workerd; __Host-pirate_csrf=csrf",
  origin: "https://app.pirate.test",
  "x-csrf-token": "csrf",
  "content-type": "application/json",
} as const;

describe("platform Pirate cleanup rename in workerd", () => {
  test("executes the generated availability route with WebCrypto-compatible hashes", async () => {
    const response = await app.request("https://worker.test/platform-pirate-handles/availability", {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        persona_id: "persona-workerd-platform-handle",
        platform_handle_id: "platform-workerd-handle",
        desired_label: "captain-workerd",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "available",
      desired_label: "captain-workerd",
      display_identifier: "captain-workerd.pirate",
      policy: {
        label_policy_hash: "7139c5f71b651833a68b14d03b2ef93f9b528b73bd53c455546cdb10a54eb873",
      },
    });
  });

  test("preserves the closed stale-state error through workerd", async () => {
    const response = await app.request("https://worker.test/platform-pirate-handles/rename", {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        idempotency_key: "rename-workerd-platform-handle",
        persona_id: "persona-workerd-platform-handle",
        platform_handle_id: "platform-workerd-handle",
        expected_state_hash: "a".repeat(64),
        desired_label: "captain-workerd",
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "stale_platform_handle", retryable: false },
    });
  });

  test("rejects a bearer credential before invoking the private account operation", async () => {
    const response = await app.request("https://worker.test/platform-pirate-handles/availability", {
      method: "POST",
      headers: { authorization: "Bearer workerd", "content-type": "application/json" },
      body: JSON.stringify({
        persona_id: "persona-workerd-platform-handle",
        platform_handle_id: "platform-workerd-handle",
        desired_label: "captain-workerd",
      }),
    });
    expect(response.status).toBe(401);
  });
});
