import { describe, expect, test } from "bun:test";
import {
  decodeHnsControlObservationResultBytes,
  decodeHnsControlObserverConfigurationBytes,
  encodeHnsControlObservationRequest,
  type HnsControlObserverConfigurationV1,
  HnsControlObserverHsdTransportError,
  type HnsControlObserverHsdTransportPort,
  type HnsControlObserverSnapshotFinalizeInput,
  type HnsControlObserverSnapshotStorePort,
  type HnsEvidenceLeasePolicy,
  hnsControlObservationRequestHash,
} from "@pirate/application/namespace-ownership";
import {
  HnsParentChainObserverError,
  makeHnsParentChainTargetObserver,
  observeHnsParentChain,
} from "./hsd-parent-chain-observer.ts";

const encoder = new TextEncoder();
const databaseTime = "2026-02-02T03:04:05.000Z";
const databaseSeconds = Math.floor(Date.parse(databaseTime) / 1_000);
const genesisHash = "2".repeat(64);
const anchorHash = "3".repeat(64);
const snapshotReference = "hns-observer:regtest:parent-01";
const leasePolicy = {
  expected_block_interval_seconds: 600,
  minimum_safe_remaining_blocks: 144,
  expiry_safety_blocks: 144,
  evidence_lease_seconds: 2_592_000,
} as const;

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
    genesis_block_hash: genesisHash,
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

const requestValue = {
  version: "pirate-hns-control-observation-request-v1",
  observation_id: "observer-parent-hsd-01",
  provider_id: "hns.owner.v1",
  provider_configuration_reference: "hns-observer-regtest",
  provider_configuration_version: "hns-observer-config-v1",
  provider_configuration_digest: "1".repeat(64),
  environment: "test",
  ownership_source: "hns_parent_chain_txt",
  root_label: "jazleeuw",
  txt_name: "jazleeuw",
  expected_txt_value: "pirate-verification=nvs_01",
} as const;

function rpc(result: unknown): Uint8Array {
  return encoder.encode(JSON.stringify({ result, error: null, id: null }));
}

function rpcError(code: number): Uint8Array {
  return encoder.encode(
    JSON.stringify({ result: null, error: { message: "rpc error", code }, id: null }),
  );
}

type ScriptOverrides = Readonly<{
  root?: "active" | "absent" | "inactive";
  records?: ReadonlyArray<unknown>;
  changedAnchor?: boolean;
  stale?: boolean;
  unsynchronized?: boolean;
  contentType?: string | null;
  status?: number;
  rpcErrorCode?: number;
  throwAt?: number;
  abortAt?: number;
  bomAt?: number;
  duplicateEnvelopeAt?: number;
}>;

function hsdScript(overrides: ScriptOverrides = {}) {
  const requests: string[] = [];
  let chainInfoCalls = 0;
  let exchangeCalls = 0;
  const transport: HnsControlObserverHsdTransportPort = {
    exchange: async (input) => {
      exchangeCalls += 1;
      requests.push(new TextDecoder().decode(input.request_bytes));
      if (overrides.abortAt === exchangeCalls) {
        throw new HnsControlObserverHsdTransportError("aborted");
      }
      if (overrides.throwAt === exchangeCalls) {
        throw new HnsControlObserverHsdTransportError("timeout");
      }
      if (overrides.rpcErrorCode !== undefined && exchangeCalls === 1) {
        return {
          status: 200,
          content_type: "application/json",
          response_bytes: rpcError(overrides.rpcErrorCode),
        };
      }
      let result: unknown;
      switch (input.method) {
        case "getblockchaininfo": {
          chainInfoCalls += 1;
          const changed = overrides.changedAnchor === true && chainInfoCalls === 2;
          result = {
            chain: "regtest",
            blocks: changed ? 123_457 : 123_456,
            headers: overrides.unsynchronized === true ? 123_457 : changed ? 123_457 : 123_456,
            bestblockhash: changed ? "4".repeat(64) : anchorHash,
            mediantime: databaseSeconds - 60,
            verificationprogress: 1,
          };
          break;
        }
        case "getblockheader": {
          const body = JSON.parse(new TextDecoder().decode(input.request_bytes)) as {
            params: [string, boolean];
          };
          if (body.params[0] === genesisHash) {
            result = { hash: genesisHash, height: 0 };
          } else {
            const changed = body.params[0] === "4".repeat(64);
            result = {
              hash: body.params[0],
              height: changed ? 123_457 : 123_456,
              time: overrides.stale === true ? databaseSeconds - 3_601 : databaseSeconds - 30,
              mediantime: databaseSeconds - 60,
              confirmations: 1,
            };
          }
          break;
        }
        case "getnameinfo":
          result = {
            info:
              overrides.root === "absent"
                ? null
                : overrides.root === "inactive"
                  ? { state: "REVOKED", registered: false, expired: true }
                  : {
                      state: "CLOSED",
                      registered: true,
                      expired: false,
                      stats: {
                        renewalPeriodEnd: 200_000,
                        blocksUntilExpire: 76_544,
                      },
                    },
          };
          break;
        case "getnameresource":
          result = {
            records: overrides.records ?? [
              { type: "NS", ns: "ns1.jazleeuw." },
              { type: "TXT", txt: ["pirate-verification=", "nvs_01"] },
              { type: "GLUE4", ns: "ns1.jazleeuw.", address: "192.0.2.53" },
              { type: "GLUE6", ns: "ns1.jazleeuw.", address: "2001:db8::53" },
              { type: "SYNTH4", address: "192.0.2.54" },
              { type: "SYNTH6", address: "2001:db8::54" },
              { type: "DS", keyTag: 12_345, algorithm: 13, digestType: 2, digest: "aabb" },
            ],
          };
          break;
      }
      const responseBytes =
        overrides.duplicateEnvelopeAt === exchangeCalls
          ? encoder.encode(
              `{"result":${JSON.stringify(result)},"result":${JSON.stringify(result)},"error":null,"id":null}`,
            )
          : rpc(result);
      const retainedBytes =
        overrides.bomAt === exchangeCalls
          ? Uint8Array.from([0xef, 0xbb, 0xbf, ...responseBytes])
          : responseBytes;
      return {
        status: overrides.status ?? 200,
        content_type:
          overrides.contentType === undefined ? "application/json" : overrides.contentType,
        response_bytes: retainedBytes,
      };
    },
  };
  return { transport, requests };
}

async function observe(
  overrides: ScriptOverrides = {},
  configurationOverrides: Partial<HnsControlObserverConfigurationV1["chain"]> = {},
) {
  const script = hsdScript(overrides);
  const configuration = {
    ...configurationValue,
    chain: { ...configurationValue.chain, ...configurationOverrides },
  };
  const result = await observeHnsParentChain({
    request: requestValue,
    request_sha256: await hnsControlObservationRequestHash(requestValue),
    configuration,
    reservation_database_time: databaseTime,
    snapshot_reference: snapshotReference,
    transport: script.transport,
    signal: new AbortController().signal,
  });
  return { result, requests: script.requests };
}

describe("HNS parent-chain HSD observer", () => {
  test("uses the exact stable source-closed RPC sequence and verifies chunked TXT", async () => {
    const observed = await observe();
    const decoded = await decodeHnsControlObservationResultBytes(
      observed.result.result_bytes,
      requestValue,
    );
    expect(decoded.result).toMatchObject({
      status: "verified",
      provider_evidence_ref: snapshotReference,
      chain_anchor_height: 123_456,
      chain_anchor_block_hash: anchorHash,
      expiry_height: 200_000,
    });
    expect(observed.result.transcript).toHaveLength(7);
    expect(observed.requests).toEqual([
      '{"method":"getblockchaininfo","params":[]}',
      `{"method":"getblockheader","params":["${anchorHash}",true]}`,
      `{"method":"getblockheader","params":["${genesisHash}",true]}`,
      '{"method":"getnameinfo","params":["jazleeuw",false]}',
      '{"method":"getnameresource","params":["jazleeuw",false]}',
      '{"method":"getblockchaininfo","params":[]}',
      `{"method":"getblockheader","params":["${anchorHash}",true]}`,
    ]);
  });

  test("produces only stable root and TXT negatives", async () => {
    for (const [overrides, expected] of [
      [{ root: "absent" }, "root_absent"],
      [{ root: "inactive" }, "root_inactive"],
      [{ records: [{ type: "NS", ns: "ns1.jazleeuw." }] }, "txt_absent"],
      [{ records: [{ type: "TXT", txt: ["pirate-verification=other"] }] }, "txt_value_mismatch"],
    ] as const) {
      const observed = await observe(overrides);
      const decoded = await decodeHnsControlObservationResultBytes(
        observed.result.result_bytes,
        requestValue,
      );
      expect(decoded.result).toMatchObject({ status: "rejected", reason_code: expected });
    }

    const horizon = await observe({}, { minimum_safe_remaining_blocks: 100_000 });
    const horizonResult = await decodeHnsControlObservationResultBytes(
      horizon.result.result_bytes,
      requestValue,
    );
    expect(horizonResult.result).toMatchObject({
      status: "rejected",
      reason_code: "expiry_horizon_insufficient",
    });
  });

  test("maps changing, stale, unsynchronized, malformed, and transport-failed views to unavailable", async () => {
    for (const [overrides, expected] of [
      [{ changedAnchor: true }, "chain_view_changed"],
      [{ stale: true }, "chain_view_stale"],
      [{ unsynchronized: true }, "chain_unsynchronized"],
      [{ contentType: "text/plain" }, "chain_response_invalid"],
      [{ status: 503 }, "chain_transport_unavailable"],
      [{ throwAt: 1 }, "chain_transport_unavailable"],
      [{ bomAt: 1 }, "chain_response_invalid"],
      [{ duplicateEnvelopeAt: 1 }, "chain_response_invalid"],
      [{ records: [{ type: "FUTURE9", payload: true }] }, "chain_response_invalid"],
    ] as const) {
      const observed = await observe(overrides);
      const decoded = await decodeHnsControlObservationResultBytes(
        observed.result.result_bytes,
        requestValue,
      );
      expect(decoded.result).toMatchObject({
        status: "unavailable",
        reason_code: expected,
        diagnostic_ref: snapshotReference,
      });
    }
  });

  test("retains the exact bounded prefix and maps a transport overflow marker to capacity", async () => {
    const responseMaxBytes = 64;
    const observed = await observe({}, { response_max_bytes: responseMaxBytes });
    const decoded = await decodeHnsControlObservationResultBytes(
      observed.result.result_bytes,
      requestValue,
    );
    expect(decoded.result).toMatchObject({
      status: "unavailable",
      reason_code: "observer_capacity",
      diagnostic_ref: snapshotReference,
    });
    expect(observed.result.transcript).toHaveLength(1);
    const retained = observed.result.transcript[0];
    const fullResponse = rpc({
      chain: "regtest",
      blocks: 123_456,
      headers: 123_456,
      bestblockhash: anchorHash,
      mediantime: databaseSeconds - 60,
      verificationprogress: 1,
    });
    const expectedPrefix = fullResponse.slice(0, responseMaxBytes);
    const expectedHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", expectedPrefix)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(retained).toMatchObject({
      method_or_view_id: "getblockchaininfo",
      transport_outcome: "response",
      transport_status: 200,
      response_sha256: expectedHash,
    });
    expect(retained?.response_bytes).toEqual(expectedPrefix);
  });

  test("keeps driver incompatibility and whole-operation abort outside semantic results", async () => {
    await expect(observe({ rpcErrorCode: -32_601 })).rejects.toMatchObject({
      reason: "misconfigured",
    });
    await expect(observe({ abortAt: 1 })).rejects.toMatchObject({
      reason: "transport_unavailable",
    });
  });

  test("stops after a driver returns success only after abort", async () => {
    const controller = new AbortController();
    let exchangeCalls = 0;
    let firstExchangeEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      firstExchangeEntered = resolve;
    });
    const observation = observeHnsParentChain({
      request: requestValue,
      request_sha256: await hnsControlObservationRequestHash(requestValue),
      configuration: configurationValue,
      reservation_database_time: databaseTime,
      snapshot_reference: snapshotReference,
      signal: controller.signal,
      transport: {
        exchange: async ({ signal }) => {
          exchangeCalls += 1;
          firstExchangeEntered?.();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            status: 200,
            content_type: "application/json",
            response_bytes: rpc({
              chain: "regtest",
              blocks: 123_456,
              headers: 123_456,
              bestblockhash: anchorHash,
              mediantime: databaseSeconds - 60,
              verificationprogress: 1,
            }),
          };
        },
      },
    });
    await entered;
    controller.abort();
    await expect(observation).rejects.toMatchObject({ reason: "transport_unavailable" });
    expect(exchangeCalls).toBe(1);
  });

  test("reserves, finalizes, and replays exact snapshot bytes through the injected store", async () => {
    const configurationBytes = encoder.encode(JSON.stringify(configurationValue));
    const decodedConfiguration =
      await decodeHnsControlObserverConfigurationBytes(configurationBytes);
    const request = {
      ...requestValue,
      provider_configuration_digest: decodedConfiguration.configuration_digest,
    };
    const requestBytes = await encodeHnsControlObservationRequest(request);
    let terminal: null | {
      bytes: Uint8Array;
      hash: HnsControlObserverSnapshotFinalizeInput["result_sha256"];
    } = null;
    let reserveCalls = 0;
    let finalizeCalls = 0;
    const store: HnsControlObserverSnapshotStorePort = {
      reserve: async () => {
        reserveCalls += 1;
        return terminal === null
          ? {
              kind: "acquired",
              observer_fence: 1,
              reservation_database_time: databaseTime,
              lease_expires_at: "2026-02-02T03:04:20.000Z",
              snapshot_reference: snapshotReference,
            }
          : {
              kind: "replay",
              snapshot_reference: snapshotReference,
              result_bytes: new Uint8Array(terminal.bytes),
              result_sha256: terminal.hash,
            };
      },
      finalize: async (input) => {
        finalizeCalls += 1;
        expect(input.snapshot_reference).toBe(snapshotReference);
        terminal = { bytes: new Uint8Array(input.result_bytes), hash: input.result_sha256 };
        return {
          kind: "retained",
          snapshot_reference: snapshotReference,
          result_bytes: new Uint8Array(input.result_bytes),
          result_sha256: input.result_sha256,
        };
      },
    };
    const target = makeHnsParentChainTargetObserver({
      configuration_resolver: {
        resolve: async () => new Uint8Array(configurationBytes),
      },
      capabilities: {
        provider_id: "hns.owner.v1",
        environment: "test",
        chain_driver_reference: "hsd-json-rpc:regtest-primary",
        authoritative_dns_driver_reference: null,
        snapshot_store_reference: "postgres:hns-control-observer-v1",
      },
      snapshot_store: store,
      hsd_transport: hsdScript().transport,
    });
    const first = await target.observe(
      { request, request_bytes: requestBytes, lease_policy: leasePolicy },
      { deadline_ms: 12_000, signal: new AbortController().signal },
    );
    const replay = await target.observe(
      { request, request_bytes: requestBytes, lease_policy: leasePolicy },
      { deadline_ms: 12_000, signal: new AbortController().signal },
    );
    expect(replay).toEqual(first);
    expect(reserveCalls).toBe(2);
    expect(finalizeCalls).toBe(1);
  });

  test("maps configuration and snapshot-store failures into closed adapter errors", async () => {
    const configurationBytes = encoder.encode(JSON.stringify(configurationValue));
    const decodedConfiguration =
      await decodeHnsControlObserverConfigurationBytes(configurationBytes);
    const request = {
      ...requestValue,
      provider_configuration_digest: decodedConfiguration.configuration_digest,
    };
    const requestBytes = await encodeHnsControlObservationRequest(request);
    const capabilities = {
      provider_id: "hns.owner.v1",
      environment: "test",
      chain_driver_reference: "hsd-json-rpc:regtest-primary",
      authoritative_dns_driver_reference: null,
      snapshot_store_reference: "postgres:hns-control-observer-v1",
    } as const;
    const noStoreWork: HnsControlObserverSnapshotStorePort = {
      reserve: async () => {
        throw new Error("must not reserve");
      },
      finalize: async () => {
        throw new Error("must not finalize");
      },
    };
    const invoke = (
      target: ReturnType<typeof makeHnsParentChainTargetObserver>,
      selectedLeasePolicy: HnsEvidenceLeasePolicy = leasePolicy,
    ) =>
      target.observe(
        { request, request_bytes: requestBytes, lease_policy: selectedLeasePolicy },
        { deadline_ms: 12_000, signal: new AbortController().signal },
      );

    await expect(
      invoke(
        makeHnsParentChainTargetObserver({
          configuration_resolver: { resolve: async () => null },
          capabilities,
          snapshot_store: noStoreWork,
          hsd_transport: hsdScript().transport,
        }),
      ),
    ).rejects.toMatchObject({ reason: "misconfigured" });
    await expect(
      invoke(
        makeHnsParentChainTargetObserver({
          configuration_resolver: {
            resolve: async () => {
              throw new Error("registry unavailable");
            },
          },
          capabilities,
          snapshot_store: noStoreWork,
          hsd_transport: hsdScript().transport,
        }),
      ),
    ).rejects.toMatchObject({ reason: "transport_unavailable" });
    await expect(
      invoke(
        makeHnsParentChainTargetObserver({
          configuration_resolver: { resolve: async () => configurationBytes },
          capabilities,
          snapshot_store: noStoreWork,
          hsd_transport: hsdScript().transport,
        }),
        { ...leasePolicy, evidence_lease_seconds: leasePolicy.evidence_lease_seconds - 1 },
      ),
    ).rejects.toMatchObject({ reason: "misconfigured" });
    await expect(
      invoke(
        makeHnsParentChainTargetObserver({
          configuration_resolver: { resolve: async () => configurationBytes },
          capabilities,
          snapshot_store: noStoreWork,
          hsd_transport: hsdScript().transport,
        }),
      ),
    ).rejects.toMatchObject({ reason: "transport_unavailable" });

    const acquired = {
      kind: "acquired",
      observer_fence: 1,
      reservation_database_time: databaseTime,
      lease_expires_at: "2026-02-02T03:04:20.000Z",
      snapshot_reference: snapshotReference,
    } as const;
    await expect(
      invoke(
        makeHnsParentChainTargetObserver({
          configuration_resolver: { resolve: async () => configurationBytes },
          capabilities,
          snapshot_store: {
            reserve: async () => acquired,
            finalize: async () => {
              throw new Error("snapshot store unavailable");
            },
          },
          hsd_transport: hsdScript().transport,
        }),
      ),
    ).rejects.toMatchObject({ reason: "transport_unavailable" });
    await expect(
      invoke(
        makeHnsParentChainTargetObserver({
          configuration_resolver: { resolve: async () => configurationBytes },
          capabilities,
          snapshot_store: {
            reserve: async () => ({ ...acquired, snapshot_reference: "invalid reference" }),
            finalize: async () => {
              throw new Error("must not finalize");
            },
          },
          hsd_transport: {
            exchange: async () => {
              throw new Error("must not call HSD");
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_response" });
  });

  test("carries one abort signal through resolution, reservation, and finalization", async () => {
    const configurationBytes = encoder.encode(JSON.stringify(configurationValue));
    const decodedConfiguration =
      await decodeHnsControlObserverConfigurationBytes(configurationBytes);
    const request = {
      ...requestValue,
      provider_configuration_digest: decodedConfiguration.configuration_digest,
    };
    const requestBytes = await encodeHnsControlObservationRequest(request);
    const controller = new AbortController();
    let finalizationEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      finalizationEntered = resolve;
    });
    let committed = 0;
    let finalizationAborted = 0;
    const target = makeHnsParentChainTargetObserver({
      configuration_resolver: {
        resolve: async (_identity, options) => {
          expect(options.deadline_ms).toBe(12_000);
          expect(options.signal).toBe(controller.signal);
          return configurationBytes;
        },
      },
      capabilities: {
        provider_id: "hns.owner.v1",
        environment: "test",
        chain_driver_reference: "hsd-json-rpc:regtest-primary",
        authoritative_dns_driver_reference: null,
        snapshot_store_reference: "postgres:hns-control-observer-v1",
      },
      snapshot_store: {
        reserve: async (_input, options) => {
          expect(options.deadline_ms).toBe(12_000);
          expect(options.signal).toBe(controller.signal);
          return {
            kind: "acquired",
            observer_fence: 1,
            reservation_database_time: databaseTime,
            lease_expires_at: "2026-02-02T03:04:20.000Z",
            snapshot_reference: snapshotReference,
          };
        },
        finalize: (input, options) => {
          expect(options.deadline_ms).toBe(12_000);
          expect(options.signal).toBe(controller.signal);
          finalizationEntered?.();
          return new Promise((resolve, reject) => {
            const lateCommit = setTimeout(() => {
              committed += 1;
              resolve({
                kind: "retained",
                snapshot_reference: input.snapshot_reference,
                result_bytes: input.result_bytes,
                result_sha256: input.result_sha256,
              });
            }, 20);
            const aborted = () => {
              clearTimeout(lateCommit);
              finalizationAborted += 1;
              reject(new Error("finalization aborted"));
            };
            if (options.signal.aborted) aborted();
            else options.signal.addEventListener("abort", aborted, { once: true });
          });
        },
      },
      hsd_transport: hsdScript().transport,
    });
    const observation = target.observe(
      { request, request_bytes: requestBytes, lease_policy: leasePolicy },
      { deadline_ms: 12_000, signal: controller.signal },
    );
    await entered;
    controller.abort();
    await expect(observation).rejects.toMatchObject({ reason: "transport_unavailable" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(finalizationAborted).toBe(1);
    expect(committed).toBe(0);
  });

  test("rejects a projection/body mismatch before configuration or driver work", async () => {
    const target = makeHnsParentChainTargetObserver({
      configuration_resolver: { resolve: async () => null },
      capabilities: {
        provider_id: "hns.owner.v1",
        environment: "test",
        chain_driver_reference: "hsd-json-rpc:regtest-primary",
        authoritative_dns_driver_reference: null,
        snapshot_store_reference: "postgres:hns-control-observer-v1",
      },
      snapshot_store: {
        reserve: async () => {
          throw new Error("must not reserve");
        },
        finalize: async () => {
          throw new Error("must not finalize");
        },
      },
      hsd_transport: {
        exchange: async () => {
          throw new Error("must not call HSD");
        },
      },
    });
    const requestBytes = await encodeHnsControlObservationRequest(requestValue);
    await expect(
      target.observe(
        {
          request: { ...requestValue, root_label: "pirate", txt_name: "pirate" },
          request_bytes: requestBytes,
          lease_policy: leasePolicy,
        },
        { deadline_ms: 12_000, signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(HnsParentChainObserverError);
  });
});
