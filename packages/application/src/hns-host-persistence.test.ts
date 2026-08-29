import { describe, expect, test } from "vitest";
import {
  deriveHnsAuthoritySuccessorGenerationsV1,
  HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
  prepareHnsDnsZoneActivationDocumentV1,
} from "./hns-host-persistence.ts";

describe("HNS authority successor generation preparation", () => {
  test("predicts the fenced jazleeuw successor generations without a reservation", () => {
    expect(
      deriveHnsAuthoritySuccessorGenerationsV1({
        dns_current_generation: 5,
        app_host_current_generation: 9,
        successor_dns_latest_health_generation: 0,
      }),
    ).toEqual({
      dns_activation_generation: 6,
      app_host_activation_generation: 10,
      health_generation: 1,
    });
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["non-incrementable", Number.MAX_SAFE_INTEGER],
  ])("rejects a %s generation snapshot", (_label, value) => {
    expect(() =>
      deriveHnsAuthoritySuccessorGenerationsV1({
        dns_current_generation: value,
        app_host_current_generation: 9,
        successor_dns_latest_health_generation: 0,
      }),
    ).toThrow("DNS current generation must be a nonnegative incrementable safe integer");
  });
});

test("emit and persistence preparation share the exact activation bytes", async () => {
  const zoneBytes = new TextEncoder().encode("$ORIGIN jazleeuw.\n; canonical observation\n");
  const input = {
    payload: {
      version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
      dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
      canonical_root: "jazleeuw",
      dns_authority: ["pirate_managed_dns_v1", "dns-authority:jazleeuw", 6] as const,
      pirate_dns_authority_inventory: [
        "authority-inventory:jazleeuw",
        "v6",
        "1".repeat(64),
      ] as const,
      zone_revision: 6,
      dnssec_keyset: ["dnssec-keyset:jazleeuw", "key-tag-10875"] as const,
      gateway: ["gateway:jazleeuw", "2".repeat(64)] as const,
      stable_chain_delegation_snapshot: ["delegation:jazleeuw", "3".repeat(64)] as const,
    },
    zone_bytes: zoneBytes,
  } as const;

  const emitted = await prepareHnsDnsZoneActivationDocumentV1(input);
  const persistencePrepared = await prepareHnsDnsZoneActivationDocumentV1(input);

  expect(emitted).toEqual(persistencePrepared);
  expect(emitted.activation_document_bytes).toEqual(persistencePrepared.activation_document_bytes);
  expect(emitted.dnssec_keyset_version).toBe("key-tag-10875");
  expect(emitted.zone_bytes).not.toBe(zoneBytes);
});
