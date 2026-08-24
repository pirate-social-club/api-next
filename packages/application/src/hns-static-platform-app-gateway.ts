export const HNS_PLATFORM_HOST_REGISTRY_VERSION = "pirate-hns-platform-host-registry-v1" as const;
export const HNS_STATIC_PLATFORM_APP_GATEWAY_VERSION =
  "pirate-hns-static-platform-app-gateway-v1" as const;
export const HNS_PLATFORM_HOST_REGISTRY_REFERENCE = "pirate-hns-platform-host-registry" as const;
export const HNS_PLATFORM_HOST_REGISTRY_SHA256 =
  "3825a52e3d6e1c571bb39773aba7bbc250182e36ac3ec04056068ee142aed267" as const;
export const HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256 =
  "4f9bdb2a451bff45f2ab73fc8b73967d0d6fde35162782d35a18f7d96a95785b" as const;

export const HNS_PLATFORM_ROOT = "pirate" as const;
export const HNS_PLATFORM_APP_HOST = "app.pirate" as const;
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

export type HnsPlatformHostRegistryV1 = readonly [
  version: typeof HNS_PLATFORM_HOST_REGISTRY_VERSION,
  root: typeof HNS_PLATFORM_ROOT,
  reserved_sublabels: typeof HNS_PLATFORM_RESERVED_SUBLABELS,
];

export type HnsStaticPlatformAppGatewayProfileV1 = readonly [
  version: typeof HNS_STATIC_PLATFORM_APP_GATEWAY_VERSION,
  registry: readonly [
    reference: typeof HNS_PLATFORM_HOST_REGISTRY_REFERENCE,
    version: typeof HNS_PLATFORM_HOST_REGISTRY_VERSION,
    sha256: typeof HNS_PLATFORM_HOST_REGISTRY_SHA256,
  ],
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

export class HnsStaticPlatformAppGatewayProfileError extends Error {
  readonly name = "HnsStaticPlatformAppGatewayProfileError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const HNS_PLATFORM_HOST_REGISTRY: HnsPlatformHostRegistryV1 = Object.freeze([
  HNS_PLATFORM_HOST_REGISTRY_VERSION,
  HNS_PLATFORM_ROOT,
  HNS_PLATFORM_RESERVED_SUBLABELS,
]);

export const HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE: HnsStaticPlatformAppGatewayProfileV1 =
  Object.freeze([
    HNS_STATIC_PLATFORM_APP_GATEWAY_VERSION,
    Object.freeze([
      HNS_PLATFORM_HOST_REGISTRY_REFERENCE,
      HNS_PLATFORM_HOST_REGISTRY_VERSION,
      HNS_PLATFORM_HOST_REGISTRY_SHA256,
    ] as const),
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

const registryBytes = encoder.encode(JSON.stringify(HNS_PLATFORM_HOST_REGISTRY));
const profileBytes = encoder.encode(JSON.stringify(HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE));

export function encodeHnsPlatformHostRegistryV1(): Uint8Array {
  return new Uint8Array(registryBytes);
}

export function encodeHnsStaticPlatformAppGatewayProfileV1(): Uint8Array {
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
    sha256(profileBytes),
  ]);
  if (
    registryDigest !== HNS_PLATFORM_HOST_REGISTRY_SHA256 ||
    profileDigest !== HNS_STATIC_PLATFORM_APP_GATEWAY_SHA256
  ) {
    throw new HnsStaticPlatformAppGatewayProfileError("Static platform profile digest is invalid");
  }
}
