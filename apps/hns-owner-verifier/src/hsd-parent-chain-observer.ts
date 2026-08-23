import {
  decodeHnsControlObservationRequestBytes,
  decodeHnsControlObservationResultBytes,
  decodeStrictHnsJsonBytes,
  HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES,
  HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES,
  HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_BYTES,
  type HnsChainAuthorityRecord,
  type HnsControlObservationRejectedReason,
  type HnsControlObservationRequestV1,
  type HnsControlObservationResultV1,
  type HnsControlObservationUnavailableReason,
  HnsControlObserverConfigurationError,
  type HnsControlObserverConfigurationResolverPort,
  type HnsControlObserverConfigurationV1,
  HnsControlObserverHsdTransportError,
  type HnsControlObserverHsdTransportPort,
  type HnsControlObserverHsdTransportResponse,
  type HnsControlObserverRuntimeCapabilities,
  type HnsControlObserverSnapshotStorePort,
  type HnsControlObserverTranscriptEntryV1,
  HnsControlObserverTranscriptError,
  type HnsEvidenceLeasePolicy,
  type HnsOwnershipSource,
  hnsChainAuthorityDigest,
  hnsChainAuthorityRecords,
  hnsControlIdentityDigest,
  hnsControlObservationRequestHash,
  hnsControlObserverSnapshotLogicalByteLength,
  hnsControlObserverTranscriptByteLength,
  hnsObservedTxtValuesDigest,
  isHnsControlObserverSnapshotReference,
  resolveHnsControlObserverConfiguration,
  validateHnsControlObserverTranscript,
} from "@pirate/application/namespace-ownership";
import { Predicate } from "effect";
import { type HnsTargetObserverPort, HnsTargetObserverPortError } from "./target-observer.ts";
import {
  finalizeHnsControlObserverResult,
  type HnsTargetObserverExecutionResult,
  makeHnsRejectedControlResult,
  makeHnsUnavailableControlResult,
  makeHnsVerifiedControlResult,
} from "./target-observer-result.ts";

type Sha256HexValue = HnsControlObservationRequestV1["provider_configuration_digest"];

const encoder = new TextEncoder();
const jsonContentTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const hsdMethodNotFound = -32_601;
const hsdInvalidParams = -32_602;

export type HnsStableHsdChainAnchorV1 = Readonly<{
  network: string;
  height: number;
  best_block_hash: Sha256HexValue;
  median_time: number;
  header_time: number;
  confirmations: number;
}>;

export type HnsStableHsdRootDecisionV1 =
  | Readonly<{ readonly kind: "root_absent"; readonly expiry_height: null }>
  | Readonly<{
      readonly kind: "root_inactive";
      readonly expiry_height: number | null;
    }>
  | Readonly<{
      readonly kind: "active";
      readonly expiry_height: number;
    }>;

export type HnsStableHsdBracketV1 = Readonly<{
  readonly request_authority: Readonly<{
    readonly provider_id: string;
    readonly provider_configuration_reference: string;
    readonly provider_configuration_version: string;
    readonly provider_configuration_digest: Sha256HexValue;
    readonly environment: string;
    readonly ownership_source: HnsOwnershipSource;
    readonly root_label: string;
    readonly chain_network: string;
    readonly chain_genesis_block_hash: Sha256HexValue;
    readonly chain_driver_reference: string;
  }>;
  readonly anchor_a: HnsStableHsdChainAnchorV1;
  readonly anchor_b: HnsStableHsdChainAnchorV1;
  readonly root: HnsStableHsdRootDecisionV1;
  readonly txt_records: ReadonlyArray<ReadonlyArray<string>>;
  readonly authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
  readonly chain_authority_digest: Sha256HexValue;
  readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
}>;

export type HnsStableHsdBracketResultV1 =
  | Readonly<{
      readonly kind: "stable";
      readonly bracket: HnsStableHsdBracketV1;
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly reason: HnsControlObservationUnavailableReason;
      readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
    }>;

export type HnsParentChainObserverResult = HnsTargetObserverExecutionResult;

export class HnsStableHsdBracketError extends HnsTargetObserverPortError {
  override readonly name: string = "HnsStableHsdBracketError";

  constructor(
    readonly reason:
      | "invalid_request"
      | "misconfigured"
      | "transport_unavailable"
      | "invalid_response",
    message: string,
  ) {
    super(reason, message);
  }
}

export class HnsParentChainObserverError extends HnsStableHsdBracketError {
  override readonly name: string = "HnsParentChainObserverError";
}

class HsdSemanticUnavailable extends Error {
  readonly name = "HsdSemanticUnavailable";

  constructor(readonly reason: HnsControlObservationUnavailableReason) {
    super(reason);
  }
}

function abortStableHsdIfSet(signal: AbortSignal, message: string): void {
  if (signal.aborted) {
    throw new HnsStableHsdBracketError("transport_unavailable", message);
  }
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function sameLeasePolicy(
  expected: HnsEvidenceLeasePolicy,
  configuration: HnsControlObserverConfigurationV1,
): boolean {
  return (
    expected.expected_block_interval_seconds ===
      configuration.chain.expected_block_interval_seconds &&
    expected.minimum_safe_remaining_blocks === configuration.chain.minimum_safe_remaining_blocks &&
    expected.expiry_safety_blocks === configuration.chain.expiry_safety_blocks &&
    expected.evidence_lease_seconds === configuration.evidence_lease_seconds
  );
}

function sha256Bytes(bytes: Uint8Array): Promise<Sha256HexValue> {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) => {
    const value = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return value as Sha256HexValue;
  });
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!Predicate.isObject(value) || Array.isArray(value)) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  return value as Record<string, unknown>;
}

function requireKeys(value: Record<string, unknown>, expected: ReadonlyArray<string>): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
}

function readHash(value: unknown): Sha256HexValue {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  return value as Sha256HexValue;
}

function hsdName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.toLowerCase() ||
    !value.endsWith(".") ||
    value.endsWith("..")
  ) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  const canonical = value.slice(0, -1);
  hnsChainAuthorityRecords("owner_authoritative_dns_txt", [["NS", canonical]]);
  return canonical;
}

type ParsedHsdResourceRecord = Readonly<{
  readonly txt: ReadonlyArray<string> | null;
  readonly authority: HnsChainAuthorityRecord | null;
}>;

function validateResourceRecord(value: unknown): ParsedHsdResourceRecord {
  const record = requireObject(value);
  switch (record.type) {
    case "TXT": {
      requireKeys(record, ["type", "txt"]);
      if (!Array.isArray(record.txt) || record.txt.length === 0) {
        throw new HsdSemanticUnavailable("chain_response_invalid");
      }
      const chunks: string[] = [];
      for (const chunk of record.txt) {
        if (
          typeof chunk !== "string" ||
          encoder.encode(chunk).byteLength > 255 ||
          [...chunk].some((character) => {
            const point = character.codePointAt(0) ?? 0;
            return point >= 0xd800 && point <= 0xdfff;
          })
        ) {
          throw new HsdSemanticUnavailable("chain_response_invalid");
        }
        chunks.push(chunk);
      }
      return { txt: chunks, authority: null };
    }
    case "NS": {
      requireKeys(record, ["type", "ns"]);
      return { txt: null, authority: ["NS", hsdName(record.ns)] };
    }
    case "GLUE4":
    case "GLUE6": {
      requireKeys(record, ["type", "ns", "address"]);
      const name = hsdName(record.ns);
      if (typeof record.address !== "string") {
        throw new HsdSemanticUnavailable("chain_response_invalid");
      }
      const authority: HnsChainAuthorityRecord =
        record.type === "GLUE4" ? ["GLUE4", name, record.address] : ["GLUE6", name, record.address];
      hnsChainAuthorityRecords("owner_authoritative_dns_txt", [authority]);
      return { txt: null, authority };
    }
    case "SYNTH4":
    case "SYNTH6": {
      requireKeys(record, ["type", "address"]);
      if (typeof record.address !== "string") {
        throw new HsdSemanticUnavailable("chain_response_invalid");
      }
      const authority: HnsChainAuthorityRecord =
        record.type === "SYNTH4"
          ? ["GLUE4", "synth.invalid", record.address]
          : ["GLUE6", "synth.invalid", record.address];
      hnsChainAuthorityRecords("owner_authoritative_dns_txt", [authority]);
      return { txt: null, authority: null };
    }
    case "DS": {
      requireKeys(record, ["type", "keyTag", "algorithm", "digestType", "digest"]);
      if (
        typeof record.keyTag !== "number" ||
        typeof record.algorithm !== "number" ||
        typeof record.digestType !== "number" ||
        typeof record.digest !== "string"
      ) {
        throw new HsdSemanticUnavailable("chain_response_invalid");
      }
      const authority = [
        "DS",
        record.keyTag,
        record.algorithm,
        record.digestType,
        record.digest.toLowerCase(),
      ] as const;
      hnsChainAuthorityRecords("owner_authoritative_dns_txt", [authority]);
      return { txt: null, authority };
    }
    default:
      throw new HsdSemanticUnavailable("chain_response_invalid");
  }
}

function parseResource(value: unknown): Readonly<{
  readonly txt_records: ReadonlyArray<ReadonlyArray<string>>;
  readonly authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
}> {
  if (value === null) return { txt_records: [], authority_records: [] };
  const resource = requireObject(value);
  requireKeys(resource, ["records"]);
  if (!Array.isArray(resource.records)) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  const txtRecords: Array<ReadonlyArray<string>> = [];
  const authorityRecords: HnsChainAuthorityRecord[] = [];
  for (const record of resource.records) {
    const parsed = validateResourceRecord(record);
    if (parsed.txt !== null) txtRecords.push(parsed.txt);
    if (parsed.authority !== null) authorityRecords.push(parsed.authority);
  }
  return {
    txt_records: txtRecords,
    authority_records: hnsChainAuthorityRecords("owner_authoritative_dns_txt", authorityRecords),
  };
}

function parseChainInfo(
  value: unknown,
  configuration: HnsControlObserverConfigurationV1,
): {
  readonly network: string;
  readonly height: number;
  readonly best_block_hash: Sha256HexValue;
  readonly median_time: number;
} {
  const result = requireObject(value);
  const height = safeInteger(result.blocks);
  const headers = safeInteger(result.headers);
  const medianTime = safeInteger(result.mediantime);
  const progress = result.verificationprogress;
  if (
    result.chain !== configuration.chain.network ||
    height === null ||
    headers === null ||
    medianTime === null ||
    typeof progress !== "number" ||
    !Number.isFinite(progress) ||
    progress < 0 ||
    progress > 1
  ) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  const bestBlockHash = readHash(result.bestblockhash);
  if (
    height !== headers ||
    Math.floor(progress * 1_000_000) < configuration.chain.minimum_verification_progress_millionths
  ) {
    throw new HsdSemanticUnavailable("chain_unsynchronized");
  }
  return {
    network: configuration.chain.network,
    height,
    best_block_hash: bestBlockHash,
    median_time: medianTime,
  };
}

function parseBestHeader(
  value: unknown,
  expected: Readonly<{
    readonly hash: Sha256HexValue;
    readonly height: number;
    readonly median_time: number;
  }>,
): Readonly<{ readonly time: number; readonly confirmations: number }> {
  const header = requireObject(value);
  const height = safeInteger(header.height);
  const medianTime = safeInteger(header.mediantime);
  const time = safeInteger(header.time);
  const confirmations = safeInteger(header.confirmations);
  if (
    readHash(header.hash) !== expected.hash ||
    height !== expected.height ||
    medianTime !== expected.median_time ||
    time === null ||
    confirmations === null ||
    confirmations < 1
  ) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  return { time, confirmations };
}

function parseGenesisHeader(value: unknown, configuredHash: Sha256HexValue): void {
  const header = requireObject(value);
  if (readHash(header.hash) !== configuredHash || safeInteger(header.height) !== 0) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
}

function parseRootDecision(value: unknown, anchorHeight: number): HnsStableHsdRootDecisionV1 {
  const envelope = requireObject(value);
  if (!("info" in envelope)) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  if (envelope.info === null) return { kind: "root_absent", expiry_height: null };
  const info = requireObject(envelope.info);
  if (
    typeof info.state !== "string" ||
    typeof info.registered !== "boolean" ||
    typeof info.expired !== "boolean"
  ) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  const state = info.state;
  if (
    state === "LOCKED" ||
    !["OPENING", "BIDDING", "REVEAL", "CLOSED", "REVOKED"].includes(state)
  ) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  const active = state === "CLOSED" && info.registered && !info.expired;
  const stats = info.stats;
  if (active) {
    const values = requireObject(stats);
    const expiryHeight = safeInteger(values.renewalPeriodEnd);
    const blocksUntilExpire = safeInteger(values.blocksUntilExpire);
    if (
      expiryHeight === null ||
      blocksUntilExpire === null ||
      blocksUntilExpire !== expiryHeight - anchorHeight
    ) {
      throw new HsdSemanticUnavailable("chain_response_invalid");
    }
    return { kind: "active", expiry_height: expiryHeight };
  }
  if (stats === undefined || stats === null) {
    return { kind: "root_inactive", expiry_height: null };
  }
  const values = requireObject(stats);
  const expiryHeight = safeInteger(values.renewalPeriodEnd);
  const blocksUntilExpire = safeInteger(values.blocksUntilExpire);
  if (
    expiryHeight === null ||
    blocksUntilExpire === null ||
    blocksUntilExpire !== expiryHeight - anchorHeight
  ) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  return { kind: "root_inactive", expiry_height: expiryHeight };
}

async function transcriptEntry(
  input: Readonly<{
    readonly method: HnsControlObserverTranscriptEntryV1["method_or_view_id"];
    readonly request_bytes: Uint8Array;
    readonly outcome: HnsControlObserverTranscriptEntryV1["transport_outcome"];
    readonly status: number | null;
    readonly response_bytes: Uint8Array | null;
    readonly driver_reference: string;
    readonly ownership_source: HnsOwnershipSource;
    readonly signal: AbortSignal;
  }>,
): Promise<HnsControlObserverTranscriptEntryV1> {
  if (input.signal.aborted) {
    throw new HnsStableHsdBracketError(
      "transport_unavailable",
      "HNS stable HSD transcript recording started after abort",
    );
  }
  const requestSha256 = await sha256Bytes(input.request_bytes);
  if (input.signal.aborted) {
    throw new HnsStableHsdBracketError(
      "transport_unavailable",
      "HNS stable HSD transcript request hashing completed after abort",
    );
  }
  const responseSha256 =
    input.response_bytes === null ? null : await sha256Bytes(input.response_bytes);
  if (input.signal.aborted) {
    throw new HnsStableHsdBracketError(
      "transport_unavailable",
      "HNS stable HSD transcript response hashing completed after abort",
    );
  }
  return {
    driver_reference: input.driver_reference,
    ownership_source: input.ownership_source,
    method_or_view_id: input.method,
    request_bytes: new Uint8Array(input.request_bytes),
    request_sha256: requestSha256,
    transport_outcome: input.outcome,
    transport_status: input.status,
    response_bytes: input.response_bytes === null ? null : new Uint8Array(input.response_bytes),
    response_sha256: responseSha256,
  };
}

async function hsdRpc(
  input: Readonly<{
    readonly method: "getblockchaininfo" | "getblockheader" | "getnameinfo" | "getnameresource";
    readonly params: ReadonlyArray<unknown>;
    readonly configuration: HnsControlObserverConfigurationV1;
    readonly ownership_source: HnsOwnershipSource;
    readonly transport: HnsControlObserverHsdTransportPort;
    readonly signal: AbortSignal;
    readonly transcript: HnsControlObserverTranscriptEntryV1[];
  }>,
): Promise<unknown> {
  if (input.signal.aborted) {
    throw new HnsStableHsdBracketError(
      "transport_unavailable",
      "HNS stable HSD RPC started after abort",
    );
  }
  const requestBytes = encoder.encode(
    JSON.stringify({ method: input.method, params: input.params }),
  );
  if (requestBytes.byteLength > HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES) {
    throw new HsdSemanticUnavailable("observer_capacity");
  }
  const aggregateBeforeResponse =
    hnsControlObserverTranscriptByteLength(input.transcript) + requestBytes.byteLength;
  if (aggregateBeforeResponse > HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_BYTES) {
    throw new HsdSemanticUnavailable("observer_capacity");
  }
  let response: HnsControlObserverHsdTransportResponse;
  try {
    response = await input.transport.exchange({
      driver_reference: input.configuration.chain.driver_reference,
      method: input.method,
      request_bytes: new Uint8Array(requestBytes),
      response_max_bytes: input.configuration.chain.response_max_bytes,
      signal: input.signal,
    });
    if (input.signal.aborted) {
      throw new HnsStableHsdBracketError(
        "transport_unavailable",
        "HNS stable HSD driver returned after its deadline",
      );
    }
  } catch (error) {
    if (error instanceof HnsStableHsdBracketError) throw error;
    const outcome =
      error instanceof HnsControlObserverHsdTransportError
        ? error.outcome
        : input.signal.aborted
          ? "aborted"
          : "transport_error";
    input.transcript.push(
      await transcriptEntry({
        method: input.method,
        request_bytes: requestBytes,
        outcome,
        status: null,
        response_bytes: null,
        driver_reference: input.configuration.chain.driver_reference,
        ownership_source: input.ownership_source,
        signal: input.signal,
      }),
    );
    if (input.signal.aborted) {
      throw new HnsStableHsdBracketError(
        "transport_unavailable",
        "HNS stable HSD transcript recording completed after abort",
      );
    }
    if (outcome === "aborted") {
      throw new HnsStableHsdBracketError(
        "transport_unavailable",
        "HNS stable HSD observation was aborted",
      );
    }
    throw new HsdSemanticUnavailable("chain_transport_unavailable");
  }
  if (!(response.response_bytes instanceof Uint8Array)) {
    throw new HnsStableHsdBracketError(
      "invalid_response",
      "HNS transport returned non-byte response authority",
    );
  }
  const responseBytes = response.response_bytes.slice(
    0,
    Math.min(
      input.configuration.chain.response_max_bytes,
      HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_BYTES - aggregateBeforeResponse,
    ),
  );
  if (responseBytes.byteLength === 0) {
    throw new HsdSemanticUnavailable("observer_capacity");
  }
  input.transcript.push(
    await transcriptEntry({
      method: input.method,
      request_bytes: requestBytes,
      outcome: "response",
      status: response.status,
      response_bytes: responseBytes,
      driver_reference: input.configuration.chain.driver_reference,
      ownership_source: input.ownership_source,
      signal: input.signal,
    }),
  );
  if (input.signal.aborted) {
    throw new HnsStableHsdBracketError(
      "transport_unavailable",
      "HNS stable HSD transcript recording completed after abort",
    );
  }
  if (
    response.response_bytes.byteLength > input.configuration.chain.response_max_bytes ||
    response.response_bytes.byteLength > responseBytes.byteLength
  ) {
    throw new HsdSemanticUnavailable("observer_capacity");
  }
  if (response.status !== 200) {
    throw new HsdSemanticUnavailable("chain_transport_unavailable");
  }
  if (
    response.content_type === null ||
    !jsonContentTypePattern.test(response.content_type.trim())
  ) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  let decoded: unknown;
  try {
    decoded = decodeStrictHnsJsonBytes(responseBytes, input.configuration.chain.response_max_bytes);
  } catch {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  const envelope = requireObject(decoded);
  requireKeys(envelope, ["result", "error", "id"]);
  if (envelope.id !== null) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  if (envelope.error === null && envelope.result !== null) return envelope.result;
  if (envelope.result !== null || envelope.error === null) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  const rpcError = requireObject(envelope.error);
  requireKeys(rpcError, ["message", "code"]);
  if (typeof rpcError.message !== "string" || !Number.isSafeInteger(rpcError.code)) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  if (rpcError.code === hsdMethodNotFound || rpcError.code === hsdInvalidParams) {
    throw new HnsStableHsdBracketError(
      "misconfigured",
      "HNS HSD driver does not implement the pinned RPC contract",
    );
  }
  throw new HsdSemanticUnavailable("chain_transport_unavailable");
}

async function chainAnchor(
  input: Readonly<{
    readonly configuration: HnsControlObserverConfigurationV1;
    readonly ownership_source: HnsOwnershipSource;
    readonly transport: HnsControlObserverHsdTransportPort;
    readonly signal: AbortSignal;
    readonly transcript: HnsControlObserverTranscriptEntryV1[];
    readonly reservation_database_time: string;
  }>,
): Promise<HnsStableHsdChainAnchorV1> {
  const chain = parseChainInfo(
    await hsdRpc({
      method: "getblockchaininfo",
      params: [],
      ...input,
    }),
    input.configuration,
  );
  const header = parseBestHeader(
    await hsdRpc({
      method: "getblockheader",
      params: [chain.best_block_hash, true],
      ...input,
    }),
    {
      hash: chain.best_block_hash,
      height: chain.height,
      median_time: chain.median_time,
    },
  );
  const databaseTime = Date.parse(input.reservation_database_time);
  if (
    !Number.isFinite(databaseTime) ||
    new Date(databaseTime).toISOString() !== input.reservation_database_time
  ) {
    throw new HnsStableHsdBracketError(
      "invalid_response",
      "HNS observer reservation database time is invalid",
    );
  }
  const ageSeconds = Math.floor(databaseTime / 1_000) - header.time;
  if (ageSeconds > input.configuration.chain.maximum_tip_age_seconds) {
    throw new HsdSemanticUnavailable("chain_view_stale");
  }
  if (ageSeconds < -input.configuration.chain.maximum_future_tip_seconds) {
    throw new HsdSemanticUnavailable("chain_response_invalid");
  }
  return {
    network: chain.network,
    height: chain.height,
    best_block_hash: chain.best_block_hash,
    median_time: chain.median_time,
    header_time: header.time,
    confirmations: header.confirmations,
  };
}

function sameAnchor(left: HnsStableHsdChainAnchorV1, right: HnsStableHsdChainAnchorV1): boolean {
  return (
    left.network === right.network &&
    left.height === right.height &&
    left.best_block_hash === right.best_block_hash &&
    left.median_time === right.median_time &&
    left.header_time === right.header_time &&
    left.confirmations === right.confirmations
  );
}

function immutableTranscript(
  transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>,
): ReadonlyArray<HnsControlObserverTranscriptEntryV1> {
  return Object.freeze(
    transcript.map((entry) =>
      Object.freeze({
        ...entry,
        request_bytes: new Uint8Array(entry.request_bytes),
        response_bytes: entry.response_bytes === null ? null : new Uint8Array(entry.response_bytes),
      }),
    ),
  );
}

/**
 * Reads one source-closed HSD root view bracketed by equal authenticated chain
 * anchors. It performs no authoritative-DNS exchange and owns no snapshot.
 */
export async function observeHnsStableHsdBracket(
  input: Readonly<{
    readonly request: HnsControlObservationRequestV1;
    readonly configuration: HnsControlObserverConfigurationV1;
    readonly reservation_database_time: string;
    readonly transport: HnsControlObserverHsdTransportPort;
    readonly signal: AbortSignal;
  }>,
): Promise<HnsStableHsdBracketResultV1> {
  const expectedTxtName =
    input.request.ownership_source === "hns_parent_chain_txt"
      ? input.request.root_label
      : `_pirate.${input.request.root_label}`;
  if (
    input.request.txt_name !== expectedTxtName ||
    input.request.provider_id !== input.configuration.provider_id ||
    input.request.provider_configuration_reference !==
      input.configuration.provider_configuration_reference ||
    input.request.provider_configuration_version !==
      input.configuration.provider_configuration_version ||
    input.request.environment !== input.configuration.environment ||
    !input.configuration.ownership_sources.includes(input.request.ownership_source)
  ) {
    throw new HnsStableHsdBracketError(
      "invalid_request",
      "HNS stable HSD bracket request and configuration authority differ",
    );
  }
  abortStableHsdIfSet(input.signal, "HNS stable HSD bracket started after abort");
  const transcript: HnsControlObserverTranscriptEntryV1[] = [];
  const transcriptContext = {
    ownership_source: input.request.ownership_source,
    root_label: input.request.root_label,
    hsd_driver_reference: input.configuration.chain.driver_reference,
    hsd_response_max_bytes: input.configuration.chain.response_max_bytes,
    authoritative_dns_driver_reference:
      input.configuration.authoritative_dns?.driver_reference ?? null,
    authoritative_dns_response_max_bytes:
      input.configuration.authoritative_dns?.response_max_bytes ?? null,
    required_view_ids: input.configuration.authoritative_dns?.required_view_ids ?? [],
  } as const;
  try {
    const anchorA = await chainAnchor({
      configuration: input.configuration,
      ownership_source: input.request.ownership_source,
      transport: input.transport,
      signal: input.signal,
      transcript,
      reservation_database_time: input.reservation_database_time,
    });
    parseGenesisHeader(
      await hsdRpc({
        method: "getblockheader",
        params: [input.configuration.chain.genesis_block_hash, true],
        configuration: input.configuration,
        ownership_source: input.request.ownership_source,
        transport: input.transport,
        signal: input.signal,
        transcript,
      }),
      input.configuration.chain.genesis_block_hash,
    );
    const root = parseRootDecision(
      await hsdRpc({
        method: "getnameinfo",
        params: [input.request.root_label, false],
        configuration: input.configuration,
        ownership_source: input.request.ownership_source,
        transport: input.transport,
        signal: input.signal,
        transcript,
      }),
      anchorA.height,
    );
    const resource =
      root.kind === "active"
        ? parseResource(
            await hsdRpc({
              method: "getnameresource",
              params: [input.request.root_label, false],
              configuration: input.configuration,
              ownership_source: input.request.ownership_source,
              transport: input.transport,
              signal: input.signal,
              transcript,
            }),
          )
        : { txt_records: [], authority_records: [] };
    const anchorB = await chainAnchor({
      configuration: input.configuration,
      ownership_source: input.request.ownership_source,
      transport: input.transport,
      signal: input.signal,
      transcript,
      reservation_database_time: input.reservation_database_time,
    });
    if (!sameAnchor(anchorA, anchorB)) {
      throw new HsdSemanticUnavailable("chain_view_changed");
    }
    const retainedTranscript = await validateHnsControlObserverTranscript({
      transcript,
      context: transcriptContext,
    });
    abortStableHsdIfSet(input.signal, "HNS stable HSD transcript validation completed after abort");
    const authorityRecords =
      input.request.ownership_source === "owner_authoritative_dns_txt"
        ? resource.authority_records
        : [];
    const chainAuthorityDigest = await hnsChainAuthorityDigest({
      chain_network: anchorA.network,
      chain_genesis_block_hash: input.configuration.chain.genesis_block_hash,
      root_label: input.request.root_label,
      ownership_source: input.request.ownership_source,
      authority_records: authorityRecords,
    });
    abortStableHsdIfSet(input.signal, "HNS stable HSD digest completed after abort");
    const retainedAuthorityRecords = Object.freeze(
      authorityRecords.map((record) => Object.freeze([...record]) as HnsChainAuthorityRecord),
    );
    return Object.freeze({
      kind: "stable",
      bracket: Object.freeze({
        request_authority: Object.freeze({
          provider_id: input.request.provider_id,
          provider_configuration_reference: input.request.provider_configuration_reference,
          provider_configuration_version: input.request.provider_configuration_version,
          provider_configuration_digest: input.request.provider_configuration_digest,
          environment: input.request.environment,
          ownership_source: input.request.ownership_source,
          root_label: input.request.root_label,
          chain_network: input.configuration.chain.network,
          chain_genesis_block_hash: input.configuration.chain.genesis_block_hash,
          chain_driver_reference: input.configuration.chain.driver_reference,
        }),
        anchor_a: Object.freeze({ ...anchorA }),
        anchor_b: Object.freeze({ ...anchorB }),
        root: Object.freeze({ ...root }),
        txt_records: Object.freeze(
          resource.txt_records.map((chunks) => Object.freeze([...chunks])),
        ),
        authority_records: retainedAuthorityRecords,
        chain_authority_digest: chainAuthorityDigest,
        transcript: immutableTranscript(retainedTranscript),
      }),
    });
  } catch (error) {
    if (error instanceof HnsStableHsdBracketError) throw error;
    const reason =
      error instanceof HsdSemanticUnavailable
        ? error.reason
        : error instanceof HnsControlObserverTranscriptError && error.reason === "observer_capacity"
          ? "observer_capacity"
          : error instanceof HnsControlObserverTranscriptError
            ? "chain_response_invalid"
            : "observer_internal_error";
    try {
      const retainedTranscript = await validateHnsControlObserverTranscript({
        transcript,
        context: {
          ...transcriptContext,
          terminal_status: "unavailable",
          terminal_reason_code: reason,
        },
      });
      abortStableHsdIfSet(
        input.signal,
        "HNS stable HSD unavailable transcript validation completed after abort",
      );
      return Object.freeze({
        kind: "unavailable",
        reason,
        transcript: immutableTranscript(retainedTranscript),
      });
    } catch (transcriptError) {
      if (transcriptError instanceof HnsStableHsdBracketError) throw transcriptError;
      if (
        transcriptError instanceof HnsControlObserverTranscriptError &&
        transcriptError.reason === "observer_capacity"
      ) {
        return Object.freeze({
          kind: "unavailable",
          reason: "observer_capacity",
          transcript: Object.freeze([]),
        });
      }
      throw new HnsStableHsdBracketError(
        "invalid_response",
        "HNS stable HSD bracket transcript is invalid",
      );
    }
  }
}

async function finalizeResult(
  request: HnsControlObservationRequestV1,
  result: HnsControlObservationResultV1,
  transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>,
  signal: AbortSignal,
): Promise<HnsParentChainObserverResult> {
  return finalizeHnsControlObserverResult({
    request,
    result,
    transcript,
    semantic_facts_bytes: null,
    signal,
    abort_error: (message) => new HnsParentChainObserverError("transport_unavailable", message),
  });
}

function unavailableResult(
  request: HnsControlObservationRequestV1,
  requestHash: Sha256HexValue,
  reason: HnsControlObservationUnavailableReason,
  snapshotReference: string,
): HnsControlObservationResultV1 {
  return makeHnsUnavailableControlResult({
    request,
    request_sha256: requestHash,
    reason,
    snapshot_reference: snapshotReference,
  });
}

function rejectedResult(
  input: Readonly<{
    readonly request: HnsControlObservationRequestV1;
    readonly request_hash: Sha256HexValue;
    readonly reason: HnsControlObservationRejectedReason;
    readonly expected_txt_value_sha256: Sha256HexValue;
    readonly observed_txt_values_digest: Sha256HexValue | null;
    readonly chain_authority_digest: Sha256HexValue;
    readonly chain_anchor: HnsStableHsdChainAnchorV1;
    readonly chain_genesis_block_hash: Sha256HexValue;
    readonly expiry_height: number | null;
    readonly snapshot_reference: string;
  }>,
): HnsControlObservationResultV1 {
  return makeHnsRejectedControlResult({
    request: input.request,
    request_sha256: input.request_hash,
    reason: input.reason,
    expected_txt_value_sha256: input.expected_txt_value_sha256,
    observed_txt_values_digest: input.observed_txt_values_digest,
    chain_authority_digest: input.chain_authority_digest,
    chain_anchor: input.chain_anchor,
    chain_genesis_block_hash: input.chain_genesis_block_hash,
    expiry_height: input.expiry_height,
    snapshot_reference: input.snapshot_reference,
  });
}

function verifiedResult(
  input: Readonly<{
    readonly request: HnsControlObservationRequestV1;
    readonly request_hash: Sha256HexValue;
    readonly expected_txt_value_sha256: Sha256HexValue;
    readonly control_identity_digest: Sha256HexValue;
    readonly chain_authority_digest: Sha256HexValue;
    readonly chain_anchor: HnsStableHsdChainAnchorV1;
    readonly chain_genesis_block_hash: Sha256HexValue;
    readonly expiry_height: number;
    readonly snapshot_reference: string;
  }>,
): HnsControlObservationResultV1 {
  return makeHnsVerifiedControlResult({
    request: input.request,
    request_sha256: input.request_hash,
    expected_txt_value_sha256: input.expected_txt_value_sha256,
    control_identity_digest: input.control_identity_digest,
    chain_authority_digest: input.chain_authority_digest,
    chain_anchor: input.chain_anchor,
    chain_genesis_block_hash: input.chain_genesis_block_hash,
    expiry_height: input.expiry_height,
    snapshot_reference: input.snapshot_reference,
  });
}

export async function observeHnsParentChain(
  input: Readonly<{
    readonly request: HnsControlObservationRequestV1;
    readonly request_sha256: Sha256HexValue;
    readonly configuration: HnsControlObserverConfigurationV1;
    readonly reservation_database_time: string;
    readonly snapshot_reference: string;
    readonly transport: HnsControlObserverHsdTransportPort;
    readonly signal: AbortSignal;
  }>,
): Promise<HnsParentChainObserverResult> {
  if (input.request.ownership_source !== "hns_parent_chain_txt") {
    throw new HnsParentChainObserverError(
      "invalid_request",
      "HNS parent-chain observer received another ownership source",
    );
  }
  const transcript: HnsControlObserverTranscriptEntryV1[] = [];
  const transcriptContext = {
    ownership_source: input.request.ownership_source,
    root_label: input.request.root_label,
    hsd_driver_reference: input.configuration.chain.driver_reference,
    hsd_response_max_bytes: input.configuration.chain.response_max_bytes,
    authoritative_dns_driver_reference:
      input.configuration.authoritative_dns?.driver_reference ?? null,
    authoritative_dns_response_max_bytes:
      input.configuration.authoritative_dns?.response_max_bytes ?? null,
    required_view_ids: input.configuration.authoritative_dns?.required_view_ids ?? [],
  } as const;
  try {
    const observedBracket = await observeHnsStableHsdBracket({
      request: input.request,
      configuration: input.configuration,
      transport: input.transport,
      signal: input.signal,
      reservation_database_time: input.reservation_database_time,
    });
    transcript.push(
      ...(observedBracket.kind === "unavailable"
        ? observedBracket.transcript
        : observedBracket.bracket.transcript),
    );
    if (observedBracket.kind === "unavailable") {
      return finalizeResult(
        input.request,
        unavailableResult(
          input.request,
          input.request_sha256,
          observedBracket.reason,
          input.snapshot_reference,
        ),
        observedBracket.transcript,
        input.signal,
      );
    }
    const { bracket } = observedBracket;
    const anchorA = bracket.anchor_a;
    const root = bracket.root;
    const txtRecords = bracket.txt_records;
    const retainedTranscript = bracket.transcript;
    const chainAuthorityDigest = bracket.chain_authority_digest;
    const expectedTxtValueSha256 = await sha256Bytes(
      encoder.encode(input.request.expected_txt_value),
    );
    abortStableHsdIfSet(input.signal, "HNS parent-chain TXT digest completed after abort");
    if (root.kind !== "active") {
      return finalizeResult(
        input.request,
        rejectedResult({
          request: input.request,
          request_hash: input.request_sha256,
          reason: root.kind,
          expected_txt_value_sha256: expectedTxtValueSha256,
          observed_txt_values_digest: null,
          chain_authority_digest: chainAuthorityDigest,
          chain_anchor: anchorA,
          chain_genesis_block_hash: input.configuration.chain.genesis_block_hash,
          expiry_height: root.expiry_height,
          snapshot_reference: input.snapshot_reference,
        }),
        retainedTranscript,
        input.signal,
      );
    }
    const observedTxtDigest = await hnsObservedTxtValuesDigest(txtRecords);
    abortStableHsdIfSet(input.signal, "HNS parent-chain observed TXT digest completed after abort");
    const values = txtRecords.map((chunks) => chunks.join(""));
    const controlVerified = values.some((value) => value === input.request.expected_txt_value);
    const safeRemainingBlocks =
      root.expiry_height - anchorA.height - input.configuration.chain.expiry_safety_blocks;
    let rejection: HnsControlObservationRejectedReason | null = null;
    if (txtRecords.length === 0) rejection = "txt_absent";
    else if (!controlVerified) rejection = "txt_value_mismatch";
    else if (safeRemainingBlocks < input.configuration.chain.minimum_safe_remaining_blocks) {
      rejection = "expiry_horizon_insufficient";
    }
    if (rejection !== null) {
      return finalizeResult(
        input.request,
        rejectedResult({
          request: input.request,
          request_hash: input.request_sha256,
          reason: rejection,
          expected_txt_value_sha256: expectedTxtValueSha256,
          observed_txt_values_digest: observedTxtDigest,
          chain_authority_digest: chainAuthorityDigest,
          chain_anchor: anchorA,
          chain_genesis_block_hash: input.configuration.chain.genesis_block_hash,
          expiry_height: root.expiry_height,
          snapshot_reference: input.snapshot_reference,
        }),
        retainedTranscript,
        input.signal,
      );
    }
    const controlIdentityDigest = await hnsControlIdentityDigest({
      ownership_source: input.request.ownership_source,
      txt_name: input.request.txt_name,
      expected_txt_value: input.request.expected_txt_value,
      root_label: input.request.root_label,
      chain_authority_digest: chainAuthorityDigest,
    });
    abortStableHsdIfSet(input.signal, "HNS parent-chain control digest completed after abort");
    return finalizeResult(
      input.request,
      verifiedResult({
        request: input.request,
        request_hash: input.request_sha256,
        expected_txt_value_sha256: expectedTxtValueSha256,
        control_identity_digest: controlIdentityDigest,
        chain_authority_digest: chainAuthorityDigest,
        chain_anchor: anchorA,
        chain_genesis_block_hash: input.configuration.chain.genesis_block_hash,
        expiry_height: root.expiry_height,
        snapshot_reference: input.snapshot_reference,
      }),
      retainedTranscript,
      input.signal,
    );
  } catch (error) {
    if (error instanceof HnsStableHsdBracketError) {
      if (error instanceof HnsParentChainObserverError) throw error;
      throw new HnsParentChainObserverError(error.reason, error.message);
    }
    const reason =
      error instanceof HsdSemanticUnavailable
        ? error.reason
        : error instanceof HnsControlObserverTranscriptError && error.reason === "observer_capacity"
          ? "observer_capacity"
          : error instanceof HnsControlObserverTranscriptError
            ? "chain_response_invalid"
            : "observer_internal_error";
    let retainedTranscript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
    try {
      retainedTranscript = await validateHnsControlObserverTranscript({
        transcript,
        context: transcriptContext,
      });
    } catch (transcriptError) {
      if (
        transcriptError instanceof HnsControlObserverTranscriptError &&
        transcriptError.reason === "observer_capacity"
      ) {
        return finalizeResult(
          input.request,
          unavailableResult(
            input.request,
            input.request_sha256,
            "observer_capacity",
            input.snapshot_reference,
          ),
          [],
          input.signal,
        );
      }
      throw new HnsParentChainObserverError(
        "invalid_response",
        "HNS parent-chain transcript is invalid",
      );
    }
    return finalizeResult(
      input.request,
      unavailableResult(input.request, input.request_sha256, reason, input.snapshot_reference),
      retainedTranscript,
      input.signal,
    );
  }
}

export type HnsTargetObserverLifecycleSourceInput = Readonly<{
  readonly request: HnsControlObservationRequestV1;
  readonly request_sha256: Sha256HexValue;
  readonly configuration: HnsControlObserverConfigurationV1;
  readonly configuration_digest: Sha256HexValue;
  readonly reservation_database_time: string;
  readonly snapshot_reference: string;
  readonly signal: AbortSignal;
}>;

export function makeHnsTargetObserverSnapshotLifecycle(
  input: Readonly<{
    readonly ownership_source: HnsOwnershipSource;
    readonly configuration_resolver: HnsControlObserverConfigurationResolverPort;
    readonly capabilities: HnsControlObserverRuntimeCapabilities;
    readonly snapshot_store: HnsControlObserverSnapshotStorePort;
    readonly observe_source: (
      input: HnsTargetObserverLifecycleSourceInput,
    ) => Promise<HnsTargetObserverExecutionResult>;
    readonly make_capacity_result: (
      input: Readonly<{
        readonly request: HnsControlObservationRequestV1;
        readonly request_sha256: Sha256HexValue;
        readonly snapshot_reference: string;
        readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
        readonly semantic_facts_bytes: Uint8Array;
        readonly signal: AbortSignal;
      }>,
    ) => Promise<HnsTargetObserverExecutionResult>;
  }>,
): HnsTargetObserverPort {
  return {
    observe: async (observation, options) => {
      if (options.signal.aborted) {
        throw new HnsParentChainObserverError(
          "transport_unavailable",
          "HNS parent-chain observation was already aborted",
        );
      }
      const decodedRequest = await decodeHnsControlObservationRequestBytes(
        observation.request_bytes,
      );
      if (
        decodedRequest.request_sha256 !==
          (await hnsControlObservationRequestHash(observation.request)) ||
        JSON.stringify(decodedRequest.request) !== JSON.stringify(observation.request) ||
        decodedRequest.request.provider_id !== "hns.owner.v1"
      ) {
        throw new HnsParentChainObserverError(
          "invalid_request",
          "HNS observer request projection and bytes differ",
        );
      }
      if (decodedRequest.request.ownership_source !== input.ownership_source) {
        throw new HnsParentChainObserverError(
          "invalid_request",
          "HNS observer received another ownership source",
        );
      }
      let configuration: Awaited<ReturnType<typeof resolveHnsControlObserverConfiguration>>;
      try {
        configuration = await resolveHnsControlObserverConfiguration({
          authority: {
            provider_id: decodedRequest.request.provider_id,
            provider_configuration_reference:
              decodedRequest.request.provider_configuration_reference,
            provider_configuration_version: decodedRequest.request.provider_configuration_version,
            provider_configuration_digest: decodedRequest.request.provider_configuration_digest,
            environment: decodedRequest.request.environment,
            ownership_source: decodedRequest.request.ownership_source,
          },
          capabilities: input.capabilities,
          resolver: input.configuration_resolver,
          deadline_ms: options.deadline_ms,
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal.aborted) {
          throw new HnsParentChainObserverError(
            "transport_unavailable",
            "HNS observer configuration resolution completed after its deadline",
          );
        }
        if (error instanceof HnsControlObserverConfigurationError) {
          throw new HnsParentChainObserverError(
            "misconfigured",
            "HNS observer configuration authority is unavailable or invalid",
          );
        }
        throw new HnsParentChainObserverError(
          "transport_unavailable",
          "HNS observer configuration registry is unavailable",
        );
      }
      if (options.signal.aborted) {
        throw new HnsParentChainObserverError(
          "transport_unavailable",
          "HNS observer configuration resolution completed after its deadline",
        );
      }
      if (options.deadline_ms !== configuration.configuration.observer_deadline_ms) {
        throw new HnsParentChainObserverError(
          "misconfigured",
          "HNS observer deadline does not match immutable configuration",
        );
      }
      if (!sameLeasePolicy(observation.lease_policy, configuration.configuration)) {
        throw new HnsParentChainObserverError(
          "misconfigured",
          "HNS facade lease policy does not match immutable observer configuration",
        );
      }
      let reservation: Awaited<ReturnType<HnsControlObserverSnapshotStorePort["reserve"]>>;
      try {
        reservation = await input.snapshot_store.reserve(
          {
            observation_id: decodedRequest.request.observation_id,
            request_bytes: new Uint8Array(decodedRequest.request_bytes),
            request_sha256: decodedRequest.request_sha256,
            configuration_bytes: new Uint8Array(configuration.configuration_bytes),
            provider_configuration_digest: configuration.configuration_digest,
            reservation_lease_seconds:
              configuration.configuration.observer_reservation_lease_seconds,
          },
          { deadline_ms: options.deadline_ms, signal: options.signal },
        );
      } catch {
        throw new HnsParentChainObserverError(
          "transport_unavailable",
          "HNS observer snapshot reservation is unavailable",
        );
      }
      if (options.signal.aborted) {
        throw new HnsParentChainObserverError(
          "transport_unavailable",
          "HNS observer snapshot reservation completed after its deadline",
        );
      }
      if (reservation.kind === "mismatch") {
        throw new HnsParentChainObserverError(
          "invalid_request",
          "HNS observation id was reused with different authority",
        );
      }
      if (reservation.kind === "busy") {
        if (
          !Number.isSafeInteger(reservation.retry_after_seconds) ||
          reservation.retry_after_seconds < 1 ||
          reservation.retry_after_seconds > 3_600
        ) {
          throw new HnsParentChainObserverError(
            "invalid_response",
            "HNS observer busy retry authority is malformed",
          );
        }
        throw new HnsParentChainObserverError(
          "transport_unavailable",
          "HNS observation is owned by another live fence",
        );
      }
      if (reservation.kind === "replay") {
        if (
          !isHnsControlObserverSnapshotReference(reservation.snapshot_reference) ||
          !(reservation.result_bytes instanceof Uint8Array)
        ) {
          throw new HnsParentChainObserverError(
            "invalid_response",
            "HNS observer replay authority is malformed",
          );
        }
        const replay = await decodeHnsControlObservationResultBytes(
          reservation.result_bytes,
          decodedRequest.request,
        );
        if (options.signal.aborted) {
          throw new HnsParentChainObserverError(
            "transport_unavailable",
            "HNS observer replay decoding completed after its deadline",
          );
        }
        if (
          replay.result_sha256 !== reservation.result_sha256 ||
          (replay.result.status === "unavailable"
            ? replay.result.diagnostic_ref !== reservation.snapshot_reference
            : replay.result.provider_evidence_ref !== reservation.snapshot_reference)
        ) {
          throw new HnsParentChainObserverError(
            "invalid_response",
            "HNS observer replay is not cross-pinned to its snapshot",
          );
        }
        if (options.signal.aborted) {
          throw new HnsParentChainObserverError(
            "transport_unavailable",
            "HNS observer replay validation completed after its deadline",
          );
        }
        return replay.result_bytes;
      }
      if (
        !Number.isSafeInteger(reservation.observer_fence) ||
        reservation.observer_fence < 1 ||
        !isHnsControlObserverSnapshotReference(reservation.snapshot_reference) ||
        !canonicalInstant(reservation.reservation_database_time) ||
        !canonicalInstant(reservation.lease_expires_at) ||
        Date.parse(reservation.lease_expires_at) -
          Date.parse(reservation.reservation_database_time) !==
          configuration.configuration.observer_reservation_lease_seconds * 1_000
      ) {
        throw new HnsParentChainObserverError(
          "invalid_response",
          "HNS observer snapshot reservation authority is malformed",
        );
      }
      let observed = await input.observe_source({
        request: decodedRequest.request,
        request_sha256: decodedRequest.request_sha256,
        configuration: configuration.configuration,
        configuration_digest: configuration.configuration_digest,
        reservation_database_time: reservation.reservation_database_time,
        snapshot_reference: reservation.snapshot_reference,
        signal: options.signal,
      });
      if (options.signal.aborted) {
        throw new HnsParentChainObserverError(
          "transport_unavailable",
          "HNS parent-chain observation completed after its deadline",
        );
      }
      const logicalSnapshotBytes = () =>
        hnsControlObserverSnapshotLogicalByteLength({
          observation_id: decodedRequest.request.observation_id,
          observer_fence: reservation.observer_fence,
          reservation_database_time: reservation.reservation_database_time,
          lease_expires_at: reservation.lease_expires_at,
          request_bytes: decodedRequest.request_bytes,
          request_sha256: decodedRequest.request_sha256,
          configuration_bytes: configuration.configuration_bytes,
          provider_configuration_digest: configuration.configuration_digest,
          snapshot_reference: reservation.snapshot_reference,
          transcript: observed.transcript,
          semantic_facts_bytes: observed.semantic_facts_bytes,
          result_bytes: observed.result_bytes,
          result_sha256: observed.result_sha256,
          result_status: observed.result_status,
          result_reference_kind: observed.result_reference_kind,
        });
      let snapshotByteLength = logicalSnapshotBytes();
      if (snapshotByteLength > HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES) {
        observed = await input.make_capacity_result({
          request: decodedRequest.request,
          request_sha256: decodedRequest.request_sha256,
          snapshot_reference: reservation.snapshot_reference,
          transcript: observed.transcript,
          semantic_facts_bytes: observed.semantic_facts_bytes,
          signal: options.signal,
        });
        snapshotByteLength = logicalSnapshotBytes();
        if (snapshotByteLength > HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES) {
          throw new HnsParentChainObserverError(
            "invalid_response",
            "HNS observer capacity result cannot fit its retained snapshot bound",
          );
        }
      }
      let finalized: Awaited<ReturnType<HnsControlObserverSnapshotStorePort["finalize"]>>;
      try {
        finalized = await input.snapshot_store.finalize(
          {
            observation_id: decodedRequest.request.observation_id,
            observer_fence: reservation.observer_fence,
            request_sha256: decodedRequest.request_sha256,
            provider_configuration_digest: configuration.configuration_digest,
            snapshot_reference: reservation.snapshot_reference,
            transcript: observed.transcript,
            semantic_facts_bytes: new Uint8Array(observed.semantic_facts_bytes),
            result_bytes: new Uint8Array(observed.result_bytes),
            result_sha256: observed.result_sha256,
          },
          { deadline_ms: options.deadline_ms, signal: options.signal },
        );
      } catch {
        throw new HnsParentChainObserverError(
          "transport_unavailable",
          "HNS observer snapshot finalization is unavailable",
        );
      }
      if (options.signal.aborted) {
        throw new HnsParentChainObserverError(
          "transport_unavailable",
          "HNS observer finalization completed after its deadline",
        );
      }
      if (finalized.kind === "lost") {
        throw new HnsParentChainObserverError(
          "transport_unavailable",
          "HNS observer lost its finalization fence",
        );
      }
      if (finalized.kind === "mismatch") {
        throw new HnsParentChainObserverError(
          "invalid_response",
          "HNS observer finalization authority mismatched",
        );
      }
      if (
        !isHnsControlObserverSnapshotReference(finalized.snapshot_reference) ||
        !(finalized.result_bytes instanceof Uint8Array) ||
        finalized.snapshot_reference !== reservation.snapshot_reference ||
        finalized.result_sha256 !== observed.result_sha256 ||
        !finalized.result_bytes.every((byte, index) => byte === observed.result_bytes[index]) ||
        finalized.result_bytes.byteLength !== observed.result_bytes.byteLength
      ) {
        throw new HnsParentChainObserverError(
          "invalid_response",
          "HNS observer finalization returned different terminal bytes",
        );
      }
      return new Uint8Array(finalized.result_bytes);
    },
  };
}

export function makeHnsParentChainTargetObserver(
  input: Readonly<{
    readonly configuration_resolver: HnsControlObserverConfigurationResolverPort;
    readonly capabilities: HnsControlObserverRuntimeCapabilities;
    readonly snapshot_store: HnsControlObserverSnapshotStorePort;
    readonly hsd_transport: HnsControlObserverHsdTransportPort;
  }>,
): HnsTargetObserverPort {
  return makeHnsTargetObserverSnapshotLifecycle({
    ownership_source: "hns_parent_chain_txt",
    configuration_resolver: input.configuration_resolver,
    capabilities: input.capabilities,
    snapshot_store: input.snapshot_store,
    observe_source: (sourceInput) =>
      observeHnsParentChain({
        request: sourceInput.request,
        request_sha256: sourceInput.request_sha256,
        configuration: sourceInput.configuration,
        reservation_database_time: sourceInput.reservation_database_time,
        snapshot_reference: sourceInput.snapshot_reference,
        transport: input.hsd_transport,
        signal: sourceInput.signal,
      }),
    make_capacity_result: (capacityInput) =>
      finalizeResult(
        capacityInput.request,
        unavailableResult(
          capacityInput.request,
          capacityInput.request_sha256,
          "observer_capacity",
          capacityInput.snapshot_reference,
        ),
        capacityInput.transcript,
        capacityInput.signal,
      ),
  });
}
