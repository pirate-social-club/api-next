import { describe, expect, test } from "bun:test";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Schema } from "effect";
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

const transcriptContext: HnsControlObserverTranscriptValidationContext = {
  ownership_source: "owner_authoritative_dns_txt",
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
  const requestBytes = encoder.encode("dns-wire-query");
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
    } as const;
    const rawByteLength =
      requestBytes.byteLength +
      configurationBytes.byteLength +
      factsBytes.byteLength +
      resultBytes.byteLength +
      hnsControlObserverTranscriptByteLength(transcript);
    const logicalByteLength = hnsControlObserverSnapshotLogicalByteLength(payload);
    expect(logicalByteLength).toBeGreaterThan(rawByteLength);
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
