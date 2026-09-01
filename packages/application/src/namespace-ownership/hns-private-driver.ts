import { validCommunityRouteRoot } from "@pirate/domain";
import {
  decodeHnsAuthoritativeDnsQueryV1,
  type HnsAuthoritativeDnsAddressFamilyV1,
  type HnsAuthoritativeDnsQueryKindV1,
} from "./hns-authoritative-dns.ts";
import {
  HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES,
  HNS_CONTROL_OBSERVER_HSD_METHODS,
} from "./hns-control-observer-store.ts";
import { decodeStrictHnsJsonBytes } from "./hns-evidence.ts";

export const HNS_PRIVATE_DRIVER_PROTOCOL = "pirate-hns-private-driver-v1" as const;
export const HNS_PRIVATE_DRIVER_REQUEST_VERSION = "pirate-hns-private-driver-request-v1" as const;
export const HNS_PRIVATE_DRIVER_ERROR_VERSION = "pirate-hns-private-driver-error-v1" as const;
export const HNS_PRIVATE_DRIVER_ORIGIN = "http://hns-observer-driver.internal" as const;
export const HNS_PRIVATE_DRIVER_HSD_PATH = "/internal/hns-observer-driver/v1/hsd" as const;
export const HNS_PRIVATE_DRIVER_DNS_PATH =
  "/internal/hns-observer-driver/v1/authoritative-dns" as const;
export const HNS_PRIVATE_DRIVER_AXFR_PATH =
  "/internal/hns-observer-driver/v1/authoritative-axfr" as const;
export const HNS_PRIVATE_DRIVER_REQUEST_MAX_BYTES = 12_288 as const;
export const HNS_PRIVATE_DRIVER_ERROR_MAX_BYTES = 256 as const;
export const HNS_PRIVATE_DRIVER_TIMEOUT_MAX_MS = 12_000 as const;
export const HNS_PRIVATE_DRIVER_HSD_RESPONSE_MAX_BYTES = 1_048_576 as const;
export const HNS_PRIVATE_DRIVER_DNS_RESPONSE_MAX_BYTES = 65_535 as const;
export const HNS_PRIVATE_DRIVER_AXFR_MESSAGE_MAX_BYTES = 65_535 as const;
export const HNS_PRIVATE_DRIVER_AXFR_MESSAGE_MAX_COUNT = 512 as const;
export const HNS_PRIVATE_DRIVER_AXFR_TOTAL_MAX_BYTES = 2 * 1_048_576;
export const HNS_PRIVATE_DRIVER_AXFR_SEQUENCE_MAX_BYTES =
  HNS_PRIVATE_DRIVER_AXFR_TOTAL_MAX_BYTES + 2 * HNS_PRIVATE_DRIVER_AXFR_MESSAGE_MAX_COUNT;
export const HNS_PRIVATE_DRIVER_AXFR_RESPONSE_MAX_BYTES =
  HNS_PRIVATE_DRIVER_AXFR_SEQUENCE_MAX_BYTES + HNS_PRIVATE_DRIVER_AXFR_MESSAGE_MAX_BYTES + 256;

export const HNS_PRIVATE_DRIVER_PROTOCOL_HEADER = "Pirate-HNS-Driver-Protocol" as const;
export const HNS_PRIVATE_DRIVER_UPSTREAM_STATUS_HEADER =
  "Pirate-HNS-Driver-Upstream-Status" as const;
export const HNS_PRIVATE_DRIVER_UPSTREAM_CONTENT_TYPE_HEADER =
  "Pirate-HNS-Driver-Upstream-Content-Type" as const;
export const HNS_PRIVATE_DRIVER_HSD_NAME_PROOF_METHOD = "verifymessagewithname" as const;

export type HnsPrivateDriverHsdRequestV1 = Readonly<{
  readonly version: typeof HNS_PRIVATE_DRIVER_REQUEST_VERSION;
  readonly exchange_kind: "hsd_json_rpc";
  readonly driver_reference: string;
  readonly request_bytes_base64: string;
  readonly response_max_bytes: number;
  readonly timeout_ms: number;
}>;

export type HnsPrivateDriverAuthoritativeDnsRequestV1 = Readonly<{
  readonly version: typeof HNS_PRIVATE_DRIVER_REQUEST_VERSION;
  readonly exchange_kind: "authoritative_dns_tcp";
  readonly driver_reference: string;
  readonly view_id: string;
  readonly query_kind: HnsAuthoritativeDnsQueryKindV1;
  readonly root_label: string;
  readonly chain_authority_digest: string;
  readonly authority_nameserver: string;
  readonly authority_address_family: HnsAuthoritativeDnsAddressFamilyV1;
  readonly authority_address: string;
  readonly request_bytes_base64: string;
  readonly response_max_bytes: number;
  readonly timeout_ms: number;
}>;

export type HnsPrivateDriverAuthoritativeAxfrRequestV1 = Readonly<{
  readonly version: typeof HNS_PRIVATE_DRIVER_REQUEST_VERSION;
  readonly exchange_kind: "authoritative_dns_tsig_axfr";
  readonly driver_reference: string;
  readonly view_id: string;
  readonly credential_reference: string;
  readonly root_label: string;
  readonly authority_nameserver: string;
  readonly authority_address_family: HnsAuthoritativeDnsAddressFamilyV1;
  readonly authority_address: string;
  readonly response_message_max_bytes: number;
  readonly response_total_max_bytes: number;
  readonly response_max_messages: number;
  readonly timeout_ms: number;
}>;

export type HnsPrivateDriverRequestV1 =
  | HnsPrivateDriverHsdRequestV1
  | HnsPrivateDriverAuthoritativeDnsRequestV1
  | HnsPrivateDriverAuthoritativeAxfrRequestV1;

export type HnsPrivateDriverDecodedRequestV1 =
  | Readonly<{
      readonly request: HnsPrivateDriverHsdRequestV1 | HnsPrivateDriverAuthoritativeDnsRequestV1;
      readonly request_bytes: Uint8Array;
    }>
  | Readonly<{
      readonly request: HnsPrivateDriverAuthoritativeAxfrRequestV1;
    }>;

export type HnsPrivateDriverAuthoritativeAxfrResponseV1 = Readonly<{
  readonly request_bytes: Uint8Array;
  readonly response_sequence_bytes: Uint8Array;
}>;

export type HnsPrivateDriverAuthoritativeAxfrExchangeInputV1 = Readonly<{
  readonly driver_reference: string;
  readonly view_id: string;
  readonly credential_reference: string;
  readonly root_label: string;
  readonly authority_nameserver: string;
  readonly authority_address_family: HnsAuthoritativeDnsAddressFamilyV1;
  readonly authority_address: string;
  readonly response_message_max_bytes: number;
  readonly response_total_max_bytes: number;
  readonly response_max_messages: number;
  readonly signal: AbortSignal;
}>;

export type HnsPrivateDriverAuthoritativeAxfrTransportPortV1 = Readonly<{
  readonly exchange: (
    input: HnsPrivateDriverAuthoritativeAxfrExchangeInputV1,
  ) => Promise<HnsPrivateDriverAuthoritativeAxfrResponseV1>;
}>;

export class HnsPrivateDriverAuthoritativeAxfrTransportErrorV1 extends Error {
  readonly name = "HnsPrivateDriverAuthoritativeAxfrTransportErrorV1";

  constructor(readonly outcome: "timeout" | "transport_error" | "aborted") {
    super(outcome);
  }
}

export type HnsPrivateDriverErrorCodeV1 =
  | "invalid_request"
  | "request_too_large"
  | "upstream_protocol_error"
  | "upstream_unavailable"
  | "timeout"
  | "internal_error";

export type HnsPrivateDriverErrorV1 = Readonly<{
  readonly version: typeof HNS_PRIVATE_DRIVER_ERROR_VERSION;
  readonly error: HnsPrivateDriverErrorCodeV1;
}>;

export class HnsPrivateDriverWireError extends Error {
  readonly name = "HnsPrivateDriverWireError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const hsdMethods = new Set<string>([
  ...HNS_CONTROL_OBSERVER_HSD_METHODS,
  HNS_PRIVATE_DRIVER_HSD_NAME_PROOF_METHOD,
]);
const driverReferencePattern = /^[a-z][a-z0-9-]{0,63}:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const viewIdPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const canonicalDnsNamePattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const axfrResponseMagic = encoder.encode("pirate-hns-private-driver-axfr-response-v1\0");
const errorStatus = {
  invalid_request: 400,
  request_too_large: 413,
  upstream_protocol_error: 502,
  upstream_unavailable: 503,
  timeout: 504,
  internal_error: 500,
} as const satisfies Readonly<Record<HnsPrivateDriverErrorCodeV1, number>>;
const errorCodes = new Set<string>(Object.keys(errorStatus));

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function safeText(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
  if (encoder.encode(value).byteLength > maximumBytes) return false;
  return [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
  });
}

function canonicalCompactHnsSignature(value: string): boolean {
  try {
    const decoded = atob(value);
    return decoded.length === 64 && btoa(decoded) === value;
  } catch {
    return false;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || !canonicalBase64Pattern.test(value)) {
    throw new HnsPrivateDriverWireError("HNS private-driver byte field is not canonical base64");
  }
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64(bytes) !== value) throw new Error("non-canonical base64");
    return bytes;
  } catch {
    throw new HnsPrivateDriverWireError("HNS private-driver byte field is invalid base64");
  }
}

export function isCanonicalHnsPrivateDriverHsdRequest(method: string, bytes: Uint8Array): boolean {
  if (
    !hsdMethods.has(method) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES
  ) {
    return false;
  }
  try {
    const text = decoder.decode(bytes);
    const decoded = JSON.parse(text) as unknown;
    if (!isRecord(decoded) || !hasExactKeys(decoded, ["method", "params"])) return false;
    if (decoded.method !== method || !Array.isArray(decoded.params)) return false;
    const parameters = decoded.params;
    const exactParameters =
      method === "getblockchaininfo"
        ? parameters.length === 0
        : method === "getblockheader"
          ? parameters.length === 2 &&
            typeof parameters[0] === "string" &&
            sha256Pattern.test(parameters[0]) &&
            parameters[1] === true
          : method === HNS_PRIVATE_DRIVER_HSD_NAME_PROOF_METHOD
            ? parameters.length === 4 &&
              typeof parameters[0] === "string" &&
              validCommunityRouteRoot("hns", parameters[0]) &&
              typeof parameters[1] === "string" &&
              parameters[1].length <= 512 &&
              canonicalBase64Pattern.test(parameters[1]) &&
              canonicalCompactHnsSignature(parameters[1]) &&
              typeof parameters[2] === "string" &&
              safeText(parameters[2], 2_048) &&
              parameters[3] === true
            : parameters.length === 2 &&
              typeof parameters[0] === "string" &&
              validCommunityRouteRoot("hns", parameters[0]) &&
              parameters[1] === false;
    return exactParameters && JSON.stringify(decoded) === text;
  } catch {
    return false;
  }
}

function hsdMethod(bytes: Uint8Array): string | null {
  try {
    const value = decodeStrictHnsJsonBytes(bytes, HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES);
    if (!isRecord(value) || typeof value.method !== "string") return null;
    return isCanonicalHnsPrivateDriverHsdRequest(value.method, bytes) ? value.method : null;
  } catch {
    return null;
  }
}

function validCommonRequest(value: Record<string, unknown>): boolean {
  return (
    value.version === HNS_PRIVATE_DRIVER_REQUEST_VERSION &&
    typeof value.driver_reference === "string" &&
    driverReferencePattern.test(value.driver_reference) &&
    positiveInteger(value.timeout_ms, HNS_PRIVATE_DRIVER_TIMEOUT_MAX_MS)
  );
}

function decodeHsdRequest(value: Record<string, unknown>): HnsPrivateDriverDecodedRequestV1 {
  if (
    !hasExactKeys(value, [
      "version",
      "exchange_kind",
      "driver_reference",
      "request_bytes_base64",
      "response_max_bytes",
      "timeout_ms",
    ]) ||
    value.exchange_kind !== "hsd_json_rpc" ||
    !validCommonRequest(value) ||
    !positiveInteger(value.response_max_bytes, HNS_PRIVATE_DRIVER_HSD_RESPONSE_MAX_BYTES)
  ) {
    throw new HnsPrivateDriverWireError("HNS private HSD driver request is invalid");
  }
  const requestBytes = decodeBase64(value.request_bytes_base64);
  if (hsdMethod(requestBytes) === null) {
    throw new HnsPrivateDriverWireError("HNS private HSD driver body is invalid");
  }
  return {
    request: value as HnsPrivateDriverHsdRequestV1,
    request_bytes: requestBytes,
  };
}

function decodeDnsRequest(value: Record<string, unknown>): HnsPrivateDriverDecodedRequestV1 {
  if (
    !hasExactKeys(value, [
      "version",
      "exchange_kind",
      "driver_reference",
      "view_id",
      "query_kind",
      "root_label",
      "chain_authority_digest",
      "authority_nameserver",
      "authority_address_family",
      "authority_address",
      "request_bytes_base64",
      "response_max_bytes",
      "timeout_ms",
    ]) ||
    value.exchange_kind !== "authoritative_dns_tcp" ||
    !validCommonRequest(value) ||
    typeof value.view_id !== "string" ||
    !viewIdPattern.test(value.view_id) ||
    (value.query_kind !== "dnskey" && value.query_kind !== "control_txt") ||
    typeof value.root_label !== "string" ||
    !validCommunityRouteRoot("hns", value.root_label) ||
    typeof value.chain_authority_digest !== "string" ||
    !sha256Pattern.test(value.chain_authority_digest) ||
    typeof value.authority_nameserver !== "string" ||
    !canonicalDnsNamePattern.test(value.authority_nameserver) ||
    (value.authority_address_family !== "GLUE4" && value.authority_address_family !== "GLUE6") ||
    !safeText(value.authority_address, 45) ||
    !positiveInteger(value.response_max_bytes, HNS_PRIVATE_DRIVER_DNS_RESPONSE_MAX_BYTES)
  ) {
    throw new HnsPrivateDriverWireError("HNS private DNS driver request is invalid");
  }
  const requestBytes = decodeBase64(value.request_bytes_base64);
  const decoded = decodeHnsAuthoritativeDnsQueryV1(requestBytes);
  if (decoded.query_kind !== value.query_kind || decoded.root_label !== value.root_label) {
    throw new HnsPrivateDriverWireError("HNS private DNS driver body does not match its envelope");
  }
  return {
    request: value as HnsPrivateDriverAuthoritativeDnsRequestV1,
    request_bytes: requestBytes,
  };
}

function decodeAxfrRequest(value: Record<string, unknown>): HnsPrivateDriverDecodedRequestV1 {
  if (
    !hasExactKeys(value, [
      "version",
      "exchange_kind",
      "driver_reference",
      "view_id",
      "credential_reference",
      "root_label",
      "authority_nameserver",
      "authority_address_family",
      "authority_address",
      "response_message_max_bytes",
      "response_total_max_bytes",
      "response_max_messages",
      "timeout_ms",
    ]) ||
    value.exchange_kind !== "authoritative_dns_tsig_axfr" ||
    !validCommonRequest(value) ||
    typeof value.view_id !== "string" ||
    !viewIdPattern.test(value.view_id) ||
    typeof value.credential_reference !== "string" ||
    !driverReferencePattern.test(value.credential_reference) ||
    typeof value.root_label !== "string" ||
    !validCommunityRouteRoot("hns", value.root_label) ||
    typeof value.authority_nameserver !== "string" ||
    !canonicalDnsNamePattern.test(value.authority_nameserver) ||
    (value.authority_address_family !== "GLUE4" && value.authority_address_family !== "GLUE6") ||
    !safeText(value.authority_address, 45) ||
    !positiveInteger(value.response_message_max_bytes, HNS_PRIVATE_DRIVER_AXFR_MESSAGE_MAX_BYTES) ||
    !positiveInteger(value.response_total_max_bytes, HNS_PRIVATE_DRIVER_AXFR_TOTAL_MAX_BYTES) ||
    value.response_total_max_bytes < value.response_message_max_bytes + 2 ||
    !positiveInteger(value.response_max_messages, HNS_PRIVATE_DRIVER_AXFR_MESSAGE_MAX_COUNT)
  ) {
    throw new HnsPrivateDriverWireError("HNS private AXFR driver request is invalid");
  }
  return { request: value as HnsPrivateDriverAuthoritativeAxfrRequestV1 };
}

export function decodeHnsPrivateDriverRequestV1(value: unknown): HnsPrivateDriverDecodedRequestV1 {
  const decoded = decodeStrictHnsJsonBytes(value, HNS_PRIVATE_DRIVER_REQUEST_MAX_BYTES);
  if (!isRecord(decoded)) throw new HnsPrivateDriverWireError("HNS private-driver body is invalid");
  if (decoded.exchange_kind === "hsd_json_rpc") return decodeHsdRequest(decoded);
  if (decoded.exchange_kind === "authoritative_dns_tcp") return decodeDnsRequest(decoded);
  if (decoded.exchange_kind === "authoritative_dns_tsig_axfr") return decodeAxfrRequest(decoded);
  throw new HnsPrivateDriverWireError("HNS private-driver exchange kind is invalid");
}

export function encodeHnsPrivateDriverRequestV1(
  input:
    | (Omit<HnsPrivateDriverHsdRequestV1, "version" | "request_bytes_base64"> &
        Readonly<{ readonly request_bytes: Uint8Array }>)
    | (Omit<HnsPrivateDriverAuthoritativeDnsRequestV1, "version" | "request_bytes_base64"> &
        Readonly<{ readonly request_bytes: Uint8Array }>)
    | Omit<HnsPrivateDriverAuthoritativeAxfrRequestV1, "version">,
): Uint8Array {
  const value =
    input.exchange_kind === "hsd_json_rpc"
      ? {
          version: HNS_PRIVATE_DRIVER_REQUEST_VERSION,
          exchange_kind: input.exchange_kind,
          driver_reference: input.driver_reference,
          request_bytes_base64: encodeBase64(input.request_bytes),
          response_max_bytes: input.response_max_bytes,
          timeout_ms: input.timeout_ms,
        }
      : input.exchange_kind === "authoritative_dns_tcp"
        ? {
            version: HNS_PRIVATE_DRIVER_REQUEST_VERSION,
            exchange_kind: input.exchange_kind,
            driver_reference: input.driver_reference,
            view_id: input.view_id,
            query_kind: input.query_kind,
            root_label: input.root_label,
            chain_authority_digest: input.chain_authority_digest,
            authority_nameserver: input.authority_nameserver,
            authority_address_family: input.authority_address_family,
            authority_address: input.authority_address,
            request_bytes_base64: encodeBase64(input.request_bytes),
            response_max_bytes: input.response_max_bytes,
            timeout_ms: input.timeout_ms,
          }
        : {
            version: HNS_PRIVATE_DRIVER_REQUEST_VERSION,
            exchange_kind: input.exchange_kind,
            driver_reference: input.driver_reference,
            view_id: input.view_id,
            credential_reference: input.credential_reference,
            root_label: input.root_label,
            authority_nameserver: input.authority_nameserver,
            authority_address_family: input.authority_address_family,
            authority_address: input.authority_address,
            response_message_max_bytes: input.response_message_max_bytes,
            response_total_max_bytes: input.response_total_max_bytes,
            response_max_messages: input.response_max_messages,
            timeout_ms: input.timeout_ms,
          };
  const bytes = encoder.encode(JSON.stringify(value));
  decodeHnsPrivateDriverRequestV1(bytes);
  return bytes;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) {
    throw new HnsPrivateDriverWireError("HNS private AXFR response is truncated");
  }
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) {
    throw new HnsPrivateDriverWireError("HNS private AXFR response is truncated");
  }
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

export function encodeHnsPrivateDriverAuthoritativeAxfrResponseV1(
  input: HnsPrivateDriverAuthoritativeAxfrResponseV1,
): Uint8Array {
  const requestBytes = Uint8Array.from(input.request_bytes);
  const sequenceBytes = Uint8Array.from(input.response_sequence_bytes);
  if (
    requestBytes.byteLength === 0 ||
    requestBytes.byteLength > HNS_PRIVATE_DRIVER_AXFR_MESSAGE_MAX_BYTES ||
    sequenceBytes.byteLength === 0 ||
    sequenceBytes.byteLength > HNS_PRIVATE_DRIVER_AXFR_SEQUENCE_MAX_BYTES
  ) {
    throw new HnsPrivateDriverWireError("HNS private AXFR response exceeds its bounds");
  }
  const bytes = new Uint8Array(
    axfrResponseMagic.byteLength + 2 + requestBytes.byteLength + 4 + sequenceBytes.byteLength,
  );
  bytes.set(axfrResponseMagic, 0);
  let offset = axfrResponseMagic.byteLength;
  bytes[offset] = (requestBytes.byteLength >>> 8) & 0xff;
  bytes[offset + 1] = requestBytes.byteLength & 0xff;
  offset += 2;
  bytes.set(requestBytes, offset);
  offset += requestBytes.byteLength;
  bytes[offset] = (sequenceBytes.byteLength >>> 24) & 0xff;
  bytes[offset + 1] = (sequenceBytes.byteLength >>> 16) & 0xff;
  bytes[offset + 2] = (sequenceBytes.byteLength >>> 8) & 0xff;
  bytes[offset + 3] = sequenceBytes.byteLength & 0xff;
  bytes.set(sequenceBytes, offset + 4);
  return bytes;
}

export function decodeHnsPrivateDriverAuthoritativeAxfrResponseV1(
  value: unknown,
): HnsPrivateDriverAuthoritativeAxfrResponseV1 {
  if (!(value instanceof Uint8Array)) {
    throw new HnsPrivateDriverWireError("HNS private AXFR response is invalid");
  }
  const bytes = Uint8Array.from(value);
  if (
    bytes.byteLength <= axfrResponseMagic.byteLength + 6 ||
    !axfrResponseMagic.every((byte, index) => bytes[index] === byte)
  ) {
    throw new HnsPrivateDriverWireError("HNS private AXFR response is invalid");
  }
  let offset = axfrResponseMagic.byteLength;
  const requestLength = readUint16(bytes, offset);
  offset += 2;
  if (requestLength === 0 || offset + requestLength + 4 > bytes.byteLength) {
    throw new HnsPrivateDriverWireError("HNS private AXFR response is invalid");
  }
  const requestBytes = bytes.slice(offset, offset + requestLength);
  offset += requestLength;
  const sequenceLength = readUint32(bytes, offset);
  offset += 4;
  if (
    sequenceLength === 0 ||
    sequenceLength > HNS_PRIVATE_DRIVER_AXFR_SEQUENCE_MAX_BYTES ||
    offset + sequenceLength !== bytes.byteLength
  ) {
    throw new HnsPrivateDriverWireError("HNS private AXFR response is invalid");
  }
  return {
    request_bytes: requestBytes,
    response_sequence_bytes: bytes.slice(offset),
  };
}

export function hnsPrivateDriverErrorStatus(error: HnsPrivateDriverErrorCodeV1): number {
  return errorStatus[error];
}

export function encodeHnsPrivateDriverErrorV1(error: HnsPrivateDriverErrorCodeV1): Uint8Array {
  return encoder.encode(JSON.stringify({ version: HNS_PRIVATE_DRIVER_ERROR_VERSION, error }));
}

export function decodeHnsPrivateDriverErrorV1(
  status: number,
  value: unknown,
): HnsPrivateDriverErrorV1 {
  const decoded = decodeStrictHnsJsonBytes(value, HNS_PRIVATE_DRIVER_ERROR_MAX_BYTES);
  if (
    !isRecord(decoded) ||
    !hasExactKeys(decoded, ["version", "error"]) ||
    decoded.version !== HNS_PRIVATE_DRIVER_ERROR_VERSION ||
    typeof decoded.error !== "string" ||
    !errorCodes.has(decoded.error) ||
    errorStatus[decoded.error as HnsPrivateDriverErrorCodeV1] !== status
  ) {
    throw new HnsPrivateDriverWireError("HNS private-driver error response is invalid");
  }
  return decoded as HnsPrivateDriverErrorV1;
}

export function encodeHnsPrivateDriverUpstreamContentType(value: string | null): string {
  if (value === null) return "-";
  if (!safeText(value, 256)) {
    throw new HnsPrivateDriverWireError("HNS private-driver upstream content type is invalid");
  }
  return encodeBase64(encoder.encode(value));
}

export function decodeHnsPrivateDriverUpstreamContentType(value: string | null): string | null {
  if (value === "-") return null;
  const bytes = decodeBase64(value);
  let decoded: string;
  try {
    decoded = decoder.decode(bytes);
  } catch {
    throw new HnsPrivateDriverWireError("HNS private-driver upstream content type is invalid");
  }
  if (!safeText(decoded, 256) || encodeHnsPrivateDriverUpstreamContentType(decoded) !== value) {
    throw new HnsPrivateDriverWireError("HNS private-driver upstream content type is invalid");
  }
  return decoded;
}
