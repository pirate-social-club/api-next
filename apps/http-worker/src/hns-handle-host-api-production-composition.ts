import {
  type CloudflareAccessJwtFetch,
  makeCloudflareAccessJwtValidatorV1,
} from "@pirate/platform-cf/cloudflare-access-jwt";
import type { HttpWorkerConfigValue } from "@pirate/platform-cf/config";
import type { HnsForwarderClockV1 } from "@pirate/platform-cf/hns-forwarder-v3";
import type { HnsForwarderWorkerAuthoritySourceV1 } from "@pirate/platform-cf/hns-handle-host-api";
import {
  type HnsHandleHostApiComposition,
  makeHnsHandleHostApiComposition,
} from "./hns-handle-host-api-composition.ts";

type ProductionConfig = Pick<
  HttpWorkerConfigValue,
  | "HNS_HANDLE_HOST_API_ENABLED"
  | "HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN"
  | "HNS_COMMUNITY_APP_API_ACCESS_ISSUER"
  | "HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL"
  | "HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE"
>;

/**
 * The handle authority shares the already protected api-next origin and Access
 * application. Its exact wire path remains disjoint from the interactive API.
 */
export function makeProductionHnsHandleHostApiComposition(input: {
  readonly config: ProductionConfig;
  readonly authority_source: HnsForwarderWorkerAuthoritySourceV1;
  readonly access_fetch?: CloudflareAccessJwtFetch;
  readonly clock?: HnsForwarderClockV1;
}): HnsHandleHostApiComposition {
  if (!input.config.HNS_HANDLE_HOST_API_ENABLED) {
    return makeHnsHandleHostApiComposition(false);
  }
  try {
    const clock =
      input.clock ?? Object.freeze({ nowUnixSeconds: () => Math.floor(Date.now() / 1_000) });
    const protectedOrigin = new URL(input.config.HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN);
    if (
      protectedOrigin.protocol !== "https:" ||
      protectedOrigin.username !== "" ||
      protectedOrigin.password !== "" ||
      protectedOrigin.port !== "" ||
      protectedOrigin.pathname !== "/" ||
      protectedOrigin.search !== "" ||
      protectedOrigin.hash !== "" ||
      protectedOrigin.origin !== input.config.HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN
    ) {
      throw new Error("invalid protected origin");
    }
    const accessValidator = makeCloudflareAccessJwtValidatorV1({
      issuer: input.config.HNS_COMMUNITY_APP_API_ACCESS_ISSUER,
      audience: input.config.HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE,
      jwksUrl: input.config.HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL,
      clock,
      ...(input.access_fetch === undefined ? {} : { fetchImpl: input.access_fetch }),
    });
    return makeHnsHandleHostApiComposition(true, {
      access_validator: accessValidator,
      authority_source: input.authority_source,
    });
  } catch {
    throw new Error("HNS handle-host API production configuration is incomplete or invalid");
  }
}
