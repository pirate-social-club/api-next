/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  decodeHnsAuthorityInventoryBytes,
  decodeHnsControlObserverConfigurationV2Bytes,
  hnsRootIsPirateWritable,
} from "@pirate/application/namespace-ownership";
import { describe, expect, it } from "vitest";

const inventoryJson =
  '{"version":"pirate-hns-authority-inventory-v1","authority_inventory_reference":"authority-inventory:regtest-20260824-01","authority_inventory_version":"authority-inventory-v1-20260824-01","environment":"test","completeness":"complete","runtime_capability_set_digest":"7066336e40d1e0f09ee0a22fb2f525b86d9ef4c7528e519456766b361d937a32","published_at":"2026-02-02T03:30:00.000Z","expires_at":"2026-02-02T04:30:00.000Z","authoritative_nameserver_glue":[{"authority_nameserver":"ns1.pirate-regtest","authority_address_family":"GLUE4","authority_address":"192.0.2.53","active":true},{"authority_nameserver":"ns2.pirate-regtest","authority_address_family":"GLUE6","authority_address":"2001:db8::53","active":true}],"dns_write_capabilities":[{"capability_reference":"dns-write:shared-provider-pirate","scope_kind":"exact_root","root_label":"pirate","active":true}]}';
const configurationV2Json =
  '{"version":"pirate-hns-control-observer-configuration-v2","provider_id":"hns.owner.v1","provider_configuration_reference":"hns-observer-regtest-config-fixture-v2","provider_configuration_version":"hns-observer-config-v2","environment":"test","ownership_sources":["hns_parent_chain_txt","owner_authoritative_dns_txt"],"chain":{"driver_reference":"hsd-json-rpc:regtest-primary","network":"regtest","genesis_block_hash":"2222222222222222222222222222222222222222222222222222222222222222","minimum_verification_progress_millionths":999000,"maximum_tip_age_seconds":21600,"maximum_future_tip_seconds":7200,"expected_block_interval_seconds":600,"minimum_safe_remaining_blocks":144,"expiry_safety_blocks":144,"response_max_bytes":1048576},"authoritative_dns":{"driver_reference":"authoritative-dns:regtest","required_view_ids":["dns-view-a","dns-view-b"],"require_dnssec":true,"require_all_views":true,"response_max_bytes":65535},"authority_inventory":{"registry_reference":"authority-inventory:regtest","maximum_inventory_lifetime_seconds":3600,"response_max_bytes":65536},"evidence_lease_seconds":2592000,"observer_deadline_ms":12000,"observer_reservation_lease_seconds":15,"snapshot_store_reference":"postgres:hns-control-observer-v1"}';

describe("HNS authority inventory codecs (workerd)", () => {
  it("reproduces the immutable inventory and configuration-v2 digests", async () => {
    const encoder = new TextEncoder();
    const inventory = await decodeHnsAuthorityInventoryBytes(encoder.encode(inventoryJson));
    const configuration = await decodeHnsControlObserverConfigurationV2Bytes(
      encoder.encode(configurationV2Json),
    );

    expect(inventory.inventory_bytes.byteLength).toBe(857);
    expect(inventory.inventory_digest).toBe(
      "0df75e870a0ec11e7a0a81439a09e30796c69d9110749383c57a475e4824b18c",
    );
    expect(inventory.inventory.runtime_capability_set_digest).toBe(
      "7066336e40d1e0f09ee0a22fb2f525b86d9ef4c7528e519456766b361d937a32",
    );
    expect(configuration.configuration_bytes.byteLength).toBe(1_230);
    expect(configuration.configuration_digest).toBe(
      "9b57c1f4630267f270f1b93dced9805d058f692d0cee879a9a4ee54b6e3e6b8b",
    );
  });

  it("derives custody from an exact active tuple or exact-root write capability", async () => {
    const inventory = await decodeHnsAuthorityInventoryBytes(
      new TextEncoder().encode(inventoryJson),
    );
    expect(
      hnsRootIsPirateWritable({
        root_label: "pirate",
        chain_authority_records: [
          ["NS", "ns1.pirate-regtest"],
          ["GLUE4", "ns1.pirate-regtest", "192.0.2.53"],
        ],
        inventory: inventory.inventory,
      }),
    ).toBe(true);
    expect(
      hnsRootIsPirateWritable({
        root_label: "pirate",
        chain_authority_records: [
          ["NS", "unmanaged.example"],
          ["GLUE4", "unmanaged.example", "198.51.100.53"],
        ],
        inventory: inventory.inventory,
      }),
    ).toBe(true);
    expect(
      hnsRootIsPirateWritable({
        root_label: "other-root",
        chain_authority_records: [
          ["NS", "ns1.pirate-regtest"],
          ["GLUE4", "ns1.pirate-regtest", "192.0.2.54"],
        ],
        inventory: inventory.inventory,
      }),
    ).toBe(false);
  });
});
