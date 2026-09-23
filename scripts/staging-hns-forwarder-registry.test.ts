import { describe, expect, test } from "bun:test";
import { parseHnsForwarderV3KeyRegistry } from "@pirate/platform-cf/hns-forwarder-v3";
import {
  custodiedRegistryExists,
  makeStagingForwarderRegistry,
  STAGING_FORWARDER_KEY_ID,
  STAGING_FORWARDER_REFERENCE,
  STAGING_FORWARDER_VERSION,
} from "./staging-hns-forwarder-registry.ts";

describe("staging HNS forwarder registry", () => {
  const now = 1_790_160_000;
  test("creates one active, exact staging key", () => {
    const source = makeStagingForwarderRegistry(now, new Uint8Array(32).fill(7));
    const registry = parseHnsForwarderV3KeyRegistry(
      source,
      STAGING_FORWARDER_REFERENCE,
      STAGING_FORWARDER_VERSION,
    );
    expect(registry.signingKey(now)?.key_id).toBe(STAGING_FORWARDER_KEY_ID);
    expect(registry.signingKey(now - 301)).toBeNull();
    expect(registry.signingKey(now + 90 * 24 * 60 * 60 + 1)).toBeNull();
    const document = JSON.parse(source);
    expect(document.keys).toHaveLength(1);
    expect(document.keys[0].key_base64url).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test("refuses wrong key length and invalid time", () => {
    expect(() => makeStagingForwarderRegistry(now, new Uint8Array(31))).toThrow("key_length");
    expect(() => makeStagingForwarderRegistry(0, new Uint8Array(32))).toThrow("time");
  });

  test("refuses a malformed or wrongly scoped custody listing before any write", async () => {
    const listing = (keys: readonly unknown[]) => async () => JSON.stringify(keys);
    const sibling = { secretKey: "CONTROL_PLANE_POSTGRES_RUNTIME_URL" };
    const registry = { secretKey: "HNS_FORWARDER_V3_HMAC_KEY_REGISTRY" };
    expect(await custodiedRegistryExists(listing([sibling]))).toBe(false);
    expect(await custodiedRegistryExists(listing([sibling, registry]))).toBe(true);
    await expect(custodiedRegistryExists(listing([registry]))).rejects.toThrow(
      "custody_scope_unproven",
    );
    await expect(custodiedRegistryExists(listing([{ secrets: [sibling] }]))).rejects.toThrow(
      "custody_listing_unreadable",
    );
    await expect(custodiedRegistryExists(async () => "{}")).rejects.toThrow(
      "custody_listing_unreadable",
    );
  });
});
