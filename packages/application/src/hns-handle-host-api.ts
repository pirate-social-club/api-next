import {
  type HnsForwarderHandlePersonaAuthorityV1,
  isCanonicalHnsForwarderHost,
  isHnsForwarderHostAuthorityV1,
} from "./hns-forwarder-v3.ts";
import {
  type HnsHandlePersonaHostAuthorityStateV1,
  hnsForwarderAuthorityMatchesState,
  resolveActiveHnsHostAuthority,
} from "./hns-host-serving.ts";

export const HNS_SOLID_HANDLE_HOST_AUTHORITY_V1_PATH =
  "/internal/hns/solid-handle-host-authority/v1/resolve" as const;
export const HNS_SOLID_HANDLE_HOST_AUTHORITY_REQUEST_V1 =
  "pirate-hns-solid-handle-host-authority-request-v1" as const;
export const HNS_SOLID_HANDLE_HOST_AUTHORITY_RESPONSE_V1 =
  "pirate-hns-solid-handle-host-authority-response-v1" as const;
export const HNS_SOLID_HANDLE_HOST_AUTHORITY_MAX_BYTES = 4_096 as const;

export type HnsSolidHandleHostAuthorityRequestV1 = readonly [
  tag: typeof HNS_SOLID_HANDLE_HOST_AUTHORITY_REQUEST_V1,
  normalized_host: string,
  host_authority: HnsForwarderHandlePersonaAuthorityV1,
  gateway_deployment_reference: string,
];

export type HnsSolidHandleHostAuthorityResponseV1 = readonly [
  tag: typeof HNS_SOLID_HANDLE_HOST_AUTHORITY_RESPONSE_V1,
  status: "active",
  normalized_host: string,
  canonical_root: string,
  canonical_handle_label: string,
  community_id: string,
  owner_persona_id: string,
  host_authority: HnsForwarderHandlePersonaAuthorityV1,
  gateway_deployment_reference: string,
];

export type HnsHandleHostApiWireFailureReasonV1 = "invalid_request" | "authority_unavailable";

export class HnsHandleHostApiWireFailure extends Error {
  readonly name = "HnsHandleHostApiWireFailure";

  constructor(readonly reason: HnsHandleHostApiWireFailureReasonV1) {
    super(`HNS handle-host API wire failed: ${reason}`);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && identityPattern.test(value);
}

export function decodeHnsSolidHandleHostAuthorityRequestV1(
  bytes: Uint8Array,
): HnsSolidHandleHostAuthorityRequestV1 {
  if (bytes.byteLength === 0 || bytes.byteLength > HNS_SOLID_HANDLE_HOST_AUTHORITY_MAX_BYTES) {
    throw new HnsHandleHostApiWireFailure("invalid_request");
  }
  try {
    const text = decoder.decode(bytes);
    const value: unknown = JSON.parse(text);
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== HNS_SOLID_HANDLE_HOST_AUTHORITY_REQUEST_V1 ||
      !isCanonicalHnsForwarderHost(value[1]) ||
      !isHnsForwarderHostAuthorityV1(value[2]) ||
      value[2][0] !== "handle_persona_v1" ||
      !validIdentity(value[3]) ||
      JSON.stringify(value) !== text
    ) {
      throw new Error("invalid handle-host authority request");
    }
    return value as unknown as HnsSolidHandleHostAuthorityRequestV1;
  } catch (error) {
    if (error instanceof HnsHandleHostApiWireFailure) throw error;
    throw new HnsHandleHostApiWireFailure("invalid_request");
  }
}

export function resolveHnsSolidHandleHostAuthorityV1(
  request: HnsSolidHandleHostAuthorityRequestV1,
  state: HnsHandlePersonaHostAuthorityStateV1 | null,
): HnsSolidHandleHostAuthorityResponseV1 {
  const active = resolveActiveHnsHostAuthority(state);
  if (
    state === null ||
    active === null ||
    active.state.variant !== "handle_persona_v1" ||
    active.normalized_host !== request[1] ||
    !hnsForwarderAuthorityMatchesState(request[2], active.state) ||
    active.state.sale_namespace_gateway_deployment_reference !== request[3] ||
    active.state.dns_zone.gateway_deployment_reference !== request[3]
  ) {
    throw new HnsHandleHostApiWireFailure("authority_unavailable");
  }
  return [
    HNS_SOLID_HANDLE_HOST_AUTHORITY_RESPONSE_V1,
    "active",
    active.normalized_host,
    active.canonical_root,
    active.state.canonical_handle_label,
    active.community_id,
    active.state.owner_persona_id,
    request[2],
    request[3],
  ];
}

export function encodeHnsSolidHandleHostAuthorityResponseV1(
  response: HnsSolidHandleHostAuthorityResponseV1,
): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(response));
  if (bytes.byteLength > HNS_SOLID_HANDLE_HOST_AUTHORITY_MAX_BYTES) {
    throw new HnsHandleHostApiWireFailure("authority_unavailable");
  }
  return bytes;
}
