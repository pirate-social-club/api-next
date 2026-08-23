import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Predicate, Schema } from "effect";
import type { HnsOwnershipSource } from "./hns-control-observer.ts";

export const HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_ENTRIES = 16 as const;
export const HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES = 4_096 as const;
export const HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_BYTES = 7_929_848 as const;
export const HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES = 10_485_760 as const;
export const HNS_CONTROL_OBSERVER_SNAPSHOT_REFERENCE_MAX_BYTES = 424 as const;

export const HNS_CONTROL_OBSERVER_HSD_METHODS = [
  "getblockchaininfo",
  "getblockheader",
  "getnameinfo",
  "getnameresource",
] as const;

export type HnsControlObserverHsdMethod = (typeof HNS_CONTROL_OBSERVER_HSD_METHODS)[number];
export type HnsControlObserverTransportOutcome =
  | "response"
  | "timeout"
  | "transport_error"
  | "aborted";

export type HnsControlObserverTranscriptEntryV1 = Readonly<{
  readonly driver_reference: string;
  readonly ownership_source: HnsOwnershipSource;
  readonly method_or_view_id: string;
  readonly request_bytes: Uint8Array;
  readonly request_sha256: Sha256HexValue;
  readonly transport_outcome: HnsControlObserverTransportOutcome;
  readonly transport_status: number | null;
  readonly response_bytes: Uint8Array | null;
  readonly response_sha256: Sha256HexValue | null;
}>;

export type HnsControlObserverReservationInput = Readonly<{
  readonly observation_id: string;
  readonly request_bytes: Uint8Array;
  readonly request_sha256: Sha256HexValue;
  readonly configuration_bytes: Uint8Array;
  readonly provider_configuration_digest: Sha256HexValue;
  readonly reservation_lease_seconds: number;
}>;

export type HnsControlObserverReservationOutcome =
  | Readonly<{
      readonly kind: "acquired";
      readonly observer_fence: number;
      readonly reservation_database_time: string;
      readonly lease_expires_at: string;
      readonly snapshot_reference: string;
    }>
  | Readonly<{
      readonly kind: "replay";
      readonly snapshot_reference: string;
      readonly result_bytes: Uint8Array;
      readonly result_sha256: Sha256HexValue;
    }>
  | Readonly<{
      readonly kind: "busy";
      readonly retry_after_seconds: number;
    }>
  | Readonly<{ readonly kind: "mismatch" }>;

export type HnsControlObserverSnapshotFinalizeInput = Readonly<{
  readonly observation_id: string;
  readonly observer_fence: number;
  readonly request_sha256: Sha256HexValue;
  readonly provider_configuration_digest: Sha256HexValue;
  readonly snapshot_reference: string;
  readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
  readonly semantic_facts_bytes: Uint8Array;
  readonly result_bytes: Uint8Array;
  readonly result_sha256: Sha256HexValue;
}>;

export type HnsControlObserverSnapshotLogicalPayload = HnsControlObserverSnapshotFinalizeInput &
  Readonly<{
    readonly request_bytes: Uint8Array;
    readonly configuration_bytes: Uint8Array;
    readonly reservation_database_time: string;
    readonly lease_expires_at: string;
    readonly result_status: "verified" | "rejected" | "unavailable";
    readonly result_reference_kind: "provider_evidence_ref" | "diagnostic_ref";
  }>;

export type HnsControlObserverSnapshotFinalizeOutcome =
  | Readonly<{
      readonly kind: "retained";
      readonly snapshot_reference: string;
      readonly result_bytes: Uint8Array;
      readonly result_sha256: Sha256HexValue;
    }>
  | Readonly<{
      readonly kind: "replay";
      readonly snapshot_reference: string;
      readonly result_bytes: Uint8Array;
      readonly result_sha256: Sha256HexValue;
    }>
  | Readonly<{ readonly kind: "lost" }>
  | Readonly<{ readonly kind: "mismatch" }>;

export type HnsControlObserverSnapshotStorePort = Readonly<{
  /**
   * Uses the store's database clock. Implementations compare exact request and
   * configuration bytes as well as their hashes before replay or reacquisition.
   */
  /** Must reject promptly and perform no later write when `signal` aborts. */
  readonly reserve: (
    input: HnsControlObserverReservationInput,
    options: Readonly<{ readonly deadline_ms: number; readonly signal: AbortSignal }>,
  ) => Promise<HnsControlObserverReservationOutcome>;
  /**
   * Atomically requires the current reserved fence and an unexpired database-
   * time lease. Lost fences cannot retain semantic results.
   */
  /** Must reject promptly and perform no later write when `signal` aborts. */
  readonly finalize: (
    input: HnsControlObserverSnapshotFinalizeInput,
    options: Readonly<{ readonly deadline_ms: number; readonly signal: AbortSignal }>,
  ) => Promise<HnsControlObserverSnapshotFinalizeOutcome>;
}>;

export type HnsControlObserverHsdTransportResponse = Readonly<{
  readonly status: number;
  readonly content_type: string | null;
  readonly response_bytes: Uint8Array;
}>;

export class HnsControlObserverHsdTransportError extends Error {
  readonly name = "HnsControlObserverHsdTransportError";

  constructor(readonly outcome: Exclude<HnsControlObserverTransportOutcome, "response">) {
    super(outcome);
  }
}

export type HnsControlObserverHsdTransportPort = Readonly<{
  /**
   * The injected transport owns endpoint and authentication material. Neither
   * is present in the request DTO or returned transcript.
   */
  readonly exchange: (
    input: Readonly<{
      readonly driver_reference: string;
      readonly method: HnsControlObserverHsdMethod;
      readonly request_bytes: Uint8Array;
      readonly response_max_bytes: number;
      readonly signal: AbortSignal;
    }>,
  ) => Promise<HnsControlObserverHsdTransportResponse>;
}>;

export type HnsControlObserverAuthoritativeDnsTransportPort = Readonly<{
  readonly query: (
    input: Readonly<{
      readonly driver_reference: string;
      readonly view_id: string;
      readonly name: string;
      readonly response_max_bytes: number;
      readonly signal: AbortSignal;
    }>,
  ) => Promise<Uint8Array>;
}>;

export type HnsControlObserverTranscriptValidationContext = Readonly<{
  readonly ownership_source: HnsOwnershipSource;
  readonly hsd_driver_reference: string;
  readonly hsd_response_max_bytes: number;
  readonly authoritative_dns_driver_reference: string | null;
  readonly authoritative_dns_response_max_bytes: number | null;
  readonly required_view_ids: ReadonlyArray<string>;
}>;

export class HnsControlObserverTranscriptError extends Error {
  readonly name = "HnsControlObserverTranscriptError";

  constructor(
    readonly reason: "invalid_transcript" | "observer_capacity",
    message: string,
  ) {
    super(message);
  }
}

const snapshotReferencePattern = /^[a-z][a-z0-9-]{0,31}(?::[a-z0-9][a-z0-9._-]{0,127}){1,3}$/u;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isHnsControlObserverSnapshotReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    utf8Length(value) <= HNS_CONTROL_OBSERVER_SNAPSHOT_REFERENCE_MAX_BYTES &&
    snapshotReferencePattern.test(value)
  );
}

export function hnsControlObserverTranscriptByteLength(
  transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>,
): number {
  let total = 0;
  for (const entry of transcript) {
    total += entry.request_bytes.byteLength;
    total += entry.response_bytes?.byteLength ?? 0;
    if (!Number.isSafeInteger(total)) return Number.POSITIVE_INFINITY;
  }
  return total;
}

/**
 * Counts exact retained byte strings plus a compact JSON accounting envelope
 * in which every byte string is represented by its decimal byte length. This
 * includes hashes, identifiers, statuses, and structural metadata without
 * base64 expansion or dependence on a physical Postgres representation.
 */
export function hnsControlObserverSnapshotAccountingEnvelopeBytes(
  input: HnsControlObserverSnapshotLogicalPayload,
): Uint8Array {
  const accountingEnvelope = {
    observation_id: input.observation_id,
    observer_fence: input.observer_fence,
    reservation_database_time: input.reservation_database_time,
    lease_expires_at: input.lease_expires_at,
    request_bytes: input.request_bytes.byteLength,
    request_sha256: input.request_sha256,
    configuration_bytes: input.configuration_bytes.byteLength,
    provider_configuration_digest: input.provider_configuration_digest,
    snapshot_reference: input.snapshot_reference,
    transcript: input.transcript.map((entry) => ({
      driver_reference: entry.driver_reference,
      ownership_source: entry.ownership_source,
      method_or_view_id: entry.method_or_view_id,
      request_bytes: entry.request_bytes.byteLength,
      request_sha256: entry.request_sha256,
      transport_outcome: entry.transport_outcome,
      transport_status: entry.transport_status,
      response_bytes: entry.response_bytes?.byteLength ?? null,
      response_sha256: entry.response_sha256,
    })),
    transcript_entry_count: input.transcript.length,
    transcript_byte_length: hnsControlObserverTranscriptByteLength(input.transcript),
    semantic_facts_bytes: input.semantic_facts_bytes.byteLength,
    result_status: input.result_status,
    result_reference_kind: input.result_reference_kind,
    result_reference: input.snapshot_reference,
    result_bytes: input.result_bytes.byteLength,
    result_sha256: input.result_sha256,
  };
  return new TextEncoder().encode(JSON.stringify(accountingEnvelope));
}

export function hnsControlObserverSnapshotLogicalByteLength(
  input: HnsControlObserverSnapshotLogicalPayload,
): number {
  const rawByteLength =
    input.request_bytes.byteLength +
    input.configuration_bytes.byteLength +
    input.semantic_facts_bytes.byteLength +
    input.result_bytes.byteLength +
    hnsControlObserverTranscriptByteLength(input.transcript);
  const metadataByteLength = hnsControlObserverSnapshotAccountingEnvelopeBytes(input).byteLength;
  const total = rawByteLength + metadataByteLength;
  return Number.isSafeInteger(total) ? total : Number.POSITIVE_INFINITY;
}

async function sha256Bytes(bytes: Uint8Array): Promise<Sha256HexValue> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const value = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return Schema.decodeUnknownSync(Sha256Hex)(value);
}

function failTranscript(message: string): never {
  throw new HnsControlObserverTranscriptError("invalid_transcript", message);
}

function failCapacity(message: string): never {
  throw new HnsControlObserverTranscriptError("observer_capacity", message);
}

export async function validateHnsControlObserverTranscript(
  input: Readonly<{
    readonly transcript: unknown;
    readonly context: HnsControlObserverTranscriptValidationContext;
  }>,
): Promise<ReadonlyArray<HnsControlObserverTranscriptEntryV1>> {
  if (!Array.isArray(input.transcript)) {
    return failTranscript("HNS observer transcript must be an array");
  }
  if (input.transcript.length > HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_ENTRIES) {
    return failCapacity("HNS observer transcript entry limit was exceeded");
  }
  if (
    !Number.isSafeInteger(input.context.hsd_response_max_bytes) ||
    input.context.hsd_response_max_bytes <= 0 ||
    (input.context.authoritative_dns_driver_reference === null) !==
      (input.context.authoritative_dns_response_max_bytes === null) ||
    (input.context.authoritative_dns_driver_reference === null) !==
      (input.context.required_view_ids.length === 0) ||
    (input.context.authoritative_dns_response_max_bytes !== null &&
      (!Number.isSafeInteger(input.context.authoritative_dns_response_max_bytes) ||
        input.context.authoritative_dns_response_max_bytes <= 0))
  ) {
    return failTranscript("HNS observer transcript context is invalid");
  }

  let aggregateBytes = 0;
  const retained: HnsControlObserverTranscriptEntryV1[] = [];
  for (const raw of input.transcript) {
    if (!Predicate.isObject(raw) || Array.isArray(raw)) {
      return failTranscript("HNS observer transcript entry must be an object");
    }
    const entry = raw as Partial<HnsControlObserverTranscriptEntryV1>;
    if (
      entry.ownership_source !== input.context.ownership_source ||
      typeof entry.driver_reference !== "string" ||
      typeof entry.method_or_view_id !== "string"
    ) {
      return failTranscript("HNS observer transcript entry authority is invalid");
    }
    const isHsdMethod = (HNS_CONTROL_OBSERVER_HSD_METHODS as ReadonlyArray<string>).includes(
      entry.method_or_view_id,
    );
    const isHsdEntry = entry.driver_reference === input.context.hsd_driver_reference && isHsdMethod;
    const isDnsEntry =
      input.context.ownership_source === "owner_authoritative_dns_txt" &&
      input.context.authoritative_dns_driver_reference !== null &&
      entry.driver_reference === input.context.authoritative_dns_driver_reference &&
      input.context.required_view_ids.includes(entry.method_or_view_id);
    if (isHsdEntry === isDnsEntry) {
      return failTranscript("HNS observer transcript driver or method is invalid");
    }
    if (!(entry.request_bytes instanceof Uint8Array) || entry.request_bytes.byteLength === 0) {
      return failTranscript("HNS observer transcript request bytes are invalid");
    }
    if (entry.request_bytes.byteLength > HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES) {
      return failCapacity("HNS observer driver request byte limit was exceeded");
    }
    if (!Schema.is(Sha256Hex)(entry.request_sha256)) {
      return failTranscript("HNS observer transcript request hash is invalid");
    }
    const requestBytes = new Uint8Array(entry.request_bytes);
    if ((await sha256Bytes(requestBytes)) !== entry.request_sha256) {
      return failTranscript("HNS observer transcript request hash does not match its bytes");
    }
    if (
      entry.transport_outcome !== "response" &&
      entry.transport_outcome !== "timeout" &&
      entry.transport_outcome !== "transport_error" &&
      entry.transport_outcome !== "aborted"
    ) {
      return failTranscript("HNS observer transcript transport outcome is invalid");
    }

    let responseBytes: Uint8Array | null = null;
    let responseHash: Sha256HexValue | null = null;
    if (entry.transport_outcome === "response") {
      if (!(entry.response_bytes instanceof Uint8Array) || entry.response_bytes.byteLength === 0) {
        return failTranscript("HNS observer response outcome requires response bytes");
      }
      const responseLimit = isHsdEntry
        ? input.context.hsd_response_max_bytes
        : input.context.authoritative_dns_response_max_bytes;
      if (responseLimit === null) {
        return failTranscript("HNS observer DNS transcript lacks a response limit");
      }
      if (entry.response_bytes.byteLength > responseLimit) {
        return failCapacity("HNS observer driver response byte limit was exceeded");
      }
      if (!Schema.is(Sha256Hex)(entry.response_sha256)) {
        return failTranscript("HNS observer transcript response hash is invalid");
      }
      if (
        isHsdEntry
          ? !Number.isSafeInteger(entry.transport_status) ||
            (entry.transport_status ?? 0) < 100 ||
            (entry.transport_status ?? 0) > 599
          : entry.transport_status !== null
      ) {
        return failTranscript("HNS observer transcript transport status is invalid");
      }
      responseBytes = new Uint8Array(entry.response_bytes);
      responseHash = entry.response_sha256;
      if ((await sha256Bytes(responseBytes)) !== responseHash) {
        return failTranscript("HNS observer transcript response hash does not match its bytes");
      }
    } else if (
      entry.transport_status !== null ||
      entry.response_bytes !== null ||
      entry.response_sha256 !== null
    ) {
      return failTranscript("HNS observer no-response outcome contains response authority");
    }

    aggregateBytes += requestBytes.byteLength + (responseBytes?.byteLength ?? 0);
    if (
      !Number.isSafeInteger(aggregateBytes) ||
      aggregateBytes > HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_BYTES
    ) {
      return failCapacity("HNS observer aggregate transcript byte limit was exceeded");
    }
    retained.push({
      driver_reference: entry.driver_reference,
      ownership_source: entry.ownership_source,
      method_or_view_id: entry.method_or_view_id,
      request_bytes: requestBytes,
      request_sha256: entry.request_sha256,
      transport_outcome: entry.transport_outcome,
      transport_status: entry.transport_status ?? null,
      response_bytes: responseBytes,
      response_sha256: responseHash,
    });
  }
  return retained;
}
