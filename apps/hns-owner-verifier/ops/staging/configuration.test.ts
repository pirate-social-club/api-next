import { expect, test } from "bun:test";
import { decodeHnsControlObserverConfigurationBytes } from "@pirate/application/namespace-ownership";
import configuration from "./observer-configuration.json";

test("staging verifier pins mainnet configuration with isolated staging state", async () => {
  const wrangler = JSON.parse(
    await Bun.file(new URL("../../wrangler.jsonc", import.meta.url)).text(),
  );
  const staging = wrangler.env.staging;
  const production = wrangler.env.production;
  const decoded = await decodeHnsControlObserverConfigurationBytes(
    new TextEncoder().encode(JSON.stringify(configuration)),
  );
  expect(decoded.configuration_digest).toBe(staging.vars.HNS_PROVIDER_CONFIGURATION_DIGEST);
  expect(configuration.environment).toBe("staging");
  expect(configuration.chain.network).toBe("main");
  expect(configuration.chain.genesis_block_hash).toBe(
    "5b6ef2d3c1f3cdcadfd9a030ba1811efdd17740f14e166489760741d075992e0",
  );
  expect(configuration.provider_configuration_reference).toBe(
    staging.vars.HNS_PROVIDER_CONFIGURATION_REFERENCE,
  );
  expect(configuration.chain.driver_reference).toBe(staging.vars.HNS_CHAIN_DRIVER_REFERENCE);
  expect(configuration.evidence_lease_seconds).toBe(Number(staging.vars.HNS_EVIDENCE_TTL_SECONDS));
  expect(staging.hyperdrive[0].id).toBe("8cb7658a0f7143359c1becfec6a15c23");
  expect(staging.vpc_services[0].service_id).toBe("01a05d1e-d199-7ee0-bb0b-a327b990ca9f");
  expect(staging.hyperdrive[0].id).not.toBe(production.hyperdrive[0].id);
  expect(staging.vpc_services[0].service_id).toBe(production.vpc_services[0].service_id);
  expect(staging.vars.HNS_PROVIDER_CONFIGURATION_REFERENCE).not.toBe(
    production.vars.HNS_PROVIDER_CONFIGURATION_REFERENCE,
  );
  expect(staging.workers_dev).toBe(false);
  expect(staging.preview_urls).toBe(false);
  expect(staging.routes).toBeUndefined();
});
