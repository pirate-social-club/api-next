import { describe, expect, test } from "bun:test";
import {
  decodeHnsAuthoritativeDnsSemanticFactsV1,
  decodeHnsControlObservationResultBytes,
  type HnsAuthoritativeDnsExchangeInputV1,
  HnsAuthoritativeDnsTransportErrorV1,
  type HnsControlObservationRequestV1,
  type HnsControlObserverConfigurationV1,
  type HnsControlObserverHsdTransportPort,
  hnsControlObservationRequestHash,
} from "@pirate/application/namespace-ownership";
import { observeHnsOwnerAuthoritativeDnsSource } from "./owner-authoritative-source-observer.ts";

type Sha256HexValue = HnsAuthoritativeDnsExchangeInputV1["chain_authority_digest"];

const encoder = new TextEncoder();
const databaseTime = "2026-02-02T03:04:05.000Z";
const databaseSeconds = Math.floor(Date.parse(databaseTime) / 1_000);
const genesisHash = "2".repeat(64) as Sha256HexValue;
const anchorHash = "3".repeat(64) as Sha256HexValue;
const configurationDigest = "1".repeat(64) as Sha256HexValue;

const request: HnsControlObservationRequestV1 = {
  version: "pirate-hns-control-observation-request-v1",
  observation_id: "owner-source-observation-1",
  provider_id: "hns.owner.v1",
  provider_configuration_reference: "hns-observer-regtest-config-fixture",
  provider_configuration_version: "hns-observer-config-v1",
  provider_configuration_digest: configurationDigest,
  environment: "test",
  ownership_source: "owner_authoritative_dns_txt",
  root_label: "jazleeuw",
  txt_name: "_pirate.jazleeuw",
  expected_txt_value: "pirate=expected",
};

const configuration: HnsControlObserverConfigurationV1 = {
  version: "pirate-hns-control-observer-configuration-v1",
  provider_id: "hns.owner.v1",
  provider_configuration_reference: request.provider_configuration_reference,
  provider_configuration_version: request.provider_configuration_version,
  environment: request.environment,
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
  evidence_lease_seconds: 2_592_000,
  observer_deadline_ms: 12_000,
  observer_reservation_lease_seconds: 15,
  snapshot_store_reference: "postgres:hns-control-observer-v1",
};

function rpc(result: unknown): Uint8Array {
  return encoder.encode(JSON.stringify({ result, error: null, id: null }));
}

function hsdTransport(input: {
  readonly requests: string[];
  readonly root?: "active" | "absent" | "inactive";
  readonly expiry_height?: number;
}): HnsControlObserverHsdTransportPort {
  return {
    exchange: async (exchange) => {
      input.requests.push(new TextDecoder().decode(exchange.request_bytes));
      const body = JSON.parse(new TextDecoder().decode(exchange.request_bytes)) as {
        method: string;
        params: unknown[];
      };
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
        case "getnameinfo": {
          const expiryHeight = input.expiry_height ?? 200_000;
          result = {
            info:
              input.root === "absent"
                ? null
                : input.root === "inactive"
                  ? { state: "REVOKED", registered: false, expired: true }
                  : {
                      state: "CLOSED",
                      registered: true,
                      expired: false,
                      stats: {
                        renewalPeriodEnd: expiryHeight,
                        blocksUntilExpire: expiryHeight - 123_456,
                      },
                    },
          };
          break;
        }
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

function uint16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function record(type: number, rdata: Uint8Array): Uint8Array {
  return concatBytes([
    new Uint8Array([0xc0, 0x0c]),
    uint16(type),
    uint16(1),
    new Uint8Array([0, 0, 1, 44]),
    uint16(rdata.byteLength),
    rdata,
  ]);
}

function signature(type: number): Uint8Array {
  const rdata = new Uint8Array(18);
  rdata.set(uint16(type));
  return record(46, rdata);
}

function dnsResponse(requestBytes: Uint8Array, answers: ReadonlyArray<Uint8Array>): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = requestBytes[0] ?? 0;
  header[1] = requestBytes[1] ?? 0;
  header.set(uint16(0x8400), 2);
  header.set(uint16(1), 4);
  header.set(uint16(answers.length), 6);
  header.set(uint16(1), 10);
  return concatBytes([
    header,
    requestBytes.subarray(12, requestBytes.byteLength - 11),
    ...answers,
    requestBytes.subarray(requestBytes.byteLength - 11),
  ]);
}

function dnsServfailResponse(requestBytes: Uint8Array): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = requestBytes[0] ?? 0;
  header[1] = requestBytes[1] ?? 0;
  header.set(uint16(0x8402), 2);
  header.set(uint16(1), 4);
  header.set(uint16(1), 10);
  return concatBytes([
    header,
    requestBytes.subarray(12, requestBytes.byteLength - 11),
    requestBytes.subarray(requestBytes.byteLength - 11),
  ]);
}

async function sha256(bytes: Uint8Array): Promise<Sha256HexValue> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("") as Sha256HexValue;
}

async function observe(
  input: {
    readonly root?: "active" | "absent" | "inactive";
    readonly expiry_height?: number;
    readonly required_view_ids?: ReadonlyArray<string>;
    readonly dns_failure?: "timeout" | "servfail" | "capacity";
    readonly dns_failure_view?: string;
  } = {},
) {
  const hsdRequests: string[] = [];
  const dnsCalls: HnsAuthoritativeDnsExchangeInputV1[] = [];
  let nextId = 1;
  const dnsConfiguration = configuration.authoritative_dns;
  if (dnsConfiguration === null) throw new Error("owner fixture lacks DNS configuration");
  const observedConfiguration =
    input.required_view_ids === undefined
      ? configuration
      : {
          ...configuration,
          authoritative_dns: {
            ...dnsConfiguration,
            required_view_ids: input.required_view_ids,
          },
        };
  const result = await observeHnsOwnerAuthoritativeDnsSource({
    request,
    request_sha256: await hnsControlObservationRequestHash(request),
    configuration: observedConfiguration,
    configuration_digest: configurationDigest,
    reservation_database_time: databaseTime,
    snapshot_reference: "hns-observer:regtest:owner-source-1",
    hsd_transport: hsdTransport({
      requests: hsdRequests,
      ...(input.root === undefined ? {} : { root: input.root }),
      ...(input.expiry_height === undefined ? {} : { expiry_height: input.expiry_height }),
    }),
    message_ids: { next_id: () => nextId++ },
    authoritative_dns_transport: {
      exchange: async (exchange) => {
        dnsCalls.push(exchange);
        if (
          input.dns_failure !== undefined &&
          (input.dns_failure_view === undefined || input.dns_failure_view === exchange.view_id)
        ) {
          if (input.dns_failure === "timeout") {
            throw new HnsAuthoritativeDnsTransportErrorV1("timeout");
          }
          if (input.dns_failure === "servfail") {
            return dnsServfailResponse(exchange.request_bytes);
          }
          return new Uint8Array(
            (observedConfiguration.authoritative_dns?.response_max_bytes ?? 65_535) + 1,
          );
        }
        if (exchange.query_kind === "dnskey") {
          return dnsResponse(exchange.request_bytes, [
            record(48, new Uint8Array([1, 3, 13, 1])),
            signature(48),
          ]);
        }
        const value = encoder.encode(request.expected_txt_value);
        return dnsResponse(exchange.request_bytes, [
          record(16, concatBytes([new Uint8Array([value.byteLength]), value])),
          signature(16),
        ]);
      },
    },
    validator: {
      policy_id: "pirate-hns-authoritative-dns-validator-policy-v1",
      validate: async (validation) => ({
        dnssec_validation: "secure",
        validated_dnskey_response_sha256: await sha256(validation.dnskey_response_bytes),
        validated_control_response_sha256: await sha256(validation.control_response_bytes),
        validated_chain_authority_digest: validation.chain_authority_digest,
      }),
    },
    signal: new AbortController().signal,
  });
  return { result, hsdRequests, dnsCalls };
}

describe("HNS owner-authoritative source observer", () => {
  test("runs one HSD bracket then one DNS pair and builds a full verified result", async () => {
    const observed = await observe();
    const decoded = await decodeHnsControlObservationResultBytes(
      observed.result.result_bytes,
      request,
    );
    expect(decoded.result).toMatchObject({
      status: "verified",
      ownership_source: "owner_authoritative_dns_txt",
      root_label: "jazleeuw",
      chain_anchor_height: 123_456,
      expiry_height: 200_000,
    });
    expect(observed.hsdRequests).toHaveLength(7);
    expect(observed.dnsCalls.map((call) => call.query_kind)).toEqual(["dnskey", "control_txt"]);
    expect(observed.result.transcript).toHaveLength(9);
    const facts = decodeHnsAuthoritativeDnsSemanticFactsV1(observed.result.semantic_facts_bytes);
    expect(facts.views).toHaveLength(1);
    expect(facts.views[0]).toMatchObject({
      view_id: "dns-view-a",
      dnssec_validation: "secure",
      semantic_class: "txt_values",
    });
  });

  test("rejects absent and inactive roots without resource or DNS calls", async () => {
    for (const root of ["absent", "inactive"] as const) {
      const observed = await observe({ root });
      const decoded = await decodeHnsControlObservationResultBytes(
        observed.result.result_bytes,
        request,
      );
      expect(decoded.result).toMatchObject({
        status: "rejected",
        reason_code: root === "absent" ? "root_absent" : "root_inactive",
      });
      expect(observed.hsdRequests).toHaveLength(6);
      expect(observed.hsdRequests.some((value) => value.includes("getnameresource"))).toBe(false);
      expect(observed.dnsCalls).toHaveLength(0);
      expect(
        decodeHnsAuthoritativeDnsSemanticFactsV1(observed.result.semantic_facts_bytes).views,
      ).toHaveLength(0);
    }
  });

  test("authenticates control before rejecting an insufficient expiry horizon", async () => {
    const observed = await observe({ expiry_height: 123_456 + 144 + 143 });
    const decoded = await decodeHnsControlObservationResultBytes(
      observed.result.result_bytes,
      request,
    );
    expect(decoded.result).toMatchObject({
      status: "rejected",
      reason_code: "expiry_horizon_insufficient",
      expiry_height: 123_743,
    });
    if (decoded.result.status !== "rejected") throw new Error("expected expiry rejection");
    expect(decoded.result.observed_txt_values_digest).not.toBeNull();
    expect(observed.hsdRequests).toHaveLength(7);
    expect(observed.dnsCalls).toHaveLength(2);
    expect(observed.result.transcript).toHaveLength(9);
  });

  test("keeps DNS timeout unavailable after the stable HSD prefix", async () => {
    const observed = await observe({ dns_failure: "timeout" });
    const decoded = await decodeHnsControlObservationResultBytes(
      observed.result.result_bytes,
      request,
    );
    expect(decoded.result).toMatchObject({
      status: "unavailable",
      reason_code: "authoritative_dns_timeout",
    });
    expect(observed.hsdRequests).toHaveLength(7);
    expect(observed.dnsCalls).toHaveLength(1);
    expect(observed.result.transcript).toHaveLength(8);
  });

  test("retains a completed secure view before a later unavailable DNS terminal", async () => {
    for (const failure of ["timeout", "servfail", "capacity"] as const) {
      const observed = await observe({
        required_view_ids: ["dns-view-a", "dns-view-b"],
        dns_failure: failure,
        dns_failure_view: "dns-view-b",
      });
      const decoded = await decodeHnsControlObservationResultBytes(
        observed.result.result_bytes,
        request,
      );
      expect(decoded.result).toMatchObject({
        status: "unavailable",
        reason_code:
          failure === "timeout"
            ? "authoritative_dns_timeout"
            : failure === "servfail"
              ? "authoritative_dns_servfail"
              : "observer_capacity",
      });
      expect(observed.dnsCalls).toHaveLength(3);
      expect(observed.result.transcript).toHaveLength(10);
      expect(
        decodeHnsAuthoritativeDnsSemanticFactsV1(observed.result.semantic_facts_bytes).views,
      ).toHaveLength(1);
    }
  });
});
