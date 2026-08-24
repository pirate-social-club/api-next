import { deriveCommunityRoute } from "@pirate/domain";

export const HNS_FORWARDER_V1 = "pirate-hns-forwarder-v1" as const;
export const HNS_FORWARDER_V2 = "pirate-hns-forwarder-v2" as const;
export const HNS_FORWARDER_V3 = "pirate-hns-forwarder-v3" as const;

export const HNS_FORWARDER_HOST_HEADER = "x-pirate-hns-host" as const;
export const HNS_FORWARDER_KEY_ID_HEADER = "x-pirate-hns-forwarder-key-id" as const;
export const HNS_FORWARDER_TIMESTAMP_HEADER = "x-pirate-hns-forwarder-timestamp" as const;
export const HNS_FORWARDER_PATH_HEADER = "x-pirate-hns-forwarder-path" as const;
export const HNS_FORWARDER_BODY_SHA256_HEADER = "x-pirate-hns-forwarder-body-sha256" as const;
export const HNS_FORWARDER_NONCE_HEADER = "x-pirate-hns-forwarder-nonce" as const;
export const HNS_FORWARDER_SIGNATURE_HEADER = "x-pirate-hns-forwarder-signature" as const;
export const HNS_FORWARDER_AUTHORITY_HEADER = "x-pirate-hns-forwarder-authority" as const;

export const HNS_FORWARDER_RESERVED_HEADERS = Object.freeze([
  HNS_FORWARDER_HOST_HEADER,
  HNS_FORWARDER_KEY_ID_HEADER,
  HNS_FORWARDER_TIMESTAMP_HEADER,
  HNS_FORWARDER_PATH_HEADER,
  HNS_FORWARDER_BODY_SHA256_HEADER,
  HNS_FORWARDER_NONCE_HEADER,
  HNS_FORWARDER_SIGNATURE_HEADER,
  HNS_FORWARDER_AUTHORITY_HEADER,
] as const);

export const HNS_FORWARDER_IDENTITY_MAX_BYTES = 256 as const;
export const HNS_FORWARDER_AUTHORITY_MAX_BYTES = 2_048 as const;
export const HNS_FORWARDER_PATH_MAX_BYTES = 8_192 as const;
export const HNS_FORWARDER_NONCE_MAX_BYTES = 256 as const;
export const HNS_FORWARDER_HOST_MAX_BYTES = 253 as const;

export type HnsForwarderRouteAuthorityV1 = readonly [
  kind: "verified_namespace_v1" | "operator_managed_route_v1",
  reference: string,
  generation: number,
];

export type HnsForwarderCommunityAppAuthorityV1 = readonly [
  tag: "community_app_v1",
  app_host_activation: readonly [id: string, generation: number],
  route_binding_id: string,
  route_authority: HnsForwarderRouteAuthorityV1,
];

export type HnsForwarderHandlePersonaAuthorityV1 = readonly [
  tag: "handle_persona_v1",
  sale_namespace_activation: readonly [id: string, generation: number],
  namespace_authority: readonly [
    kind: "verified_namespace_v1",
    reference: string,
    generation: number,
  ],
  handle_grant: readonly [id: string, generation: number],
  owner_persona_id: string,
];

export type HnsForwarderHostAuthorityV1 =
  | HnsForwarderCommunityAppAuthorityV1
  | HnsForwarderHandlePersonaAuthorityV1;

export type HnsForwarderV3PreimageInput = Readonly<{
  key_id: string;
  timestamp: string;
  method: string;
  normalized_host: string;
  path_and_query: string;
  canonical_root: string;
  community_id: string;
  host_authority: HnsForwarderHostAuthorityV1;
  body_sha256: string;
  nonce: string;
}>;

export type HnsForwarderV2PreimageInput = Readonly<{
  key_id: string;
  timestamp: string;
  method: string;
  normalized_host: string;
  path_and_query: string;
  canonical_root: string;
  community_id: string;
  canonical_path_segment: string;
  subdomain: string;
  body_sha256: string;
  nonce: string;
}>;

export type HnsForwarderV1PreimageInput = Readonly<{
  timestamp: string;
  method: string;
  normalized_host: string;
  path_and_query: string;
  root: string;
  community_id: string;
  community_route: string;
  subdomain: string;
}>;

export class HnsForwarderWireError extends Error {
  readonly name = "HnsForwarderWireError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const noncePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const timestampPattern = /^(?:0|[1-9][0-9]{0,19})$/u;
const methodPattern = /^[A-Z]+$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    identityPattern.test(value) &&
    utf8Length(value) <= HNS_FORWARDER_IDENTITY_MAX_BYTES
  );
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isCanonicalHnsForwarderHost(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.toLowerCase() ||
    value.endsWith(".") ||
    utf8Length(value) > HNS_FORWARDER_HOST_MAX_BYTES
  ) {
    return false;
  }
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => dnsLabelPattern.test(label));
}

export function isCanonicalHnsForwarderPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("#") ||
    utf8Length(value) > HNS_FORWARDER_PATH_MAX_BYTES
  ) {
    return false;
  }
  return [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point >= 0x20 && point !== 0x7f;
  });
}

function canonicalRoot(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const route = deriveCommunityRoute({ family: "hns", root_label: value });
  return route.kind === "accepted" && route.value.root_label === value;
}

function validRouteAuthority(value: unknown): value is HnsForwarderRouteAuthorityV1 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    (value[0] === "verified_namespace_v1" || value[0] === "operator_managed_route_v1") &&
    validIdentity(value[1]) &&
    validGeneration(value[2])
  );
}

function validCommunityAuthority(value: unknown): value is HnsForwarderCommunityAppAuthorityV1 {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value[0] === "community_app_v1" &&
    Array.isArray(value[1]) &&
    value[1].length === 2 &&
    validIdentity(value[1][0]) &&
    validGeneration(value[1][1]) &&
    validIdentity(value[2]) &&
    validRouteAuthority(value[3])
  );
}

function validHandleAuthority(value: unknown): value is HnsForwarderHandlePersonaAuthorityV1 {
  return (
    Array.isArray(value) &&
    value.length === 5 &&
    value[0] === "handle_persona_v1" &&
    Array.isArray(value[1]) &&
    value[1].length === 2 &&
    validIdentity(value[1][0]) &&
    validGeneration(value[1][1]) &&
    Array.isArray(value[2]) &&
    value[2].length === 3 &&
    value[2][0] === "verified_namespace_v1" &&
    validIdentity(value[2][1]) &&
    validGeneration(value[2][2]) &&
    Array.isArray(value[3]) &&
    value[3].length === 2 &&
    validIdentity(value[3][0]) &&
    validGeneration(value[3][1]) &&
    validIdentity(value[4])
  );
}

export function isHnsForwarderHostAuthorityV1(
  value: unknown,
): value is HnsForwarderHostAuthorityV1 {
  return validCommunityAuthority(value) || validHandleAuthority(value);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!base64UrlPattern.test(value)) {
    throw new HnsForwarderWireError("HNS forwarder authority is not unpadded base64url");
  }
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64Url(bytes) !== value) throw new Error("non-minimal base64url");
    return bytes;
  } catch {
    throw new HnsForwarderWireError("HNS forwarder authority is invalid base64url");
  }
}

export function encodeHnsForwarderAuthorityHeader(authority: HnsForwarderHostAuthorityV1): string {
  if (!isHnsForwarderHostAuthorityV1(authority)) {
    throw new HnsForwarderWireError("HNS forwarder authority tuple is invalid");
  }
  const bytes = encoder.encode(JSON.stringify(authority));
  if (bytes.byteLength > HNS_FORWARDER_AUTHORITY_MAX_BYTES) {
    throw new HnsForwarderWireError("HNS forwarder authority tuple is oversized");
  }
  return encodeBase64Url(bytes);
}

export function decodeHnsForwarderAuthorityHeader(value: string): HnsForwarderHostAuthorityV1 {
  const bytes = decodeBase64Url(value);
  if (bytes.byteLength > HNS_FORWARDER_AUTHORITY_MAX_BYTES) {
    throw new HnsForwarderWireError("HNS forwarder authority tuple is oversized");
  }
  try {
    const text = decoder.decode(bytes);
    const decoded = JSON.parse(text) as unknown;
    if (!isHnsForwarderHostAuthorityV1(decoded) || JSON.stringify(decoded) !== text) {
      throw new Error("noncanonical authority tuple");
    }
    return decoded;
  } catch (error) {
    if (error instanceof HnsForwarderWireError) throw error;
    throw new HnsForwarderWireError("HNS forwarder authority tuple is invalid");
  }
}

function validCommonV3(input: HnsForwarderV3PreimageInput): boolean {
  if (
    !validIdentity(input.key_id) ||
    !timestampPattern.test(input.timestamp) ||
    !methodPattern.test(input.method) ||
    !isCanonicalHnsForwarderHost(input.normalized_host) ||
    !isCanonicalHnsForwarderPath(input.path_and_query) ||
    !canonicalRoot(input.canonical_root) ||
    !validIdentity(input.community_id) ||
    !isHnsForwarderHostAuthorityV1(input.host_authority) ||
    !sha256Pattern.test(input.body_sha256)
  ) {
    return false;
  }
  if (safeMethods.has(input.method)) {
    if (input.nonce !== "") return false;
  } else if (!noncePattern.test(input.nonce)) {
    return false;
  }
  if (input.host_authority[0] === "community_app_v1") {
    return input.normalized_host === `app.${input.canonical_root}`;
  }
  const suffix = `.${input.canonical_root}`;
  return (
    (input.method === "GET" || input.method === "HEAD") &&
    input.path_and_query === "/" &&
    input.normalized_host.endsWith(suffix) &&
    input.normalized_host.length > suffix.length &&
    !input.normalized_host.slice(0, -suffix.length).includes(".")
  );
}

export function hnsForwarderV3Preimage(input: HnsForwarderV3PreimageInput): string {
  if (!validCommonV3(input)) throw new HnsForwarderWireError("HNS forwarder v3 input is invalid");
  return JSON.stringify([
    HNS_FORWARDER_V3,
    input.key_id,
    input.timestamp,
    input.method,
    input.normalized_host,
    input.path_and_query,
    input.canonical_root,
    input.community_id,
    input.host_authority,
    input.body_sha256,
    input.nonce,
  ]);
}

export function hnsForwarderV2Preimage(input: HnsForwarderV2PreimageInput): string {
  return JSON.stringify([
    HNS_FORWARDER_V2,
    input.key_id,
    input.timestamp,
    input.method,
    input.normalized_host,
    input.path_and_query,
    input.canonical_root,
    input.community_id,
    input.canonical_path_segment,
    input.subdomain,
    input.body_sha256,
    input.nonce,
  ]);
}

export function hnsForwarderV1Preimage(input: HnsForwarderV1PreimageInput): string {
  return JSON.stringify([
    HNS_FORWARDER_V1,
    input.timestamp,
    input.method,
    input.normalized_host,
    input.path_and_query,
    input.root,
    input.community_id,
    input.community_route,
    input.subdomain,
  ]);
}

export function isHnsForwarderV3Signature(value: unknown): value is string {
  return typeof value === "string" && /^v3=[0-9a-f]{64}$/u.test(value);
}
