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
  HNS_FORWARDER_V3_KEY_REGISTRY_MAX_BYTES,
  HNS_FORWARDER_V3_KEY_REGISTRY_SCHEMA,
  type HnsForwarderClockV1,
  type HnsForwarderWorkerAuthoritySourceV1,
  parseHnsForwarderV3KeyRegistry,
} from "@pirate/platform-cf/hns-forwarder-v3";
import { Redacted } from "effect";
import {
  type HnsCommunityAppApiComposition,
  makeHnsCommunityAppApiComposition,
} from "./hns-community-app-api-composition.ts";
import { HNS_COMMUNITY_APP_API_MAX_BODY_BYTES } from "./hns-community-app-api-transport.ts";

export { HNS_FORWARDER_V3_KEY_REGISTRY_MAX_BYTES, HNS_FORWARDER_V3_KEY_REGISTRY_SCHEMA };

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
    const keyRegistry = parseHnsForwarderV3KeyRegistry(
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
