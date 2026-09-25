import { describe, expect, test } from "bun:test";
import { makeDirectPostgresControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { makeSpacesProductionComposition } from "./spaces-production-composition.ts";

const layer = makeDirectPostgresControlPlaneLayer("postgres://unused:unused@127.0.0.1/unused");
const credentials = {
  SPACES_VERIFIER_ACCESS_CLIENT_ID: "test-access-id",
  SPACES_VERIFIER_ACCESS_CLIENT_SECRET: "test-access-secret",
  SPACES_VERIFIER_BEARER_TOKEN: "test-verifier-token",
};

describe("Spaces production composition", () => {
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
      pageCapacity: 1_000,
    });
    expect(typeof result.spacesOwnerProof?.start).toBe("function");
    expect(typeof result.spacesOperatorAssignments?.reportFunding).toBe("function");
  });
});
