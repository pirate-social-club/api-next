import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseJsonc } from "../../../scripts/secret-drift-audit.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeHnsActiveLeaseRenewalJob } = await import("./hns-active-lease-renewal.ts");
const { makeHnsRouteRevalidationComposition } = await import("./hns-route-revalidation.ts");

type Environment = Readonly<{
  vars: Readonly<Record<string, string>>;
  services?: readonly Readonly<{ binding: string; service: string }>[];
}>;
const read = (path: string) =>
  parseJsonc<{ env: Readonly<Record<string, Environment>> }>(
    readFileSync(new URL(path, import.meta.url), "utf8"),
  );
const jobs = read("../wrangler.jsonc");
const verifier = read("../../hns-owner-verifier/wrangler.jsonc");

test("the shipped staging bindings compose one challenge-free renewal writer with the declared verifier pin", () => {
  const staging = jobs.env.staging;
  const provider = verifier.env.staging;
  if (staging === undefined || provider === undefined)
    throw new Error("staging configuration missing");
  expect(staging.services?.filter((binding) => binding.binding === "HNS_OWNER_VERIFIER")).toEqual([
    { binding: "HNS_OWNER_VERIFIER", service: "pirate-hns-owner-verifier-staging" },
  ]);
  expect(staging.vars.HNS_OWNERSHIP_CONFIGURATION_REFERENCE).toBe(
    provider.vars.HNS_PROVIDER_CONFIGURATION_REFERENCE,
  );
  expect(staging.vars.HNS_OWNERSHIP_CONFIGURATION_VERSION).toBe(
    provider.vars.HNS_PROVIDER_CONFIGURATION_VERSION,
  );
  const bindings = {
    ...staging.vars,
    HNS_OWNER_VERIFIER: {
      fetch: async () => {
        throw new Error("composition must not call the provider");
      },
    },
  };
  const renewal = makeHnsActiveLeaseRenewalJob(bindings, "staging", {});
  expect(renewal).not.toBeNull();
  expect(renewal?.schedule).toBe("*/5 * * * *");
  // Up to twelve scheduled polls across eligible roots fit this lead; the
  // existing three-attempt-per-binding-generation bound remains in force.
  expect(Number(staging.vars.HNS_ROUTE_RENEWAL_LEAD_SECONDS)).toBe(3600);
  expect(Number(staging.vars.HNS_ROUTE_RENEWAL_LEAD_SECONDS)).toBeLessThan(
    Number(provider.vars.HNS_EVIDENCE_TTL_SECONDS),
  );
  expect(makeHnsRouteRevalidationComposition(bindings).enabled).toBe(false);
});

test("the source correction leaves production ownership renewal disabled", () => {
  const production = jobs.env.production;
  if (production === undefined) throw new Error("production configuration missing");
  expect(makeHnsActiveLeaseRenewalJob(production.vars, "production", {})).toBeNull();
  expect(
    production.services?.some((binding) => binding.binding === "HNS_OWNER_VERIFIER") ?? false,
  ).toBe(false);
});
