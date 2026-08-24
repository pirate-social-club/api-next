import { describe, expect, test } from "bun:test";
import {
  decodeHnsControlObservationResultV2Bytes,
  encodeHnsAuthorityInventory,
  encodeHnsControlObservationRequest,
  encodeHnsControlObserverConfigurationV2,
  type HnsAuthorityInventoryResolvedV1,
  type HnsAuthorityInventoryV1,
  type HnsControlObservationRequestV1,
  type HnsControlObserverConfigurationV2,
  type HnsControlObserverHsdTransportPort,
  hnsAuthorityCapabilitySetDigest,
} from "@pirate/application/namespace-ownership";
import { makeHnsOwnerAuthoritativeDnsTargetObserverV2 } from "./owner-authoritative-source-observer-v2.ts";

const encoder = new TextEncoder();
const databaseTime = "2026-02-02T03:04:05.000Z";
const databaseSeconds = Math.floor(Date.parse(databaseTime) / 1_000);
const genesisHash = "2".repeat(64);
const anchorHash = "3".repeat(64);

function rpc(result: unknown): Uint8Array {
  return encoder.encode(JSON.stringify({ result, error: null, id: null }));
}

function hsdTransport(calls: string[]): HnsControlObserverHsdTransportPort {
  return {
    exchange: async (exchange) => {
      const body = JSON.parse(new TextDecoder().decode(exchange.request_bytes)) as {
        method: string;
        params: unknown[];
      };
      calls.push(body.method);
      let result: unknown;
      switch (body.method) {
        case "getblockchaininfo":
          result = {
            chain: "regtest",
            blocks: 123_456,
            headers: 123_456,
            bestblockhash: anchorHash,
            mediantime: databaseSeconds - 60,
            verificationprogress: 1,
          };
          break;
        case "getblockheader":
          result =
            body.params[0] === genesisHash
              ? { hash: genesisHash, height: 0 }
              : {
                  hash: anchorHash,
                  height: 123_456,
                  time: databaseSeconds - 30,
                  mediantime: databaseSeconds - 60,
                  confirmations: 1,
                };
          break;
        case "getnameinfo":
          result = {
            info: {
              state: "CLOSED",
              registered: true,
              expired: false,
              stats: { renewalPeriodEnd: 200_000, blocksUntilExpire: 76_544 },
            },
          };
          break;
        case "getnameresource":
          result = {
            records: [
              { type: "NS", ns: "ns1.jazleeuw." },
              { type: "GLUE4", ns: "ns1.jazleeuw.", address: "192.0.2.53" },
              {
                type: "DS",
                keyTag: 12_345,
                algorithm: 13,
                digestType: 2,
                digest: "ab".repeat(32),
              },
            ],
          };
          break;
        default:
          throw new Error(`unexpected HSD method ${body.method}`);
      }
      return { status: 200, content_type: "application/json", response_bytes: rpc(result) };
    },
  };
}

async function fixture(staleInventory = false) {
  const nameserverGlue = [
    {
      authority_nameserver: "ns1.jazleeuw",
      authority_address_family: "GLUE4" as const,
      authority_address: "192.0.2.53",
      active: true,
    },
  ];
  const capabilitySetDigest = await hnsAuthorityCapabilitySetDigest({
    environment: "test",
    authoritative_nameserver_glue: nameserverGlue,
    dns_write_capabilities: [],
  });
  const inventory: HnsAuthorityInventoryV1 = {
    version: "pirate-hns-authority-inventory-v1",
    authority_inventory_reference: "authority-inventory:regtest-01",
    authority_inventory_version: "authority-inventory-v1-01",
    environment: "test",
    completeness: "complete",
    runtime_capability_set_digest: capabilitySetDigest,
    published_at: "2026-02-02T03:00:00.000Z",
    expires_at: staleInventory ? "2026-02-02T03:04:05.000Z" : "2026-02-02T04:00:00.000Z",
    authoritative_nameserver_glue: nameserverGlue,
    dns_write_capabilities: [],
  };
  const inventoryBytes = await encodeHnsAuthorityInventory(inventory);
  const inventoryDigest = await crypto.subtle
    .digest("SHA-256", inventoryBytes)
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  const configuration: HnsControlObserverConfigurationV2 = {
    version: "pirate-hns-control-observer-configuration-v2",
    provider_id: "hns.owner.v1",
    provider_configuration_reference: "hns-observer-regtest-config-v2",
    provider_configuration_version: "hns-observer-config-v2",
    environment: "test",
    ownership_sources: ["owner_authoritative_dns_txt"],
    chain: {
      driver_reference: "hsd-json-rpc:regtest-primary",
      network: "regtest",
      genesis_block_hash: genesisHash,
      minimum_verification_progress_millionths: 999_000,
      maximum_tip_age_seconds: 21_600,
      maximum_future_tip_seconds: 7_200,
      expected_block_interval_seconds: 600,
      minimum_safe_remaining_blocks: 144,
      expiry_safety_blocks: 144,
      response_max_bytes: 1_048_576,
    },
    authoritative_dns: {
      driver_reference: "authoritative-dns:regtest",
      required_view_ids: ["dns-view-a"],
      require_dnssec: true,
      require_all_views: true,
      response_max_bytes: 65_535,
    },
    authority_inventory: {
      registry_reference: "authority-inventory:regtest",
      maximum_inventory_lifetime_seconds: 3_600,
      response_max_bytes: 65_536,
    },
    evidence_lease_seconds: 2_592_000,
    observer_deadline_ms: 12_000,
    observer_reservation_lease_seconds: 15,
    snapshot_store_reference: "postgres:hns-control-observer-v1",
  };
  const configurationBytes = await encodeHnsControlObserverConfigurationV2(configuration);
  const configurationDigest = await crypto.subtle
    .digest("SHA-256", configurationBytes)
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  const request: HnsControlObservationRequestV1 = {
    version: "pirate-hns-control-observation-request-v1",
    observation_id: staleInventory ? "custody-stale-01" : "custody-ineligible-01",
    provider_id: "hns.owner.v1",
    provider_configuration_reference: configuration.provider_configuration_reference,
    provider_configuration_version: configuration.provider_configuration_version,
    provider_configuration_digest: configurationDigest,
    environment: "test",
    ownership_source: "owner_authoritative_dns_txt",
    root_label: "jazleeuw",
    txt_name: "_pirate.jazleeuw",
    expected_txt_value: "pirate=expected",
  };
  return {
    capabilitySetDigest,
    configuration,
    configurationBytes,
    inventory,
    inventoryBytes,
    inventoryDigest,
    request,
    requestBytes: await encodeHnsControlObservationRequest(request),
  };
}

async function observeInventoryFailure(
  value: Awaited<ReturnType<typeof fixture>>,
  resolvedInventory: HnsAuthorityInventoryResolvedV1,
) {
  const hsdCalls: string[] = [];
  let dnsCalls = 0;
  const observer = makeHnsOwnerAuthoritativeDnsTargetObserverV2({
    configuration_resolver: { resolve: async () => value.configurationBytes },
    capabilities: {
      provider_id: "hns.owner.v1",
      environment: "test",
      chain_driver_reference: value.configuration.chain.driver_reference,
      authoritative_dns_driver_reference:
        value.configuration.authoritative_dns?.driver_reference ?? null,
      snapshot_store_reference: value.configuration.snapshot_store_reference,
      authority_inventory_registry_reference:
        value.configuration.authority_inventory?.registry_reference ?? "",
      authority_inventory_runtime_capability_set_digest: value.capabilitySetDigest,
    },
    authority_inventory_resolver: { resolve: async () => resolvedInventory },
    snapshot_store: {
      reserve: async () => ({
        kind: "acquired",
        observer_fence: 1,
        reservation_database_time: databaseTime,
        lease_expires_at: "2026-02-02T03:04:20.000Z",
        snapshot_reference: "hns-observer:regtest:custody-hostile-01",
      }),
      finalize: async (input) => ({
        kind: "retained",
        snapshot_reference: input.snapshot_reference,
        result_bytes: input.result_bytes,
        result_sha256: input.result_sha256,
      }),
    },
    hsd_transport: {
      exchange: async () => {
        hsdCalls.push("unexpected");
        throw new Error("HSD must not run for hostile inventory");
      },
    },
    authoritative_dns_transport: {
      exchange: async () => {
        dnsCalls += 1;
        throw new Error("DNS must not run for hostile inventory");
      },
    },
    message_ids: { next_id: () => 1 },
    validator: {
      policy_id: "pirate-hns-authoritative-dns-validator-policy-v1",
      validate: async () => {
        throw new Error("validator must not run for hostile inventory");
      },
    },
  });
  const resultBytes = await observer.observe(
    {
      request: value.request,
      request_bytes: value.requestBytes,
      lease_policy: {
        expected_block_interval_seconds: 600,
        minimum_safe_remaining_blocks: 144,
        expiry_safety_blocks: 144,
        evidence_lease_seconds: 2_592_000,
      },
    },
    { deadline_ms: 12_000, signal: new AbortController().signal },
  );
  return {
    result: (await decodeHnsControlObservationResultV2Bytes(resultBytes, value.request)).result,
    hsdCalls,
    dnsCalls,
  };
}

describe("HNS owner-authority custody runtime", () => {
  test("derives Pirate custody after the stable bracket and performs no DNS exchange", async () => {
    const value = await fixture();
    const hsdCalls: string[] = [];
    let dnsCalls = 0;
    let finalized = 0;
    const observer = makeHnsOwnerAuthoritativeDnsTargetObserverV2({
      configuration_resolver: { resolve: async () => value.configurationBytes },
      capabilities: {
        provider_id: "hns.owner.v1",
        environment: "test",
        chain_driver_reference: value.configuration.chain.driver_reference,
        authoritative_dns_driver_reference:
          value.configuration.authoritative_dns?.driver_reference ?? null,
        snapshot_store_reference: value.configuration.snapshot_store_reference,
        authority_inventory_registry_reference:
          value.configuration.authority_inventory?.registry_reference ?? "",
        authority_inventory_runtime_capability_set_digest: value.capabilitySetDigest,
      },
      authority_inventory_resolver: {
        resolve: async () => ({
          authority_inventory_reference: value.inventory.authority_inventory_reference,
          authority_inventory_version: value.inventory.authority_inventory_version,
          authority_inventory_digest: value.inventoryDigest,
          inventory_bytes: value.inventoryBytes,
        }),
      },
      snapshot_store: {
        reserve: async () => ({
          kind: "acquired",
          observer_fence: 1,
          reservation_database_time: databaseTime,
          lease_expires_at: "2026-02-02T03:04:20.000Z",
          snapshot_reference: "hns-observer:regtest:custody-ineligible-01",
        }),
        finalize: async (input) => {
          finalized += 1;
          expect(input.transcript).toHaveLength(7);
          expect(input.authority_inventory_bytes).toEqual(value.inventoryBytes);
          return {
            kind: "retained",
            snapshot_reference: input.snapshot_reference,
            result_bytes: input.result_bytes,
            result_sha256: input.result_sha256,
          };
        },
      },
      hsd_transport: hsdTransport(hsdCalls),
      authoritative_dns_transport: {
        exchange: async () => {
          dnsCalls += 1;
          throw new Error("DNS must not run for Pirate-writable authority");
        },
      },
      message_ids: { next_id: () => 1 },
      validator: {
        policy_id: "pirate-hns-authoritative-dns-validator-policy-v1",
        validate: async () => {
          throw new Error("validator must not run for Pirate-writable authority");
        },
      },
    });
    const resultBytes = await observer.observe(
      {
        request: value.request,
        request_bytes: value.requestBytes,
        lease_policy: {
          expected_block_interval_seconds: 600,
          minimum_safe_remaining_blocks: 144,
          expiry_safety_blocks: 144,
          evidence_lease_seconds: 2_592_000,
        },
      },
      { deadline_ms: 12_000, signal: new AbortController().signal },
    );
    const decoded = await decodeHnsControlObservationResultV2Bytes(resultBytes, value.request);
    expect(decoded.result).toMatchObject({
      status: "ineligible",
      reason_code: "owner_authoritative_source_ineligible",
      authority_inventory_digest: value.inventoryDigest,
    });
    expect(hsdCalls).toHaveLength(7);
    expect(dnsCalls).toBe(0);
    expect(finalized).toBe(1);
  });

  test("classifies stale inventory before every HSD and DNS exchange", async () => {
    const value = await fixture(true);
    let hsdCalls = 0;
    let dnsCalls = 0;
    const observer = makeHnsOwnerAuthoritativeDnsTargetObserverV2({
      configuration_resolver: { resolve: async () => value.configurationBytes },
      capabilities: {
        provider_id: "hns.owner.v1",
        environment: "test",
        chain_driver_reference: value.configuration.chain.driver_reference,
        authoritative_dns_driver_reference:
          value.configuration.authoritative_dns?.driver_reference ?? null,
        snapshot_store_reference: value.configuration.snapshot_store_reference,
        authority_inventory_registry_reference:
          value.configuration.authority_inventory?.registry_reference ?? "",
        authority_inventory_runtime_capability_set_digest: value.capabilitySetDigest,
      },
      authority_inventory_resolver: {
        resolve: async () => ({
          authority_inventory_reference: value.inventory.authority_inventory_reference,
          authority_inventory_version: value.inventory.authority_inventory_version,
          authority_inventory_digest: value.inventoryDigest,
          inventory_bytes: value.inventoryBytes,
        }),
      },
      snapshot_store: {
        reserve: async () => ({
          kind: "acquired",
          observer_fence: 1,
          reservation_database_time: databaseTime,
          lease_expires_at: "2026-02-02T03:04:20.000Z",
          snapshot_reference: "hns-observer:regtest:custody-stale-01",
        }),
        finalize: async (input) => ({
          kind: "retained",
          snapshot_reference: input.snapshot_reference,
          result_bytes: input.result_bytes,
          result_sha256: input.result_sha256,
        }),
      },
      hsd_transport: {
        exchange: async () => {
          hsdCalls += 1;
          throw new Error("HSD must not run for stale inventory");
        },
      },
      authoritative_dns_transport: {
        exchange: async () => {
          dnsCalls += 1;
          throw new Error("DNS must not run for stale inventory");
        },
      },
      message_ids: { next_id: () => 1 },
      validator: {
        policy_id: "pirate-hns-authoritative-dns-validator-policy-v1",
        validate: async () => {
          throw new Error("validator must not run for stale inventory");
        },
      },
    });
    const resultBytes = await observer.observe(
      {
        request: value.request,
        request_bytes: value.requestBytes,
        lease_policy: {
          expected_block_interval_seconds: 600,
          minimum_safe_remaining_blocks: 144,
          expiry_safety_blocks: 144,
          evidence_lease_seconds: 2_592_000,
        },
      },
      { deadline_ms: 12_000, signal: new AbortController().signal },
    );
    const decoded = await decodeHnsControlObservationResultV2Bytes(resultBytes, value.request);
    expect(decoded.result).toMatchObject({
      status: "unavailable",
      reason_code: "authority_inventory_unavailable",
    });
    expect(hsdCalls).toBe(0);
    expect(dnsCalls).toBe(0);
  });

  test("rejects each resolver tuple mismatch before HSD or DNS", async () => {
    const hostileCases = [
      {
        name: "reference",
        resolve: (value: Awaited<ReturnType<typeof fixture>>) => ({
          authority_inventory_reference: "authority-inventory:wrong",
          authority_inventory_version: value.inventory.authority_inventory_version,
          authority_inventory_digest: value.inventoryDigest,
          inventory_bytes: value.inventoryBytes,
        }),
      },
      {
        name: "version",
        resolve: (value: Awaited<ReturnType<typeof fixture>>) => ({
          authority_inventory_reference: value.inventory.authority_inventory_reference,
          authority_inventory_version: "authority-inventory-v1-wrong",
          authority_inventory_digest: value.inventoryDigest,
          inventory_bytes: value.inventoryBytes,
        }),
      },
      {
        name: "digest",
        resolve: (value: Awaited<ReturnType<typeof fixture>>) => ({
          authority_inventory_reference: value.inventory.authority_inventory_reference,
          authority_inventory_version: value.inventory.authority_inventory_version,
          authority_inventory_digest: "f".repeat(
            64,
          ) as HnsAuthorityInventoryResolvedV1["authority_inventory_digest"],
          inventory_bytes: value.inventoryBytes,
        }),
      },
      {
        name: "bytes",
        resolve: (value: Awaited<ReturnType<typeof fixture>>) => ({
          authority_inventory_reference: value.inventory.authority_inventory_reference,
          authority_inventory_version: value.inventory.authority_inventory_version,
          authority_inventory_digest: value.inventoryDigest,
          inventory_bytes: value.inventoryBytes.slice(0, -1),
        }),
      },
    ] as const;

    for (const hostileCase of hostileCases) {
      const value = await fixture();
      const outcome = await observeInventoryFailure(value, hostileCase.resolve(value));
      expect(outcome.result, hostileCase.name).toMatchObject({
        status: "unavailable",
        reason_code: "authority_inventory_unavailable",
      });
      expect(outcome.hsdCalls, hostileCase.name).toHaveLength(0);
      expect(outcome.dnsCalls, hostileCase.name).toBe(0);
    }
  });
});
