import {
  HNS_SOLID_HOST_AUTHORITY_REQUEST_V2,
  HNS_SOLID_HOST_AUTHORITY_RESPONSE_V2,
} from "./hns-community-app-api.ts";
import { HNS_FORWARDER_V3 } from "./hns-forwarder-v3.ts";

export const HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_VERSION =
  "pirate-hns-community-app-interactive-gateway-v3" as const;
export const HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256 =
  "c4f4c07252ba10a25467f476cc5b56d50ef9cf02e25ad368a05551d19ba861ed" as const;

export const HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_METHODS = Object.freeze([
  "GET",
  "HEAD",
  "POST",
  "PATCH",
] as const);

export const HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PATH_MAPS = Object.freeze([
  "root_to_canonical_community_v2",
  "preserve_other_path_and_query_v1",
] as const);

export const HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_REQUEST_HEADERS = Object.freeze([
  "accept",
  "accept-language",
  "cache-control",
  "content-language",
  "content-type",
  "cookie",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "idempotency-key",
  "origin",
  "range",
  "referer",
  "x-csrf-token",
  "x-request-id",
] as const);

export const HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_RESPONSE_COOKIES = Object.freeze([
  "__Host-pirate_session",
  "__Host-pirate_csrf",
] as const);

export const HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_AUTHORITY_WIRE = Object.freeze([
  HNS_SOLID_HOST_AUTHORITY_REQUEST_V2,
  HNS_SOLID_HOST_AUTHORITY_RESPONSE_V2,
] as const);

export type HnsCommunityAppInteractiveGatewayProfileV3 = readonly [
  version: typeof HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_VERSION,
  forwarder: typeof HNS_FORWARDER_V3,
  authority_variant: "community_app_v1",
  methods: typeof HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_METHODS,
  path_maps: typeof HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PATH_MAPS,
  request_headers: typeof HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_REQUEST_HEADERS,
  response_cookies: typeof HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_RESPONSE_COOKIES,
  authority_wire: typeof HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_AUTHORITY_WIRE,
  maximum_origin_form_target_bytes: 8_192,
  maximum_request_field_count: 128,
  maximum_request_header_bytes: 32_768,
  maximum_request_body_bytes: 1_048_576,
  maximum_sensitive_cookie_value_bytes: 16_384,
  maximum_buffered_response_bytes: 16_777_216,
  gateway_upstream_deadline_milliseconds: 15_000,
  maximum_private_authority_bytes: 4_096,
  private_authority_deadline_milliseconds: 4_000,
];

export const HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE: HnsCommunityAppInteractiveGatewayProfileV3 =
  Object.freeze([
    HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_VERSION,
    HNS_FORWARDER_V3,
    "community_app_v1",
    HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_METHODS,
    HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PATH_MAPS,
    HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_REQUEST_HEADERS,
    HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_RESPONSE_COOKIES,
    HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_AUTHORITY_WIRE,
    8_192,
    128,
    32_768,
    1_048_576,
    16_384,
    16_777_216,
    15_000,
    4_096,
    4_000,
  ] as const);

export class HnsCommunityAppInteractiveGatewayProfileError extends Error {
  readonly name = "HnsCommunityAppInteractiveGatewayProfileError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const profileBytes = encoder.encode(JSON.stringify(HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE));

export function encodeHnsCommunityAppInteractiveGatewayProfileV3(): Uint8Array {
  return new Uint8Array(profileBytes);
}

export function decodeHnsCommunityAppInteractiveGatewayProfileV3(
  bytes: Uint8Array,
): HnsCommunityAppInteractiveGatewayProfileV3 {
  if (
    bytes.byteLength !== profileBytes.byteLength ||
    !bytes.every((byte, index) => byte === profileBytes[index])
  ) {
    throw new HnsCommunityAppInteractiveGatewayProfileError(
      "Interactive community gateway profile bytes are invalid",
    );
  }
  try {
    if (JSON.stringify(JSON.parse(decoder.decode(bytes))) !== decoder.decode(bytes)) {
      throw new Error("noncanonical profile");
    }
  } catch {
    throw new HnsCommunityAppInteractiveGatewayProfileError(
      "Interactive community gateway profile bytes are invalid",
    );
  }
  return HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyHnsCommunityAppInteractiveGatewayProfileV3(): Promise<void> {
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", profileBytes)));
  if (digest !== HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_SHA256) {
    throw new HnsCommunityAppInteractiveGatewayProfileError(
      "Interactive community gateway profile digest is invalid",
    );
  }
}
