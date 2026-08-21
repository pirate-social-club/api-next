import { ProviderConfigurationRef } from "@pirate/domain/verification";
import type { CommunityCreationRepositoryOptions } from "@pirate/platform-cf/community-creation-repository";
import type {
  HnsOwnerTransport,
  PlatformNamespaceOwnershipProviderOptions,
} from "@pirate/platform-cf/namespace-ownership-provider-registry";
import {
  HNS_OWNER_PROTOCOL_VERSION,
  HNS_OWNER_PROVIDER_ID,
} from "@pirate/platform-cf/namespace-ownership-provider-registry";
import { Option, Schema } from "effect";

const exactParseOptions = { onExcessProperty: "error" } as const;
const MAX_CONFIGURATION_IDENTITY_BYTES = 256;

export type HnsOwnershipCompositionConfig = Readonly<{
  readonly enabled: boolean;
  readonly environment: "development" | "staging" | "production";
  readonly configuration_reference: string;
  readonly configuration_version: string;
}>;

export type HnsOwnershipCompositionDependencies = Readonly<{
  readonly transport?: HnsOwnerTransport;
}>;

export type HnsOwnershipComposition = Readonly<{
  readonly namespace_provider_bindings: NonNullable<
    CommunityCreationRepositoryOptions["namespace_provider_bindings"]
  >;
  readonly provider_registry_options: PlatformNamespaceOwnershipProviderOptions;
}>;

const disabledComposition: HnsOwnershipComposition = Object.freeze({
  namespace_provider_bindings: Object.freeze([]),
  provider_registry_options: Object.freeze({}),
});

function boundedConfigurationIdentity(value: string): boolean {
  return (
    !value.includes("\u0000") &&
    new TextEncoder().encode(value).byteLength <= MAX_CONFIGURATION_IDENTITY_BYTES
  );
}

/**
 * Derives creation and ceremony authority from one configuration source.
 * No transport is inferred: external HNS verification remains disabled until
 * a separately reviewed transport is injected and explicitly enabled.
 */
export function makeHnsOwnershipComposition(
  config: HnsOwnershipCompositionConfig,
  dependencies: HnsOwnershipCompositionDependencies = {},
): HnsOwnershipComposition {
  if (!config.enabled) return disabledComposition;

  const providerConfiguration = Schema.decodeUnknownOption(
    ProviderConfigurationRef,
    exactParseOptions,
  )({
    kind: "managed",
    reference: config.configuration_reference,
    version: config.configuration_version,
  });
  if (
    Option.isNone(providerConfiguration) ||
    !boundedConfigurationIdentity(config.configuration_reference) ||
    !boundedConfigurationIdentity(config.configuration_version) ||
    dependencies.transport === undefined
  ) {
    throw new Error("HNS ownership composition is incomplete or invalid");
  }

  const configuration = Object.freeze(providerConfiguration.value);
  const binding = Object.freeze({
    requirement: "namespace_ownership" as const,
    family: "hns" as const,
    provider_id: HNS_OWNER_PROVIDER_ID,
    provider_configuration: configuration,
    protocol_version: HNS_OWNER_PROTOCOL_VERSION,
  });
  const environments = Object.freeze([config.environment]);

  return Object.freeze({
    namespace_provider_bindings: Object.freeze([binding]),
    provider_registry_options: Object.freeze({
      hns: Object.freeze({
        enabled: true,
        transport: dependencies.transport,
        provider_configuration: configuration,
        environments,
      }),
    }),
  });
}
