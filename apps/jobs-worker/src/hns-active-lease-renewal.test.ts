import { describe, expect, mock, test } from "bun:test";
import { AlertCollector, ControlPlaneDb } from "@pirate/application";
import { encodeHnsControlObserverConfiguration } from "@pirate/application/namespace-ownership";
import { Effect } from "effect";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeHnsActiveLeaseRenewalJob } = await import("./hns-active-lease-renewal");
const { buildJobRegistry, isScheduleDue, JobContext } = await import("./registry");
const { makeHnsRouteRevalidationJob, makeHnsRouteRevalidationComposition } = await import(
  "./hns-route-revalidation"
);

const bindings = () => ({
  HNS_ACTIVE_LEASE_RENEWAL_ENABLED: "true",
  HNS_OWNERSHIP_ENABLED: "false",
  HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "hns-observer-regtest",
  HNS_OWNERSHIP_CONFIGURATION_VERSION: "hns-observer-config-v1",
  HNS_ROUTE_RENEWAL_LEAD_SECONDS: "900",
  HNS_OWNER_VERIFIER: {
    fetch: async () => {
      throw new Error("No provider call during composition");
    },
  },
});

const observerConfiguration = JSON.parse(
  await Bun.file(
    new URL(
      "../../hns-owner-verifier/ops/staging/observer-configuration-regtest.json",
      import.meta.url,
    ),
  ).text(),
);
const configurationBytes = await encodeHnsControlObserverConfiguration(observerConfiguration);

async function runTick(options: { environment?: string; lead?: string; missing?: boolean } = {}) {
  const statements: Array<{ label: string; values: readonly unknown[] }> = [];
  const job = makeHnsActiveLeaseRenewalJob(
    {
      ...bindings(),
      HNS_OWNERSHIP_CONFIGURATION_REFERENCE: observerConfiguration.provider_configuration_reference,
      HNS_OWNERSHIP_CONFIGURATION_VERSION: observerConfiguration.provider_configuration_version,
      HNS_ROUTE_RENEWAL_LEAD_SECONDS: options.lead ?? "900",
    },
    options.environment ?? "staging",
    {},
  );
  if (!job) throw new Error("Missing configured renewal job");
  const db = {
    execute: <Row>(statement: { label: string; values: readonly unknown[] }) =>
      Effect.sync(() => {
        statements.push(statement);
        if (statement.label === "hns-control-observer.configuration.resolve") {
          const rows = options.missing ? [] : [{ configuration_bytes: configurationBytes }];
          return { rows: rows as Row[], rowCount: rows.length };
        }
        if (
          statement.label !== "community-route.expiry.candidates" &&
          statement.label !== "hns-active-renewal.candidates"
        )
          throw new Error(`Unexpected query: ${statement.label}`);
        return { rows: [] as Row[], rowCount: 0 };
      }),
    withTransaction: () => Effect.die("An empty tick must not open a transaction"),
  } as unknown as ControlPlaneDb["Service"];
  const result = Effect.runPromise(
    job.run.pipe(
      Effect.provideService(ControlPlaneDb, db),
      Effect.provideService(AlertCollector, { emit: () => Effect.void }),
      Effect.provideService(JobContext, {
        adapterSafety: { isProven: () => false, markAbortedOrFenced: () => undefined },
        attemptId: "renewal-runtime-test",
        lease: () => ({ expiresAt: Date.now() + 60_000, generation: 1, owner: "test-owner" }),
        owner: "test-owner",
      }),
    ),
  );
  return { statements, result };
}

describe("active ownership renewal runtime admission", () => {
  test("keeps missing and disabled configuration inert", () => {
    expect(makeHnsActiveLeaseRenewalJob({}, "staging", {})).toBeNull();
    expect(
      makeHnsActiveLeaseRenewalJob({ HNS_ACTIVE_LEASE_RENEWAL_ENABLED: "false" }, "production", {}),
    ).toBeNull();
  });
  test("rejects incomplete settings and simultaneous legacy ownership writes", () => {
    for (const change of [
      { HNS_ACTIVE_LEASE_RENEWAL_ENABLED: "yes" },
      { HNS_OWNERSHIP_ENABLED: "true" },
      { HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "" },
      { HNS_OWNERSHIP_CONFIGURATION_VERSION: " " },
      { HNS_ROUTE_RENEWAL_LEAD_SECONDS: "0" },
      { HNS_ROUTE_RENEWAL_LEAD_SECONDS: "Infinity" },
      { HNS_ROUTE_RENEWAL_LEAD_SECONDS: "604801" },
    ])
      expect(() =>
        makeHnsActiveLeaseRenewalJob({ ...bindings(), ...change }, "staging", {}),
      ).toThrow();
    const { HNS_OWNER_VERIFIER: _provider, ...missingProvider } = bindings();
    expect(() => makeHnsActiveLeaseRenewalJob(missingProvider, "staging", {})).toThrow();
  });
  test("uses the existing registry, lease lane and five-minute schedule", async () => {
    const job = makeHnsActiveLeaseRenewalJob(bindings(), "staging", {});
    expect(job).not.toBeNull();
    if (!job) throw new Error("Missing renewal job");
    const registry = await Effect.runPromise(buildJobRegistry([job]));
    expect(registry.byName.get("hns-active-lease-renewal.poll")).toBe(job);
    expect(job.lane).toBe("hns-route-revalidation");
    expect(isScheduleDue(job.schedule, Date.UTC(2026, 9, 2, 17, 30))).toBe(true);
    expect(isScheduleDue(job.schedule, Date.UTC(2026, 9, 2, 17, 31))).toBe(false);
    expect(job.requiresAdapterSafety).toBe(true);
  });
  test("the registry independently refuses two ownership writers", async () => {
    const renewal = makeHnsActiveLeaseRenewalJob(bindings(), "staging", {});
    const legacy = makeHnsRouteRevalidationComposition({
      ...bindings(),
      HNS_OWNERSHIP_ENABLED: "true",
    });
    if (!renewal || !legacy.enabled) throw new Error("Missing test declarations");
    const duplicate = makeHnsRouteRevalidationJob({ ...legacy, sink: {}, environment: "staging" });
    await expect(Effect.runPromise(buildJobRegistry([renewal, duplicate]))).rejects.toMatchObject({
      reason: "duplicate-table-writer",
    });
  });
  test("executes database-time expiry before selecting renewal with the pinned observer", async () => {
    const tick = await runTick();
    await tick.result;
    expect(tick.statements.map((statement) => statement.label)).toEqual([
      "community-route.expiry.candidates",
      "hns-control-observer.configuration.resolve",
      "hns-active-renewal.candidates",
    ]);
    expect(tick.statements[0]?.values).toEqual(["hns", 1]);
    expect(tick.statements[2]?.values).toEqual([
      observerConfiguration.provider_configuration_reference,
      observerConfiguration.provider_configuration_version,
      "staging",
      900,
      1,
    ]);
  });
  test("refuses missing, cross-environment and too-late renewal configuration before selection", async () => {
    for (const options of [{ missing: true }, { environment: "production" }, { lead: "3600" }]) {
      const tick = await runTick(options);
      await expect(tick.result).rejects.toMatchObject({ reason: "misconfigured" });
      expect(tick.statements.map((statement) => statement.label)).toEqual([
        "community-route.expiry.candidates",
        "hns-control-observer.configuration.resolve",
      ]);
    }
  });
});
