import { describe, expect, test } from "bun:test";
import {
  type HnsOwnerTransport,
  makePlatformNamespaceOwnershipProviderRegistry,
} from "@pirate/platform-cf/namespace-ownership-provider-registry";
import { Effect } from "effect";
import { makeHnsOwnershipComposition } from "./hns-ownership-composition.ts";

const transport: HnsOwnerTransport = {
  start: () => Effect.die("transport must not run during composition"),
  poll: () => Effect.die("transport must not run during composition"),
};

const configured = {
  enabled: true,
  environment: "staging" as const,
  configuration_reference: "hns-owner-staging",
  configuration_version: "hns-owner-config-v1",
};

describe("HNS ownership Worker composition", () => {
  test("keeps both creation and ceremony authority absent while disabled", () => {
    const composition = makeHnsOwnershipComposition(
      { ...configured, enabled: false },
      { transport },
    );

    expect(composition.namespace_provider_bindings).toEqual([]);
    expect(composition.provider_registry_options).toEqual({});
  });

  test("fails closed when enabled without a complete managed configuration and transport", () => {
    expect(() => makeHnsOwnershipComposition(configured)).toThrow(
      "HNS ownership composition is incomplete or invalid",
    );
    expect(() =>
      makeHnsOwnershipComposition({ ...configured, configuration_reference: "" }, { transport }),
    ).toThrow("HNS ownership composition is incomplete or invalid");
    expect(() =>
      makeHnsOwnershipComposition(
        { ...configured, configuration_version: " version-1" },
        { transport },
      ),
    ).toThrow("HNS ownership composition is incomplete or invalid");
    expect(() =>
      makeHnsOwnershipComposition(
        { ...configured, configuration_reference: `hns-${"x".repeat(253)}` },
        { transport },
      ),
    ).toThrow("HNS ownership composition is incomplete or invalid");
    expect(() =>
      makeHnsOwnershipComposition(
        { ...configured, configuration_version: "v1\u0000changed" },
        { transport },
      ),
    ).toThrow("HNS ownership composition is incomplete or invalid");
  });

  test("derives the store binding and runtime adapter from one authority object", async () => {
    const composition = makeHnsOwnershipComposition(configured, { transport });
    const binding = composition.namespace_provider_bindings[0];
    const registry = await Effect.runPromise(
      makePlatformNamespaceOwnershipProviderRegistry(composition.provider_registry_options),
    );

    expect(binding).toEqual({
      requirement: "namespace_ownership",
      family: "hns",
      provider_id: "hns.owner.v1",
      provider_configuration: {
        kind: "managed",
        reference: "hns-owner-staging",
        version: "hns-owner-config-v1",
      },
      protocol_version: "hns-txt-v1",
    });
    expect(composition.provider_registry_options.hns?.provider_configuration).toBe(
      binding?.provider_configuration,
    );
    expect(composition.provider_registry_options.hns?.environments).toEqual(["staging"]);
    expect(registry.list()).toEqual([
      expect.objectContaining({
        provider_id: binding?.provider_id,
        protocol_versions: [binding?.protocol_version],
        environments: ["staging"],
      }),
    ]);
  });
});
