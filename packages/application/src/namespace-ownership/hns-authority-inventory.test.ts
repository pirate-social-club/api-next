import { expect, test } from "bun:test";
import type { Sha256Hex } from "@pirate/domain/verification";
import {
  decodeHnsAuthorityInventoryBytes,
  type HnsAuthorityInventoryV1,
  hnsAuthorityCapabilitySetDigest,
  hnsAuthorityCapabilitySetPreimage,
  validateHnsAuthorityInventoryAtDatabaseTime,
} from "./hns-authority-inventory.ts";
import {
  decodeHnsControlObserverCompatibleConfigurationBytes,
  decodeHnsControlObserverConfigurationBytes,
  decodeHnsControlObserverConfigurationV2Bytes,
  encodeHnsControlObserverConfigurationV2,
  HnsControlObserverConfigurationError,
  type HnsControlObserverConfigurationV2,
} from "./hns-control-observer-configuration.ts";

const encoder = new TextEncoder();

const capabilitySetPreimage =
  '["pirate-hns-authority-capability-set-v1","test",[{"authority_nameserver":"ns1.pirate-regtest","authority_address_family":"GLUE4","authority_address":"192.0.2.53","active":true},{"authority_nameserver":"ns2.pirate-regtest","authority_address_family":"GLUE6","authority_address":"2001:db8::53","active":true}],[{"capability_reference":"dns-write:shared-provider-pirate","scope_kind":"exact_root","root_label":"pirate","active":true}]]';
const capabilitySetDigest =
  "7066336e40d1e0f09ee0a22fb2f525b86d9ef4c7528e519456766b361d937a32" as Sha256Hex;
const inventoryJson =
  '{"version":"pirate-hns-authority-inventory-v1","authority_inventory_reference":"authority-inventory:regtest-20260824-01","authority_inventory_version":"authority-inventory-v1-20260824-01","environment":"test","completeness":"complete","runtime_capability_set_digest":"7066336e40d1e0f09ee0a22fb2f525b86d9ef4c7528e519456766b361d937a32","published_at":"2026-02-02T03:30:00.000Z","expires_at":"2026-02-02T04:30:00.000Z","authoritative_nameserver_glue":[{"authority_nameserver":"ns1.pirate-regtest","authority_address_family":"GLUE4","authority_address":"192.0.2.53","active":true},{"authority_nameserver":"ns2.pirate-regtest","authority_address_family":"GLUE6","authority_address":"2001:db8::53","active":true}],"dns_write_capabilities":[{"capability_reference":"dns-write:shared-provider-pirate","scope_kind":"exact_root","root_label":"pirate","active":true}]}';
const inventoryDigest =
  "0df75e870a0ec11e7a0a81439a09e30796c69d9110749383c57a475e4824b18c" as Sha256Hex;
const configurationV2Json =
  '{"version":"pirate-hns-control-observer-configuration-v2","provider_id":"hns.owner.v1","provider_configuration_reference":"hns-observer-regtest-config-fixture-v2","provider_configuration_version":"hns-observer-config-v2","environment":"test","ownership_sources":["hns_parent_chain_txt","owner_authoritative_dns_txt"],"chain":{"driver_reference":"hsd-json-rpc:regtest-primary","network":"regtest","genesis_block_hash":"2222222222222222222222222222222222222222222222222222222222222222","minimum_verification_progress_millionths":999000,"maximum_tip_age_seconds":21600,"maximum_future_tip_seconds":7200,"expected_block_interval_seconds":600,"minimum_safe_remaining_blocks":144,"expiry_safety_blocks":144,"response_max_bytes":1048576},"authoritative_dns":{"driver_reference":"authoritative-dns:regtest","required_view_ids":["dns-view-a","dns-view-b"],"require_dnssec":true,"require_all_views":true,"response_max_bytes":65535},"authority_inventory":{"registry_reference":"authority-inventory:regtest","maximum_inventory_lifetime_seconds":3600,"response_max_bytes":65536},"evidence_lease_seconds":2592000,"observer_deadline_ms":12000,"observer_reservation_lease_seconds":15,"snapshot_store_reference":"postgres:hns-control-observer-v1"}';
const configurationV2Digest = "9b57c1f4630267f270f1b93dced9805d058f692d0cee879a9a4ee54b6e3e6b8b";

function inventoryValue(): HnsAuthorityInventoryV1 {
  return JSON.parse(inventoryJson) as HnsAuthorityInventoryV1;
}

function configurationV2Value(): HnsControlObserverConfigurationV2 {
  return JSON.parse(configurationV2Json) as HnsControlObserverConfigurationV2;
}

test("reproduces the authority inventory and configuration-v2 vectors", async () => {
  const inventory = inventoryValue();
  expect(
    hnsAuthorityCapabilitySetPreimage({
      environment: inventory.environment,
      authoritative_nameserver_glue: inventory.authoritative_nameserver_glue,
      dns_write_capabilities: inventory.dns_write_capabilities,
    }),
  ).toBe(capabilitySetPreimage);
  expect(
    await hnsAuthorityCapabilitySetDigest({
      environment: inventory.environment,
      authoritative_nameserver_glue: inventory.authoritative_nameserver_glue,
      dns_write_capabilities: inventory.dns_write_capabilities,
    }),
  ).toBe(capabilitySetDigest);

  const inventoryBytes = encoder.encode(inventoryJson);
  expect(inventoryBytes.byteLength).toBe(857);
  const decodedInventory = await decodeHnsAuthorityInventoryBytes(inventoryBytes);
  expect(decodedInventory.inventory).toEqual(inventory);
  expect(decodedInventory.inventory_digest).toBe(inventoryDigest);
  expect(decodedInventory.inventory_bytes).toEqual(inventoryBytes);
  expect(decodedInventory.inventory_bytes).not.toBe(inventoryBytes);

  const configurationBytes = encoder.encode(configurationV2Json);
  expect(configurationBytes.byteLength).toBe(1_230);
  const decodedConfiguration =
    await decodeHnsControlObserverConfigurationV2Bytes(configurationBytes);
  expect(decodedConfiguration.configuration).toEqual(configurationV2Value());
  expect(decodedConfiguration.configuration_digest).toBe(configurationV2Digest);
  expect(await encodeHnsControlObserverConfigurationV2(configurationV2Value())).toEqual(
    configurationBytes,
  );
  await expect(
    decodeHnsControlObserverCompatibleConfigurationBytes(configurationBytes),
  ).resolves.toEqual(decodedConfiguration);
});

test("keeps the compatibility decoder version-closed", async () => {
  const v1Bytes = encoder.encode(
    '{"version":"pirate-hns-control-observer-configuration-v1","provider_id":"hns.owner.v1","provider_configuration_reference":"hns-observer-regtest-config-fixture","provider_configuration_version":"hns-observer-config-v1","environment":"test","ownership_sources":["hns_parent_chain_txt"],"chain":{"driver_reference":"hsd-json-rpc:regtest-primary","network":"regtest","genesis_block_hash":"2222222222222222222222222222222222222222222222222222222222222222","minimum_verification_progress_millionths":999000,"maximum_tip_age_seconds":21600,"maximum_future_tip_seconds":7200,"expected_block_interval_seconds":600,"minimum_safe_remaining_blocks":144,"expiry_safety_blocks":144,"response_max_bytes":1048576},"authoritative_dns":null,"evidence_lease_seconds":2592000,"observer_deadline_ms":12000,"observer_reservation_lease_seconds":15,"snapshot_store_reference":"postgres:hns-control-observer-v1"}',
  );
  const v1 = await decodeHnsControlObserverConfigurationBytes(v1Bytes);
  await expect(decodeHnsControlObserverCompatibleConfigurationBytes(v1Bytes)).resolves.toEqual(v1);
  await expect(decodeHnsControlObserverConfigurationV2Bytes(v1Bytes)).rejects.toThrow(
    HnsControlObserverConfigurationError,
  );

  const missingInventory = configurationV2Value() as Record<string, unknown>;
  delete missingInventory.authority_inventory;
  await expect(
    decodeHnsControlObserverCompatibleConfigurationBytes(
      encoder.encode(JSON.stringify(missingInventory)),
    ),
  ).rejects.toThrow(HnsControlObserverConfigurationError);

  const widenedV1 = JSON.parse(new TextDecoder().decode(v1Bytes)) as Record<string, unknown>;
  widenedV1.authority_inventory = null;
  await expect(
    decodeHnsControlObserverCompatibleConfigurationBytes(encoder.encode(JSON.stringify(widenedV1))),
  ).rejects.toThrow(HnsControlObserverConfigurationError);

  await expect(
    decodeHnsControlObserverConfigurationV2Bytes(
      encoder.encode(
        JSON.stringify({
          ...configurationV2Value(),
          authority_inventory: null,
        }),
      ),
    ),
  ).rejects.toThrow("does not match its source set");

  await expect(
    decodeHnsControlObserverConfigurationV2Bytes(
      encoder.encode(
        JSON.stringify({
          ...configurationV2Value(),
          ownership_sources: ["hns_parent_chain_txt"],
          authoritative_dns: null,
        }),
      ),
    ),
  ).rejects.toThrow("does not match its source set");

  const reusedCapability = configurationV2Value();
  if (reusedCapability.authority_inventory === null) {
    throw new Error("configuration fixture inventory policy is missing");
  }
  await expect(
    decodeHnsControlObserverConfigurationV2Bytes(
      encoder.encode(
        JSON.stringify({
          ...reusedCapability,
          authority_inventory: {
            ...reusedCapability.authority_inventory,
            registry_reference: reusedCapability.chain.driver_reference,
          },
        }),
      ),
    ),
  ).rejects.toThrow("must be a distinct capability");
});

test("rejects reordered, noncanonical, duplicated, and self-inconsistent inventory", async () => {
  const base = inventoryValue();
  const reordered = {
    ...base,
    authoritative_nameserver_glue: [...base.authoritative_nameserver_glue].reverse(),
  };
  await expect(
    decodeHnsAuthorityInventoryBytes(encoder.encode(JSON.stringify(reordered))),
  ).rejects.toThrow("duplicated or reordered");

  const firstNameserver = base.authoritative_nameserver_glue[0];
  if (firstNameserver === undefined) throw new Error("inventory fixture nameserver is missing");
  const noncanonicalAddress = {
    ...base,
    authoritative_nameserver_glue: [
      { ...firstNameserver, authority_address: "192.000.2.53" },
      ...base.authoritative_nameserver_glue.slice(1),
    ],
  };
  await expect(
    decodeHnsAuthorityInventoryBytes(encoder.encode(JSON.stringify(noncanonicalAddress))),
  ).rejects.toThrow("not canonical");

  const firstWriteCapability = base.dns_write_capabilities[0];
  if (firstWriteCapability === undefined) throw new Error("inventory fixture write is missing");
  const duplicate = {
    ...base,
    dns_write_capabilities: [...base.dns_write_capabilities, { ...firstWriteCapability }],
  };
  await expect(
    decodeHnsAuthorityInventoryBytes(encoder.encode(JSON.stringify(duplicate))),
  ).rejects.toThrow("duplicated or reordered");

  const badDigest = {
    ...base,
    runtime_capability_set_digest: "0".repeat(64) as Sha256Hex,
  };
  await expect(
    decodeHnsAuthorityInventoryBytes(encoder.encode(JSON.stringify(badDigest))),
  ).rejects.toMatchObject({ reason: "capability_mismatch" });
});

test("validates immutable inventory identity and freshness at database time", async () => {
  const decoded = await decodeHnsAuthorityInventoryBytes(encoder.encode(inventoryJson));
  const input = {
    decoded,
    expected_reference: decoded.inventory.authority_inventory_reference,
    expected_version: decoded.inventory.authority_inventory_version,
    expected_digest: inventoryDigest,
    expected_environment: "test",
    expected_runtime_capability_set_digest: capabilitySetDigest,
    database_now: "2026-02-02T04:00:00.000Z",
    maximum_inventory_lifetime_seconds: 3_600,
  } as const;
  expect(validateHnsAuthorityInventoryAtDatabaseTime(input)).toEqual(decoded.inventory);
  expect(() =>
    validateHnsAuthorityInventoryAtDatabaseTime({
      ...input,
      expected_reference: "authority-inventory:other",
    }),
  ).toThrow("identity does not match");
  expect(() =>
    validateHnsAuthorityInventoryAtDatabaseTime({
      ...input,
      expected_digest: "0".repeat(64) as Sha256Hex,
    }),
  ).toThrow("digest does not match");
  expect(() =>
    validateHnsAuthorityInventoryAtDatabaseTime({
      ...input,
      database_now: decoded.inventory.expires_at,
    }),
  ).toThrow("not fresh");
  expect(() =>
    validateHnsAuthorityInventoryAtDatabaseTime({
      ...input,
      maximum_inventory_lifetime_seconds: 3_599,
    }),
  ).toThrow("not fresh");
});
