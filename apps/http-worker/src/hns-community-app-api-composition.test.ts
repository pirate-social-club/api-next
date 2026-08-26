import { describe, expect, test } from "bun:test";
import { makeStaticHnsForwarderKeyRegistryV1 } from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import {
  disabledProductionHnsCommunityAppApiComposition,
  makeHnsCommunityAppApiComposition,
} from "./hns-community-app-api-composition.ts";

const dependencies = {
  protected_origin: "https://api-next.internal",
  access_validator: { verify: async () => undefined },
  authority_source: { resolve: () => Effect.succeed(null) },
  key_registry: makeStaticHnsForwarderKeyRegistryV1([
    {
      key_id: "gateway-key-test",
      key_bytes: new Uint8Array(32).fill(7),
      signing_enabled: true,
      verify_not_before: 1,
      verify_not_after: 2,
    },
  ]),
  replay_store: { consume: async () => false },
  clock: { nowUnixSeconds: () => 1 },
  limits: {
    max_body_bytes: 1_048_576,
    freshness_window_seconds: 60,
    future_clock_skew_seconds: 1,
  },
};

describe("HNS community application API composition", () => {
  test("keeps production disabled and unbound", () => {
    expect(disabledProductionHnsCommunityAppApiComposition).toEqual({
      enabled: false,
      access_validator: null,
      forwarder_validator: null,
      authority_source: null,
      protected_origin: null,
    });
    expect(makeHnsCommunityAppApiComposition(false, dependencies)).toEqual(
      disabledProductionHnsCommunityAppApiComposition,
    );
  });

  test("fails closed for every partial enabled authority set", () => {
    expect(() => makeHnsCommunityAppApiComposition(true)).toThrow(
      "HNS community API composition is incomplete or invalid",
    );
    for (const missing of Object.keys(dependencies) as (keyof typeof dependencies)[]) {
      expect(() =>
        makeHnsCommunityAppApiComposition(true, { ...dependencies, [missing]: undefined }),
      ).toThrow("HNS community API composition is incomplete or invalid");
    }
  });

  test("constructs only from one complete source-closed set", () => {
    const composition = makeHnsCommunityAppApiComposition(true, dependencies);
    expect(composition.enabled).toBe(true);
    if (!composition.enabled) throw new Error("expected enabled composition");
    expect(composition.access_validator).toBe(dependencies.access_validator);
    expect(composition.authority_source).toBe(dependencies.authority_source);
    expect(composition.protected_origin).toBe(dependencies.protected_origin);
    expect(composition.forwarder_validator).toBeDefined();
  });
});
