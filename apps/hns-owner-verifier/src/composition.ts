import type { HnsControlObserverRuntimeCapabilities } from "@pirate/application/namespace-ownership";
import { makeHnsControlObserverHsdPrivateTransport } from "@pirate/platform-cf/namespace-ownership-hns-control-observer-hsd-private-transport";
import {
  makeControlPlaneHnsControlObserverConfigurationResolver,
  makeControlPlaneHnsControlObserverSnapshotReader,
  makeControlPlaneHnsControlObserverSnapshotStore,
} from "@pirate/platform-cf/namespace-ownership-hns-control-observer-postgres";
import {
  type HnsPrivateDriverBinding,
  makeHnsAuthoritativeDnsPrivateDriverTransport,
  makeHnsControlObserverHsdPrivateDriverCapability,
} from "@pirate/platform-cf/namespace-ownership-hns-private-driver-transport";
import {
  type HyperdriveConnection,
  makeHyperdriveControlPlaneLayer,
} from "@pirate/platform-cf/postgres";
import { makeHnsAuthoritativeDnsValidatorV1 } from "./owner-authoritative-dns-policy-v1.ts";
import type { HnsTargetObserverRuntime } from "./target-observer.ts";
import {
  makeHnsOwnerAuthoritativeTargetObserverRuntime,
  makeHnsParentChainTargetObserverRuntime,
} from "./target-observer-runtime.ts";

export type HnsTargetCompositionBindings = Readonly<{
  readonly CONTROL_PLANE?: HyperdriveConnection;
  readonly HNS_OBSERVER_DRIVER?: HnsPrivateDriverBinding;
  readonly HNS_PROVIDER_CONFIGURATION_DIGEST?: string;
  readonly HNS_CHAIN_DRIVER_REFERENCE?: string;
  readonly HNS_AUTHORITATIVE_DNS_DRIVER_REFERENCE?: string;
  readonly HNS_SNAPSHOT_STORE_REFERENCE?: string;
  readonly HNS_OBSERVER_DEADLINE_MS?: string;
}>;

type HnsTargetCompositionEnvironment = HnsTargetCompositionBindings &
  Readonly<{
    readonly HNS_OWNERSHIP_SOURCE?: string;
    readonly HNS_PROVIDER_ENVIRONMENT?: string;
    readonly HNS_PROVIDER_CONFIGURATION_REFERENCE?: string;
    readonly HNS_PROVIDER_CONFIGURATION_VERSION?: string;
  }>;

const digestPattern = /^[0-9a-f]{64}$/u;
const safeReferencePattern = /^[a-z][a-z0-9-]{0,63}:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

function safeText(value: string | undefined, maximumBytes: number): value is string {
  if (value === undefined || value.length === 0 || value.trim() !== value) return false;
  if (new TextEncoder().encode(value).byteLength > maximumBytes) return false;
  return [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
  });
}

function deadline(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 12_000 ? parsed : null;
}

function sequentialMessageIds() {
  const seed = new Uint16Array(1);
  crypto.getRandomValues(seed);
  let next = seed[0] ?? 0;
  return Object.freeze({
    next_id: () => {
      const current = next;
      next = (next + 1) & 0xffff;
      return current;
    },
  });
}

export async function composeHnsTargetObserverRuntime(
  env: HnsTargetCompositionEnvironment,
  signal: AbortSignal,
): Promise<HnsTargetObserverRuntime | undefined> {
  const source = env.HNS_OWNERSHIP_SOURCE;
  const configurationDigest = env.HNS_PROVIDER_CONFIGURATION_DIGEST;
  const observerDeadline = deadline(env.HNS_OBSERVER_DEADLINE_MS);
  if (
    (source !== "hns_parent_chain_txt" && source !== "owner_authoritative_dns_txt") ||
    env.CONTROL_PLANE === undefined ||
    env.HNS_OBSERVER_DRIVER === undefined ||
    !safeText(env.HNS_PROVIDER_ENVIRONMENT, 256) ||
    !safeText(env.HNS_PROVIDER_CONFIGURATION_REFERENCE, 512) ||
    !safeText(env.HNS_PROVIDER_CONFIGURATION_VERSION, 256) ||
    configurationDigest === undefined ||
    !digestPattern.test(configurationDigest) ||
    env.HNS_CHAIN_DRIVER_REFERENCE === undefined ||
    !safeReferencePattern.test(env.HNS_CHAIN_DRIVER_REFERENCE) ||
    !safeText(env.HNS_SNAPSHOT_STORE_REFERENCE, 256) ||
    observerDeadline === null ||
    signal.aborted
  ) {
    return undefined;
  }
  const authoritativeDnsDriverReference = env.HNS_AUTHORITATIVE_DNS_DRIVER_REFERENCE;
  if (
    source === "owner_authoritative_dns_txt"
      ? authoritativeDnsDriverReference === undefined ||
        !safeReferencePattern.test(authoritativeDnsDriverReference)
      : authoritativeDnsDriverReference !== undefined
  ) {
    return undefined;
  }

  // Runtime crypto support is proven before configuration resolution can
  // create an owner-authoritative observation lifecycle.
  const validator =
    source === "owner_authoritative_dns_txt"
      ? await makeHnsAuthoritativeDnsValidatorV1()
      : undefined;
  if (signal.aborted) return undefined;

  const controlPlane = makeHyperdriveControlPlaneLayer(env.CONTROL_PLANE);
  const configurationResolver =
    makeControlPlaneHnsControlObserverConfigurationResolver(controlPlane);
  const snapshotStore = makeControlPlaneHnsControlObserverSnapshotStore(controlPlane, {
    snapshotStoreReference: env.HNS_SNAPSHOT_STORE_REFERENCE,
  });
  const snapshotReader = makeControlPlaneHnsControlObserverSnapshotReader(controlPlane);
  const hsdCapability = makeHnsControlObserverHsdPrivateDriverCapability({
    binding: env.HNS_OBSERVER_DRIVER,
    driver_reference: env.HNS_CHAIN_DRIVER_REFERENCE,
    timeout_ms: observerDeadline,
  });
  const hsdTransport = makeHnsControlObserverHsdPrivateTransport({
    driver_reference: env.HNS_CHAIN_DRIVER_REFERENCE,
    capability: hsdCapability,
  });
  const capabilities: HnsControlObserverRuntimeCapabilities = {
    provider_id: "hns.owner.v1",
    environment: env.HNS_PROVIDER_ENVIRONMENT,
    chain_driver_reference: env.HNS_CHAIN_DRIVER_REFERENCE,
    authoritative_dns_driver_reference:
      source === "owner_authoritative_dns_txt" ? (authoritativeDnsDriverReference ?? null) : null,
    snapshot_store_reference: env.HNS_SNAPSHOT_STORE_REFERENCE,
  };
  const authority = {
    provider_id: "hns.owner.v1" as const,
    provider_configuration_reference: env.HNS_PROVIDER_CONFIGURATION_REFERENCE,
    provider_configuration_version: env.HNS_PROVIDER_CONFIGURATION_VERSION,
    provider_configuration_digest: configurationDigest,
    environment: env.HNS_PROVIDER_ENVIRONMENT,
  };
  if (source === "hns_parent_chain_txt") {
    const runtime = await makeHnsParentChainTargetObserverRuntime(
      {
        authority: { ...authority, ownership_source: source },
        capabilities,
        configuration_resolver: configurationResolver,
        snapshot_store: snapshotStore,
        hsd_transport: hsdTransport,
      },
      { deadline_ms: observerDeadline, signal },
    );
    return Object.freeze({ ...runtime, snapshot_reader: snapshotReader });
  }
  if (validator === undefined || authoritativeDnsDriverReference === undefined) return undefined;
  const runtime = await makeHnsOwnerAuthoritativeTargetObserverRuntime(
    {
      authority: { ...authority, ownership_source: source },
      capabilities,
      configuration_resolver: configurationResolver,
      snapshot_store: snapshotStore,
      hsd_transport: hsdTransport,
      authoritative_dns_transport: makeHnsAuthoritativeDnsPrivateDriverTransport({
        binding: env.HNS_OBSERVER_DRIVER,
        driver_reference: authoritativeDnsDriverReference,
        timeout_ms: observerDeadline,
      }),
      message_ids: sequentialMessageIds(),
      validator,
    },
    { deadline_ms: observerDeadline, signal },
  );
  return Object.freeze({ ...runtime, snapshot_reader: snapshotReader });
}
