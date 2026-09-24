import { expect, test } from "bun:test";
import { decodeHnsControlObserverConfigurationBytes } from "@pirate/application/namespace-ownership";
import configuration from "./observer-configuration.json";

test("staging verifier pins regtest configuration and distinct private infrastructure", async () => {
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
  expect(configuration.chain.network).toBe("regtest");
  expect(configuration.chain.genesis_block_hash).toBe(
    "ae3895cf597eff05b19e02a70ceeeecb9dc72dbfe6504a50e9343a72f06a87c5",
  );
  expect(configuration.provider_configuration_reference).toBe(
    staging.vars.HNS_PROVIDER_CONFIGURATION_REFERENCE,
  );
  expect(configuration.chain.driver_reference).toBe(staging.vars.HNS_CHAIN_DRIVER_REFERENCE);
  expect(configuration.evidence_lease_seconds).toBe(Number(staging.vars.HNS_EVIDENCE_TTL_SECONDS));
  expect(staging.hyperdrive[0].id).toBe("8cb7658a0f7143359c1becfec6a15c23");
  expect(staging.vpc_services[0].service_id).toBe("01a0ca40-3b7b-7ac1-ac71-1b2567fd4c14");
  expect(staging.hyperdrive[0].id).not.toBe(production.hyperdrive[0].id);
  expect(staging.vpc_services[0].service_id).not.toBe(production.vpc_services[0].service_id);
  expect(staging.workers_dev).toBe(false);
  expect(staging.preview_urls).toBe(false);
  expect(staging.routes).toBeUndefined();
});
