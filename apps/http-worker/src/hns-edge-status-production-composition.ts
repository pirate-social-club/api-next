import type { HnsEdgeStatusClock } from "@pirate/application/use-cases/hns-edge-status";
import {
  type CloudflareAccessJwtFetch,
  makeCloudflareAccessJwtValidatorV1,
} from "@pirate/platform-cf/cloudflare-access-jwt";
import type { HttpWorkerConfigValue } from "@pirate/platform-cf/config";
import {
  type HnsEdgeStatusKvNamespace,
  makeCloudflareHnsEdgeStatusStore,
} from "@pirate/platform-cf/hns-edge-status-kv";
import {
  type HnsEdgeStatusComposition,
  makeHnsEdgeStatusComposition,
} from "./hns-edge-status-page.ts";

type ProductionConfig = Pick<
  HttpWorkerConfigValue,
  | "HNS_EDGE_STATUS_ENABLED"
  | "HNS_EDGE_STATUS_ACCESS_ISSUER"
  | "HNS_EDGE_STATUS_ACCESS_JWKS_URL"
  | "HNS_EDGE_STATUS_ACCESS_AUDIENCE"
>;

export function makeProductionHnsEdgeStatusComposition(input: {
  readonly config: ProductionConfig;
  readonly namespace?: HnsEdgeStatusKvNamespace;
  readonly access_fetch?: CloudflareAccessJwtFetch;
  readonly clock?: HnsEdgeStatusClock;
}): HnsEdgeStatusComposition {
  if (!input.config.HNS_EDGE_STATUS_ENABLED) return makeHnsEdgeStatusComposition(false);
  try {
    if (input.namespace === undefined) throw new Error("missing status namespace");
    const clock =
      input.clock ?? Object.freeze({ nowUnixSeconds: () => Math.floor(Date.now() / 1_000) });
    const accessValidator = makeCloudflareAccessJwtValidatorV1({
      issuer: input.config.HNS_EDGE_STATUS_ACCESS_ISSUER,
      audience: input.config.HNS_EDGE_STATUS_ACCESS_AUDIENCE,
      jwksUrl: input.config.HNS_EDGE_STATUS_ACCESS_JWKS_URL,
      clock,
      ...(input.access_fetch === undefined ? {} : { fetchImpl: input.access_fetch }),
    });
    return makeHnsEdgeStatusComposition(true, {
      access_validator: accessValidator,
      store: makeCloudflareHnsEdgeStatusStore(input.namespace),
      clock,
    });
  } catch {
    throw new Error("HNS edge status production configuration is incomplete or invalid");
  }
}
