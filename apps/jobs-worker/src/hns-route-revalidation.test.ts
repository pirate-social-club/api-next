import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

const { HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL, makeHnsRouteRevalidationComposition } =
  await import("./hns-route-revalidation");
type HnsRouteRevalidationBindings = import("./hns-route-revalidation").HnsRouteRevalidationBindings;

const serviceBinding = {
  fetch: async (_input: string | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
};

const enabledBindings = (): HnsRouteRevalidationBindings => ({
  HNS_OWNER_VERIFIER: serviceBinding,
  HNS_OWNERSHIP_ENABLED: "true",
  HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "hns-owner-staging",
  HNS_OWNERSHIP_CONFIGURATION_VERSION: "hns-owner-config-v1",
});

describe("jobs-worker HNS route-revalidation composition", () => {
  test("is disabled by absence and by an explicit false flag", () => {
    expect(makeHnsRouteRevalidationComposition({})).toEqual({ enabled: false });
    expect(
      makeHnsRouteRevalidationComposition({
        HNS_OWNERSHIP_ENABLED: "false",
      }),
    ).toEqual({ enabled: false });
  });

  test("fails closed for an invalid enablement or incomplete provider authority", () => {
    const withoutVerifier: HnsRouteRevalidationBindings = {
      HNS_OWNERSHIP_ENABLED: "true",
      HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "hns-owner-staging",
      HNS_OWNERSHIP_CONFIGURATION_VERSION: "hns-owner-config-v1",
    };
    for (const bindings of [
      { HNS_OWNERSHIP_ENABLED: "yes" },
      { HNS_OWNERSHIP_ENABLED: "true" },
      withoutVerifier,
      { ...enabledBindings(), HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "" },
      { ...enabledBindings(), HNS_OWNERSHIP_CONFIGURATION_VERSION: " " },
    ]) {
      expect(() => makeHnsRouteRevalidationComposition(bindings)).toThrow(
        "Jobs worker HNS route-revalidation configuration is incomplete or invalid",
      );
    }
  });

  test("accepts only a complete, bounded one-shot force selector", () => {
    const normal = makeHnsRouteRevalidationComposition(enabledBindings());
    expect(normal.enabled).toBe(true);
    if (!normal.enabled) return;
    expect(normal.force).toBeNull();

    const forced = makeHnsRouteRevalidationComposition({
      ...enabledBindings(),
      HNS_REVALIDATION_FORCE_ROUTE_BINDING_ID: "binding-123",
      HNS_REVALIDATION_FORCE_EXPECTED_GENERATION: "7",
    });
    expect(forced.enabled && forced.force).toEqual({
      route_binding_id: "binding-123",
      expected_generation: 7,
    });

    for (const bindings of [
      { ...enabledBindings(), HNS_REVALIDATION_FORCE_ROUTE_BINDING_ID: "binding-123" },
      { ...enabledBindings(), HNS_REVALIDATION_FORCE_EXPECTED_GENERATION: "7" },
      {
        ...enabledBindings(),
        HNS_REVALIDATION_FORCE_ROUTE_BINDING_ID: " binding-123",
        HNS_REVALIDATION_FORCE_EXPECTED_GENERATION: "7",
      },
      {
        ...enabledBindings(),
        HNS_REVALIDATION_FORCE_ROUTE_BINDING_ID: "binding-123",
        HNS_REVALIDATION_FORCE_EXPECTED_GENERATION: "0",
      },
      {
        ...enabledBindings(),
        HNS_REVALIDATION_FORCE_ROUTE_BINDING_ID: "binding-123",
        HNS_REVALIDATION_FORCE_EXPECTED_GENERATION: "7.0",
      },
    ]) {
      expect(() => makeHnsRouteRevalidationComposition(bindings)).toThrow(
        "Jobs worker HNS route-revalidation configuration is incomplete or invalid",
      );
    }
  });

  test("keeps active expiry and suspended same-root recovery in the scheduler query", () => {
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "requirement.provider_configuration_ref AS provider_configuration_reference",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "requirement.provider_configuration_kind = 'managed'",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain("WITH prior_recovery AS");
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "attempt.expected_binding_generation + 1 AS binding_generation",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "prior_session.requirement_hash AS authority_requirement_hash",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "b.route_lifecycle_status = 'suspended'",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "b.verified_evidence_ref IS NULL",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "prior_session.terminal_at AS prior_terminal_at",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "prior.prior_terminal_at <= clock_timestamp() - ($1 * INTERVAL '1 second')",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "evidence.expires_at <= clock_timestamp() + ($1 * INTERVAL '1 second')",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "b.route_binding_id = $4 AND b.binding_generation = $5",
    );
  });

  test("keeps HNS enablement and verifier binding staging-only", async () => {
    const wrangler = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text();
    const stagingStart = wrangler.indexOf('"staging"');
    const productionStart = wrangler.indexOf('"production"');
    expect(stagingStart).toBeGreaterThanOrEqual(0);
    expect(productionStart).toBeGreaterThan(stagingStart);
    expect(wrangler.slice(stagingStart, productionStart)).toContain('"HNS_OWNER_VERIFIER"');
    expect(wrangler.slice(stagingStart, productionStart)).toContain(
      '"HNS_OWNERSHIP_ENABLED": "true"',
    );
    expect(wrangler.slice(0, stagingStart)).not.toContain("HNS_OWNER_VERIFIER");
    expect(wrangler.slice(productionStart)).not.toContain("HNS_OWNER_VERIFIER");
    expect(wrangler.slice(0, stagingStart)).not.toContain("HNS_OWNERSHIP_ENABLED");
    expect(wrangler.slice(productionStart)).not.toContain("HNS_OWNERSHIP_ENABLED");
  });
});
