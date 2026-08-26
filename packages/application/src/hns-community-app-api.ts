import {
  HNS_FORWARDER_RESERVED_HEADERS,
  type HnsForwarderCommunityAppAuthorityV1,
  isCanonicalHnsForwarderHost,
  isHnsForwarderHostAuthorityV1,
} from "./hns-forwarder-v3.ts";
import {
  type HnsCommunityAppHostAuthorityStateV1,
  hnsForwarderAuthorityMatchesState,
  resolveActiveHnsHostAuthority,
} from "./hns-host-serving.ts";

export const HNS_SOLID_HOST_AUTHORITY_V2_PATH =
  "/internal/hns/solid-host-authority/v2/resolve" as const;
export const HNS_SOLID_HOST_AUTHORITY_REQUEST_V2 =
  "pirate-hns-solid-host-authority-request-v2" as const;
export const HNS_SOLID_HOST_AUTHORITY_RESPONSE_V2 =
  "pirate-hns-solid-host-authority-response-v2" as const;
export const HNS_SOLID_HOST_AUTHORITY_MAX_BYTES = 4_096 as const;
export const HNS_COMMUNITY_APP_API_PREFIX = "/api" as const;

export const CF_ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion" as const;
export const CF_ACCESS_CLIENT_ID_HEADER = "cf-access-client-id" as const;
export const CF_ACCESS_CLIENT_SECRET_HEADER = "cf-access-client-secret" as const;

export type HnsSolidHostAuthorityRequestV2 = readonly [
  tag: typeof HNS_SOLID_HOST_AUTHORITY_REQUEST_V2,
  normalized_host: string,
  host_authority: HnsForwarderCommunityAppAuthorityV1,
  gateway_deployment_reference: string,
];

export type HnsSolidHostAuthorityResponseV2 = readonly [
  tag: typeof HNS_SOLID_HOST_AUTHORITY_RESPONSE_V2,
  status: "active",
  normalized_host: string,
  canonical_root: string,
  community_id: string,
  host_authority: HnsForwarderCommunityAppAuthorityV1,
  gateway_deployment_reference: string,
];

export type HnsCommunityAppApiWireFailureReasonV1 = "invalid_request" | "authority_unavailable";

export class HnsCommunityAppApiWireFailure extends Error {
  readonly name = "HnsCommunityAppApiWireFailure";

  constructor(readonly reason: HnsCommunityAppApiWireFailureReasonV1) {
    super(`HNS community application API wire failed: ${reason}`);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const reservedForwarderHeaders = new Set<string>(HNS_FORWARDER_RESERVED_HEADERS);

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && identityPattern.test(value);
}

export function isHnsCommunityAppApiPath(pathname: string): boolean {
  return pathname === HNS_COMMUNITY_APP_API_PREFIX || pathname.startsWith("/api/");
}

export function isHnsCommunityAppPrivateHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    reservedForwarderHeaders.has(lower) ||
    lower === CF_ACCESS_ASSERTION_HEADER ||
    lower === CF_ACCESS_CLIENT_ID_HEADER ||
    lower === CF_ACCESS_CLIENT_SECRET_HEADER ||
    lower.startsWith("cf-access-") ||
    lower.startsWith("x-pirate-gateway-") ||
    lower.startsWith("x-pirate-hns-forwarder-")
  );
}

export function hasHnsCommunityAppPrivateHeader(headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (isHnsCommunityAppPrivateHeaderName(name)) return true;
  }
  return false;
}

export function decodeHnsSolidHostAuthorityRequestV2(
  bytes: Uint8Array,
): HnsSolidHostAuthorityRequestV2 {
  if (bytes.byteLength === 0 || bytes.byteLength > HNS_SOLID_HOST_AUTHORITY_MAX_BYTES) {
    throw new HnsCommunityAppApiWireFailure("invalid_request");
  }
  try {
    const text = decoder.decode(bytes);
    const value: unknown = JSON.parse(text);
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== HNS_SOLID_HOST_AUTHORITY_REQUEST_V2 ||
      !isCanonicalHnsForwarderHost(value[1]) ||
      !isHnsForwarderHostAuthorityV1(value[2]) ||
      value[2][0] !== "community_app_v1" ||
      !validIdentity(value[3]) ||
      JSON.stringify(value) !== text
    ) {
      throw new Error("invalid authority request");
    }
    return value as unknown as HnsSolidHostAuthorityRequestV2;
  } catch (error) {
    if (error instanceof HnsCommunityAppApiWireFailure) throw error;
    throw new HnsCommunityAppApiWireFailure("invalid_request");
  }
}

export function resolveHnsSolidHostAuthorityV2(
  request: HnsSolidHostAuthorityRequestV2,
  state: HnsCommunityAppHostAuthorityStateV1 | null,
): HnsSolidHostAuthorityResponseV2 {
  const active = resolveActiveHnsHostAuthority(state);
  if (
    state === null ||
    active === null ||
    active.state.variant !== "community_app_v1" ||
    active.normalized_host !== request[1] ||
    !hnsForwarderAuthorityMatchesState(request[2], active.state) ||
    active.state.activation_gateway_deployment_reference !== request[3]
  ) {
    throw new HnsCommunityAppApiWireFailure("authority_unavailable");
  }
  return [
    HNS_SOLID_HOST_AUTHORITY_RESPONSE_V2,
    "active",
    active.normalized_host,
    active.canonical_root,
    active.community_id,
    request[2],
    request[3],
  ];
}

export function encodeHnsSolidHostAuthorityResponseV2(
  response: HnsSolidHostAuthorityResponseV2,
): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(response));
  if (bytes.byteLength > HNS_SOLID_HOST_AUTHORITY_MAX_BYTES) {
    throw new HnsCommunityAppApiWireFailure("authority_unavailable");
  }
  return bytes;
}
