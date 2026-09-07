import { HNS_FORWARDER_V3 } from "./hns-forwarder-v3.ts";
import {
  HNS_SOLID_HANDLE_HOST_AUTHORITY_REQUEST_V1,
  HNS_SOLID_HANDLE_HOST_AUTHORITY_RESPONSE_V1,
} from "./hns-handle-host-api.ts";

export const HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_VERSION =
  "pirate-hns-community-handle-persona-public-gateway-v2" as const;
export const HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_SHA256 =
  "b4440ab21ae73a73d3ab3549bcaaa66c1e27891e22cdd308d4377b0b6eb549dc" as const;

export const HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_METHODS = Object.freeze(["GET", "HEAD"] as const);
export const HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PATH_MAPS = Object.freeze([
  "preserve_signed_root_v1",
  "render_canonical_persona_v1",
] as const);
export const HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_REQUEST_HEADERS = Object.freeze([] as const);
export const HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_RESPONSE_COOKIES = Object.freeze([] as const);
export const HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_AUTHORITY_WIRE = Object.freeze([
  HNS_SOLID_HANDLE_HOST_AUTHORITY_REQUEST_V1,
  HNS_SOLID_HANDLE_HOST_AUTHORITY_RESPONSE_V1,
] as const);
export const HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PATHS = Object.freeze([
  "/internal/hns/solid-handle-host-authority/v1/resolve",
  "/public-personas/:personaId",
  "/p/:personaId",
] as const);

export type HnsCommunityHandlePersonaGatewayProfileV2 = readonly [
  version: typeof HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_VERSION,
  forwarder: typeof HNS_FORWARDER_V3,
  authority_variant: "handle_persona_v1",
  methods: typeof HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_METHODS,
  path_maps: typeof HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PATH_MAPS,
  request_headers: typeof HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_REQUEST_HEADERS,
  response_cookies: typeof HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_RESPONSE_COOKIES,
  authority_wire: typeof HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_AUTHORITY_WIRE,
  paths: typeof HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PATHS,
  maximum_origin_form_target_bytes: 8_192,
  maximum_request_field_count: 128,
  maximum_request_header_bytes: 32_768,
  maximum_request_body_bytes: 0,
  maximum_buffered_response_bytes: 16_777_216,
  gateway_upstream_deadline_milliseconds: 15_000,
  maximum_private_authority_bytes: 4_096,
  private_authority_deadline_milliseconds: 4_000,
  maximum_public_persona_response_bytes: 1_048_576,
  public_persona_deadline_milliseconds: 2_000,
];

export const HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE: HnsCommunityHandlePersonaGatewayProfileV2 =
  Object.freeze([
    HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_VERSION,
    HNS_FORWARDER_V3,
    "handle_persona_v1",
    HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_METHODS,
    HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PATH_MAPS,
    HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_REQUEST_HEADERS,
    HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_RESPONSE_COOKIES,
    HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_AUTHORITY_WIRE,
    HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PATHS,
    8_192,
    128,
    32_768,
    0,
    16_777_216,
    15_000,
    4_096,
    4_000,
    1_048_576,
    2_000,
  ] as const);

export class HnsCommunityHandlePersonaGatewayProfileError extends Error {
  readonly name = "HnsCommunityHandlePersonaGatewayProfileError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const profileBytes = encoder.encode(JSON.stringify(HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE));

export function encodeHnsCommunityHandlePersonaGatewayProfileV2(): Uint8Array {
  return new Uint8Array(profileBytes);
}

export function decodeHnsCommunityHandlePersonaGatewayProfileV2(
  bytes: Uint8Array,
): HnsCommunityHandlePersonaGatewayProfileV2 {
  if (
    bytes.byteLength !== profileBytes.byteLength ||
    !bytes.every((byte, index) => byte === profileBytes[index])
  ) {
    throw new HnsCommunityHandlePersonaGatewayProfileError(
      "Community handle-persona gateway profile bytes are invalid",
    );
  }
  try {
    const text = decoder.decode(bytes);
    if (JSON.stringify(JSON.parse(text)) !== text) throw new Error("noncanonical profile");
  } catch {
    throw new HnsCommunityHandlePersonaGatewayProfileError(
      "Community handle-persona gateway profile bytes are invalid",
    );
  }
  return HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyHnsCommunityHandlePersonaGatewayProfileV2(): Promise<void> {
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", profileBytes)));
  if (digest !== HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_SHA256) {
    throw new HnsCommunityHandlePersonaGatewayProfileError(
      "Community handle-persona gateway profile digest is invalid",
    );
  }
}
