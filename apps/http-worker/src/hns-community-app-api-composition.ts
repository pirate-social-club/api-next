import type { CloudflareAccessJwtValidatorV1 } from "@pirate/platform-cf/cloudflare-access-jwt";
import {
  type HnsForwarderClockV1,
  type HnsForwarderKeyRegistryV1,
  type HnsForwarderReplayStoreV1,
  type HnsForwarderRuntimeLimitsV1,
  type HnsForwarderWorkerAuthoritySourceV1,
  makeHnsForwarderV3WorkerValidator,
} from "@pirate/platform-cf/hns-forwarder-v3";

type HnsForwarderV3WorkerValidator = ReturnType<typeof makeHnsForwarderV3WorkerValidator>;

export type HnsCommunityAppApiComposition =
  | Readonly<{
      enabled: false;
      access_validator: null;
      forwarder_validator: null;
      authority_source: null;
      protected_origin: null;
    }>
  | Readonly<{
      enabled: true;
      access_validator: CloudflareAccessJwtValidatorV1;
      forwarder_validator: HnsForwarderV3WorkerValidator;
      authority_source: HnsForwarderWorkerAuthoritySourceV1;
      protected_origin: string;
    }>;

export type HnsCommunityAppApiCompositionDependencies = Readonly<{
  access_validator?: CloudflareAccessJwtValidatorV1;
  authority_source?: HnsForwarderWorkerAuthoritySourceV1;
  key_registry?: HnsForwarderKeyRegistryV1;
  replay_store?: HnsForwarderReplayStoreV1;
  clock?: HnsForwarderClockV1;
  limits?: HnsForwarderRuntimeLimitsV1;
  protected_origin?: string;
}>;

const disabledComposition: HnsCommunityAppApiComposition = Object.freeze({
  enabled: false,
  access_validator: null,
  forwarder_validator: null,
  authority_source: null,
  protected_origin: null,
});

/**
 * The interactive HNS API branch is source-closed over both trust systems.
 * Tests may inject the complete set; partial authority is never accepted.
 */
export function makeHnsCommunityAppApiComposition(
  enabled: boolean,
  dependencies: HnsCommunityAppApiCompositionDependencies = {},
): HnsCommunityAppApiComposition {
  if (!enabled) return disabledComposition;
  const {
    access_validator,
    authority_source,
    key_registry,
    replay_store,
    clock,
    limits,
    protected_origin,
  } = dependencies;
  if (
    access_validator === undefined ||
    authority_source === undefined ||
    key_registry === undefined ||
    replay_store === undefined ||
    clock === undefined ||
    limits === undefined ||
    protected_origin === undefined
  ) {
    throw new Error("HNS community API composition is incomplete or invalid");
  }
  return Object.freeze({
    enabled: true,
    access_validator,
    authority_source,
    protected_origin,
    forwarder_validator: makeHnsForwarderV3WorkerValidator({
      authority_source,
      key_registry,
      replay_store,
      clock,
      limits,
    }),
  });
}

/** Fail-closed default used whenever the production activation flag is false. */
export const disabledProductionHnsCommunityAppApiComposition =
  makeHnsCommunityAppApiComposition(false);
