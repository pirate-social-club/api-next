/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, test } from "vitest";

/**
 * This is intentionally a construction test. An official, redistributable
 * valid proof fixture was not found in Self's public documentation/examples;
 * no user proof is fabricated or checked into the repository. The coordinator
 * must supply a provenance-reviewed fixture before adding a positive verify()
 * assertion.
 */
describe("Self Pass SDK in the api-next Worker runtime", () => {
  test("constructs the pinned verifier under 2026-08-01 + nodejs_compat", async () => {
    const { AllIds, DefaultConfigStore, SelfBackendVerifier } = await import("@selfxyz/core");
    const verifier = new SelfBackendVerifier(
      "pirate-social",
      "https://api.example/verification/callbacks/self.pass",
      true,
      AllIds,
      new DefaultConfigStore({ minimumAge: 18 }),
      "uuid",
    );
    expect(verifier).toBeDefined();
  });
});
