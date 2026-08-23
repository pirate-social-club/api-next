import {
  type HnsControlObserverConfigurationAuthority,
  HnsControlObserverConfigurationError,
  type HnsControlObserverConfigurationResolverPort,
  type HnsControlObserverHsdTransportPort,
  type HnsControlObserverRuntimeCapabilities,
  type HnsControlObserverSnapshotStorePort,
  resolveHnsControlObserverConfiguration,
} from "@pirate/application/namespace-ownership";
import {
  HnsParentChainObserverError,
  makeHnsParentChainTargetObserver,
} from "./hsd-parent-chain-observer.ts";
import {
  HNS_TARGET_OBSERVER_DEADLINE_MAX_MS,
  type HnsTargetObserverRuntime,
} from "./target-observer.ts";

export type HnsParentChainTargetObserverRuntimeAuthority =
  HnsControlObserverConfigurationAuthority &
    Readonly<{ readonly ownership_source: "hns_parent_chain_txt" }>;

export async function makeHnsParentChainTargetObserverRuntime(
  input: Readonly<{
    readonly authority: HnsParentChainTargetObserverRuntimeAuthority;
    readonly capabilities: HnsControlObserverRuntimeCapabilities;
    readonly configuration_resolver: HnsControlObserverConfigurationResolverPort;
    readonly snapshot_store: HnsControlObserverSnapshotStorePort;
    readonly hsd_transport: HnsControlObserverHsdTransportPort;
  }>,
  options: Readonly<{ readonly deadline_ms: number; readonly signal: AbortSignal }>,
): Promise<HnsTargetObserverRuntime> {
  if (
    !Number.isSafeInteger(options.deadline_ms) ||
    options.deadline_ms < 1 ||
    options.deadline_ms > HNS_TARGET_OBSERVER_DEADLINE_MAX_MS
  ) {
    throw new HnsParentChainObserverError(
      "misconfigured",
      "HNS target-observer configuration deadline is invalid",
    );
  }
  if (options.signal.aborted) {
    throw new HnsParentChainObserverError(
      "transport_unavailable",
      "HNS target-observer composition was already aborted",
    );
  }

  let resolved: Awaited<ReturnType<typeof resolveHnsControlObserverConfiguration>>;
  try {
    resolved = await resolveHnsControlObserverConfiguration({
      authority: input.authority,
      capabilities: input.capabilities,
      resolver: input.configuration_resolver,
      deadline_ms: options.deadline_ms,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) {
      throw new HnsParentChainObserverError(
        "transport_unavailable",
        "HNS target-observer configuration resolution was aborted",
      );
    }
    if (error instanceof HnsControlObserverConfigurationError) {
      throw new HnsParentChainObserverError(
        "misconfigured",
        "HNS target-observer composition authority is invalid",
      );
    }
    throw new HnsParentChainObserverError(
      "transport_unavailable",
      "HNS target-observer configuration registry is unavailable",
    );
  }
  if (options.signal.aborted) {
    throw new HnsParentChainObserverError(
      "transport_unavailable",
      "HNS target-observer configuration resolved after abort",
    );
  }

  const configuration = resolved.configuration;
  if (options.deadline_ms !== configuration.observer_deadline_ms) {
    throw new HnsParentChainObserverError(
      "misconfigured",
      "HNS target-observer composition deadline does not match immutable configuration",
    );
  }
  const pinnedConfigurationBytes = new Uint8Array(resolved.configuration_bytes);
  const pinnedCapabilities = Object.freeze({ ...input.capabilities });
  const leasePolicy = Object.freeze({
    expected_block_interval_seconds: configuration.chain.expected_block_interval_seconds,
    minimum_safe_remaining_blocks: configuration.chain.minimum_safe_remaining_blocks,
    expiry_safety_blocks: configuration.chain.expiry_safety_blocks,
    evidence_lease_seconds: configuration.evidence_lease_seconds,
  });
  const runtimeConfiguration = Object.freeze({
    provider_id: configuration.provider_id,
    provider_configuration_reference: configuration.provider_configuration_reference,
    provider_configuration_version: configuration.provider_configuration_version,
    provider_configuration_digest: resolved.configuration_digest,
    environment: configuration.environment,
    ownership_source: "hns_parent_chain_txt" as const,
    observer_deadline_ms: configuration.observer_deadline_ms,
    lease_policy: leasePolicy,
  });
  const parentObserver = makeHnsParentChainTargetObserver({
    configuration_resolver: {
      resolve: async (identity, resolutionOptions) => {
        if (resolutionOptions.signal.aborted) {
          throw new Error("HNS pinned target-observer configuration resolution aborted");
        }
        if (
          identity.reference !== runtimeConfiguration.provider_configuration_reference ||
          identity.version !== runtimeConfiguration.provider_configuration_version
        ) {
          return null;
        }
        return new Uint8Array(pinnedConfigurationBytes);
      },
    },
    capabilities: pinnedCapabilities,
    snapshot_store: input.snapshot_store,
    hsd_transport: input.hsd_transport,
  });
  const observer = Object.freeze({
    observe: async (...parameters: Parameters<typeof parentObserver.observe>) => {
      const [observation, observationOptions] = parameters;
      const request = observation.request;
      if (
        request.provider_id !== runtimeConfiguration.provider_id ||
        request.provider_configuration_reference !==
          runtimeConfiguration.provider_configuration_reference ||
        request.provider_configuration_version !==
          runtimeConfiguration.provider_configuration_version ||
        request.provider_configuration_digest !==
          runtimeConfiguration.provider_configuration_digest ||
        request.environment !== runtimeConfiguration.environment ||
        request.ownership_source !== runtimeConfiguration.ownership_source ||
        observationOptions.deadline_ms !== runtimeConfiguration.observer_deadline_ms
      ) {
        throw new HnsParentChainObserverError(
          "misconfigured",
          "HNS observation authority does not match the composed runtime",
        );
      }
      return parentObserver.observe(observation, observationOptions);
    },
  });
  return Object.freeze({ configuration: runtimeConfiguration, observer });
}
