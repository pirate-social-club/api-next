import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NEXT_GATEWAY, PREVIOUS_GATEWAY } from "./hns-staging-gateway/cookie-plan.ts";
import {
  HNS_STAGING_DIRECT_CHECK_COMMAND,
  readHnsStagingGatewayPin,
  verifyHnsStagingGatewayManifest,
} from "./hns-staging-gateway-preflight.ts";

const fingerprint = `solid-hns-ingress-sha256:${"a".repeat(64)}`;
const manifest = JSON.stringify({
  schema: "pirate-hns-community-app-handle-gateway-staging-public-v1",
  mode: "staging-public-tls",
  public_tls_listener: "94.103.168.209:443",
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
      pendingCutoverTo: null,
    });
  });

  test("refuses the retired wallet-host listener even with its exact pin", () => {
    const oldHostManifest = JSON.stringify({
      ...JSON.parse(manifest),
      public_tls_listener: "81.15.150.167:443",
    });
    const oldHostPin = {
      ...pin,
      gateway_reference: `hns-community-app-handle-gateway-sha256:${createHash("sha256").update(oldHostManifest).digest("hex")}`,
    };
    expect(() => verifyHnsStagingGatewayManifest(oldHostManifest, oldHostPin)).toThrow(
      "differs from the reviewed deploy pin",
    );
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

  describe("pending cutover", () => {
    const target = `solid-hns-ingress-sha256:${"b".repeat(64)}`;
    const pendingPin = {
      schema: pin.schema,
      gateway_reference: `hns-community-app-handle-gateway-sha256:${"c".repeat(64)}`,
      solid_ingress_composition_reference: target,
      pending_cutover_from: {
        gateway_reference: gatewayReference,
        solid_ingress_composition_reference: fingerprint,
      },
    };

    test("admits the exact stand-in and names the Solid identity it requires", () => {
      expect(verifyHnsStagingGatewayManifest(manifest, pendingPin)).toEqual({
        gatewayReference,
        fingerprint,
        pendingCutoverTo: target,
      });
    });

    test("uses the ordinary path once the live gateway has rotated", () => {
      const rotated = JSON.stringify({
        ...JSON.parse(manifest),
        solid_ingress_composition_reference: target,
      });
      const reference = `hns-community-app-handle-gateway-sha256:${createHash("sha256").update(rotated).digest("hex")}`;
      expect(
        verifyHnsStagingGatewayManifest(rotated, { ...pendingPin, gateway_reference: reference }),
      ).toEqual({ gatewayReference: reference, fingerprint: target, pendingCutoverTo: null });
    });

    test("treats a stand-in equal to the pin as already rotated", () => {
      expect(
        verifyHnsStagingGatewayManifest(manifest, {
          ...pin,
          pending_cutover_from: pendingPin.pending_cutover_from,
        }).pendingCutoverTo,
      ).toBeNull();
    });

    test("refuses a stand-in without a target identity", () => {
      const { solid_ingress_composition_reference: _, ...noTarget } = pendingPin;
      expect(() => verifyHnsStagingGatewayManifest(manifest, noTarget)).toThrow(
        "differs from the reviewed deploy pin",
      );
    });

    test("refuses a stand-in that differs in either half", () => {
      for (const pending_cutover_from of [
        { ...pendingPin.pending_cutover_from, gateway_reference: "old" },
        { ...pendingPin.pending_cutover_from, solid_ingress_composition_reference: "old" },
        { gateway_reference: gatewayReference },
        [gatewayReference, fingerprint],
        null,
      ]) {
        expect(() =>
          verifyHnsStagingGatewayManifest(manifest, { ...pendingPin, pending_cutover_from }),
        ).toThrow("differs from the reviewed deploy pin");
      }
    });

    test("still refuses a production or unknown listener under a matching stand-in", () => {
      const other = JSON.stringify({ ...JSON.parse(manifest), mode: "production" });
      const reference = `hns-community-app-handle-gateway-sha256:${createHash("sha256").update(other).digest("hex")}`;
      expect(() =>
        verifyHnsStagingGatewayManifest(other, {
          ...pendingPin,
          pending_cutover_from: {
            gateway_reference: reference,
            solid_ingress_composition_reference: fingerprint,
          },
        }),
      ).toThrow("differs from the reviewed deploy pin");
    });

    test("binds the committed pin to the exact cookie transition", async () => {
      const committed = (await readHnsStagingGatewayPin(
        dirname(import.meta.dir),
      )) as typeof pendingPin;
      expect(committed.gateway_reference).toBe(NEXT_GATEWAY);
      expect(committed.solid_ingress_composition_reference).toBe(
        "solid-hns-ingress-sha256:ca8947f90135419945ed697af91e429bc07b45e04d8ace973f655fe6f37758f5",
      );
      expect(committed.pending_cutover_from).toEqual({
        gateway_reference: PREVIOUS_GATEWAY,
        solid_ingress_composition_reference:
          "solid-hns-ingress-sha256:614a197b91112007fe26dda867b23452a2beeefa47acfdba147a5c7bfee38076",
      });
    });
  });

  test("the direct check command runs the real export and propagates its failure", async () => {
    const solid = await mkdtemp(join(tmpdir(), "hns-direct-check-"));
    try {
      await mkdir(join(solid, "scripts"));
      const module = join(solid, "scripts/staging-release-check.mjs");
      const [command, ...args] = HNS_STAGING_DIRECT_CHECK_COMMAND;

      await writeFile(module, 'export const checkDirectStaging = async () => ({ origin: "x" });\n');
      const passed = spawnSync(command, args, { cwd: solid, encoding: "utf8" });
      expect(passed.status).toBe(0);
      expect(JSON.parse(passed.stdout)).toEqual({ origin: "x" });

      await writeFile(
        module,
        'export const checkDirectStaging = async () => { throw new Error("unreachable"); };\n',
      );
      const failed = spawnSync(command, args, { cwd: solid, encoding: "utf8" });
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain("unreachable");
    } finally {
      await rm(solid, { recursive: true, force: true });
    }
  });
});
