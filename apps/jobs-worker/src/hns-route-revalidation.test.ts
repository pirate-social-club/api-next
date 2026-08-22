import { describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

const {
  HNS_ROUTE_REVALIDATION_BATCH_LIMIT,
  HNS_ROUTE_REVALIDATION_PENDING_SESSIONS_SQL,
  HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL,
  makeHnsRouteRevalidationComposition,
  runBoundedHnsRouteRevalidationBatch,
} = await import("./hns-route-revalidation");
const { HnsRouteRevalidationProviderFailed, HnsRouteRevalidationStartStorageFailed } = await import(
  "@pirate/application"
);
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
  test("bounds a tick and continues after expected item failures", async () => {
    const invoked: string[] = [];
    const summary = await Effect.runPromise(
      runBoundedHnsRouteRevalidationBatch(
        ["first", "second", "third"],
        HNS_ROUTE_REVALIDATION_BATCH_LIMIT,
        (item) => {
          invoked.push(item);
          return item === "first"
            ? Effect.fail(new HnsRouteRevalidationProviderFailed({ reason: "unavailable" }))
            : Effect.void;
        },
      ),
    );

    expect(invoked).toEqual(["first", "second"]);
    expect(summary).toEqual({
      processed: 2,
      expected_failures: 1,
      high_severity_failures: 0,
    });
  });

  test("propagates an unexpected failure instead of hiding a scheduler defect", async () => {
    const invoked: string[] = [];
    await expect(
      Effect.runPromise(
        runBoundedHnsRouteRevalidationBatch(["first", "second"], 2, (item) => {
          invoked.push(item);
          return Effect.fail(new Error("unexpected scheduler defect"));
        }),
      ),
    ).rejects.toThrow("unexpected scheduler defect");
    expect(invoked).toEqual(["first"]);
  });

  test("classifies storage failures as high severity while continuing the bounded batch", async () => {
    const summary = await Effect.runPromise(
      runBoundedHnsRouteRevalidationBatch(["first", "second"], 2, (item) =>
        item === "first" ? Effect.fail(new HnsRouteRevalidationStartStorageFailed()) : Effect.void,
      ),
    );
    expect(summary).toEqual({
      processed: 2,
      expected_failures: 1,
      high_severity_failures: 1,
    });
  });

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

  test("limits challenge-shaped starts to suspended same-root recovery", () => {
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
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).not.toContain(
      "b.route_lifecycle_status = 'active'",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "prior_session.status = 'failed'",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "prior_session.terminal_at AS prior_terminal_at",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "prior.prior_terminal_at <= clock_timestamp() - ($1 * INTERVAL '1 second')",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "b.route_binding_id = $4 AND b.binding_generation = $5",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "$4::text IS NOT NULL\n        OR NOT EXISTS (",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "open_session.expected_binding_generation = b.binding_generation",
    );
    expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL).toContain(
      "open_session.status = 'pending'",
    );
    for (const predicate of [
      "provider_configuration_reference = $7",
      "provider_configuration_version = $8",
      "environment = $6",
    ]) {
      expect(HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL.indexOf(predicate)).toBeLessThan(
        HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL.indexOf("LIMIT $2"),
      );
    }
  });

  test("filters exhausted pending sessions before consuming the SQL poll limit", () => {
    expect(HNS_ROUTE_REVALIDATION_PENDING_SESSIONS_SQL).toContain(
      "HAVING COUNT(a.route_revalidation_attempt_id) FILTER (WHERE a.state = 'consumed') < 3",
    );
    expect(HNS_ROUTE_REVALIDATION_PENDING_SESSIONS_SQL.indexOf("HAVING COUNT")).toBeLessThan(
      HNS_ROUTE_REVALIDATION_PENDING_SESSIONS_SQL.indexOf("LIMIT $5"),
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
