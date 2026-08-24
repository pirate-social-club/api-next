import { describe, expect, test } from "bun:test";
import { makeStaticHnsForwarderKeyRegistryV1 } from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import {
  disabledProductionHnsHostServingComposition,
  makeHnsHostServingComposition,
} from "./hns-host-serving-composition.ts";

const keyRegistry = makeStaticHnsForwarderKeyRegistryV1([
  {
    key_id: "gateway-key-test",
    key_bytes: new Uint8Array(32).fill(7),
    signing_enabled: true,
    verify_not_before: 1,
    verify_not_after: 2,
  },
]);
const dependencies = {
  authority_source: { resolve: () => Effect.succeed(null) },
  key_registry: keyRegistry,
  replay_store: { consume: async () => false },
  clock: { nowUnixSeconds: () => 1 },
  limits: {
    max_body_bytes: 1_024,
    freshness_window_seconds: 60,
    future_clock_skew_seconds: 1,
  },
};

describe("HNS first-party host-serving composition", () => {
  test("keeps production composition disabled even when test authorities are injected", () => {
    expect(makeHnsHostServingComposition(false, dependencies)).toEqual({
      enabled: false,
      validator: null,
    });
    expect(disabledProductionHnsHostServingComposition).toEqual({
      enabled: false,
      validator: null,
    });
  });

  test("fails closed when any enabled authority is absent", () => {
    expect(() => makeHnsHostServingComposition(true)).toThrow(
      "HNS host-serving composition is incomplete or invalid",
    );
    for (const missing of Object.keys(dependencies) as (keyof typeof dependencies)[]) {
      expect(() =>
        makeHnsHostServingComposition(true, { ...dependencies, [missing]: undefined }),
      ).toThrow("HNS host-serving composition is incomplete or invalid");
    }
  });

  test("constructs only from a complete source-closed authority set", () => {
    const composition = makeHnsHostServingComposition(true, dependencies);
    expect(composition.enabled).toBe(true);
    expect(composition.validator).not.toBeNull();
  });
});
