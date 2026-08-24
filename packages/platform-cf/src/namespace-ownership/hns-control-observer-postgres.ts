import {
  ControlPlaneDb,
  type ControlPlaneError,
  classifyHnsAuthoritativeDnsResponseV1,
  decodeHnsAuthoritativeDnsSemanticFactsV1,
  decodeHnsAuthorityInventoryBytes,
  decodeHnsControlObservationRequestBytes,
  decodeHnsControlObservationResultBytes,
  decodeHnsControlObservationResultV2Bytes,
  decodeHnsControlObserverCompatibleConfigurationBytes,
  decodeHnsControlObserverConfigurationBytes,
  decodeHnsControlObserverConfigurationV2Bytes,
  HNS_CONTROL_OBSERVER_CONFIGURATION_MAX_BYTES,
  HNS_CONTROL_OBSERVER_RESERVATION_LEASE_MAX_SECONDS,
  HNS_CONTROL_OBSERVER_RESERVATION_LEASE_MIN_SECONDS,
  HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES,
  type HnsAuthoritativeDnsSemanticViewV1,
  type HnsAuthorityInventoryResolverPortV1,
  type HnsControlObservationResultV1,
  type HnsControlObservationResultV2,
  type HnsControlObserverConfigurationResolverPort,
  type HnsControlObserverReservationInput,
  type HnsControlObserverReservationOutcome,
  type HnsControlObserverRetainedSnapshotV1,
  type HnsControlObserverSnapshotFinalizeInput,
  type HnsControlObserverSnapshotFinalizeInputV2,
  type HnsControlObserverSnapshotFinalizeOutcome,
  type HnsControlObserverSnapshotLogicalPayload,
  HnsControlObserverSnapshotReadError,
  type HnsControlObserverSnapshotReaderPort,
  type HnsControlObserverSnapshotStorePort,
  type HnsControlObserverSnapshotStorePortV2,
  type HnsControlObserverTranscriptEntryV1,
  hnsControlObserverSnapshotAccountingEnvelopeBytes,
  hnsControlObserverSnapshotAccountingEnvelopeV2Bytes,
  hnsControlObserverSnapshotDigestV2,
  hnsControlObserverSnapshotLogicalByteLength,
  hnsControlObserverSnapshotLogicalByteLengthV2,
  hnsControlObserverTranscriptByteLength,
  hnsControlObserverTranscriptManifestDigestV2,
  hnsControlObserverTranscriptManifestV2,
  hnsObservedTxtValuesDigest,
  isHnsControlObserverSnapshotReference,
  validateHnsControlObserverTranscript,
} from "@pirate/application";
import type { Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Effect, type Layer } from "effect";

const DEFAULT_SNAPSHOT_STORE_REFERENCE = "postgres:hns-control-observer-v1";
const MAX_SAFE_FENCE = Number.MAX_SAFE_INTEGER;

type Row = Readonly<Record<string, unknown>>;

export class HnsControlObserverPostgresError extends Error {
  readonly name = "HnsControlObserverPostgresError";

  constructor(
    readonly reason: "invalid_input" | "invalid_row" | "storage",
    message: string,
  ) {
    super(message);
  }
}

class FinalizationFenceLost extends Error {
  readonly name = "FinalizationFenceLost";
}

function invalidInput(message: string): HnsControlObserverPostgresError {
  return new HnsControlObserverPostgresError("invalid_input", message);
}

function invalidRow(message: string): HnsControlObserverPostgresError {
  return new HnsControlObserverPostgresError("invalid_row", message);
}

function copyBytes(value: unknown): Uint8Array | null {
  if (!(value instanceof Uint8Array)) return null;
  return new Uint8Array(value);
}

function stringValue(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function integerValue(row: Row, key: string): number | null {
  const value = row[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : typeof value === "string" && /^-?\d+$/u.test(value)
          ? Number(value)
          : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function oneRow(result: Readonly<{ readonly rows: readonly Row[]; readonly rowCount: number }>) {
  if (result.rowCount === 0 && result.rows.length === 0) return null;
  if (result.rowCount !== 1 || result.rows.length !== 1) return undefined;
  return result.rows[0];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function safeIdentity(value: string, maximumBytes: number): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  if (new TextEncoder().encode(value).byteLength > maximumBytes) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  }
  return true;
}

function ownerDnsSemanticFactsMatchTerminalResult(
  views: ReadonlyArray<HnsAuthoritativeDnsSemanticViewV1>,
  result: HnsControlObservationResultV1 | HnsControlObservationResultV2,
  dnsTranscriptEntryCount: number,
): boolean {
  if (result.status === "unavailable") {
    const firstNonSecureIndex = views.findIndex((view) => view.dnssec_validation !== "secure");
    if (result.reason_code === "authoritative_dns_insecure") {
      if (views.length === 0 && dnsTranscriptEntryCount === 0) return true;
      return (
        firstNonSecureIndex === views.length - 1 &&
        firstNonSecureIndex >= 0 &&
        (views[firstNonSecureIndex]?.dnssec_validation === "insecure" ||
          views[firstNonSecureIndex]?.dnssec_validation === "bogus") &&
        dnsTranscriptEntryCount === views.length * 2
      );
    }
    if (result.reason_code === "authoritative_dns_inconclusive" && firstNonSecureIndex >= 0) {
      return (
        firstNonSecureIndex === views.length - 1 &&
        views[firstNonSecureIndex]?.dnssec_validation === "indeterminate" &&
        dnsTranscriptEntryCount === views.length * 2
      );
    }
    if (result.reason_code === "authoritative_dns_inconclusive") {
      if (views.length === 0 && dnsTranscriptEntryCount === 0) return true;
      if (dnsTranscriptEntryCount > views.length * 2) return true;
      const semanticKeys = views.map((view) =>
        view.semantic_class === "txt_values"
          ? `txt_values:${view.observed_txt_values_digest}`
          : view.semantic_class,
      );
      return semanticKeys.length > 1 && new Set(semanticKeys).size > 1;
    }
    return firstNonSecureIndex < 0;
  }
  const allSecureTxtValues =
    views.length > 0 &&
    views.every(
      (view) =>
        view.dnssec_validation === "secure" &&
        view.semantic_class === "txt_values" &&
        view.observed_txt_values_digest !== null,
    );
  const observedDigests = new Set(views.map((view) => view.observed_txt_values_digest));
  if (result.status === "verified") {
    return allSecureTxtValues && observedDigests.size === 1;
  }
  if (result.reason_code === "txt_absent") {
    return (
      views.length > 0 &&
      views.every(
        (view) =>
          view.dnssec_validation === "secure" &&
          (view.semantic_class === "nxdomain" || view.semantic_class === "nodata") &&
          view.observed_txt_values_digest === null,
      ) &&
      new Set(views.map((view) => view.semantic_class)).size === 1
    );
  }
  if (
    result.reason_code === "txt_value_mismatch" ||
    result.reason_code === "expiry_horizon_insufficient"
  ) {
    return (
      allSecureTxtValues &&
      observedDigests.size === 1 &&
      views.every((view) => view.observed_txt_values_digest === result.observed_txt_values_digest)
    );
  }
  return views.length === 0;
}

async function ownerDnsSemanticFactsMatchWire(
  views: ReadonlyArray<HnsAuthoritativeDnsSemanticViewV1>,
  dnsEntries: ReadonlyArray<HnsControlObserverTranscriptEntryV1>,
  result: HnsControlObservationResultV1 | HnsControlObservationResultV2,
): Promise<boolean> {
  let viewIndex = 0;
  for (let index = 0; index + 1 < dnsEntries.length; index += 2) {
    const dnskey = dnsEntries[index];
    const control = dnsEntries[index + 1];
    if (
      dnskey?.transport_outcome !== "response" ||
      dnskey.response_bytes === null ||
      control?.transport_outcome !== "response" ||
      control.response_bytes === null
    ) {
      continue;
    }
    const isTerminalControlCapacityPrefix =
      result.status === "unavailable" &&
      result.reason_code === "observer_capacity" &&
      index + 1 === dnsEntries.length - 1;
    if (isTerminalControlCapacityPrefix) continue;
    const dnskeyClass = classifyHnsAuthoritativeDnsResponseV1({
      request_bytes: dnskey.request_bytes,
      response_bytes: dnskey.response_bytes,
    }).kind;
    const controlClassification = classifyHnsAuthoritativeDnsResponseV1({
      request_bytes: control.request_bytes,
      response_bytes: control.response_bytes,
    });
    const controlClass = controlClassification.kind;
    if (
      dnskeyClass === "dnskey" &&
      (controlClass === "txt_values" || controlClass === "nxdomain" || controlClass === "nodata")
    ) {
      const view = views[viewIndex];
      if (view === undefined) return false;
      if (view.dnssec_validation === "secure") {
        const observedTxtValuesDigest =
          controlClass === "txt_values"
            ? await hnsObservedTxtValuesDigest(controlClassification.observed_txt_records)
            : null;
        if (
          view.semantic_class !== controlClass ||
          view.observed_txt_values_digest !== observedTxtValuesDigest
        ) {
          return false;
        }
      }
      viewIndex += 1;
    }
  }
  return viewIndex === views.length;
}

function rowIdentityMatches(
  row: Row,
  input: Readonly<{
    readonly observation_id: string;
    readonly request_bytes: Uint8Array;
    readonly request_sha256: string;
    readonly configuration_bytes: Uint8Array;
    readonly provider_configuration_digest: string;
  }>,
): boolean {
  const requestBytes = copyBytes(row.request_bytes);
  const configurationBytes = copyBytes(row.configuration_bytes);
  return (
    stringValue(row, "observation_id") === input.observation_id &&
    stringValue(row, "request_sha256") === input.request_sha256 &&
    stringValue(row, "provider_configuration_digest") === input.provider_configuration_digest &&
    requestBytes !== null &&
    bytesEqual(requestBytes, input.request_bytes) &&
    configurationBytes !== null &&
    bytesEqual(configurationBytes, input.configuration_bytes)
  );
}

const FORMAT_RESERVATION_SQL = `to_char(
  reservation_database_time AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
) AS reservation_database_time,
to_char(
  lease_expires_at AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
) AS lease_expires_at`;

const SELECT_OPERATION_SQL = `SELECT observation_id,
       provider_configuration_reference,
       provider_configuration_version,
       provider_configuration_digest,
       request_bytes,
       request_sha256,
       configuration_bytes,
       snapshot_reference
  FROM hns_control_observer_operations
 WHERE observation_id = $1`;

const LOCK_OPERATION_SQL = `${SELECT_OPERATION_SQL} FOR UPDATE`;

const LOCK_RESERVATION_SQL = `SELECT observation_id,
       state,
       reservation_lease_seconds,
       observer_fence,
       ${FORMAT_RESERVATION_SQL},
       terminal_snapshot_reference,
       terminal_status
  FROM hns_control_observer_reservations
 WHERE observation_id = $1
 FOR UPDATE`;

const SELECT_SNAPSHOT_REPLAY_SQL = `SELECT snapshot_reference, result_bytes, result_sha256
  FROM hns_control_observer_snapshots
 WHERE observation_id = $1`;

const SELECT_FINALIZE_AUTHORITY_SQL = `SELECT operation.observation_id,
       operation.provider_configuration_reference,
       operation.provider_configuration_version,
       operation.provider_configuration_digest,
       operation.request_bytes,
       operation.request_sha256,
       operation.configuration_bytes,
       operation.snapshot_reference,
       ${FORMAT_RESERVATION_SQL},
       reservation.state,
       reservation.observer_fence,
       reservation.reservation_lease_seconds
  FROM hns_control_observer_operations AS operation
  JOIN hns_control_observer_reservations AS reservation
    USING (observation_id)
 WHERE operation.observation_id = $1`;

function replayFromRow(
  row: Row | null | undefined,
): Extract<HnsControlObserverSnapshotFinalizeOutcome, { readonly kind: "replay" }> {
  if (row === undefined || row === null) {
    throw invalidRow("HNS observer terminal reservation lacks exactly one snapshot");
  }
  const snapshotReference = stringValue(row, "snapshot_reference");
  const resultBytes = copyBytes(row.result_bytes);
  const resultSha256 = stringValue(row, "result_sha256");
  if (
    snapshotReference === null ||
    !isHnsControlObserverSnapshotReference(snapshotReference) ||
    resultBytes === null ||
    resultBytes.byteLength === 0 ||
    resultSha256 === null ||
    !/^[0-9a-f]{64}$/u.test(resultSha256)
  ) {
    throw invalidRow("HNS observer retained snapshot row is invalid");
  }
  return {
    kind: "replay",
    snapshot_reference: snapshotReference,
    result_bytes: resultBytes,
    result_sha256: resultSha256 as Sha256HexValue,
  };
}

async function validateReservationInput(
  input: HnsControlObserverReservationInput,
  snapshotStoreReference: string,
) {
  if (
    !safeIdentity(input.observation_id, 256) ||
    !(input.request_bytes instanceof Uint8Array) ||
    !(input.configuration_bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(input.reservation_lease_seconds) ||
    input.reservation_lease_seconds < HNS_CONTROL_OBSERVER_RESERVATION_LEASE_MIN_SECONDS ||
    input.reservation_lease_seconds > HNS_CONTROL_OBSERVER_RESERVATION_LEASE_MAX_SECONDS
  ) {
    throw invalidInput("HNS observer reservation input is invalid");
  }
  const request = await decodeHnsControlObservationRequestBytes(input.request_bytes);
  const configuration = await decodeHnsControlObserverCompatibleConfigurationBytes(
    input.configuration_bytes,
  );
  if (
    request.request.observation_id !== input.observation_id ||
    request.request_sha256 !== input.request_sha256 ||
    configuration.configuration_digest !== input.provider_configuration_digest ||
    request.request.provider_configuration_digest !== configuration.configuration_digest ||
    configuration.configuration.provider_configuration_reference !==
      request.request.provider_configuration_reference ||
    configuration.configuration.provider_configuration_version !==
      request.request.provider_configuration_version ||
    configuration.configuration.provider_id !== request.request.provider_id ||
    configuration.configuration.environment !== request.request.environment ||
    !configuration.configuration.ownership_sources.includes(request.request.ownership_source) ||
    configuration.configuration.observer_reservation_lease_seconds !==
      input.reservation_lease_seconds ||
    configuration.configuration.snapshot_store_reference !== snapshotStoreReference
  ) {
    throw invalidInput("HNS observer reservation authority does not match its exact bytes");
  }
  return {
    observation_id: input.observation_id,
    request_bytes: new Uint8Array(request.request_bytes),
    request_sha256: request.request_sha256,
    configuration_bytes: new Uint8Array(configuration.configuration_bytes),
    provider_configuration_digest: configuration.configuration_digest,
    provider_configuration_reference: configuration.configuration.provider_configuration_reference,
    provider_configuration_version: configuration.configuration.provider_configuration_version,
    reservation_lease_seconds: input.reservation_lease_seconds,
  } as const;
}

async function validateFinalizeInput(
  input: HnsControlObserverSnapshotFinalizeInput,
  operation: Row,
) {
  const requestBytes = copyBytes(operation.request_bytes);
  const configurationBytes = copyBytes(operation.configuration_bytes);
  const reservationDatabaseTime = stringValue(operation, "reservation_database_time");
  const leaseExpiresAt = stringValue(operation, "lease_expires_at");
  if (
    requestBytes === null ||
    configurationBytes === null ||
    reservationDatabaseTime === null ||
    leaseExpiresAt === null
  ) {
    throw invalidRow("HNS observer operation snapshot authority is invalid");
  }
  const request = await decodeHnsControlObservationRequestBytes(requestBytes);
  const configuration = await decodeHnsControlObserverConfigurationBytes(configurationBytes);
  const result = await decodeHnsControlObservationResultBytes(input.result_bytes, request.request);
  if (
    request.request_sha256 !== input.request_sha256 ||
    configuration.configuration_digest !== input.provider_configuration_digest ||
    request.request.provider_configuration_digest !== configuration.configuration_digest ||
    configuration.configuration.provider_configuration_reference !==
      request.request.provider_configuration_reference ||
    configuration.configuration.provider_configuration_version !==
      request.request.provider_configuration_version ||
    configuration.configuration.provider_id !== request.request.provider_id ||
    configuration.configuration.environment !== request.request.environment ||
    !configuration.configuration.ownership_sources.includes(request.request.ownership_source) ||
    stringValue(operation, "provider_configuration_reference") !==
      configuration.configuration.provider_configuration_reference ||
    stringValue(operation, "provider_configuration_version") !==
      configuration.configuration.provider_configuration_version ||
    result.result_sha256 !== input.result_sha256 ||
    result.result.observation_id !== input.observation_id ||
    (result.result.status === "unavailable"
      ? result.result.diagnostic_ref !== input.snapshot_reference
      : result.result.provider_evidence_ref !== input.snapshot_reference)
  ) {
    throw invalidInput("HNS observer finalization bytes do not match retained authority");
  }
  const transcript = await validateHnsControlObserverTranscript({
    transcript: input.transcript,
    context: {
      ownership_source: request.request.ownership_source,
      root_label: request.request.root_label,
      hsd_driver_reference: configuration.configuration.chain.driver_reference,
      hsd_response_max_bytes: configuration.configuration.chain.response_max_bytes,
      authoritative_dns_driver_reference:
        configuration.configuration.authoritative_dns?.driver_reference ?? null,
      authoritative_dns_response_max_bytes:
        configuration.configuration.authoritative_dns?.response_max_bytes ?? null,
      required_view_ids: configuration.configuration.authoritative_dns?.required_view_ids ?? [],
      terminal_status: result.result.status,
      terminal_reason_code: result.result.status === "verified" ? null : result.result.reason_code,
    },
  });
  let semanticFactsBytes = new Uint8Array(input.semantic_facts_bytes);
  if (request.request.ownership_source === "owner_authoritative_dns_txt") {
    const dns = configuration.configuration.authoritative_dns;
    if (dns === null) {
      throw invalidInput("HNS observer owner-DNS finalization lacks configured authority");
    }
    let semanticFacts: ReturnType<typeof decodeHnsAuthoritativeDnsSemanticFactsV1>;
    try {
      semanticFacts = decodeHnsAuthoritativeDnsSemanticFactsV1(semanticFactsBytes);
    } catch {
      throw invalidInput("HNS observer owner-DNS semantic facts are invalid");
    }
    const dnsEntries = transcript.filter(
      (entry) =>
        entry.ownership_source === "owner_authoritative_dns_txt" &&
        entry.driver_reference === dns.driver_reference,
    );
    const terminalChainAuthorityDigest =
      result.result.status === "unavailable" ? null : result.result.chain_authority_digest;
    const semanticFactsMatchWire = await ownerDnsSemanticFactsMatchWire(
      semanticFacts.views,
      dnsEntries,
      result.result,
    );
    const chainOnlyRejection =
      result.result.status === "rejected" &&
      (result.result.reason_code === "root_absent" ||
        result.result.reason_code === "root_inactive");
    if (
      !semanticFactsMatchWire ||
      (result.result.status !== "unavailable" &&
        !chainOnlyRejection &&
        semanticFacts.views.length !== dns.required_view_ids.length) ||
      (chainOnlyRejection && (semanticFacts.views.length !== 0 || dnsEntries.length !== 0)) ||
      semanticFacts.views.some((view, index) => {
        const dnskey = dnsEntries[index * 2];
        const control = dnsEntries[index * 2 + 1];
        return (
          view.view_id !== dns.required_view_ids[index] ||
          view.validation_database_time !== reservationDatabaseTime ||
          dnskey === undefined ||
          control === undefined ||
          dnskey.method_or_view_id !== view.view_id ||
          control.method_or_view_id !== view.view_id ||
          dnskey.request_sha256 !== view.dnskey_request_sha256 ||
          dnskey.response_sha256 !== view.dnskey_response_sha256 ||
          control.request_sha256 !== view.control_request_sha256 ||
          control.response_sha256 !== view.control_response_sha256
        );
      }) ||
      (terminalChainAuthorityDigest !== null &&
        semanticFacts.views.some(
          (view) => view.chain_authority_digest !== terminalChainAuthorityDigest,
        )) ||
      new Set(semanticFacts.views.map((view) => view.chain_authority_digest)).size > 1 ||
      !ownerDnsSemanticFactsMatchTerminalResult(
        semanticFacts.views,
        result.result,
        dnsEntries.length,
      )
    ) {
      throw invalidInput("HNS observer owner-DNS semantic facts do not match the transcript");
    }
    semanticFactsBytes = new Uint8Array(semanticFacts.semantic_facts_bytes);
  }
  const logicalPayload: HnsControlObserverSnapshotLogicalPayload = {
    observation_id: input.observation_id,
    observer_fence: input.observer_fence,
    reservation_database_time: reservationDatabaseTime,
    lease_expires_at: leaseExpiresAt,
    request_bytes: requestBytes,
    request_sha256: input.request_sha256,
    configuration_bytes: configurationBytes,
    provider_configuration_digest: input.provider_configuration_digest,
    snapshot_reference: input.snapshot_reference,
    transcript,
    semantic_facts_bytes: semanticFactsBytes,
    result_bytes: new Uint8Array(result.result_bytes),
    result_sha256: result.result_sha256,
    result_status: result.result.status,
    result_reference_kind:
      result.result.status === "unavailable" ? "diagnostic_ref" : "provider_evidence_ref",
  };
  const accountingEnvelopeBytes = hnsControlObserverSnapshotAccountingEnvelopeBytes(logicalPayload);
  const logicalSnapshotByteLength = hnsControlObserverSnapshotLogicalByteLength(logicalPayload);
  if (
    logicalPayload.semantic_facts_bytes.byteLength === 0 ||
    !Number.isSafeInteger(logicalSnapshotByteLength) ||
    logicalSnapshotByteLength > HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES
  ) {
    throw invalidInput("HNS observer finalization exceeds the retained snapshot bound");
  }
  return {
    ...logicalPayload,
    authority_inventory_bytes: null,
    authority_inventory_reference_or_null: null,
    authority_inventory_version_or_null: null,
    authority_inventory_digest_or_null: null,
    semantic_facts_sha256: null,
    transcript_manifest_sha256: null,
    observer_snapshot_sha256: null,
    transcript_byte_length: hnsControlObserverTranscriptByteLength(transcript),
    accounting_envelope_bytes: accountingEnvelopeBytes,
    logical_snapshot_byte_length: logicalSnapshotByteLength,
  } as const;
}

async function sha256ExactBytes(bytes: Uint8Array): Promise<Sha256HexValue> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  ) as Sha256HexValue;
}

async function validateFinalizeInputV2(
  input: HnsControlObserverSnapshotFinalizeInputV2,
  operation: Row,
) {
  const requestBytes = copyBytes(operation.request_bytes);
  const configurationBytes = copyBytes(operation.configuration_bytes);
  const reservationDatabaseTime = stringValue(operation, "reservation_database_time");
  const leaseExpiresAt = stringValue(operation, "lease_expires_at");
  if (
    requestBytes === null ||
    configurationBytes === null ||
    reservationDatabaseTime === null ||
    leaseExpiresAt === null
  ) {
    throw invalidRow("HNS observer v2 operation snapshot authority is invalid");
  }
  const request = await decodeHnsControlObservationRequestBytes(requestBytes);
  const configuration = await decodeHnsControlObserverConfigurationV2Bytes(configurationBytes);
  const result = await decodeHnsControlObservationResultV2Bytes(
    input.result_bytes,
    request.request,
  );
  const hasInventoryBytes = input.authority_inventory_bytes !== null;
  const hasInventoryReference = input.authority_inventory_reference_or_null !== null;
  const hasInventoryVersion = input.authority_inventory_version_or_null !== null;
  const hasInventoryDigest = input.authority_inventory_digest_or_null !== null;
  if (
    !(
      hasInventoryBytes === hasInventoryReference &&
      hasInventoryReference === hasInventoryVersion &&
      hasInventoryVersion === hasInventoryDigest
    )
  ) {
    throw invalidInput("HNS observer v2 inventory authority is a partial nullable tuple");
  }
  if (
    request.request_sha256 !== input.request_sha256 ||
    request.request.ownership_source !== "owner_authoritative_dns_txt" ||
    configuration.configuration_digest !== input.provider_configuration_digest ||
    request.request.provider_configuration_digest !== configuration.configuration_digest ||
    configuration.configuration.provider_configuration_reference !==
      request.request.provider_configuration_reference ||
    configuration.configuration.provider_configuration_version !==
      request.request.provider_configuration_version ||
    configuration.configuration.provider_id !== request.request.provider_id ||
    configuration.configuration.environment !== request.request.environment ||
    !configuration.configuration.ownership_sources.includes(request.request.ownership_source) ||
    stringValue(operation, "provider_configuration_reference") !==
      configuration.configuration.provider_configuration_reference ||
    stringValue(operation, "provider_configuration_version") !==
      configuration.configuration.provider_configuration_version ||
    result.result_sha256 !== input.result_sha256 ||
    result.result.observation_id !== input.observation_id ||
    result.result.observer_snapshot_sha256 !== input.observer_snapshot_sha256 ||
    (result.result.status === "unavailable" || result.result.status === "ineligible"
      ? result.result.diagnostic_ref !== input.snapshot_reference
      : result.result.provider_evidence_ref !== input.snapshot_reference)
  ) {
    throw invalidInput("HNS observer v2 finalization bytes do not match retained authority");
  }
  if (
    input.authority_inventory_bytes !== null &&
    (await sha256ExactBytes(input.authority_inventory_bytes)) !==
      input.authority_inventory_digest_or_null
  ) {
    throw invalidInput("HNS observer v2 inventory digest does not match exact bytes");
  }
  if (
    result.result.status === "ineligible" &&
    (input.authority_inventory_reference_or_null !== result.result.authority_inventory_reference ||
      input.authority_inventory_version_or_null !== result.result.authority_inventory_version ||
      input.authority_inventory_digest_or_null !== result.result.authority_inventory_digest)
  ) {
    throw invalidInput("HNS observer v2 source-ineligible inventory identity differs");
  }
  if (
    result.result.status !== "unavailable" ||
    result.result.reason_code !== "authority_inventory_unavailable"
  ) {
    if (input.authority_inventory_bytes === null) {
      throw invalidInput("HNS observer v2 semantic terminal lacks its inventory");
    }
    const decodedInventory = await decodeHnsAuthorityInventoryBytes(
      input.authority_inventory_bytes,
    );
    if (
      decodedInventory.inventory.authority_inventory_reference !==
        input.authority_inventory_reference_or_null ||
      decodedInventory.inventory.authority_inventory_version !==
        input.authority_inventory_version_or_null ||
      decodedInventory.inventory.environment !== configuration.configuration.environment ||
      decodedInventory.inventory_digest !== input.authority_inventory_digest_or_null
    ) {
      throw invalidInput("HNS observer v2 inventory document identity differs");
    }
  }
  const transcript = await validateHnsControlObserverTranscript({
    transcript: input.transcript,
    context: {
      ownership_source: request.request.ownership_source,
      root_label: request.request.root_label,
      hsd_driver_reference: configuration.configuration.chain.driver_reference,
      hsd_response_max_bytes: configuration.configuration.chain.response_max_bytes,
      authoritative_dns_driver_reference:
        configuration.configuration.authoritative_dns?.driver_reference ?? null,
      authoritative_dns_response_max_bytes:
        configuration.configuration.authoritative_dns?.response_max_bytes ?? null,
      required_view_ids: configuration.configuration.authoritative_dns?.required_view_ids ?? [],
      terminal_status: result.result.status,
      terminal_reason_code: result.result.status === "verified" ? null : result.result.reason_code,
    },
  });
  const transcriptManifestSha256 = await hnsControlObserverTranscriptManifestDigestV2(
    hnsControlObserverTranscriptManifestV2(transcript),
  );
  const semanticFactsBytes = new Uint8Array(input.semantic_facts_bytes);
  const semanticFactsSha256 = await sha256ExactBytes(semanticFactsBytes);
  if (
    transcriptManifestSha256 !== input.transcript_manifest_sha256 ||
    semanticFactsSha256 !== input.semantic_facts_sha256
  ) {
    throw invalidInput("HNS observer v2 retained manifest digest differs");
  }
  const observerSnapshotSha256 = await hnsControlObserverSnapshotDigestV2({
    observation_id: input.observation_id,
    request_sha256: input.request_sha256,
    provider_configuration_digest: input.provider_configuration_digest,
    authority_inventory_reference_or_null: input.authority_inventory_reference_or_null,
    authority_inventory_version_or_null: input.authority_inventory_version_or_null,
    authority_inventory_digest_or_null: input.authority_inventory_digest_or_null,
    reservation_database_time: reservationDatabaseTime,
    snapshot_reference: input.snapshot_reference,
    transcript_manifest_sha256: transcriptManifestSha256,
    semantic_facts_sha256: semanticFactsSha256,
  });
  if (observerSnapshotSha256 !== input.observer_snapshot_sha256) {
    throw invalidInput("HNS observer v2 snapshot manifest digest differs");
  }
  const dns = configuration.configuration.authoritative_dns;
  if (dns === null) {
    throw invalidInput("HNS observer v2 owner-DNS finalization lacks configured authority");
  }
  let semanticFacts: ReturnType<typeof decodeHnsAuthoritativeDnsSemanticFactsV1>;
  try {
    semanticFacts = decodeHnsAuthoritativeDnsSemanticFactsV1(semanticFactsBytes);
  } catch {
    throw invalidInput("HNS observer v2 owner-DNS semantic facts are invalid");
  }
  const dnsEntries = transcript.filter(
    (entry) =>
      entry.ownership_source === "owner_authoritative_dns_txt" &&
      entry.driver_reference === dns.driver_reference,
  );
  if (result.result.status === "ineligible") {
    if (semanticFacts.views.length !== 0 || dnsEntries.length !== 0) {
      throw invalidInput("HNS observer source-ineligible terminal contains DNS facts");
    }
  } else if (
    result.result.status === "unavailable" &&
    result.result.reason_code === "authority_inventory_unavailable"
  ) {
    if (semanticFacts.views.length !== 0 || transcript.length !== 0) {
      throw invalidInput("HNS observer inventory-unavailable terminal contains provider facts");
    }
  } else {
    const terminalChainAuthorityDigest =
      result.result.status === "unavailable" ? null : result.result.chain_authority_digest;
    const semanticFactsMatchWire = await ownerDnsSemanticFactsMatchWire(
      semanticFacts.views,
      dnsEntries,
      result.result,
    );
    const chainOnlyRejection =
      result.result.status === "rejected" &&
      (result.result.reason_code === "root_absent" ||
        result.result.reason_code === "root_inactive");
    if (
      !semanticFactsMatchWire ||
      (result.result.status !== "unavailable" &&
        !chainOnlyRejection &&
        semanticFacts.views.length !== dns.required_view_ids.length) ||
      (chainOnlyRejection && (semanticFacts.views.length !== 0 || dnsEntries.length !== 0)) ||
      (terminalChainAuthorityDigest !== null &&
        semanticFacts.views.some(
          (view) => view.chain_authority_digest !== terminalChainAuthorityDigest,
        )) ||
      !ownerDnsSemanticFactsMatchTerminalResult(
        semanticFacts.views,
        result.result,
        dnsEntries.length,
      )
    ) {
      throw invalidInput("HNS observer v2 semantic facts do not match the transcript");
    }
  }
  const logicalPayload = {
    observation_id: input.observation_id,
    observer_fence: input.observer_fence,
    reservation_database_time: reservationDatabaseTime,
    lease_expires_at: leaseExpiresAt,
    request_bytes: requestBytes,
    request_sha256: input.request_sha256,
    configuration_bytes: configurationBytes,
    provider_configuration_digest: input.provider_configuration_digest,
    authority_inventory_bytes:
      input.authority_inventory_bytes === null
        ? null
        : new Uint8Array(input.authority_inventory_bytes),
    authority_inventory_reference_or_null: input.authority_inventory_reference_or_null,
    authority_inventory_version_or_null: input.authority_inventory_version_or_null,
    authority_inventory_digest_or_null: input.authority_inventory_digest_or_null,
    snapshot_reference: input.snapshot_reference,
    transcript,
    transcript_manifest_sha256: transcriptManifestSha256,
    semantic_facts_bytes: new Uint8Array(semanticFacts.semantic_facts_bytes),
    semantic_facts_sha256: semanticFactsSha256,
    observer_snapshot_sha256: observerSnapshotSha256,
    result_status: result.result.status,
    result_reference_kind:
      result.result.status === "verified" || result.result.status === "rejected"
        ? ("provider_evidence_ref" as const)
        : ("diagnostic_ref" as const),
    result_bytes: new Uint8Array(result.result_bytes),
    result_sha256: result.result_sha256,
  } as const;
  const accountingEnvelopeBytes =
    hnsControlObserverSnapshotAccountingEnvelopeV2Bytes(logicalPayload);
  const logicalSnapshotByteLength = hnsControlObserverSnapshotLogicalByteLengthV2(logicalPayload);
  if (
    logicalPayload.semantic_facts_bytes.byteLength === 0 ||
    !Number.isSafeInteger(logicalSnapshotByteLength) ||
    logicalSnapshotByteLength > HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES
  ) {
    throw invalidInput("HNS observer v2 finalization exceeds the retained snapshot bound");
  }
  return {
    ...logicalPayload,
    transcript_byte_length: hnsControlObserverTranscriptByteLength(transcript),
    accounting_envelope_bytes: accountingEnvelopeBytes,
    logical_snapshot_byte_length: logicalSnapshotByteLength,
  } as const;
}

type ValidatedFinalizeInput =
  | Awaited<ReturnType<typeof validateFinalizeInput>>
  | Awaited<ReturnType<typeof validateFinalizeInputV2>>;

async function validateFinalizeInputCompatible(
  input: HnsControlObserverSnapshotFinalizeInput | HnsControlObserverSnapshotFinalizeInputV2,
  operation: Row,
): Promise<ValidatedFinalizeInput> {
  return "observer_snapshot_sha256" in input
    ? validateFinalizeInputV2(input, operation)
    : validateFinalizeInput(input, operation);
}

export function makeControlPlaneHnsControlObserverRepository(
  options: Readonly<{ readonly snapshotStoreReference?: string }> = {},
) {
  const snapshotStoreReference = options.snapshotStoreReference ?? DEFAULT_SNAPSHOT_STORE_REFERENCE;

  const resolve = (identity: Readonly<{ readonly reference: string; readonly version: string }>) =>
    Effect.gen(function* () {
      if (!safeIdentity(identity.reference, 512) || !safeIdentity(identity.version, 256)) {
        return yield* Effect.fail(invalidInput("HNS observer configuration identity is invalid"));
      }
      const db = yield* ControlPlaneDb;
      const selected = yield* db.execute<Row>({
        label: "hns-control-observer.configuration.resolve",
        text: `SELECT configuration_bytes
                 FROM hns_control_observer_configurations
                WHERE provider_configuration_reference = $1
                  AND provider_configuration_version = $2`,
        values: [identity.reference, identity.version],
        readonly: true,
      });
      const row = oneRow(selected);
      if (row === null) return null;
      if (row === undefined) {
        return yield* Effect.fail(invalidRow("HNS observer configuration identity is ambiguous"));
      }
      const bytes = copyBytes(row.configuration_bytes);
      if (
        bytes === null ||
        bytes.byteLength === 0 ||
        bytes.byteLength > HNS_CONTROL_OBSERVER_CONFIGURATION_MAX_BYTES
      ) {
        return yield* Effect.fail(invalidRow("HNS observer configuration row is invalid"));
      }
      return bytes;
    });

  const read = (snapshotReference: string) =>
    Effect.gen(function* () {
      if (!isHnsControlObserverSnapshotReference(snapshotReference)) {
        return yield* Effect.fail(invalidInput("HNS observer snapshot reference is invalid"));
      }
      const db = yield* ControlPlaneDb;
      const selected = yield* db.execute<Row>({
        label: "hns-control-observer.snapshot.read",
        text: `SELECT snapshot_reference, request_bytes, result_bytes, result_sha256
                 FROM hns_control_observer_snapshots
                WHERE snapshot_reference = $1`,
        values: [snapshotReference],
        readonly: true,
      });
      const row = oneRow(selected);
      if (row === null) return null;
      if (row === undefined) {
        return yield* Effect.fail(invalidRow("HNS observer snapshot reference is ambiguous"));
      }
      const requestBytes = copyBytes(row.request_bytes);
      const resultBytes = copyBytes(row.result_bytes);
      const resultSha256 = stringValue(row, "result_sha256");
      if (
        stringValue(row, "snapshot_reference") !== snapshotReference ||
        requestBytes === null ||
        requestBytes.byteLength === 0 ||
        resultBytes === null ||
        resultBytes.byteLength === 0 ||
        resultSha256 === null ||
        !/^[0-9a-f]{64}$/u.test(resultSha256)
      ) {
        return yield* Effect.fail(invalidRow("HNS observer retained snapshot row is invalid"));
      }
      return {
        snapshot_reference: snapshotReference,
        request_bytes: requestBytes,
        result_bytes: resultBytes,
        result_sha256: resultSha256 as Sha256HexValue,
      } satisfies HnsControlObserverRetainedSnapshotV1;
    });

  const reserve = (rawInput: HnsControlObserverReservationInput) =>
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise({
        try: () => validateReservationInput(rawInput, snapshotStoreReference),
        catch: (error) =>
          error instanceof HnsControlObserverPostgresError
            ? error
            : invalidInput("HNS observer reservation input failed strict decoding"),
      });
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* transaction.execute({
            label: "hns-control-observer.operation.insert",
            text: `INSERT INTO hns_control_observer_operations (
                     observation_id,
                     provider_configuration_reference,
                     provider_configuration_version,
                     provider_configuration_digest,
                     request_bytes,
                     request_sha256,
                     configuration_bytes,
                     snapshot_reference
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
                   ON CONFLICT (observation_id) DO NOTHING`,
            values: [
              input.observation_id,
              input.provider_configuration_reference,
              input.provider_configuration_version,
              input.provider_configuration_digest,
              input.request_bytes,
              input.request_sha256,
              input.configuration_bytes,
            ],
            readonly: false,
          });
          const operationResult = yield* transaction.execute<Row>({
            label: "hns-control-observer.operation.lock",
            text: LOCK_OPERATION_SQL,
            values: [input.observation_id],
            readonly: false,
          });
          const operation = oneRow(operationResult);
          if (operation === undefined || operation === null) {
            return yield* Effect.fail(invalidRow("HNS observer operation row is missing"));
          }
          if (!rowIdentityMatches(operation, input)) {
            return { kind: "mismatch" } as const;
          }
          const snapshotReference = stringValue(operation, "snapshot_reference");
          if (
            snapshotReference === null ||
            !isHnsControlObserverSnapshotReference(snapshotReference)
          ) {
            return yield* Effect.fail(invalidRow("HNS observer snapshot reference is invalid"));
          }

          const reservationResult = yield* transaction.execute<Row>({
            label: "hns-control-observer.reservation.lock",
            text: LOCK_RESERVATION_SQL,
            values: [input.observation_id],
            readonly: false,
          });
          const reservation = oneRow(reservationResult);
          if (reservation === undefined) {
            return yield* Effect.fail(invalidRow("HNS observer reservation identity is ambiguous"));
          }
          if (reservation === null) {
            const inserted = yield* transaction.execute<Row>({
              label: "hns-control-observer.reservation.insert",
              text: `WITH db_clock AS (
                       SELECT date_trunc('milliseconds', clock_timestamp()) AS database_now
                     )
                     INSERT INTO hns_control_observer_reservations (
                       observation_id,
                       state,
                       reservation_lease_seconds,
                       observer_fence,
                       reservation_database_time,
                       lease_expires_at,
                       created_at,
                       updated_at
                     )
                     SELECT $1,
                            'reserved',
                            $2::INTEGER,
                            1,
                            database_now,
                            database_now + ($2::INTEGER) * INTERVAL '1 second',
                            database_now,
                            database_now
                       FROM db_clock
                     RETURNING observer_fence, ${FORMAT_RESERVATION_SQL}`,
              values: [input.observation_id, input.reservation_lease_seconds],
              readonly: false,
            });
            const row = oneRow(inserted);
            if (row === undefined || row === null) {
              return yield* Effect.fail(invalidRow("HNS observer reservation was not inserted"));
            }
            const observerFence = integerValue(row, "observer_fence");
            const reservationDatabaseTime = stringValue(row, "reservation_database_time");
            const leaseExpiresAt = stringValue(row, "lease_expires_at");
            if (
              observerFence !== 1 ||
              reservationDatabaseTime === null ||
              leaseExpiresAt === null
            ) {
              return yield* Effect.fail(invalidRow("HNS observer reservation result is invalid"));
            }
            return {
              kind: "acquired",
              observer_fence: observerFence,
              reservation_database_time: reservationDatabaseTime,
              lease_expires_at: leaseExpiresAt,
              snapshot_reference: snapshotReference,
            } as const;
          }

          if (stringValue(reservation, "state") === "terminal") {
            const replayResult = yield* transaction.execute<Row>({
              label: "hns-control-observer.snapshot.replay",
              text: SELECT_SNAPSHOT_REPLAY_SQL,
              values: [input.observation_id],
              readonly: true,
            });
            return replayFromRow(oneRow(replayResult));
          }
          if (
            stringValue(reservation, "state") !== "reserved" ||
            integerValue(reservation, "reservation_lease_seconds") !==
              input.reservation_lease_seconds
          ) {
            return yield* Effect.fail(invalidRow("HNS observer reservation row is invalid"));
          }

          const reacquired = yield* transaction.execute<Row>({
            label: "hns-control-observer.reservation.reacquire",
            text: `WITH db_clock AS (
                     SELECT date_trunc('milliseconds', clock_timestamp()) AS database_now
                   )
                   UPDATE hns_control_observer_reservations AS reservation
                      SET observer_fence = reservation.observer_fence + 1,
                          reservation_database_time = db_clock.database_now,
                          lease_expires_at = db_clock.database_now
                            + reservation.reservation_lease_seconds * INTERVAL '1 second',
                          updated_at = db_clock.database_now
                     FROM db_clock
                    WHERE reservation.observation_id = $1
                      AND reservation.state = 'reserved'
                      AND reservation.observer_fence < $2
                      AND reservation.lease_expires_at <= db_clock.database_now
                   RETURNING reservation.observer_fence, ${FORMAT_RESERVATION_SQL}`,
            values: [input.observation_id, MAX_SAFE_FENCE],
            readonly: false,
          });
          const reacquiredRow = oneRow(reacquired);
          if (reacquiredRow !== null && reacquiredRow !== undefined) {
            const observerFence = integerValue(reacquiredRow, "observer_fence");
            const reservationDatabaseTime = stringValue(reacquiredRow, "reservation_database_time");
            const leaseExpiresAt = stringValue(reacquiredRow, "lease_expires_at");
            if (
              observerFence === null ||
              reservationDatabaseTime === null ||
              leaseExpiresAt === null
            ) {
              return yield* Effect.fail(invalidRow("HNS observer reacquisition row is invalid"));
            }
            return {
              kind: "acquired",
              observer_fence: observerFence,
              reservation_database_time: reservationDatabaseTime,
              lease_expires_at: leaseExpiresAt,
              snapshot_reference: snapshotReference,
            } as const;
          }
          if (reacquiredRow === undefined) {
            return yield* Effect.fail(invalidRow("HNS observer reacquisition is ambiguous"));
          }

          const busyResult = yield* transaction.execute<Row>({
            label: "hns-control-observer.reservation.busy",
            text: `WITH db_clock AS (SELECT clock_timestamp() AS database_now)
                   SELECT GREATEST(
                            1,
                            CEIL(EXTRACT(EPOCH FROM (reservation.lease_expires_at
                              - db_clock.database_now)))
                          )::BIGINT AS retry_after_seconds
                     FROM hns_control_observer_reservations AS reservation,
                          db_clock
                    WHERE reservation.observation_id = $1
                      AND reservation.state = 'reserved'
                      AND reservation.lease_expires_at > db_clock.database_now`,
            values: [input.observation_id],
            readonly: true,
          });
          const busy = oneRow(busyResult);
          const retryAfterSeconds =
            busy === null ? null : integerValue(busy ?? {}, "retry_after_seconds");
          if (busy === undefined || retryAfterSeconds === null) {
            return yield* Effect.fail(invalidRow("HNS observer live reservation is invalid"));
          }
          return { kind: "busy", retry_after_seconds: retryAfterSeconds } as const;
        }),
      );
    });

  const finalize = (
    rawInput: HnsControlObserverSnapshotFinalizeInput | HnsControlObserverSnapshotFinalizeInputV2,
  ) =>
    Effect.gen(function* () {
      if (
        !safeIdentity(rawInput.observation_id, 256) ||
        !Number.isSafeInteger(rawInput.observer_fence) ||
        rawInput.observer_fence < 1 ||
        !isHnsControlObserverSnapshotReference(rawInput.snapshot_reference)
      ) {
        return { kind: "mismatch" } as const;
      }
      const db = yield* ControlPlaneDb;
      const authorityResult = yield* db.execute<Row>({
        label: "hns-control-observer.finalize.authority",
        text: SELECT_FINALIZE_AUTHORITY_SQL,
        values: [rawInput.observation_id],
        readonly: true,
      });
      const authority = oneRow(authorityResult);
      if (authority === null) return { kind: "mismatch" } as const;
      if (authority === undefined) {
        return yield* Effect.fail(invalidRow("HNS observer finalization authority is ambiguous"));
      }
      const requestBytes = copyBytes(authority.request_bytes);
      const configurationBytes = copyBytes(authority.configuration_bytes);
      if (
        requestBytes === null ||
        configurationBytes === null ||
        !rowIdentityMatches(authority, {
          observation_id: rawInput.observation_id,
          request_bytes: requestBytes,
          request_sha256: rawInput.request_sha256,
          configuration_bytes: configurationBytes,
          provider_configuration_digest: rawInput.provider_configuration_digest,
        }) ||
        stringValue(authority, "snapshot_reference") !== rawInput.snapshot_reference
      ) {
        return { kind: "mismatch" } as const;
      }
      if (stringValue(authority, "state") === "terminal") {
        const replayResult = yield* db.execute<Row>({
          label: "hns-control-observer.finalize.replay",
          text: SELECT_SNAPSHOT_REPLAY_SQL,
          values: [rawInput.observation_id],
          readonly: true,
        });
        const replay = replayFromRow(oneRow(replayResult));
        return replay.result_sha256 === rawInput.result_sha256 &&
          bytesEqual(replay.result_bytes, rawInput.result_bytes)
          ? replay
          : ({ kind: "mismatch" } as const);
      }

      const input = yield* Effect.tryPromise({
        try: () => validateFinalizeInputCompatible(rawInput, authority),
        catch: (error) =>
          error instanceof HnsControlObserverPostgresError
            ? error
            : invalidInput("HNS observer finalization failed strict decoding"),
      });

      const attempted = yield* db
        .withTransaction((transaction) =>
          Effect.gen(function* () {
            const operationResult = yield* transaction.execute<Row>({
              label: "hns-control-observer.finalize.lock-operation",
              text: LOCK_OPERATION_SQL,
              values: [input.observation_id],
              readonly: false,
            });
            const operation = oneRow(operationResult);
            if (operation === undefined || operation === null) {
              return yield* Effect.fail(invalidRow("HNS observer operation disappeared"));
            }
            if (!rowIdentityMatches(operation, input)) return { kind: "mismatch" } as const;

            const reservationResult = yield* transaction.execute<Row>({
              label: "hns-control-observer.finalize.lock-reservation",
              text: LOCK_RESERVATION_SQL,
              values: [input.observation_id],
              readonly: false,
            });
            const reservation = oneRow(reservationResult);
            if (reservation === undefined || reservation === null) {
              return yield* Effect.fail(invalidRow("HNS observer reservation disappeared"));
            }
            if (stringValue(reservation, "state") === "terminal") {
              const replayResult = yield* transaction.execute<Row>({
                label: "hns-control-observer.finalize.concurrent-replay",
                text: SELECT_SNAPSHOT_REPLAY_SQL,
                values: [input.observation_id],
                readonly: true,
              });
              const replay = replayFromRow(oneRow(replayResult));
              return replay.result_sha256 === input.result_sha256 &&
                bytesEqual(replay.result_bytes, input.result_bytes)
                ? replay
                : ({ kind: "mismatch" } as const);
            }
            if (
              stringValue(reservation, "state") !== "reserved" ||
              integerValue(reservation, "observer_fence") !== input.observer_fence ||
              stringValue(reservation, "reservation_database_time") !==
                input.reservation_database_time ||
              stringValue(reservation, "lease_expires_at") !== input.lease_expires_at
            ) {
              return { kind: "lost" } as const;
            }

            const inserted = yield* transaction.execute({
              label: "hns-control-observer.snapshot.insert",
              text: `INSERT INTO hns_control_observer_snapshots (
                       snapshot_reference,
                       observation_id,
                       observer_fence,
                       request_bytes,
                       request_sha256,
                       configuration_bytes,
                       provider_configuration_digest,
                       authority_inventory_bytes,
                       authority_inventory_reference,
                       authority_inventory_version,
                       authority_inventory_digest,
                       reservation_database_time,
                       lease_expires_at,
                       semantic_facts_bytes,
                       semantic_facts_sha256,
                       transcript_manifest_sha256,
                       observer_snapshot_sha256,
                       result_status,
                       result_reference_kind,
                       result_reference,
                       result_bytes,
                       result_sha256,
                       transcript_entry_count,
                       transcript_byte_length,
                       accounting_envelope_bytes,
                       logical_snapshot_byte_length,
                       retained_at
                     )
                     SELECT operation.snapshot_reference,
                            operation.observation_id,
                            reservation.observer_fence,
                            operation.request_bytes,
                            operation.request_sha256,
                            operation.configuration_bytes,
                            operation.provider_configuration_digest,
                            $5,
                            $6,
                            $7,
                            $8,
                            reservation.reservation_database_time,
                            reservation.lease_expires_at,
                            $9,
                            $10,
                            $11,
                            $12,
                            $13,
                            $14,
                            operation.snapshot_reference,
                            $15,
                            $16,
                            $17,
                            $18,
                            $19,
                            $20,
                            date_trunc('milliseconds', clock_timestamp())
                       FROM hns_control_observer_operations AS operation
                       JOIN hns_control_observer_reservations AS reservation
                         USING (observation_id)
                      WHERE operation.observation_id = $1
                        AND operation.request_sha256 = $2
                        AND operation.provider_configuration_digest = $3
                        AND operation.snapshot_reference = $4
                        AND reservation.state = 'reserved'
                        AND reservation.observer_fence = $21
                        AND reservation.lease_expires_at > clock_timestamp()`,
              values: [
                input.observation_id,
                input.request_sha256,
                input.provider_configuration_digest,
                input.snapshot_reference,
                input.authority_inventory_bytes,
                input.authority_inventory_reference_or_null,
                input.authority_inventory_version_or_null,
                input.authority_inventory_digest_or_null,
                input.semantic_facts_bytes,
                input.semantic_facts_sha256,
                input.transcript_manifest_sha256,
                input.observer_snapshot_sha256,
                input.result_status,
                input.result_reference_kind,
                input.result_bytes,
                input.result_sha256,
                input.transcript.length,
                input.transcript_byte_length,
                input.accounting_envelope_bytes,
                input.logical_snapshot_byte_length,
                input.observer_fence,
              ],
              readonly: false,
            });
            if (inserted.rowCount !== 1) return yield* Effect.fail(new FinalizationFenceLost());

            for (let index = 0; index < input.transcript.length; index += 1) {
              const entry = input.transcript[index];
              if (entry === undefined) {
                return yield* Effect.fail(invalidRow("HNS observer transcript entry disappeared"));
              }
              yield* transaction.execute({
                label: "hns-control-observer.transcript.insert",
                text: `INSERT INTO hns_control_observer_snapshot_transcript_entries (
                         snapshot_reference,
                         entry_ordinal,
                         driver_reference,
                         ownership_source,
                         method_or_view_id,
                         request_bytes,
                         request_sha256,
                         transport_outcome,
                         transport_status,
                         response_bytes,
                         response_sha256
                       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                values: [
                  input.snapshot_reference,
                  index,
                  entry.driver_reference,
                  entry.ownership_source,
                  entry.method_or_view_id,
                  entry.request_bytes,
                  entry.request_sha256,
                  entry.transport_outcome,
                  entry.transport_status,
                  entry.response_bytes,
                  entry.response_sha256,
                ],
                readonly: false,
              });
            }

            const terminal = yield* transaction.execute({
              label: "hns-control-observer.reservation.finalize",
              text: `WITH db_clock AS (
                       SELECT date_trunc('milliseconds', clock_timestamp()) AS database_now
                     )
                     UPDATE hns_control_observer_reservations AS reservation
                        SET state = 'terminal',
                            terminal_snapshot_reference = $4,
                            terminal_status = $5,
                            terminal_at = db_clock.database_now,
                            updated_at = db_clock.database_now
                       FROM db_clock
                      WHERE reservation.observation_id = $1
                        AND reservation.state = 'reserved'
                        AND reservation.observer_fence = $2
                        AND reservation.lease_expires_at > clock_timestamp()
                        AND EXISTS (
                          SELECT 1
                            FROM hns_control_observer_operations AS operation
                           WHERE operation.observation_id = reservation.observation_id
                             AND operation.request_sha256 = $3
                             AND operation.provider_configuration_digest = $6
                             AND operation.snapshot_reference = $4
                        )`,
              values: [
                input.observation_id,
                input.observer_fence,
                input.request_sha256,
                input.snapshot_reference,
                input.result_status,
                input.provider_configuration_digest,
              ],
              readonly: false,
            });
            if (terminal.rowCount !== 1) return yield* Effect.fail(new FinalizationFenceLost());
            return {
              kind: "retained",
              snapshot_reference: input.snapshot_reference,
              result_bytes: new Uint8Array(input.result_bytes),
              result_sha256: input.result_sha256,
            } as const;
          }),
        )
        .pipe(Effect.result);
      if (attempted._tag === "Success") return attempted.success;
      if (attempted.failure instanceof FinalizationFenceLost) return { kind: "lost" } as const;
      return yield* Effect.fail(attempted.failure);
    });

  return { resolve, read, reserve, finalize } as const;
}

function runPort<A, E>(
  effect: Effect.Effect<A, E, ControlPlaneDb>,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: Readonly<{ readonly deadline_ms: number; readonly signal: AbortSignal }>,
): Promise<A> {
  if (
    options.signal.aborted ||
    !Number.isSafeInteger(options.deadline_ms) ||
    options.deadline_ms <= 0
  ) {
    return Promise.reject(invalidInput("HNS observer persistence deadline is invalid or aborted"));
  }
  return Effect.runPromise(
    Effect.scoped(Effect.timeout(Effect.provide(runtime)(effect), options.deadline_ms)),
    { signal: options.signal },
  );
}

export function makeControlPlaneHnsControlObserverConfigurationResolver(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HnsControlObserverConfigurationResolverPort {
  const repository = makeControlPlaneHnsControlObserverRepository();
  return {
    resolve: (identity, options) => runPort(repository.resolve(identity), runtime, options),
  };
}

export function makeControlPlaneHnsAuthorityInventoryResolver(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: Readonly<{
    readonly registryReference: string;
    readonly responseMaxBytes: number;
  }>,
): HnsAuthorityInventoryResolverPortV1 {
  if (
    !safeIdentity(options.registryReference, 256) ||
    !Number.isSafeInteger(options.responseMaxBytes) ||
    options.responseMaxBytes < 1 ||
    options.responseMaxBytes > 65_536
  ) {
    throw invalidInput("HNS authority inventory registry options are invalid");
  }
  return {
    resolve: (runOptions) =>
      runPort(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const selected = yield* db.execute<Row>({
            label: "hns-authority-inventory.current.resolve",
            text: `WITH db_clock AS (
                     SELECT date_trunc('milliseconds', clock_timestamp()) AS database_now
                   )
                   SELECT authority_inventory_reference,
                          authority_inventory_version,
                          authority_inventory_digest,
                          inventory_bytes
                     FROM hns_authority_inventories, db_clock
                    WHERE registry_reference = $1
                      AND published_at <= db_clock.database_now
                      AND expires_at > db_clock.database_now
                    ORDER BY published_at DESC, authority_inventory_version
                    LIMIT 2`,
            values: [options.registryReference],
            readonly: true,
          });
          if (selected.rowCount === 0 && selected.rows.length === 0) return null;
          if (selected.rowCount !== 1 || selected.rows.length !== 1) {
            return yield* Effect.fail(
              invalidRow("HNS authority inventory registry has ambiguous current authority"),
            );
          }
          const row = selected.rows[0] ?? {};
          const reference = stringValue(row, "authority_inventory_reference");
          const version = stringValue(row, "authority_inventory_version");
          const digest = stringValue(row, "authority_inventory_digest");
          const bytes = copyBytes(row.inventory_bytes);
          if (
            reference === null ||
            version === null ||
            digest === null ||
            !/^[0-9a-f]{64}$/u.test(digest) ||
            bytes === null ||
            bytes.byteLength < 1 ||
            bytes.byteLength > options.responseMaxBytes
          ) {
            return yield* Effect.fail(invalidRow("HNS authority inventory row is invalid"));
          }
          return {
            authority_inventory_reference: reference,
            authority_inventory_version: version,
            authority_inventory_digest: digest as Sha256HexValue,
            inventory_bytes: bytes,
          } as const;
        }),
        runtime,
        runOptions,
      ),
  };
}

export function makeControlPlaneHnsControlObserverSnapshotStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: Readonly<{ readonly snapshotStoreReference?: string }> = {},
): HnsControlObserverSnapshotStorePort {
  const repository = makeControlPlaneHnsControlObserverRepository(options);
  return {
    reserve: (input, runOptions) =>
      runPort(
        repository.reserve({
          ...input,
          request_bytes: new Uint8Array(input.request_bytes),
          configuration_bytes: new Uint8Array(input.configuration_bytes),
        }),
        runtime,
        runOptions,
      ) as Promise<HnsControlObserverReservationOutcome>,
    finalize: (input, runOptions) =>
      runPort(
        repository.finalize({
          ...input,
          transcript: input.transcript.map((entry) => ({
            ...entry,
            request_bytes: new Uint8Array(entry.request_bytes),
            response_bytes:
              entry.response_bytes === null ? null : new Uint8Array(entry.response_bytes),
          })),
          semantic_facts_bytes: new Uint8Array(input.semantic_facts_bytes),
          result_bytes: new Uint8Array(input.result_bytes),
        }),
        runtime,
        runOptions,
      ) as Promise<HnsControlObserverSnapshotFinalizeOutcome>,
  };
}

export function makeControlPlaneHnsControlObserverSnapshotStoreV2(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: Readonly<{ readonly snapshotStoreReference?: string }> = {},
): HnsControlObserverSnapshotStorePortV2 {
  const repository = makeControlPlaneHnsControlObserverRepository(options);
  return {
    reserve: (input, runOptions) =>
      runPort(
        repository.reserve({
          ...input,
          request_bytes: new Uint8Array(input.request_bytes),
          configuration_bytes: new Uint8Array(input.configuration_bytes),
        }),
        runtime,
        runOptions,
      ) as Promise<HnsControlObserverReservationOutcome>,
    finalize: (input, runOptions) =>
      runPort(
        repository.finalize({
          ...input,
          authority_inventory_bytes:
            input.authority_inventory_bytes === null
              ? null
              : new Uint8Array(input.authority_inventory_bytes),
          transcript: input.transcript.map((entry) => ({
            ...entry,
            request_bytes: new Uint8Array(entry.request_bytes),
            response_bytes:
              entry.response_bytes === null ? null : new Uint8Array(entry.response_bytes),
          })),
          semantic_facts_bytes: new Uint8Array(input.semantic_facts_bytes),
          result_bytes: new Uint8Array(input.result_bytes),
        }),
        runtime,
        runOptions,
      ) as Promise<HnsControlObserverSnapshotFinalizeOutcome>,
  };
}

export function makeControlPlaneHnsControlObserverSnapshotReader(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HnsControlObserverSnapshotReaderPort {
  const repository = makeControlPlaneHnsControlObserverRepository();
  return {
    read: (snapshotReference, runOptions) =>
      runPort(repository.read(snapshotReference), runtime, runOptions)
        .then((snapshot) =>
          snapshot === null
            ? null
            : {
                ...snapshot,
                request_bytes: new Uint8Array(snapshot.request_bytes),
                result_bytes: new Uint8Array(snapshot.result_bytes),
              },
        )
        .catch((error: unknown) =>
          Promise.reject(
            new HnsControlObserverSnapshotReadError(
              error instanceof HnsControlObserverPostgresError && error.reason !== "storage"
                ? "invalid_snapshot"
                : "unavailable",
            ),
          ),
        ),
  };
}
