import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import {
  requireHnsGatewayRotationFence,
  requireHnsReviewedGatewayRotation,
} from "./hns-gateway-rotation.ts";

const previous = "hns-community-app-handle-gateway-sha256:previous";
const spki = "ab".repeat(32);
const observedAt = "2026-10-21T19:00:00.000Z";

function input(staging: boolean, overrides: Readonly<Record<string, unknown>> = {}) {
  const manifest = {
    schema: staging
      ? "pirate-hns-community-app-handle-gateway-staging-public-v1"
      : "pirate-hns-community-app-handle-gateway-deployment-v1",
    ...(staging ? { mode: "staging-public-tls", public_tls_listener: "94.103.168.209:443" } : {}),
    profile_sha256: "cd".repeat(32),
    handle_profile_sha256: "ef".repeat(32),
    gateway_certificate_spki_sha256: spki,
    ...overrides,
  };
  const manifestJson = JSON.stringify(manifest);
  return {
    rotation: {
      version: "hns-reviewed-gateway-rotation-v1",
      previous_gateway_reference: previous,
      gateway_reference: `hns-community-app-handle-gateway-sha256:${createHash("sha256").update(manifestJson).digest("hex")}`,
      profile_sha256: manifest.profile_sha256,
      handle_profile_sha256: manifest.handle_profile_sha256,
      manifest_json: manifestJson,
      observed_at: observedAt,
      readiness: "operator_attested_shadow_ready",
    },
    previousGatewayReference: previous,
    certificateSpki: spki,
    observedAt,
  };
}

describe("reviewed gateway rotation environment", () => {
  test("retains the production manifest and admits the CI listener only in staging", async () => {
    await expect(requireHnsReviewedGatewayRotation(input(false))).resolves.toMatchObject({
      previous_gateway_reference: previous,
    });
    await expect(
      requireHnsReviewedGatewayRotation({ ...input(true), environment: "staging" }),
    ).resolves.toMatchObject({ previous_gateway_reference: previous });
    await expect(requireHnsReviewedGatewayRotation(input(true))).rejects.toThrow();
    await expect(
      requireHnsReviewedGatewayRotation({ ...input(true), environment: "production" }),
    ).rejects.toThrow();
  });

  test("refuses another listener, another mode, or a changed certificate", async () => {
    for (const changed of [
      { public_tls_listener: "81.15.150.167:443" },
      { mode: "private-tls" },
      { gateway_certificate_spki_sha256: "01".repeat(32) },
    ]) {
      await expect(
        requireHnsReviewedGatewayRotation({ ...input(true, changed), environment: "staging" }),
      ).rejects.toThrow();
    }
  });

  test("uses the predecessor inventory environment at the promotion fence", async () => {
    const staged = input(true);
    const promote = (environment: string) =>
      requireHnsGatewayRotationFence({
        client: {
          query: async () => ({
            rows: [
              {
                current_generation: 1,
                gateway_deployment_reference: previous,
                gateway_certificate_spki_sha256: spki,
                health_generation: 3,
                observed_at: observedAt,
                environment,
              },
            ],
          }),
        } as unknown as Client,
        dnsActivationId: "dns-current",
        successorGeneration: 2,
        successorGatewayReference: staged.rotation.gateway_reference,
        certificateSpki: spki,
        rotation: { reviewed: staged.rotation, previousHealthGeneration: 3 },
      });
    await expect(promote("staging")).resolves.toBeUndefined();
    await expect(promote("production")).rejects.toThrow();
  });
});
