import { describe, expect, test } from "bun:test";
import type { PlatformPirateHandleStore } from "@pirate/application/use-cases/handles/platform-pirate-rename";
import { Effect } from "effect";
import { makePlatformPirateHandleHandlers } from "./platform-pirate-handle-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const store = (overrides: Partial<PlatformPirateHandleStore> = {}): PlatformPirateHandleStore => ({
  checkAvailability: () => Effect.succeed({ kind: "available" }),
  rename: () => Effect.succeed({ kind: "handle_unavailable" }),
  ...overrides,
});

const worker = (value: PlatformPirateHandleStore) =>
  createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    handlers: makePlatformPirateHandleHandlers(value),
    authenticate: () => ({ kind: "user", subject: "account-http" }),
    authorize: () => undefined,
  });

const post = (path: string, body: unknown) =>
  new Request(`https://api.pirate.test${path}`, {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("platform Pirate handle HTTP handlers", () => {
  test("keeps invalid availability advisory and session-derives the account", async () => {
    let calls = 0;
    const app = worker(
      store({
        checkAvailability: () => {
          calls += 1;
          return Effect.succeed({ kind: "available" });
        },
      }),
    );
    const response = await app.request(
      post("/platform-pirate-handles/availability", {
        persona_id: "persona-http",
        platform_handle_id: "platform-http",
        desired_label: "Captain",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "unavailable", reason: "invalid_label" });
    expect(calls).toBe(1);
  });

  test("maps closed rename conflicts without exposing storage details", async () => {
    let observedAccount = "";
    const app = worker(
      store({
        rename: (input) => {
          observedAccount = input.accountId;
          return Effect.succeed({ kind: "cleanup_rename_unavailable" });
        },
      }),
    );
    const response = await app.request(
      post("/platform-pirate-handles/rename", {
        idempotency_key: "rename-http",
        persona_id: "persona-http",
        platform_handle_id: "platform-http",
        expected_state_hash: "a".repeat(64),
        desired_label: "captain-data",
      }),
    );
    expect(response.status).toBe(409);
    expect(observedAccount).toBe("account-http");
    expect(await response.json()).toMatchObject({
      error: {
        code: "cleanup_rename_unavailable",
        message: "Platform Pirate handle request rejected",
        retryable: false,
      },
    });
  });
});
