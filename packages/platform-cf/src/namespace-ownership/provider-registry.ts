import {
  makeNamespaceOwnershipProviderRegistry,
  type NamespaceOwnershipProviderAdapter,
  type NamespaceOwnershipProviderRegistryOptions,
  type NamespaceOwnershipProviderRegistryService,
} from "@pirate/application";
import { ProviderConfigurationRef } from "@pirate/domain/verification";
import { type Effect, Option, Schema } from "effect";
import {
  type HnsOwnerAdapterOptions,
  type HnsOwnerTransport,
  makeHnsOwnerAdapter,
} from "./hns-owner.ts";

export { HNS_OWNER_PROTOCOL_VERSION, HNS_OWNER_PROVIDER_ID } from "@pirate/application";
export type { HnsOwnerTransport } from "./hns-owner.ts";
export type { HnsOwnerServiceBinding } from "./hns-owner-service-binding.ts";
export { makeHnsOwnerServiceBindingTransport } from "./hns-owner-service-binding.ts";

const exactParseOptions = { onExcessProperty: "error" } as const;

export type PlatformNamespaceOwnershipProviderOptions = Readonly<{
  readonly now?: () => number;
  readonly hns?: Readonly<{
    /** Must be true for the adapter to be assembled into the runtime registry. */
    readonly enabled?: boolean;
    readonly transport?: HnsOwnerTransport;
    readonly provider_configuration?: Schema.Schema.Type<typeof ProviderConfigurationRef>;
    readonly environments?: readonly string[];
    readonly operation_deadlines?: HnsOwnerAdapterOptions["operation_deadlines"];
    readonly target_observation_contract?: HnsOwnerAdapterOptions["target_observation_contract"];
  }>;
}>;

function configuredHnsAdapter(
  options: PlatformNamespaceOwnershipProviderOptions,
): NamespaceOwnershipProviderAdapter | undefined {
  const hns = options.hns;
  if (
    hns === undefined ||
    hns.enabled !== true ||
    hns.transport === undefined ||
    hns.provider_configuration === undefined ||
    hns.environments === undefined ||
    hns.environments.length === 0
  ) {
    return undefined;
  }
  const configuration = Schema.decodeUnknownOption(
    ProviderConfigurationRef,
    exactParseOptions,
  )(hns.provider_configuration);
  if (Option.isNone(configuration)) return undefined;
  try {
    return makeHnsOwnerAdapter({
      transport: hns.transport,
      target_observation_contract: hns.target_observation_contract ?? "v2",
      provider_configuration: configuration.value,
      environments: hns.environments,
      ...(hns.operation_deadlines === undefined
        ? {}
        : { operation_deadlines: hns.operation_deadlines }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch {
    return undefined;
  }
}

/**
 * Production assembly deliberately starts with no namespace provider. HNS is
 * constructed only when the caller supplies a complete, injected transport
 * and explicitly enables it; no default fetch or implicit runtime registration
 * exists here.
 */
export function makePlatformNamespaceOwnershipProviderRegistry(
  options: PlatformNamespaceOwnershipProviderOptions = {},
): Effect.Effect<
  NamespaceOwnershipProviderRegistryService,
  import("@pirate/application").NamespaceOwnershipProviderRegistryError
> {
  const adapter = configuredHnsAdapter(options);
  const adapters = adapter === undefined ? [] : [adapter];
  const registryOptions: NamespaceOwnershipProviderRegistryOptions = {
    now: options.now ?? Date.now,
  };
  return makeNamespaceOwnershipProviderRegistry(adapters, registryOptions);
}
