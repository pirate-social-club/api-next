import { describe, expect, test } from "bun:test";
import { makeSpacesRegistryService } from "@pirate/application/use-cases/handles/spaces-registry";
import { makeDirectPostgresControlPlaneLayer } from "@pirate/platform-cf/postgres";
import {
  makeSpacesProductionComposition,
  spacesTaprootRecipientEnabled,
} from "./spaces-production-composition.ts";

const layer = makeDirectPostgresControlPlaneLayer("postgres://unused:unused@127.0.0.1/unused");
const credentials = {
  SPACES_VERIFIER_ACCESS_CLIENT_ID: "test-access-id",
  SPACES_VERIFIER_ACCESS_CLIENT_SECRET: "test-access-secret",
  SPACES_VERIFIER_BEARER_TOKEN: "test-verifier-token",
};

describe("Spaces production composition", () => {
  test("keeps recipient setup disabled unless the full staging pilot is explicitly enabled", () => {
    expect(spacesTaprootRecipientEnabled({}, "staging")).toBe(false);
    expect(
      spacesTaprootRecipientEnabled({ SPACES_TAPROOT_RECIPIENT_ENABLED: "false" }, "staging"),
    ).toBe(false);
    expect(() =>
      spacesTaprootRecipientEnabled({ SPACES_TAPROOT_RECIPIENT_ENABLED: "true" }, "staging"),
    ).toThrow("Spaces Taproot recipient configuration is invalid");
    expect(() =>
      spacesTaprootRecipientEnabled(
        { SPACES_RUNTIME_ENABLED: "true", SPACES_TAPROOT_RECIPIENT_ENABLED: "true" },
        "production",
      ),
    ).toThrow("Spaces Taproot recipient configuration is invalid");
    expect(() =>
      spacesTaprootRecipientEnabled(
        { SPACES_RUNTIME_ENABLED: "true", SPACES_TAPROOT_RECIPIENT_ENABLED: "TRUE" },
        "staging",
      ),
    ).toThrow("Spaces Taproot recipient configuration is invalid");
    expect(
      spacesTaprootRecipientEnabled(
        { SPACES_RUNTIME_ENABLED: "true", SPACES_TAPROOT_RECIPIENT_ENABLED: "true" },
        "staging",
      ),
    ).toBe(true);
  });

  test("keeps every ceremony and registry route absent by default", () => {
    expect(makeSpacesProductionComposition({}, layer, "staging")).toEqual({});
    expect(
      makeSpacesProductionComposition({ SPACES_RUNTIME_ENABLED: "false" }, layer, "staging"),
    ).toEqual({});
  });

  test("refuses partial credentials, non-staging, and ambiguous flags", () => {
    expect(() =>
      makeSpacesProductionComposition({ SPACES_RUNTIME_ENABLED: "true" }, layer, "staging"),
    ).toThrow("Spaces root verifier credentials are incomplete");
    expect(() =>
      makeSpacesProductionComposition(
        { ...credentials, SPACES_RUNTIME_ENABLED: "true" },
        layer,
        "production",
      ),
    ).toThrow("Spaces runtime configuration is invalid");
    expect(() =>
      makeSpacesProductionComposition(
        { ...credentials, SPACES_RUNTIME_ENABLED: "TRUE" },
        layer,
        "staging",
      ),
    ).toThrow("Spaces runtime configuration is invalid");
  });

  test("composes only the scoped staging services after all credentials exist", () => {
    const result = makeSpacesProductionComposition(
      { ...credentials, SPACES_RUNTIME_ENABLED: "true" },
      layer,
      "staging",
    );
    expect(result.spacesRegistry).toMatchObject({
      basePath: "/internal/spaces/registry/v1",
      environment: "staging",
      pageCapacity: 500,
    });
    const registry = result.spacesRegistry;
    if (registry === undefined) throw new Error("Spaces registry was not composed");
    expect(() => makeSpacesRegistryService(registry)).not.toThrow();
    expect(typeof result.spacesOwnerProof?.start).toBe("function");
    expect(typeof result.spacesOperatorAssignments?.reportFunding).toBe("function");
  });
});
