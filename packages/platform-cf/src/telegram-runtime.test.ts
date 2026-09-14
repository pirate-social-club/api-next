import { expect, test } from "bun:test";
import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import type { Layer } from "effect";
import { makeTelegramServices, type TelegramBindings } from "./telegram-runtime.ts";

const runtime = {} as unknown as Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/u, "");

function bindings(extra: Partial<TelegramBindings> = {}): TelegramBindings {
  return {
    TELEGRAM_ENABLED: "true",
    TELEGRAM_PUBLIC_ORIGIN: "https://pirate.example.invalid",
    TELEGRAM_WEBHOOK_ORIGIN: "https://api.example.invalid",
    TELEGRAM_CREDENTIAL_ACTIVE_VERSION: "1",
    TELEGRAM_CREDENTIAL_KEYS_JSON: JSON.stringify({ "1": key }),
    TELEGRAM_QUEUE: { send: async () => undefined },
    ...extra,
  };
}

const poster = {
  artifactRef: "media://derived/key/poster.jpg",
  key: "video-analysis/op/v1/c1/a1/poster.jpg",
  sha256: "a".repeat(64),
  sourceSha256: "b".repeat(64),
  policyRevision: "7",
};

test("the runtime exposes the validated sealed poster reader through composition", async () => {
  const services = await makeTelegramServices(bindings(), runtime, {
    get: async () => ({
      key: poster.key,
      size: 512,
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: {
        sha256: poster.sha256,
        sourceSha256: poster.sourceSha256,
        policyRevision: poster.policyRevision,
      },
      arrayBuffer: async () => new Uint8Array(512).buffer,
    }),
  });
  expect(services).not.toBeNull();
  expect(typeof services?.posterBytes).toBe("function");
  expect((await services?.posterBytes?.(poster))?.byteLength).toBe(512);
});

test("without the sealed bucket binding the runtime stays text-only", async () => {
  const services = await makeTelegramServices(bindings(), runtime);
  expect(services?.posterBytes).toBeUndefined();
});
