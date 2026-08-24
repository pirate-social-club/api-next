import type { HnsStaticPlatformGatewayFetch, HnsStaticPlatformGatewayService } from "./service.ts";
import { makeHnsStaticPlatformGatewayService } from "./service.ts";

export type HnsStaticPlatformGatewayComposition =
  | Readonly<{ enabled: false; service: null }>
  | Readonly<{ enabled: true; service: HnsStaticPlatformGatewayService }>;

const disabledComposition: HnsStaticPlatformGatewayComposition = Object.freeze({
  enabled: false,
  service: null,
});

export function makeHnsStaticPlatformGatewayComposition(
  enabled: boolean,
  dependencies: Readonly<{ upstream_fetch?: HnsStaticPlatformGatewayFetch }> = {},
): HnsStaticPlatformGatewayComposition {
  if (!enabled) return disabledComposition;
  if (dependencies.upstream_fetch === undefined) {
    throw new Error("HNS static platform gateway composition is incomplete or invalid");
  }
  return Object.freeze({
    enabled: true,
    service: makeHnsStaticPlatformGatewayService({ upstream_fetch: dependencies.upstream_fetch }),
  });
}

export const disabledProductionHnsStaticPlatformGatewayComposition =
  makeHnsStaticPlatformGatewayComposition(false);
