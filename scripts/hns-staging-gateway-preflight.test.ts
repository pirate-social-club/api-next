import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verifyHnsStagingGatewayManifest } from "./hns-staging-gateway-preflight.ts";

const fingerprint = `solid-hns-ingress-sha256:${"a".repeat(64)}`;
const manifest = JSON.stringify({
  schema: "pirate-hns-community-app-handle-gateway-staging-public-v1",
  mode: "staging-public-tls",
  solid_origin: "https://hns-community-ingress-staging.pirate.sc",
  solid_ingress_composition_reference: fingerprint,
});
const gatewayReference = `hns-community-app-handle-gateway-sha256:${createHash("sha256").update(manifest).digest("hex")}`;
const pin = {
  schema: "pirate-hns-staging-gateway-deploy-pin-v1",
  gateway_reference: gatewayReference,
  solid_ingress_composition_reference: fingerprint,
};

describe("staging HNS gateway deploy pin", () => {
  test("accepts an exact active manifest", () => {
    expect(verifyHnsStagingGatewayManifest(manifest, pin)).toEqual({
      gatewayReference,
      fingerprint,
    });
  });

  test("refuses a gateway or fingerprint rotation before the HTTP deploy", () => {
    expect(() =>
      verifyHnsStagingGatewayManifest(manifest, { ...pin, gateway_reference: "old" }),
    ).toThrow("differs from the reviewed deploy pin");
    expect(() =>
      verifyHnsStagingGatewayManifest(manifest, {
        ...pin,
        solid_ingress_composition_reference: "old",
      }),
    ).toThrow("differs from the reviewed deploy pin");
  });
});
