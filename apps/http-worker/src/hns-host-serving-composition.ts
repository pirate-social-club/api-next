import {
  type HnsForwarderClockV1,
  type HnsForwarderKeyRegistryV1,
  type HnsForwarderReplayStoreV1,
  type HnsForwarderRuntimeLimitsV1,
  type HnsForwarderWorkerAuthoritySourceV1,
  makeHnsForwarderV3WorkerValidator,
} from "@pirate/platform-cf/hns-forwarder-v3";

export type HnsHostServingComposition = Readonly<{
  enabled: boolean;
  validator: ReturnType<typeof makeHnsForwarderV3WorkerValidator> | null;
}>;

export type HnsHostServingCompositionDependencies = Readonly<{
  authority_source?: HnsForwarderWorkerAuthoritySourceV1;
  key_registry?: HnsForwarderKeyRegistryV1;
  replay_store?: HnsForwarderReplayStoreV1;
  clock?: HnsForwarderClockV1;
  limits?: HnsForwarderRuntimeLimitsV1;
}>;

const disabledComposition: HnsHostServingComposition = Object.freeze({
  enabled: false,
  validator: null,
});

/**
 * Host serving has no production binding or configuration in this checkpoint.
 * Tests may inject the complete authority set; partial authority always fails.
 */
export function makeHnsHostServingComposition(
  enabled: boolean,
  dependencies: HnsHostServingCompositionDependencies = {},
): HnsHostServingComposition {
  if (!enabled) return disabledComposition;
  const { authority_source, key_registry, replay_store, clock, limits } = dependencies;
  if (
    authority_source === undefined ||
    key_registry === undefined ||
    replay_store === undefined ||
    clock === undefined ||
    limits === undefined
  ) {
    throw new Error("HNS host-serving composition is incomplete or invalid");
  }
  return Object.freeze({
    enabled: true,
    validator: makeHnsForwarderV3WorkerValidator({
      authority_source,
      key_registry,
      replay_store,
      clock,
      limits,
    }),
  });
}

export const disabledProductionHnsHostServingComposition = makeHnsHostServingComposition(false);
