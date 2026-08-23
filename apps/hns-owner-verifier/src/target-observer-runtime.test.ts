import { describe, expect, test } from "bun:test";
import {
  decodeHnsControlObservationResultBytes,
  encodeHnsControlObservationRequest,
  encodeHnsControlObserverConfiguration,
  type HnsControlObserverConfigurationResolverPort,
  HnsControlObserverHsdTransportError,
  type HnsControlObserverSnapshotFinalizeInput,
  type HnsControlObserverSnapshotStorePort,
} from "@pirate/application/namespace-ownership";
import { makeHnsParentChainTargetObserverRuntime } from "./target-observer-runtime.ts";

const configurationValue = {
  version: "pirate-hns-control-observer-configuration-v1",
  provider_id: "hns.owner.v1",
  provider_configuration_reference: "hns-observer-regtest",
  provider_configuration_version: "hns-observer-config-v1",
  environment: "test",
  ownership_sources: ["hns_parent_chain_txt"],
  chain: {
    driver_reference: "hsd-json-rpc:regtest-primary",
    network: "regtest",
    genesis_block_hash: "2".repeat(64),
    minimum_verification_progress_millionths: 999_000,
    maximum_tip_age_seconds: 3_600,
    maximum_future_tip_seconds: 7_200,
    expected_block_interval_seconds: 600,
    minimum_safe_remaining_blocks: 144,
    expiry_safety_blocks: 144,
    response_max_bytes: 1_048_576,
  },
  authoritative_dns: null,
  evidence_lease_seconds: 2_592_000,
  observer_deadline_ms: 12_000,
  observer_reservation_lease_seconds: 15,
  snapshot_store_reference: "postgres:hns-control-observer-v1",
} as const;

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function fixture() {
  const configurationBytes = await encodeHnsControlObserverConfiguration(configurationValue);
  const configurationDigest = await sha256(configurationBytes);
  const authority = {
    provider_id: "hns.owner.v1",
    provider_configuration_reference: configurationValue.provider_configuration_reference,
    provider_configuration_version: configurationValue.provider_configuration_version,
    provider_configuration_digest: configurationDigest as `${string}`,
    environment: configurationValue.environment,
    ownership_source: "hns_parent_chain_txt",
  } as const;
  const capabilities = {
    provider_id: "hns.owner.v1",
    environment: "test",
    chain_driver_reference: configurationValue.chain.driver_reference,
    authoritative_dns_driver_reference: null,
    snapshot_store_reference: configurationValue.snapshot_store_reference,
  } as const;
  return { authority, capabilities, configurationBytes, configurationDigest };
}

describe("HNS parent-chain target-observer runtime composition", () => {
  test("derives runtime authority from immutable configuration and wires every injected port", async () => {
    const { authority, capabilities, configurationBytes, configurationDigest } = await fixture();
    let resolutionCalls = 0;
    const resolver: HnsControlObserverConfigurationResolverPort = {
      resolve: async () => {
        resolutionCalls += 1;
        return new Uint8Array(configurationBytes);
      },
    };
    let reserved = 0;
    let finalized: HnsControlObserverSnapshotFinalizeInput | undefined;
    const snapshotStore: HnsControlObserverSnapshotStorePort = {
      reserve: async () => {
        reserved += 1;
        return {
          kind: "acquired",
          observer_fence: 1,
          reservation_database_time: "2026-02-02T03:04:05.000Z",
          lease_expires_at: "2026-02-02T03:04:20.000Z",
          snapshot_reference: "hns-observer:regtest:runtime-01",
        };
      },
      finalize: async (input) => {
        finalized = input;
        return {
          kind: "retained",
          snapshot_reference: input.snapshot_reference,
          result_bytes: new Uint8Array(input.result_bytes),
          result_sha256: input.result_sha256,
        };
      },
    };
    let hsdCalls = 0;
    const runtime = await makeHnsParentChainTargetObserverRuntime(
      {
        authority,
        capabilities,
        configuration_resolver: resolver,
        snapshot_store: snapshotStore,
        hsd_transport: {
          exchange: async () => {
            hsdCalls += 1;
            throw new HnsControlObserverHsdTransportError("transport_error");
          },
        },
      },
      { deadline_ms: 12_000, signal: new AbortController().signal },
    );
    expect(runtime.configuration).toEqual({
      provider_id: "hns.owner.v1",
      provider_configuration_reference: "hns-observer-regtest",
      provider_configuration_version: "hns-observer-config-v1",
      provider_configuration_digest: configurationDigest,
      environment: "test",
      ownership_source: "hns_parent_chain_txt",
      observer_deadline_ms: 12_000,
      lease_policy: {
        expected_block_interval_seconds: 600,
        minimum_safe_remaining_blocks: 144,
        expiry_safety_blocks: 144,
        evidence_lease_seconds: 2_592_000,
      },
    });
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.configuration)).toBe(true);
    expect(Object.isFrozen(runtime.configuration.lease_policy)).toBe(true);
    expect(Object.isFrozen(runtime.observer)).toBe(true);

    const request = {
      version: "pirate-hns-control-observation-request-v1",
      observation_id: "runtime-observation-01",
      provider_id: "hns.owner.v1",
      provider_configuration_reference: "hns-observer-regtest",
      provider_configuration_version: "hns-observer-config-v1",
      provider_configuration_digest: configurationDigest,
      environment: "test",
      ownership_source: "hns_parent_chain_txt",
      root_label: "jazleeuw",
      txt_name: "jazleeuw",
      expected_txt_value: "pirate-verification=nvs_01",
    } as const;
    const requestBytes = await encodeHnsControlObservationRequest(request);
    const resultBytes = await runtime.observer.observe(
      {
        request,
        request_bytes: requestBytes,
        lease_policy: runtime.configuration.lease_policy,
      },
      { deadline_ms: 12_000, signal: new AbortController().signal },
    );
    const decoded = await decodeHnsControlObservationResultBytes(resultBytes, request);
    expect(decoded.result).toMatchObject({
      status: "unavailable",
      reason_code: "chain_transport_unavailable",
      diagnostic_ref: "hns-observer:regtest:runtime-01",
    });
    expect(resolutionCalls).toBe(1);
    expect(reserved).toBe(1);
    expect(hsdCalls).toBe(1);
    expect(finalized?.transcript).toHaveLength(1);
    expect(finalized?.transcript[0]).toMatchObject({
      driver_reference: "hsd-json-rpc:regtest-primary",
      method_or_view_id: "getblockchaininfo",
      transport_outcome: "transport_error",
      transport_status: null,
      response_bytes: null,
    });
  });

  test("pins runtime authority and rejects a later request for changed configuration bytes", async () => {
    const { authority, capabilities, configurationBytes } = await fixture();
    const driftedConfigurationBytes = await encodeHnsControlObserverConfiguration({
      ...configurationValue,
      evidence_lease_seconds: configurationValue.evidence_lease_seconds - 1,
    });
    const driftedConfigurationDigest = await sha256(driftedConfigurationBytes);
    let resolverCalls = 0;
    let storeCalls = 0;
    let hsdCalls = 0;
    const runtime = await makeHnsParentChainTargetObserverRuntime(
      {
        authority,
        capabilities,
        configuration_resolver: {
          resolve: async () => {
            resolverCalls += 1;
            return resolverCalls === 1
              ? new Uint8Array(configurationBytes)
              : new Uint8Array(driftedConfigurationBytes);
          },
        },
        snapshot_store: {
          reserve: async () => {
            storeCalls += 1;
            return { kind: "mismatch" };
          },
          finalize: async () => {
            storeCalls += 1;
            return { kind: "lost" };
          },
        },
        hsd_transport: {
          exchange: async () => {
            hsdCalls += 1;
            throw new Error("must not reach HSD");
          },
        },
      },
      { deadline_ms: 12_000, signal: new AbortController().signal },
    );
    const driftedRequest = {
      version: "pirate-hns-control-observation-request-v1",
      observation_id: "runtime-observation-drift-01",
      provider_id: "hns.owner.v1",
      provider_configuration_reference: "hns-observer-regtest",
      provider_configuration_version: "hns-observer-config-v1",
      provider_configuration_digest: driftedConfigurationDigest,
      environment: "test",
      ownership_source: "hns_parent_chain_txt",
      root_label: "jazleeuw",
      txt_name: "jazleeuw",
      expected_txt_value: "pirate-verification=nvs_drift",
    } as const;
    await expect(
      runtime.observer.observe(
        {
          request: driftedRequest,
          request_bytes: await encodeHnsControlObservationRequest(driftedRequest),
          lease_policy: {
            ...runtime.configuration.lease_policy,
            evidence_lease_seconds: configurationValue.evidence_lease_seconds - 1,
          },
        },
        { deadline_ms: 12_000, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ reason: "misconfigured" });
    expect(resolverCalls).toBe(1);
    expect(storeCalls).toBe(0);
    expect(hsdCalls).toBe(0);
  });

  test("rejects capability, deadline, and abort drift before store or HSD work", async () => {
    const { authority, capabilities, configurationBytes } = await fixture();
    let resolverCalls = 0;
    let storeCalls = 0;
    let hsdCalls = 0;
    const resolver: HnsControlObserverConfigurationResolverPort = {
      resolve: async () => {
        resolverCalls += 1;
        return new Uint8Array(configurationBytes);
      },
    };
    const snapshotStore: HnsControlObserverSnapshotStorePort = {
      reserve: async () => {
        storeCalls += 1;
        return { kind: "mismatch" };
      },
      finalize: async () => {
        storeCalls += 1;
        return { kind: "lost" };
      },
    };
    await expect(
      makeHnsParentChainTargetObserverRuntime(
        {
          authority,
          capabilities: { ...capabilities, environment: "other" },
          configuration_resolver: resolver,
          snapshot_store: snapshotStore,
          hsd_transport: {
            exchange: async () => {
              hsdCalls += 1;
              throw new Error("not reached");
            },
          },
        },
        { deadline_ms: 12_000, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ reason: "misconfigured" });
    expect(resolverCalls).toBe(1);
    expect(storeCalls).toBe(0);
    expect(hsdCalls).toBe(0);

    for (const mismatchedCapabilities of [
      { ...capabilities, provider_id: "other" as "hns.owner.v1" },
      { ...capabilities, snapshot_store_reference: "postgres:other-observer" },
      { ...capabilities, authoritative_dns_driver_reference: "dns:unexpected" },
    ]) {
      await expect(
        makeHnsParentChainTargetObserverRuntime(
          {
            authority,
            capabilities: mismatchedCapabilities,
            configuration_resolver: resolver,
            snapshot_store: snapshotStore,
            hsd_transport: {
              exchange: async () => {
                hsdCalls += 1;
                throw new Error("not reached");
              },
            },
          },
          { deadline_ms: 12_000, signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ reason: "misconfigured" });
    }
    expect(resolverCalls).toBe(4);
    expect(storeCalls).toBe(0);
    expect(hsdCalls).toBe(0);

    await expect(
      makeHnsParentChainTargetObserverRuntime(
        {
          authority,
          capabilities,
          configuration_resolver: resolver,
          snapshot_store: snapshotStore,
          hsd_transport: {
            exchange: async () => {
              hsdCalls += 1;
              throw new Error("not reached");
            },
          },
        },
        { deadline_ms: 11_999, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ reason: "misconfigured" });
    expect(resolverCalls).toBe(5);

    const controller = new AbortController();
    controller.abort();
    await expect(
      makeHnsParentChainTargetObserverRuntime(
        {
          authority,
          capabilities,
          configuration_resolver: resolver,
          snapshot_store: snapshotStore,
          hsd_transport: {
            exchange: async () => {
              hsdCalls += 1;
              throw new Error("not reached");
            },
          },
        },
        { deadline_ms: 12_000, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ reason: "transport_unavailable" });
    expect(resolverCalls).toBe(5);
    expect(storeCalls).toBe(0);
    expect(hsdCalls).toBe(0);

    const duringResolution = new AbortController();
    await expect(
      makeHnsParentChainTargetObserverRuntime(
        {
          authority,
          capabilities,
          configuration_resolver: {
            resolve: async () => {
              duringResolution.abort();
              return new Uint8Array(configurationBytes);
            },
          },
          snapshot_store: snapshotStore,
          hsd_transport: {
            exchange: async () => {
              hsdCalls += 1;
              throw new Error("not reached");
            },
          },
        },
        { deadline_ms: 12_000, signal: duringResolution.signal },
      ),
    ).rejects.toMatchObject({ reason: "transport_unavailable" });
    expect(storeCalls).toBe(0);
    expect(hsdCalls).toBe(0);
  });
});
