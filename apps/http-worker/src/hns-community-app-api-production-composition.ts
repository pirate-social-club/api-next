import {
  type CloudflareAccessJwtFetch,
  makeCloudflareAccessJwtValidatorV1,
} from "@pirate/platform-cf/cloudflare-access-jwt";
import type { HttpWorkerConfigValue } from "@pirate/platform-cf/config";
import {
  HNS_COMMUNITY_APP_API_REPLAY_SCOPE,
  type HnsForwarderReplayStoreNamespace,
  makeDurableObjectHnsForwarderReplayStore,
} from "@pirate/platform-cf/hns-forwarder-replay-store";
import {
  HNS_FORWARDER_KEY_MIN_BYTES,
  type HnsForwarderClockV1,
  type HnsForwarderWorkerAuthoritySourceV1,
  makeStaticHnsForwarderKeyRegistryV1,
} from "@pirate/platform-cf/hns-forwarder-v3";
import { Redacted, Schema } from "effect";
import {
  type HnsCommunityAppApiComposition,
  makeHnsCommunityAppApiComposition,
} from "./hns-community-app-api-composition.ts";
import { HNS_COMMUNITY_APP_API_MAX_BODY_BYTES } from "./hns-community-app-api-transport.ts";

export const HNS_FORWARDER_V3_KEY_REGISTRY_SCHEMA =
  "pirate-hns-forwarder-v3-key-registry-v1" as const;
export const HNS_FORWARDER_V3_KEY_REGISTRY_MAX_BYTES = 65_536 as const;

type ProductionConfig = Pick<
  HttpWorkerConfigValue,
  | "HNS_COMMUNITY_APP_API_ENABLED"
  | "HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN"
  | "HNS_COMMUNITY_APP_API_ACCESS_ISSUER"
  | "HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL"
  | "HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE"
  | "HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE"
  | "HNS_FORWARDER_V3_KEY_REGISTRY_VERSION"
  | "HNS_FORWARDER_V3_HMAC_KEY_REGISTRY"
  | "HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS"
  | "HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS"
>;

const RegistryIdentity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
);
const KeyId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
const Base64Url = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);
const UnixSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const RegistryKey = Schema.Struct({
  key_id: KeyId,
  key_base64url: Base64Url,
  signing_enabled: Schema.Boolean,
  verify_not_before: UnixSeconds,
  verify_not_after: UnixSeconds,
});
const RegistryDocument = Schema.Struct({
  schema: Schema.Literal(HNS_FORWARDER_V3_KEY_REGISTRY_SCHEMA),
  registry_reference: RegistryIdentity,
  registry_version: RegistryIdentity,
  keys: Schema.Array(RegistryKey).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});

type RegistryDocumentValue = Schema.Schema.Type<typeof RegistryDocument>;

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function decodeBase64Url(value: string): Uint8Array {
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const canonical = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    if (
      canonical !== value ||
      bytes.byteLength < HNS_FORWARDER_KEY_MIN_BYTES ||
      bytes.byteLength > 1_024
    ) {
      throw new Error("invalid key bytes");
    }
    return bytes;
  } catch {
    throw new Error("Invalid HNS forwarder key registry");
  }
}

function parseRegistry(source: string, expectedReference: string, expectedVersion: string) {
  if (new TextEncoder().encode(source).byteLength > HNS_FORWARDER_V3_KEY_REGISTRY_MAX_BYTES) {
    throw new Error("Invalid HNS forwarder key registry");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error("Invalid HNS forwarder key registry");
  }
  if (
    !hasExactKeys(raw, ["schema", "registry_reference", "registry_version", "keys"]) ||
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    !("keys" in raw) ||
    !Array.isArray(raw.keys) ||
    !raw.keys.every((entry) =>
      hasExactKeys(entry, [
        "key_id",
        "key_base64url",
        "signing_enabled",
        "verify_not_before",
        "verify_not_after",
      ]),
    )
  ) {
    throw new Error("Invalid HNS forwarder key registry");
  }
  let document: RegistryDocumentValue;
  try {
    document = Schema.decodeUnknownSync(RegistryDocument)(raw);
  } catch {
    throw new Error("Invalid HNS forwarder key registry");
  }
  if (
    document.registry_reference !== expectedReference ||
    document.registry_version !== expectedVersion
  ) {
    throw new Error("Invalid HNS forwarder key registry");
  }
  return makeStaticHnsForwarderKeyRegistryV1(
    document.keys.map((key) => ({
      key_id: key.key_id,
      key_bytes: decodeBase64Url(key.key_base64url),
      signing_enabled: key.signing_enabled,
      verify_not_before: key.verify_not_before,
      verify_not_after: key.verify_not_after,
    })),
  );
}

function exactProtectedOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== value
    ) {
      throw new Error("invalid origin");
    }
    return parsed.origin;
  } catch {
    throw new Error("Invalid HNS community API production configuration");
  }
}

function forwarderLimits(config: ProductionConfig) {
  const freshness = config.HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS;
  const futureSkew = config.HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS;
  if (
    !Number.isSafeInteger(freshness) ||
    freshness <= 0 ||
    !Number.isSafeInteger(futureSkew) ||
    futureSkew < 0 ||
    !Number.isSafeInteger(freshness + futureSkew + 1)
  ) {
    throw new Error("Invalid HNS community API production configuration");
  }
  return Object.freeze({
    max_body_bytes: HNS_COMMUNITY_APP_API_MAX_BODY_BYTES,
    freshness_window_seconds: freshness,
    future_clock_skew_seconds: futureSkew,
  });
}

/** Builds the production-capable graph while preserving an inert disabled path. */
export function makeProductionHnsCommunityAppApiComposition(input: {
  readonly config: ProductionConfig;
  readonly authority_source: HnsForwarderWorkerAuthoritySourceV1;
  readonly replay_namespace?: HnsForwarderReplayStoreNamespace;
  readonly access_fetch?: CloudflareAccessJwtFetch;
  readonly clock?: HnsForwarderClockV1;
}): HnsCommunityAppApiComposition {
  if (!input.config.HNS_COMMUNITY_APP_API_ENABLED) {
    return makeHnsCommunityAppApiComposition(false);
  }
  try {
    if (input.replay_namespace === undefined) {
      throw new Error("missing replay namespace");
    }
    const protectedOrigin = exactProtectedOrigin(
      input.config.HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN,
    );
    const clock =
      input.clock ?? Object.freeze({ nowUnixSeconds: () => Math.floor(Date.now() / 1_000) });
    const limits = forwarderLimits(input.config);
    const keyRegistry = parseRegistry(
      Redacted.value(input.config.HNS_FORWARDER_V3_HMAC_KEY_REGISTRY),
      input.config.HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE,
      input.config.HNS_FORWARDER_V3_KEY_REGISTRY_VERSION,
    );
    const accessValidator = makeCloudflareAccessJwtValidatorV1({
      issuer: input.config.HNS_COMMUNITY_APP_API_ACCESS_ISSUER,
      audience: input.config.HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE,
      jwksUrl: input.config.HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL,
      clock,
      ...(input.access_fetch === undefined ? {} : { fetchImpl: input.access_fetch }),
    });
    const replayStore = makeDurableObjectHnsForwarderReplayStore({
      namespace: input.replay_namespace,
      consumerScope: HNS_COMMUNITY_APP_API_REPLAY_SCOPE,
      clock,
      retentionSeconds: limits.freshness_window_seconds + limits.future_clock_skew_seconds + 1,
    });
    return makeHnsCommunityAppApiComposition(true, {
      protected_origin: protectedOrigin,
      access_validator: accessValidator,
      authority_source: input.authority_source,
      key_registry: keyRegistry,
      replay_store: replayStore,
      clock,
      limits,
    });
  } catch {
    throw new Error("HNS community API production configuration is incomplete or invalid");
  }
}
