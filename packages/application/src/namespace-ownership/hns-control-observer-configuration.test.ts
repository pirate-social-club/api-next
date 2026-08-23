import { describe, expect, test } from "bun:test";
import type { Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import {
  decodeHnsControlObserverConfigurationBytes,
  encodeHnsControlObserverConfiguration,
  HNS_CONTROL_OBSERVER_CONFIGURATION_MAX_BYTES,
  HnsControlObserverConfigurationError,
  type HnsControlObserverRuntimeCapabilities,
  resolveHnsControlObserverConfiguration,
} from "./hns-control-observer-configuration.ts";

const encoder = new TextEncoder();
const resolutionOptions = {
  deadline_ms: 12_000,
  signal: new AbortController().signal,
} as const;
const configurationJson =
  '{"version":"pirate-hns-control-observer-configuration-v1","provider_id":"hns.owner.v1","provider_configuration_reference":"hns-observer-regtest-config-fixture","provider_configuration_version":"hns-observer-config-v1","environment":"test","ownership_sources":["hns_parent_chain_txt","owner_authoritative_dns_txt"],"chain":{"driver_reference":"hsd-json-rpc:regtest-primary","network":"regtest","genesis_block_hash":"2222222222222222222222222222222222222222222222222222222222222222","minimum_verification_progress_millionths":999000,"maximum_tip_age_seconds":21600,"maximum_future_tip_seconds":7200,"expected_block_interval_seconds":600,"minimum_safe_remaining_blocks":144,"expiry_safety_blocks":144,"response_max_bytes":1048576},"authoritative_dns":{"driver_reference":"authoritative-dns:regtest","required_view_ids":["dns-view-a","dns-view-b"],"require_dnssec":true,"require_all_views":true,"response_max_bytes":65535},"evidence_lease_seconds":2592000,"observer_deadline_ms":12000,"observer_reservation_lease_seconds":15,"snapshot_store_reference":"postgres:hns-control-observer-v1"}';
const configurationBytes = encoder.encode(configurationJson);
const configurationDigest =
  "0d3124f191af535fecc577b83c0fe2b310382dd558d63eae664eb2a84d683fa3" as Sha256HexValue;

function changedConfiguration(change: (value: Record<string, unknown>) => void): Uint8Array {
  const value = JSON.parse(configurationJson) as Record<string, unknown>;
  change(value);
  return encoder.encode(JSON.stringify(value));
}

const capabilities: HnsControlObserverRuntimeCapabilities = {
  provider_id: "hns.owner.v1",
  environment: "test",
  chain_driver_reference: "hsd-json-rpc:regtest-primary",
  authoritative_dns_driver_reference: "authoritative-dns:regtest",
  snapshot_store_reference: "postgres:hns-control-observer-v1",
};

const authority = {
  provider_id: "hns.owner.v1",
  provider_configuration_reference: "hns-observer-regtest-config-fixture",
  provider_configuration_version: "hns-observer-config-v1",
  provider_configuration_digest: configurationDigest,
  environment: "test",
  ownership_source: "hns_parent_chain_txt",
} as const;

describe("HNS control observer configuration", () => {
  test("reproduces the literal exact-byte vector", async () => {
    const decoded = await decodeHnsControlObserverConfigurationBytes(configurationBytes);
    expect(decoded.configuration_bytes).toEqual(configurationBytes);
    expect(decoded.configuration_bytes).not.toBe(configurationBytes);
    expect(decoded.configuration_bytes.byteLength).toBe(1_083);
    expect(decoded.configuration_digest).toBe(configurationDigest);
    expect(decoded.configuration.chain.minimum_safe_remaining_blocks).toBe(144);
    expect(decoded.configuration.authoritative_dns?.required_view_ids).toEqual([
      "dns-view-a",
      "dns-view-b",
    ]);
    expect(await encodeHnsControlObserverConfiguration(decoded.configuration)).toEqual(
      configurationBytes,
    );
  });

  test("rejects non-canonical and oversized documents", async () => {
    const reordered = JSON.parse(configurationJson) as Record<string, unknown>;
    const version = reordered.version;
    delete reordered.version;
    reordered.version = version;
    const duplicate = configurationJson.replace(
      '"provider_id":"hns.owner.v1",',
      '"provider_id":"hns.owner.v1","provider_id":"hns.owner.v1",',
    );
    const cases = [
      encoder.encode(` ${configurationJson}`),
      encoder.encode(JSON.stringify(reordered)),
      encoder.encode(duplicate),
      new Uint8Array([0xef, 0xbb, 0xbf, ...configurationBytes]),
      new Uint8Array(HNS_CONTROL_OBSERVER_CONFIGURATION_MAX_BYTES + 1),
      changedConfiguration((value) => {
        value.unknown = true;
      }),
    ];
    for (const value of cases) {
      await expect(decodeHnsControlObserverConfigurationBytes(value)).rejects.toThrow(
        HnsControlObserverConfigurationError,
      );
    }
  });

  test("enforces registry, source, view, and lease invariants", async () => {
    const cases = [
      changedConfiguration((value) => {
        (value.chain as Record<string, unknown>).driver_reference = "https://chain.invalid";
      }),
      changedConfiguration((value) => {
        (value.chain as Record<string, unknown>).network = "REGTEST";
      }),
      changedConfiguration((value) => {
        value.ownership_sources = ["owner_authoritative_dns_txt", "hns_parent_chain_txt"];
      }),
      changedConfiguration((value) => {
        value.authoritative_dns = null;
      }),
      changedConfiguration((value) => {
        (value.authoritative_dns as Record<string, unknown>).required_view_ids = [
          "dns-view-b",
          "dns-view-a",
        ];
      }),
      changedConfiguration((value) => {
        (value.authoritative_dns as Record<string, unknown>).required_view_ids = Array.from(
          { length: 9 },
          (_, index) => `dns-view-${index}`,
        );
      }),
      changedConfiguration((value) => {
        value.observer_reservation_lease_seconds = 14;
      }),
    ];
    for (const value of cases) {
      await expect(decodeHnsControlObserverConfigurationBytes(value)).rejects.toThrow(
        HnsControlObserverConfigurationError,
      );
    }
  });

  test("resolves exact bytes and cross-checks authority and capabilities", async () => {
    const source = new Uint8Array(configurationBytes);
    const resolver = { resolve: async () => source };
    const decoded = await resolveHnsControlObserverConfiguration({
      authority,
      capabilities,
      resolver,
      ...resolutionOptions,
    });
    source.fill(0);
    expect(decoded.configuration_bytes).toEqual(configurationBytes);

    await expect(
      resolveHnsControlObserverConfiguration({
        authority: {
          ...authority,
          provider_configuration_digest: "1".repeat(64) as Sha256HexValue,
        },
        capabilities,
        resolver: { resolve: async () => configurationBytes },
        ...resolutionOptions,
      }),
    ).rejects.toMatchObject({ reason: "digest_mismatch" });

    await expect(
      resolveHnsControlObserverConfiguration({
        authority,
        capabilities: { ...capabilities, chain_driver_reference: "hsd-json-rpc:wrong" },
        resolver: { resolve: async () => configurationBytes },
        ...resolutionOptions,
      }),
    ).rejects.toMatchObject({ reason: "capability_mismatch" });

    await expect(
      resolveHnsControlObserverConfiguration({
        authority,
        capabilities,
        resolver: { resolve: async () => null },
        ...resolutionOptions,
      }),
    ).rejects.toMatchObject({ reason: "not_found" });
  });

  test("rejects a self-identity mismatch even when the changed bytes are correctly hashed", async () => {
    const bytes = changedConfiguration((value) => {
      value.provider_configuration_reference = "different-reference";
    });
    const decoded = await decodeHnsControlObserverConfigurationBytes(bytes);
    await expect(
      resolveHnsControlObserverConfiguration({
        authority: { ...authority, provider_configuration_digest: decoded.configuration_digest },
        capabilities,
        resolver: { resolve: async () => bytes },
        ...resolutionOptions,
      }),
    ).rejects.toMatchObject({ reason: "identity_mismatch" });
  });
});
