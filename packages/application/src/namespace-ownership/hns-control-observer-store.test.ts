import { describe, expect, test } from "bun:test";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Schema } from "effect";
import {
  buildHnsAuthoritativeDnsQueryV1,
  decodeHnsAuthoritativeDnsQueryV1,
} from "./hns-authoritative-dns.ts";
import {
  HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES,
  HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_BYTES,
  type HnsControlObserverReservationInput,
  type HnsControlObserverReservationOutcome,
  type HnsControlObserverSnapshotFinalizeInput,
  type HnsControlObserverSnapshotFinalizeOutcome,
  type HnsControlObserverSnapshotStorePort,
  type HnsControlObserverTranscriptEntryV1,
  type HnsControlObserverTranscriptValidationContext,
  hnsControlObserverSnapshotAccountingEnvelopeBytes,
  hnsControlObserverSnapshotLogicalByteLength,
  hnsControlObserverTranscriptByteLength,
  validateHnsControlObserverTranscript,
} from "./hns-control-observer-store.ts";

const encoder = new TextEncoder();
const storeOptions = {
  deadline_ms: 12_000,
  signal: new AbortController().signal,
} as const;

async function sha256(bytes: Uint8Array): Promise<Sha256HexValue> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const value = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return Schema.decodeUnknownSync(Sha256Hex)(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function uint16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function dnsRecord(type: number, rdata: Uint8Array): Uint8Array {
  return concatBytes([
    new Uint8Array([0xc0, 0x0c]),
    uint16(type),
    uint16(1),
    new Uint8Array([0, 0, 1, 44]),
    uint16(rdata.byteLength),
    rdata,
  ]);
}

function validDnskeyResponse(request: Uint8Array): Uint8Array {
  const signature = new Uint8Array(18);
  signature.set(uint16(48));
  const answers = [dnsRecord(48, new Uint8Array([1])), dnsRecord(46, signature)];
  const header = new Uint8Array(12);
  header[0] = request[0] ?? 0;
  header[1] = request[1] ?? 0;
  header.set(uint16(0x8400), 2);
  header.set(uint16(1), 4);
  header.set(uint16(answers.length), 6);
  header.set(uint16(1), 10);
  return concatBytes([
    header,
    request.subarray(12, request.byteLength - 11),
    ...answers,
    request.subarray(request.byteLength - 11),
  ]);
}

function servfailResponse(request: Uint8Array): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = request[0] ?? 0;
  header[1] = request[1] ?? 0;
  header.set(uint16(0x8002), 2);
  header.set(uint16(1), 4);
  header.set(uint16(1), 10);
  return concatBytes([
    header,
    request.subarray(12, request.byteLength - 11),
    request.subarray(request.byteLength - 11),
  ]);
}

const transcriptContext: HnsControlObserverTranscriptValidationContext = {
  ownership_source: "owner_authoritative_dns_txt",
  root_label: "jazleeuw",
  hsd_driver_reference: "hsd-json-rpc:regtest-primary",
  hsd_response_max_bytes: 1_048_576,
  authoritative_dns_driver_reference: "authoritative-dns:regtest",
  authoritative_dns_response_max_bytes: 65_535,
  required_view_ids: ["dns-view-a", "dns-view-b"],
};

async function responseEntry(
  overrides: Partial<HnsControlObserverTranscriptEntryV1> = {},
): Promise<HnsControlObserverTranscriptEntryV1> {
  const requestBytes = overrides.request_bytes ?? encoder.encode('{"method":"getblockchaininfo"}');
  const responseBytes = overrides.response_bytes ?? encoder.encode('{"result":{"blocks":12}}');
  return {
    driver_reference: "hsd-json-rpc:regtest-primary",
    ownership_source: "owner_authoritative_dns_txt",
    method_or_view_id: "getblockchaininfo",
    request_bytes: requestBytes,
    request_sha256: overrides.request_sha256 ?? (await sha256(requestBytes)),
    transport_outcome: "response",
    transport_status: 200,
    response_bytes: responseBytes,
    response_sha256: overrides.response_sha256 ?? (await sha256(responseBytes)),
    ...overrides,
  };
}

async function noResponseDnsEntry(): Promise<HnsControlObserverTranscriptEntryV1> {
  const requestBytes = buildHnsAuthoritativeDnsQueryV1({
    message_id: 1,
    query_kind: "dnskey",
    root_label: transcriptContext.root_label,
  });
  return {
    driver_reference: "authoritative-dns:regtest",
    ownership_source: "owner_authoritative_dns_txt",
    method_or_view_id: "dns-view-a",
    request_bytes: requestBytes,
    request_sha256: await sha256(requestBytes),
    transport_outcome: "timeout",
    transport_status: null,
    response_bytes: null,
    response_sha256: null,
  };
}

async function dnsEntry(
  input: Readonly<{
    readonly view_id: string;
    readonly query_kind: "dnskey" | "control_txt";
    readonly message_id: number;
    readonly outcome?: "response" | "timeout" | "transport_error" | "aborted";
    readonly root_label?: string;
    readonly response_bytes?: Uint8Array;
  }>,
): Promise<HnsControlObserverTranscriptEntryV1> {
  const requestBytes = buildHnsAuthoritativeDnsQueryV1({
    message_id: input.message_id,
    query_kind: input.query_kind,
    root_label: input.root_label ?? transcriptContext.root_label,
  });
  const outcome = input.outcome ?? "response";
  const responseBytes =
    outcome === "response"
      ? (input.response_bytes ?? new Uint8Array([input.message_id & 0xff, 1]))
      : null;
  return {
    driver_reference: "authoritative-dns:regtest",
    ownership_source: "owner_authoritative_dns_txt",
    method_or_view_id: input.view_id,
    request_bytes: requestBytes,
    request_sha256: await sha256(requestBytes),
    transport_outcome: outcome,
    transport_status: null,
    response_bytes: responseBytes,
    response_sha256: responseBytes === null ? null : await sha256(responseBytes),
  };
}

describe("HNS control observer transcript", () => {
  test("validates the exact driver matrix and retains owned byte copies", async () => {
    const hsd = await responseEntry();
    const dns = await noResponseDnsEntry();
    const retained = await validateHnsControlObserverTranscript({
      transcript: [hsd, dns],
      context: transcriptContext,
    });
    expect(retained).toHaveLength(2);
    expect(hnsControlObserverTranscriptByteLength(retained)).toBe(
      hsd.request_bytes.byteLength +
        (hsd.response_bytes?.byteLength ?? 0) +
        dns.request_bytes.byteLength,
    );
    const retainedRequestByte = retained[0]?.request_bytes[0];
    const retainedResponseByte = retained[0]?.response_bytes?.[0];
    hsd.request_bytes[0] = 0;
    if (hsd.response_bytes !== null) hsd.response_bytes[0] = 0;
    expect(retained[0]?.request_bytes[0]).toBe(retainedRequestByte);
    expect(retained[0]?.response_bytes?.[0]).toBe(retainedResponseByte);
  });

  test("charges exact byte strings and all logical snapshot metadata", async () => {
    const transcript = [await responseEntry()];
    const requestBytes = encoder.encode("request");
    const configurationBytes = encoder.encode("configuration");
    const factsBytes = encoder.encode("facts");
    const resultBytes = encoder.encode("result");
    const payload = {
      observation_id: "observer-operation-1",
      observer_fence: 1,
      reservation_database_time: "2026-02-02T03:04:05.000Z",
      lease_expires_at: "2026-02-02T03:04:20.000Z",
      request_bytes: requestBytes,
      request_sha256: await sha256(requestBytes),
      configuration_bytes: configurationBytes,
      provider_configuration_digest: await sha256(configurationBytes),
      snapshot_reference: "hns-observer:test:snapshot-1",
      transcript,
      semantic_facts_bytes: factsBytes,
      result_bytes: resultBytes,
      result_sha256: await sha256(resultBytes),
      result_status: "unavailable",
      result_reference_kind: "diagnostic_ref",
    } as const;
    const rawByteLength =
      requestBytes.byteLength +
      configurationBytes.byteLength +
      factsBytes.byteLength +
      resultBytes.byteLength +
      hnsControlObserverTranscriptByteLength(transcript);
    const logicalByteLength = hnsControlObserverSnapshotLogicalByteLength(payload);
    const accountingEnvelopeBytes = hnsControlObserverSnapshotAccountingEnvelopeBytes(payload);
    const accountingEnvelope = new TextDecoder().decode(accountingEnvelopeBytes);
    expect(logicalByteLength).toBe(rawByteLength + accountingEnvelopeBytes.byteLength);
    expect(logicalByteLength).toBeGreaterThan(rawByteLength);
    expect(accountingEnvelope).toContain('"result_status":"unavailable"');
    expect(accountingEnvelope).toContain('"result_reference_kind":"diagnostic_ref"');
    expect(accountingEnvelope).toContain('"transcript_entry_count":1');
    expect(
      hnsControlObserverSnapshotLogicalByteLength({
        ...payload,
        result_bytes: encoder.encode("result!"),
      }),
    ).toBe(logicalByteLength + 1);
  });

  test("rejects hash, status, driver, source, and no-response substitution", async () => {
    const valid = await responseEntry();
    for (const changed of [
      { ...valid, request_sha256: "0".repeat(64) },
      { ...valid, transport_status: 99 },
      { ...valid, driver_reference: "hsd-json-rpc:other" },
      { ...valid, ownership_source: "hns_parent_chain_txt" },
      {
        ...(await noResponseDnsEntry()),
        response_bytes: encoder.encode("forbidden"),
      },
    ]) {
      await expect(
        validateHnsControlObserverTranscript({
          transcript: [changed],
          context: transcriptContext,
        }),
      ).rejects.toMatchObject({ reason: "invalid_transcript" });
    }
  });

  test("classifies entry, request, response, and aggregate overflow as observer capacity", async () => {
    const valid = await responseEntry();
    await expect(
      validateHnsControlObserverTranscript({
        transcript: Array.from({ length: 17 }, () => valid),
        context: transcriptContext,
      }),
    ).rejects.toMatchObject({ reason: "observer_capacity" });

    const oversizedRequest = new Uint8Array(HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES + 1);
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [
          await responseEntry({
            request_bytes: oversizedRequest,
            request_sha256: await sha256(oversizedRequest),
          }),
        ],
        context: transcriptContext,
      }),
    ).rejects.toMatchObject({ reason: "observer_capacity" });

    await expect(
      validateHnsControlObserverTranscript({
        transcript: [valid],
        context: { ...transcriptContext, hsd_response_max_bytes: 1 },
      }),
    ).rejects.toMatchObject({ reason: "observer_capacity" });

    const largeResponse = new Uint8Array(1_048_576);
    const largeEntry = await responseEntry({
      response_bytes: largeResponse,
      response_sha256: await sha256(largeResponse),
    });
    expect(8 * largeResponse.byteLength).toBeGreaterThan(HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_BYTES);
    await expect(
      validateHnsControlObserverTranscript({
        transcript: Array.from({ length: 8 }, () => largeEntry),
        context: transcriptContext,
      }),
    ).rejects.toMatchObject({ reason: "observer_capacity" });
  });

  test("requires configured DNSKEY/control pairs and treats a method-named view as DNS", async () => {
    const collisionContext = {
      ...transcriptContext,
      required_view_ids: ["getblockchaininfo", "dns-view-b"],
      terminal_status: "verified" as const,
    };
    const transcript = [
      await responseEntry(),
      await dnsEntry({ view_id: "getblockchaininfo", query_kind: "dnskey", message_id: 1 }),
      await dnsEntry({ view_id: "getblockchaininfo", query_kind: "control_txt", message_id: 2 }),
      await dnsEntry({ view_id: "dns-view-b", query_kind: "dnskey", message_id: 3 }),
      await dnsEntry({ view_id: "dns-view-b", query_kind: "control_txt", message_id: 4 }),
    ];
    const retained = await validateHnsControlObserverTranscript({
      transcript,
      context: collisionContext,
    });
    expect(retained).toHaveLength(5);
    expect(decodeHnsAuthoritativeDnsQueryV1(retained[1]?.request_bytes).query_kind).toBe("dnskey");
    expect(decodeHnsAuthoritativeDnsQueryV1(retained[2]?.request_bytes).query_kind).toBe(
      "control_txt",
    );
  });

  test("allows only root-state owner rejections to terminate before DNS", async () => {
    const hsd = await responseEntry();
    for (const reason of ["root_absent", "root_inactive"] as const) {
      await expect(
        validateHnsControlObserverTranscript({
          transcript: [hsd],
          context: {
            ...transcriptContext,
            terminal_status: "rejected",
            terminal_reason_code: reason,
          },
        }),
      ).resolves.toHaveLength(1);
    }
    for (const reason of [
      "txt_absent",
      "txt_value_mismatch",
      "expiry_horizon_insufficient",
    ] as const) {
      await expect(
        validateHnsControlObserverTranscript({
          transcript: [hsd],
          context: {
            ...transcriptContext,
            terminal_status: "rejected",
            terminal_reason_code: reason,
          },
        }),
      ).rejects.toMatchObject({ reason: "invalid_transcript" });
    }
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [
          hsd,
          await dnsEntry({ view_id: "dns-view-a", query_kind: "dnskey", message_id: 9 }),
        ],
        context: {
          ...transcriptContext,
          terminal_status: "rejected",
          terminal_reason_code: "root_absent",
        },
      }),
    ).rejects.toMatchObject({ reason: "invalid_transcript" });
  });

  test("accepts only a legal ordered unavailable DNS prefix", async () => {
    const hsd = await responseEntry();
    const dnskeyTimeout = await dnsEntry({
      view_id: "dns-view-a",
      query_kind: "dnskey",
      message_id: 1,
      outcome: "timeout",
    });
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd, dnskeyTimeout],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "authoritative_dns_timeout",
        },
      }),
    ).resolves.toHaveLength(2);
    for (const reason of [
      "chain_transport_unavailable",
      "chain_unsynchronized",
      "chain_view_stale",
      "chain_view_changed",
      "chain_response_invalid",
      "observer_internal_error",
    ] as const) {
      await expect(
        validateHnsControlObserverTranscript({
          transcript: [hsd],
          context: {
            ...transcriptContext,
            terminal_status: "unavailable",
            terminal_reason_code: reason,
          },
        }),
      ).resolves.toHaveLength(1);
      await expect(
        validateHnsControlObserverTranscript({
          transcript: [hsd, dnskeyTimeout],
          context: {
            ...transcriptContext,
            terminal_status: "unavailable",
            terminal_reason_code: reason,
          },
        }),
      ).rejects.toMatchObject({ reason: "invalid_transcript" });
    }
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "authoritative_dns_timeout",
        },
      }),
    ).rejects.toMatchObject({ reason: "invalid_transcript" });

    const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 1,
      query_kind: "dnskey",
      root_label: transcriptContext.root_label,
    });
    const dnskey = await dnsEntry({
      view_id: "dns-view-a",
      query_kind: "dnskey",
      message_id: 1,
      response_bytes: validDnskeyResponse(dnskeyRequest),
    });
    const controlTimeout = await dnsEntry({
      view_id: "dns-view-a",
      query_kind: "control_txt",
      message_id: 2,
      outcome: "transport_error",
    });
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd, dnskey, controlTimeout],
        context: { ...transcriptContext, terminal_status: "unavailable" },
      }),
    ).resolves.toHaveLength(3);

    const capacityBytes = new Uint8Array(
      transcriptContext.authoritative_dns_response_max_bytes ?? 0,
    );
    const capacityPrefix = {
      ...(await dnsEntry({
        view_id: "dns-view-a",
        query_kind: "dnskey",
        message_id: 3,
      })),
      response_bytes: capacityBytes,
      response_sha256: await sha256(capacityBytes),
    };
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd, capacityPrefix],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "observer_capacity",
        },
      }),
    ).resolves.toHaveLength(2);
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd, capacityPrefix],
        context: { ...transcriptContext, terminal_status: "unavailable" },
      }),
    ).rejects.toMatchObject({ reason: "invalid_transcript" });

    const hsdCapacityBytes = new Uint8Array(transcriptContext.hsd_response_max_bytes);
    const hsdCapacity = await responseEntry({
      response_bytes: hsdCapacityBytes,
      response_sha256: await sha256(hsdCapacityBytes),
    });
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsdCapacity],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "observer_capacity",
        },
      }),
    ).resolves.toHaveLength(1);
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "observer_capacity",
        },
      }),
    ).resolves.toHaveLength(1);

    const inconclusiveDnskey = await dnsEntry({
      view_id: "dns-view-a",
      query_kind: "dnskey",
      message_id: 4,
    });
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd, inconclusiveDnskey],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "authoritative_dns_inconclusive",
        },
      }),
    ).resolves.toHaveLength(2);

    const servfailRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 8,
      query_kind: "dnskey",
      root_label: transcriptContext.root_label,
    });
    const servfailDnskey = await dnsEntry({
      view_id: "dns-view-a",
      query_kind: "dnskey",
      message_id: 8,
      response_bytes: servfailResponse(servfailRequest),
    });
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd, servfailDnskey],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "authoritative_dns_servfail",
        },
      }),
    ).resolves.toHaveLength(2);
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd, servfailDnskey],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "authoritative_dns_insecure",
        },
      }),
    ).rejects.toMatchObject({ reason: "invalid_transcript" });
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "authoritative_dns_servfail",
        },
      }),
    ).rejects.toMatchObject({ reason: "invalid_transcript" });

    const controlInconclusive = await dnsEntry({
      view_id: "dns-view-a",
      query_kind: "control_txt",
      message_id: 5,
    });
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd, dnskey, controlInconclusive],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "authoritative_dns_inconclusive",
        },
      }),
    ).resolves.toHaveLength(3);
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd, dnskey, controlInconclusive],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "authoritative_dns_servfail",
        },
      }),
    ).rejects.toMatchObject({ reason: "invalid_transcript" });
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [
          hsd,
          dnskey,
          controlInconclusive,
          await dnsEntry({ view_id: "dns-view-b", query_kind: "dnskey", message_id: 6 }),
        ],
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: "authoritative_dns_inconclusive",
        },
      }),
    ).rejects.toMatchObject({ reason: "invalid_transcript" });

    const aborted = await dnsEntry({
      view_id: "dns-view-a",
      query_kind: "dnskey",
      message_id: 7,
      outcome: "aborted",
    });
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd, aborted],
        context: { ...transcriptContext, terminal_status: "unavailable" },
      }),
    ).rejects.toMatchObject({ reason: "invalid_transcript" });
  });

  test("rejects reversed, duplicate, skipped, wrong-root, missing, and post-terminal DNS entries", async () => {
    const hsd = await responseEntry();
    const dnskeyA = await dnsEntry({
      view_id: "dns-view-a",
      query_kind: "dnskey",
      message_id: 1,
    });
    const controlA = await dnsEntry({
      view_id: "dns-view-a",
      query_kind: "control_txt",
      message_id: 2,
    });
    const dnskeyB = await dnsEntry({
      view_id: "dns-view-b",
      query_kind: "dnskey",
      message_id: 3,
    });
    const timeoutA = await dnsEntry({
      view_id: "dns-view-a",
      query_kind: "dnskey",
      message_id: 4,
      outcome: "timeout",
    });
    const wrongRoot = await dnsEntry({
      view_id: "dns-view-a",
      query_kind: "dnskey",
      message_id: 5,
      root_label: "jazleevv",
    });
    const invalidTranscripts = [
      [hsd, controlA],
      [hsd, dnskeyA, dnskeyA],
      [hsd, dnskeyB],
      [hsd, wrongRoot],
      [hsd, dnskeyA],
      [hsd, timeoutA, dnskeyB],
      [hsd, dnskeyA, controlA, hsd],
    ];
    for (const transcript of invalidTranscripts) {
      await expect(
        validateHnsControlObserverTranscript({
          transcript,
          context: { ...transcriptContext, terminal_status: "unavailable" },
        }),
      ).rejects.toMatchObject({ reason: "invalid_transcript" });
    }
    await expect(
      validateHnsControlObserverTranscript({
        transcript: [hsd, dnskeyA, controlA],
        context: { ...transcriptContext, terminal_status: "verified" },
      }),
    ).rejects.toMatchObject({ reason: "invalid_transcript" });
  });
});

type FakeRow = {
  observation_id: string;
  request_bytes: Uint8Array;
  request_sha256: Sha256HexValue;
  configuration_bytes: Uint8Array;
  provider_configuration_digest: Sha256HexValue;
  observer_fence: number;
  reservation_database_time: string;
  lease_expires_at: string;
  snapshot_reference: string;
  terminal: null | {
    transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
    semantic_facts_bytes: Uint8Array;
    result_bytes: Uint8Array;
    result_sha256: Sha256HexValue;
  };
};

class FakeSnapshotStore implements HnsControlObserverSnapshotStorePort {
  private nowMilliseconds = Date.parse("2026-02-02T03:04:05.000Z");
  private readonly rows = new Map<string, FakeRow>();

  advance(seconds: number): void {
    this.nowMilliseconds += seconds * 1_000;
  }

  inspect(observationId: string): FakeRow | undefined {
    return this.rows.get(observationId);
  }

  readonly reserve = async (
    input: HnsControlObserverReservationInput,
    _options: Parameters<HnsControlObserverSnapshotStorePort["reserve"]>[1],
  ): Promise<HnsControlObserverReservationOutcome> => {
    if (
      (await sha256(input.request_bytes)) !== input.request_sha256 ||
      (await sha256(input.configuration_bytes)) !== input.provider_configuration_digest
    ) {
      return { kind: "mismatch" };
    }
    const row = this.rows.get(input.observation_id);
    if (row !== undefined) {
      if (
        row.request_sha256 !== input.request_sha256 ||
        row.provider_configuration_digest !== input.provider_configuration_digest ||
        !bytesEqual(row.request_bytes, input.request_bytes) ||
        !bytesEqual(row.configuration_bytes, input.configuration_bytes)
      ) {
        return { kind: "mismatch" };
      }
      if (row.terminal !== null) {
        return {
          kind: "replay",
          snapshot_reference: row.snapshot_reference,
          result_bytes: new Uint8Array(row.terminal.result_bytes),
          result_sha256: row.terminal.result_sha256,
        };
      }
      const leaseMilliseconds = Date.parse(row.lease_expires_at);
      if (leaseMilliseconds > this.nowMilliseconds) {
        return {
          kind: "busy",
          retry_after_seconds: Math.max(
            1,
            Math.ceil((leaseMilliseconds - this.nowMilliseconds) / 1_000),
          ),
        };
      }
      row.observer_fence += 1;
      row.reservation_database_time = new Date(this.nowMilliseconds).toISOString();
      row.lease_expires_at = new Date(
        this.nowMilliseconds + input.reservation_lease_seconds * 1_000,
      ).toISOString();
      return {
        kind: "acquired",
        observer_fence: row.observer_fence,
        reservation_database_time: row.reservation_database_time,
        lease_expires_at: row.lease_expires_at,
        snapshot_reference: row.snapshot_reference,
      };
    }
    const reservationDatabaseTime = new Date(this.nowMilliseconds).toISOString();
    const created: FakeRow = {
      observation_id: input.observation_id,
      request_bytes: new Uint8Array(input.request_bytes),
      request_sha256: input.request_sha256,
      configuration_bytes: new Uint8Array(input.configuration_bytes),
      provider_configuration_digest: input.provider_configuration_digest,
      observer_fence: 1,
      reservation_database_time: reservationDatabaseTime,
      lease_expires_at: new Date(
        this.nowMilliseconds + input.reservation_lease_seconds * 1_000,
      ).toISOString(),
      snapshot_reference: `hns-observer:test:${String(this.rows.size + 1).padStart(4, "0")}`,
      terminal: null,
    };
    this.rows.set(input.observation_id, created);
    return {
      kind: "acquired",
      observer_fence: created.observer_fence,
      reservation_database_time: created.reservation_database_time,
      lease_expires_at: created.lease_expires_at,
      snapshot_reference: created.snapshot_reference,
    };
  };

  readonly finalize = async (
    input: HnsControlObserverSnapshotFinalizeInput,
    _options: Parameters<HnsControlObserverSnapshotStorePort["finalize"]>[1],
  ): Promise<HnsControlObserverSnapshotFinalizeOutcome> => {
    const row = this.rows.get(input.observation_id);
    if (
      row === undefined ||
      row.request_sha256 !== input.request_sha256 ||
      row.provider_configuration_digest !== input.provider_configuration_digest ||
      row.snapshot_reference !== input.snapshot_reference ||
      (await sha256(input.result_bytes)) !== input.result_sha256
    ) {
      return { kind: "mismatch" };
    }
    if (row.terminal !== null) {
      return row.terminal.result_sha256 === input.result_sha256 &&
        bytesEqual(row.terminal.result_bytes, input.result_bytes)
        ? {
            kind: "replay",
            snapshot_reference: row.snapshot_reference,
            result_bytes: new Uint8Array(row.terminal.result_bytes),
            result_sha256: row.terminal.result_sha256,
          }
        : { kind: "mismatch" };
    }
    if (
      row.observer_fence !== input.observer_fence ||
      Date.parse(row.lease_expires_at) <= this.nowMilliseconds
    ) {
      return { kind: "lost" };
    }
    row.terminal = {
      transcript: input.transcript.map((entry) => ({
        ...entry,
        request_bytes: new Uint8Array(entry.request_bytes),
        response_bytes: entry.response_bytes === null ? null : new Uint8Array(entry.response_bytes),
      })),
      semantic_facts_bytes: new Uint8Array(input.semantic_facts_bytes),
      result_bytes: new Uint8Array(input.result_bytes),
      result_sha256: input.result_sha256,
    };
    return {
      kind: "retained",
      snapshot_reference: row.snapshot_reference,
      result_bytes: new Uint8Array(row.terminal.result_bytes),
      result_sha256: row.terminal.result_sha256,
    };
  };
}

describe("HNS control observer snapshot-store contract", () => {
  test("models exact replay, live busy, expired-fence reacquisition, and append-only finalization", async () => {
    const store = new FakeSnapshotStore();
    const requestBytes = encoder.encode("observer-request-1");
    const configurationBytes = encoder.encode("observer-configuration-1");
    const reservation: HnsControlObserverReservationInput = {
      observation_id: "observer-operation-1",
      request_bytes: requestBytes,
      request_sha256: await sha256(requestBytes),
      configuration_bytes: configurationBytes,
      provider_configuration_digest: await sha256(configurationBytes),
      reservation_lease_seconds: 15,
    };
    const first = await store.reserve(reservation, storeOptions);
    expect(first).toMatchObject({ kind: "acquired", observer_fence: 1 });
    if (first.kind !== "acquired") throw new Error("expected first reservation");
    requestBytes[0] = 0;
    configurationBytes[0] = 0;
    expect(store.inspect(reservation.observation_id)?.request_bytes[0]).not.toBe(0);
    expect(store.inspect(reservation.observation_id)?.configuration_bytes[0]).not.toBe(0);

    const exactReservation = {
      ...reservation,
      request_bytes: encoder.encode("observer-request-1"),
      configuration_bytes: encoder.encode("observer-configuration-1"),
    };
    await expect(store.reserve(exactReservation, storeOptions)).resolves.toMatchObject({
      kind: "busy",
      retry_after_seconds: 15,
    });
    const changedRequest = encoder.encode("changed-request");
    await expect(
      store.reserve(
        {
          ...exactReservation,
          request_bytes: changedRequest,
          request_sha256: await sha256(changedRequest),
        },
        storeOptions,
      ),
    ).resolves.toEqual({ kind: "mismatch" });

    store.advance(16);
    const reacquired = await store.reserve(exactReservation, storeOptions);
    expect(reacquired).toMatchObject({
      kind: "acquired",
      observer_fence: 2,
      snapshot_reference: first.snapshot_reference,
    });
    if (reacquired.kind !== "acquired") throw new Error("expected reacquisition");
    expect(reacquired.reservation_database_time).not.toBe(first.reservation_database_time);
    const transcript = [await responseEntry()];
    const semanticFactsBytes = encoder.encode("semantic-facts-1");
    const resultBytes = encoder.encode("semantic-result-1");
    const resultHash = await sha256(resultBytes);
    const finalize = (observerFence: number): HnsControlObserverSnapshotFinalizeInput => ({
      observation_id: exactReservation.observation_id,
      observer_fence: observerFence,
      request_sha256: exactReservation.request_sha256,
      provider_configuration_digest: exactReservation.provider_configuration_digest,
      snapshot_reference: reacquired.snapshot_reference,
      transcript,
      semantic_facts_bytes: semanticFactsBytes,
      result_bytes: resultBytes,
      result_sha256: resultHash,
    });
    await expect(store.finalize(finalize(first.observer_fence), storeOptions)).resolves.toEqual({
      kind: "lost",
    });
    await expect(
      store.finalize(finalize(reacquired.observer_fence), storeOptions),
    ).resolves.toMatchObject({
      kind: "retained",
      snapshot_reference: reacquired.snapshot_reference,
      result_sha256: resultHash,
    });

    semanticFactsBytes[0] = 0;
    resultBytes[0] = 0;
    transcript[0]?.request_bytes.fill(0);
    const retained = store.inspect(exactReservation.observation_id)?.terminal;
    expect(retained?.semantic_facts_bytes[0]).not.toBe(0);
    expect(retained?.result_bytes[0]).not.toBe(0);
    expect(retained?.transcript[0]?.request_bytes[0]).not.toBe(0);

    const replay = await store.reserve(exactReservation, storeOptions);
    expect(replay).toMatchObject({
      kind: "replay",
      snapshot_reference: reacquired.snapshot_reference,
      result_sha256: resultHash,
    });
    if (replay.kind !== "replay") throw new Error("expected replay");
    expect(new TextDecoder().decode(replay.result_bytes)).toBe("semantic-result-1");
  });
});
