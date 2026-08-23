import { describe, expect, test } from "bun:test";
import {
  type HnsAuthoritativeDnsExchangeInputV1,
  HnsAuthoritativeDnsTransportErrorV1,
  type HnsAuthoritativeDnsTransportPortV1,
  type HnsAuthoritativeDnsValidatorPortV1,
  type HnsChainAuthorityRecord,
  type HnsControlObservationRequestV1,
  type HnsControlObserverConfigurationV1,
} from "@pirate/application/namespace-ownership";
import {
  HnsOwnerAuthoritativeDnsObserverError,
  observeHnsOwnerAuthoritativeDns,
} from "./owner-authoritative-dns-observer.ts";

type Sha256HexValue = HnsAuthoritativeDnsExchangeInputV1["chain_authority_digest"];

const request: HnsControlObservationRequestV1 = {
  version: "pirate-hns-control-observation-request-v1",
  observation_id: "owner-dns-observation-1",
  provider_id: "hns.owner.v1",
  provider_configuration_reference: "hns-observer-regtest-config-fixture",
  provider_configuration_version: "hns-observer-config-v1",
  provider_configuration_digest: "1".repeat(64) as Sha256HexValue,
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
  environment: "test",
  ownership_sources: ["owner_authoritative_dns_txt"],
  chain: {
    driver_reference: "hsd-json-rpc:regtest-primary",
    network: "regtest",
    genesis_block_hash: "2".repeat(64) as Sha256HexValue,
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
    required_view_ids: ["dns-view-a", "dns-view-b"],
    require_dnssec: true,
    require_all_views: true,
    response_max_bytes: 65_535,
  },
  evidence_lease_seconds: 2_592_000,
  observer_deadline_ms: 12_000,
  observer_reservation_lease_seconds: 15,
  snapshot_store_reference: "postgres:hns-control-observer-v1",
};

const authorityRecords: ReadonlyArray<HnsChainAuthorityRecord> = [
  ["NS", "ns1.jazleeuw"],
  ["NS", "ns2.jazleeuw"],
  ["GLUE4", "ns1.jazleeuw", "192.0.2.53"],
  ["GLUE6", "ns2.jazleeuw", "2001:db8::2"],
  ["DS", 12_345, 13, 2, "ab".repeat(32)],
];

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

function response(
  input: Readonly<{
    readonly request_bytes: Uint8Array;
    readonly flags?: number;
    readonly answers?: ReadonlyArray<Uint8Array>;
    readonly authorities?: ReadonlyArray<Uint8Array>;
  }>,
): Uint8Array {
  const answers = input.answers ?? [];
  const authorities = input.authorities ?? [];
  const header = new Uint8Array(12);
  header[0] = input.request_bytes[0] ?? 0;
  header[1] = input.request_bytes[1] ?? 0;
  header.set(uint16(input.flags ?? 0x8400), 2);
  header.set(uint16(1), 4);
  header.set(uint16(answers.length), 6);
  header.set(uint16(authorities.length), 8);
  header.set(uint16(1), 10);
  return concatBytes([
    header,
    input.request_bytes.subarray(12, input.request_bytes.byteLength - 11),
    ...answers,
    ...authorities,
    input.request_bytes.subarray(input.request_bytes.byteLength - 11),
  ]);
}

function txtRdata(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concatBytes([new Uint8Array([bytes.byteLength]), bytes]);
}

async function sha256(bytes: Uint8Array): Promise<Sha256HexValue> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("") as Sha256HexValue;
}

function secureValidator(): HnsAuthoritativeDnsValidatorPortV1 {
  return {
    validate: async (input) => ({
      dnssec_validation: "secure",
      validated_dnskey_response_sha256: await sha256(input.dnskey_response_bytes),
      validated_control_response_sha256: await sha256(input.control_response_bytes),
      validated_chain_authority_digest: input.chain_authority_digest,
    }),
  };
}

function transportForValues(
  values: Readonly<Record<string, string>>,
  calls: HnsAuthoritativeDnsExchangeInputV1[],
): HnsAuthoritativeDnsTransportPortV1 {
  return {
    exchange: async (input) => {
      calls.push(input);
      if (input.query_kind === "dnskey") {
        return response({
          request_bytes: input.request_bytes,
          answers: [record(48, new Uint8Array([1, 3, 13, 1])), signature(48)],
        });
      }
      const value = values[input.view_id] ?? "pirate=missing";
      return response({
        request_bytes: input.request_bytes,
        answers: [record(16, txtRdata(value)), signature(16)],
      });
    },
  };
}

function observationInput(overrides: Readonly<Record<string, unknown>> = {}) {
  let nextId = 1;
  return {
    request,
    configuration,
    authority_records: authorityRecords,
    reservation_database_time: "2026-02-02T00:00:00.000Z",
    message_ids: { next_id: () => nextId++ },
    transport: transportForValues(
      { "dns-view-a": request.expected_txt_value, "dns-view-b": request.expected_txt_value },
      [],
    ),
    validator: secureValidator(),
    signal: new AbortController().signal,
    ...overrides,
  } as Parameters<typeof observeHnsOwnerAuthoritativeDns>[0];
}

describe("HNS owner-authoritative DNS observer", () => {
  test("observes every view sequentially with pinned tuple, exact pairs, and secure agreement", async () => {
    const calls: HnsAuthoritativeDnsExchangeInputV1[] = [];
    const result = await observeHnsOwnerAuthoritativeDns(
      observationInput({
        transport: transportForValues(
          { "dns-view-a": request.expected_txt_value, "dns-view-b": request.expected_txt_value },
          calls,
        ),
      }),
    );
    expect(result.status).toBe("verified");
    expect(result.reason_code).toBeNull();
    expect(result.observed_txt_values_digest).not.toBeNull();
    expect(result.transcript).toHaveLength(4);
    expect(calls.map((call) => [call.view_id, call.query_kind])).toEqual([
      ["dns-view-a", "dnskey"],
      ["dns-view-a", "control_txt"],
      ["dns-view-b", "dnskey"],
      ["dns-view-b", "control_txt"],
    ]);
    expect(new Set(calls.map((call) => call.request_bytes.slice(0, 2).join("."))).size).toBe(4);
    expect(
      calls.map((call) => [
        call.authority_nameserver,
        call.authority_address_family,
        call.authority_address,
      ]),
    ).toEqual([
      ["ns1.jazleeuw", "GLUE4", "192.0.2.53"],
      ["ns1.jazleeuw", "GLUE4", "192.0.2.53"],
      ["ns2.jazleeuw", "GLUE6", "2001:db8::2"],
      ["ns2.jazleeuw", "GLUE6", "2001:db8::2"],
    ]);
    expect(Object.isFrozen(calls[0]?.authority_records)).toBe(true);
    expect(Object.isFrozen(calls[0]?.authority_records[0])).toBe(true);
    const facts = JSON.parse(new TextDecoder().decode(result.semantic_facts_bytes));
    expect(facts.views.map((view: { view_id: string }) => view.view_id)).toEqual([
      "dns-view-a",
      "dns-view-b",
    ]);
  });

  test("returns stable mismatch and keeps NODATA distinct from positive data", async () => {
    const mismatch = await observeHnsOwnerAuthoritativeDns(
      observationInput({
        transport: transportForValues(
          { "dns-view-a": "pirate=other", "dns-view-b": "pirate=other" },
          [],
        ),
      }),
    );
    expect(mismatch.status).toBe("rejected");
    expect(mismatch.reason_code).toBe("txt_value_mismatch");

    const negativeTransport: HnsAuthoritativeDnsTransportPortV1 = {
      exchange: async (input) => {
        if (input.query_kind === "dnskey") {
          return response({
            request_bytes: input.request_bytes,
            answers: [record(48, new Uint8Array([1])), signature(48)],
          });
        }
        return response({
          request_bytes: input.request_bytes,
          authorities: [
            record(6, new Uint8Array([0])),
            record(47, new Uint8Array([0])),
            signature(6),
            signature(47),
          ],
        });
      },
    };
    const negative = await observeHnsOwnerAuthoritativeDns(
      observationInput({ transport: negativeTransport }),
    );
    expect(negative.status).toBe("rejected");
    expect(negative.reason_code).toBe("txt_absent");
    expect(negative.observed_txt_values_digest).toBeNull();
  });

  test("fails unavailable on cross-view disagreement without downgrading it to a negative", async () => {
    const result = await observeHnsOwnerAuthoritativeDns(
      observationInput({
        transport: transportForValues(
          { "dns-view-a": request.expected_txt_value, "dns-view-b": "pirate=other" },
          [],
        ),
      }),
    );
    expect(result.status).toBe("unavailable");
    expect(result.reason_code).toBe("authoritative_dns_inconclusive");
  });

  test("retains typed timeout and one-byte capacity prefixes without invoking validation", async () => {
    let validatorCalls = 0;
    const validator: HnsAuthoritativeDnsValidatorPortV1 = {
      validate: async () => {
        validatorCalls += 1;
        throw new Error("must not run");
      },
    };
    const timeout = await observeHnsOwnerAuthoritativeDns(
      observationInput({
        transport: {
          exchange: async () => {
            throw new HnsAuthoritativeDnsTransportErrorV1("timeout");
          },
        },
        validator,
      }),
    );
    expect(timeout.reason_code).toBe("authoritative_dns_timeout");
    expect(timeout.transcript).toHaveLength(1);
    expect(timeout.transcript[0]?.transport_outcome).toBe("timeout");

    const boundedConfiguration = {
      ...configuration,
      authoritative_dns: { ...configuration.authoritative_dns, response_max_bytes: 64 },
    } as HnsControlObserverConfigurationV1;
    const capacity = await observeHnsOwnerAuthoritativeDns(
      observationInput({
        configuration: boundedConfiguration,
        transport: { exchange: async () => new Uint8Array(65) },
        validator,
      }),
    );
    expect(capacity.reason_code).toBe("observer_capacity");
    expect(capacity.transcript[0]?.response_bytes).toHaveLength(64);
    expect(validatorCalls).toBe(0);

    await expect(
      observeHnsOwnerAuthoritativeDns(
        observationInput({
          configuration: boundedConfiguration,
          transport: { exchange: async () => new Uint8Array(66) },
          validator,
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_response" });
    expect(validatorCalls).toBe(0);
  });

  test("rejects repeated entropy and validator hash substitution as adapter failures", async () => {
    await expect(
      observeHnsOwnerAuthoritativeDns(observationInput({ message_ids: { next_id: () => 7 } })),
    ).rejects.toBeInstanceOf(HnsOwnerAuthoritativeDnsObserverError);

    await expect(
      observeHnsOwnerAuthoritativeDns(
        observationInput({
          validator: {
            validate: async (
              input: Parameters<HnsAuthoritativeDnsValidatorPortV1["validate"]>[0],
            ) => ({
              dnssec_validation: "secure",
              validated_dnskey_response_sha256: "0".repeat(64) as Sha256HexValue,
              validated_control_response_sha256: await sha256(input.control_response_bytes),
              validated_chain_authority_digest: input.chain_authority_digest,
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_response" });
  });

  test("lets abort win before entropy and after a late transport completion", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let idCalls = 0;
    let transportCalls = 0;
    await expect(
      observeHnsOwnerAuthoritativeDns(
        observationInput({
          message_ids: {
            next_id: () => {
              idCalls += 1;
              return 1;
            },
          },
          transport: {
            exchange: async () => {
              transportCalls += 1;
              return new Uint8Array([1]);
            },
          },
          signal: alreadyAborted.signal,
        }),
      ),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(idCalls).toBe(0);
    expect(transportCalls).toBe(0);

    const lateAbort = new AbortController();
    const calls: HnsAuthoritativeDnsExchangeInputV1[] = [];
    const transport = transportForValues(
      { "dns-view-a": request.expected_txt_value, "dns-view-b": request.expected_txt_value },
      calls,
    );
    await expect(
      observeHnsOwnerAuthoritativeDns(
        observationInput({
          signal: lateAbort.signal,
          transport: {
            exchange: async (input: HnsAuthoritativeDnsExchangeInputV1) => {
              const responseBytes = await transport.exchange(input);
              lateAbort.abort();
              return responseBytes;
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(calls).toHaveLength(1);
  });

  test("rejects a direct TXT-name boundary bypass before any capability call", async () => {
    let idCalls = 0;
    await expect(
      observeHnsOwnerAuthoritativeDns(
        observationInput({
          request: { ...request, txt_name: request.root_label },
          message_ids: {
            next_id: () => {
              idCalls += 1;
              return 1;
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_request" });
    expect(idCalls).toBe(0);
  });
});
