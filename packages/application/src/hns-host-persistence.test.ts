import { describe, expect, test } from "vitest";
import {
  deriveHnsAuthoritySuccessorGenerationsV1,
  HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
  prepareHnsDnsZoneActivationDocumentV1,
  requireHnsAuthorityEmitObservationV1,
  requireReviewedHnsAuthorityCandidateV1,
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

const chainDs = [
  [10875, 13, 2, "a".repeat(64)],
  [10875, 13, 4, "b".repeat(96)],
] as const;
const observedView = (authorityAddress: string) => ({
  authority_address: authorityAddress,
  outcome: "observed" as const,
  zone_bytes_digest: "c".repeat(64),
  dnskey_key_tag: 10875,
  derived_ds: chainDs,
});

test("admits only two complete agreeing authority views with chain-matching DS", () => {
  expect(
    requireHnsAuthorityEmitObservationV1({
      expected_authority_addresses: ["94.103.168.161", "81.15.150.159"],
      views: [observedView("94.103.168.161"), observedView("81.15.150.159")],
      chain_ds: chainDs,
    }),
  ).toHaveLength(2);
});

test("refuses missing and unavailable authority views without partial emission", () => {
  const expected = ["94.103.168.161", "81.15.150.159"] as const;
  expect(() =>
    requireHnsAuthorityEmitObservationV1({
      expected_authority_addresses: expected,
      views: [observedView(expected[0])],
      chain_ds: chainDs,
    }),
  ).toThrow("incomplete_authority_views");
  expect(() =>
    requireHnsAuthorityEmitObservationV1({
      expected_authority_addresses: expected,
      views: [
        observedView(expected[0]),
        {
          authority_address: expected[1],
          outcome: "unavailable",
          zone_bytes_digest: null,
          dnskey_key_tag: null,
          derived_ds: null,
        },
      ],
      chain_ds: chainDs,
    }),
  ).toThrow("unavailable_authority_view");
});

test("refuses authority disagreement and DNSKEY-to-chain DS mismatch", () => {
  const expected = ["94.103.168.161", "81.15.150.159"] as const;
  expect(() =>
    requireHnsAuthorityEmitObservationV1({
      expected_authority_addresses: expected,
      views: [observedView(expected[0]), { ...observedView(expected[1]), dnskey_key_tag: 39280 }],
      chain_ds: chainDs,
    }),
  ).toThrow("authority_view_mismatch");
  expect(() =>
    requireHnsAuthorityEmitObservationV1({
      expected_authority_addresses: expected,
      views: [observedView(expected[0]), observedView(expected[1])],
      chain_ds: [[39280, 13, 2, "d".repeat(64)]],
    }),
  ).toThrow("dnskey_ds_mismatch");
});

const emittedSnapshot = {
  dns_current_generation: 5,
  app_host_current_generation: 9,
  successor_dns_latest_health_generation: 0,
} as const;

test("refuses pointer drift independently of candidate byte identity", () => {
  const bytes = new TextEncoder().encode("reviewed-6-10-1");
  expect(() =>
    requireReviewedHnsAuthorityCandidateV1({
      emitted_snapshot: emittedSnapshot,
      current_snapshot: { ...emittedSnapshot, dns_current_generation: 6 },
      reviewed_candidate_bytes: bytes,
      recomputed_candidate_bytes: bytes,
    }),
  ).toThrow("generation_fence_changed");
});

test("refuses altered reviewed bytes while generation pointers remain unchanged", () => {
  expect(() =>
    requireReviewedHnsAuthorityCandidateV1({
      emitted_snapshot: emittedSnapshot,
      current_snapshot: emittedSnapshot,
      reviewed_candidate_bytes: new TextEncoder().encode("reviewed-6-10-1"),
      recomputed_candidate_bytes: new TextEncoder().encode("changed-6-10-1"),
    }),
  ).toThrow("candidate_bytes_mismatch");
});

test("admits only unchanged pointers and byte-identical recomputation", () => {
  const bytes = new TextEncoder().encode("reviewed-6-10-1");
  expect(() =>
    requireReviewedHnsAuthorityCandidateV1({
      emitted_snapshot: emittedSnapshot,
      current_snapshot: emittedSnapshot,
      reviewed_candidate_bytes: bytes,
      recomputed_candidate_bytes: new Uint8Array(bytes),
    }),
  ).not.toThrow();
});
