export const HNS_PLATFORM_HOST_REGISTRY_VERSION = "pirate-hns-platform-host-registry-v1" as const;
export const HNS_STATIC_PLATFORM_APP_GATEWAY_VERSION_V1 =
  "pirate-hns-static-platform-app-gateway-v1" as const;
export const HNS_STATIC_PLATFORM_APP_GATEWAY_VERSION =
  "pirate-hns-platform-app-gateway-v2" as const;
export const HNS_PLATFORM_HOST_REGISTRY_REFERENCE = "pirate-hns-platform-host-registry" as const;
export const HNS_PLATFORM_HOST_REGISTRY_SHA256 =
  "3825a52e3d6e1c571bb39773aba7bbc250182e36ac3ec04056068ee142aed267" as const;
export const HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256_V1 =
  "4f9bdb2a451bff45f2ab73fc8b73967d0d6fde35162782d35a18f7d96a95785b" as const;
export const HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256 =
  "d1c7bcc81925f5668f4db7b2c79c9018f8274941d5210988287d5ce328724a76" as const;

export const HNS_PLATFORM_ROOT = "pirate" as const;
export const HNS_PLATFORM_APP_HOST = "app.pirate" as const;
export const HNS_PLATFORM_APP_ORIGIN = "https://app.pirate" as const;
export const HNS_PLATFORM_CANONICAL_ORIGIN = "https://pirate.sc" as const;

export const HNS_PLATFORM_RESERVED_SUBLABELS = Object.freeze([
  "www",
  "api",
  "api-staging",
  "spaces",
  "app",
  "home",
  "admin",
  "assets",
  "static",
  "cdn",
  "dev",
  "staging",
  "profile",
] as const);

export const HNS_STATIC_PLATFORM_APP_GATEWAY_REQUEST_HEADERS = Object.freeze([
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

export const HNS_STATIC_PLATFORM_APP_GATEWAY_RESPONSE_COOKIES = Object.freeze([
  "__Host-pirate_session",
  "__Host-pirate_csrf",
] as const);

export type HnsPlatformHostRegistryV1 = readonly [
  version: typeof HNS_PLATFORM_HOST_REGISTRY_VERSION,
  root: typeof HNS_PLATFORM_ROOT,
  reserved_sublabels: typeof HNS_PLATFORM_RESERVED_SUBLABELS,
];

type HnsPlatformHostRegistryReference = readonly [
  reference: typeof HNS_PLATFORM_HOST_REGISTRY_REFERENCE,
  version: typeof HNS_PLATFORM_HOST_REGISTRY_VERSION,
  sha256: typeof HNS_PLATFORM_HOST_REGISTRY_SHA256,
];

export type HnsStaticPlatformAppGatewayProfileV1 = readonly [
  version: typeof HNS_STATIC_PLATFORM_APP_GATEWAY_VERSION_V1,
  registry: HnsPlatformHostRegistryReference,
  root: typeof HNS_PLATFORM_ROOT,
  app_host: typeof HNS_PLATFORM_APP_HOST,
  canonical_origin: typeof HNS_PLATFORM_CANONICAL_ORIGIN,
  methods: readonly ["GET", "HEAD"],
  maximum_origin_form_target_bytes: 8_192,
  maximum_request_field_count: 128,
  maximum_request_header_bytes: 32_768,
  maximum_buffered_response_bytes: 16_777_216,
  upstream_deadline_milliseconds: 15_000,
];

export type HnsStaticPlatformAppGatewayProfileV2 = readonly [
  version: typeof HNS_STATIC_PLATFORM_APP_GATEWAY_VERSION,
  registry: HnsPlatformHostRegistryReference,
  root: typeof HNS_PLATFORM_ROOT,
  app_host: typeof HNS_PLATFORM_APP_HOST,
  canonical_origin: typeof HNS_PLATFORM_CANONICAL_ORIGIN,
  methods: readonly ["GET", "HEAD", "POST", "PATCH"],
  request_headers: typeof HNS_STATIC_PLATFORM_APP_GATEWAY_REQUEST_HEADERS,
  response_cookies: typeof HNS_STATIC_PLATFORM_APP_GATEWAY_RESPONSE_COOKIES,
  maximum_origin_form_target_bytes: 8_192,
  maximum_request_field_count: 128,
  maximum_request_header_bytes: 32_768,
  maximum_request_body_bytes: 1_048_576,
  maximum_sensitive_cookie_value_bytes: 16_384,
  maximum_buffered_response_bytes: 16_777_216,
  upstream_deadline_milliseconds: 15_000,
];

export class HnsStaticPlatformAppGatewayProfileError extends Error {
  readonly name = "HnsStaticPlatformAppGatewayProfileError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const registryReference: HnsPlatformHostRegistryReference = Object.freeze([
  HNS_PLATFORM_HOST_REGISTRY_REFERENCE,
  HNS_PLATFORM_HOST_REGISTRY_VERSION,
  HNS_PLATFORM_HOST_REGISTRY_SHA256,
]);

export const HNS_PLATFORM_HOST_REGISTRY: HnsPlatformHostRegistryV1 = Object.freeze([
  HNS_PLATFORM_HOST_REGISTRY_VERSION,
  HNS_PLATFORM_ROOT,
  HNS_PLATFORM_RESERVED_SUBLABELS,
]);

export const HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE_V1: HnsStaticPlatformAppGatewayProfileV1 =
  Object.freeze([
    HNS_STATIC_PLATFORM_APP_GATEWAY_VERSION_V1,
    registryReference,
    HNS_PLATFORM_ROOT,
    HNS_PLATFORM_APP_HOST,
    HNS_PLATFORM_CANONICAL_ORIGIN,
    Object.freeze(["GET", "HEAD"] as const),
    8_192,
    128,
    32_768,
    16_777_216,
    15_000,
  ] as const);

export const HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE: HnsStaticPlatformAppGatewayProfileV2 =
  Object.freeze([
    HNS_STATIC_PLATFORM_APP_GATEWAY_VERSION,
    registryReference,
    HNS_PLATFORM_ROOT,
    HNS_PLATFORM_APP_HOST,
    HNS_PLATFORM_CANONICAL_ORIGIN,
    Object.freeze(["GET", "HEAD", "POST", "PATCH"] as const),
    HNS_STATIC_PLATFORM_APP_GATEWAY_REQUEST_HEADERS,
    HNS_STATIC_PLATFORM_APP_GATEWAY_RESPONSE_COOKIES,
    8_192,
    128,
    32_768,
    1_048_576,
    16_384,
    16_777_216,
    15_000,
  ] as const);

const registryBytes = encoder.encode(JSON.stringify(HNS_PLATFORM_HOST_REGISTRY));
const profileV1Bytes = encoder.encode(JSON.stringify(HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE_V1));
const profileBytes = encoder.encode(JSON.stringify(HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE));

export function encodeHnsPlatformHostRegistryV1(): Uint8Array {
  return new Uint8Array(registryBytes);
}

export function encodeHnsStaticPlatformAppGatewayProfileV1(): Uint8Array {
  return new Uint8Array(profileV1Bytes);
}

export function encodeHnsStaticPlatformAppGatewayProfileV2(): Uint8Array {
  return new Uint8Array(profileBytes);
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function decodeExact<T>(bytes: Uint8Array, expected: Uint8Array, value: T): T {
  if (!exactBytes(bytes, expected)) {
    throw new HnsStaticPlatformAppGatewayProfileError("Static platform profile bytes are invalid");
  }
  try {
    JSON.parse(decoder.decode(bytes));
  } catch {
    throw new HnsStaticPlatformAppGatewayProfileError("Static platform profile bytes are invalid");
  }
  return value;
}

export function decodeHnsPlatformHostRegistryV1(bytes: Uint8Array): HnsPlatformHostRegistryV1 {
  return decodeExact(bytes, registryBytes, HNS_PLATFORM_HOST_REGISTRY);
}

export function decodeHnsStaticPlatformAppGatewayProfileV1(
  bytes: Uint8Array,
): HnsStaticPlatformAppGatewayProfileV1 {
  return decodeExact(bytes, profileV1Bytes, HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE_V1);
}

export function decodeHnsStaticPlatformAppGatewayProfileV2(
  bytes: Uint8Array,
): HnsStaticPlatformAppGatewayProfileV2 {
  return decodeExact(bytes, profileBytes, HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function verifyHnsStaticPlatformAppGatewayProfileV1(): Promise<void> {
  const [registryDigest, profileDigest] = await Promise.all([
    sha256(registryBytes),
    sha256(profileV1Bytes),
  ]);
  if (
    registryDigest !== HNS_PLATFORM_HOST_REGISTRY_SHA256 ||
    profileDigest !== HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256_V1
  ) {
    throw new HnsStaticPlatformAppGatewayProfileError("Static platform profile digest is invalid");
  }
}

export async function verifyHnsStaticPlatformAppGatewayProfileV2(): Promise<void> {
  const [registryDigest, profileDigest] = await Promise.all([
    sha256(registryBytes),
    sha256(profileBytes),
  ]);
  if (
    registryDigest !== HNS_PLATFORM_HOST_REGISTRY_SHA256 ||
    profileDigest !== HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256
  ) {
    throw new HnsStaticPlatformAppGatewayProfileError("Static platform profile digest is invalid");
  }
}
