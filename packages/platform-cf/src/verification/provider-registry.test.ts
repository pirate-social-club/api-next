import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makePlatformVerificationProviderRegistry } from "./provider-registry.ts";

describe("platform verification provider registry", () => {
  test("registers Self Pass only when explicitly configured", async () => {
    const disabled = await Effect.runPromise(makePlatformVerificationProviderRegistry());
    expect(disabled.list()).toEqual([]);

    const enabled = await Effect.runPromise(
      makePlatformVerificationProviderRegistry({
        self_pass: {
          callback_origin: "https://api.example",
          app_name: "Pirate",
          mock_passport: false,
        },
      }),
    );
    expect(enabled.list()).toEqual([
      expect.objectContaining({
        provider_id: "self.pass",
        callback_mode: "session_bound_proof",
        callback_header_allowlist: [],
      }),
    ]);
    await expect(Effect.runPromise(enabled.resolve("self.pass"))).resolves.toBeDefined();
  });
});
