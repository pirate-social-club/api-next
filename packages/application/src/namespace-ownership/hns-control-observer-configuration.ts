import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Option, Schema } from "effect";
import { HNS_AUTHORITY_EVIDENCE_MAX_LIFETIME_SECONDS } from "./hns-authority-inventory.ts";
import type { HnsOwnershipSource } from "./hns-control-observer.ts";
import { decodeStrictHnsJsonBytes, HnsOwnerResponseDecodeError } from "./hns-evidence.ts";

export const HNS_CONTROL_OBSERVER_CONFIGURATION_VERSION =
  "pirate-hns-control-observer-configuration-v1" as const;
export const HNS_CONTROL_OBSERVER_CONFIGURATION_V2_VERSION =
  "pirate-hns-control-observer-configuration-v2" as const;
export const HNS_CONTROL_OBSERVER_CONFIGURATION_MAX_BYTES = 8_192 as const;
export const HNS_CONTROL_OBSERVER_CONFIGURATION_REFERENCE_MAX_BYTES = 512 as const;
export const HNS_CONTROL_OBSERVER_CONFIGURATION_IDENTITY_MAX_BYTES = 256 as const;
export const HNS_CONTROL_OBSERVER_CONFIGURATION_VIEW_MAX_COUNT = 4 as const;
export const HNS_CONTROL_OBSERVER_HSD_RESPONSE_MAX_BYTES = 1_048_576 as const;
export const HNS_CONTROL_OBSERVER_DNS_RESPONSE_MAX_BYTES = 65_535 as const;
export const HNS_CONTROL_OBSERVER_DEADLINE_MAX_MS = 12_000 as const;
export const HNS_CONTROL_OBSERVER_RESERVATION_LEASE_MIN_SECONDS = 4 as const;
export const HNS_CONTROL_OBSERVER_RESERVATION_LEASE_MAX_SECONDS = 60 as const;

const exactParseOptions = { onExcessProperty: "error" } as const;
const encoder = new TextEncoder();
const sourceValues = ["hns_parent_chain_txt", "owner_authoritative_dns_txt"] as const;
const registryReferencePattern = /^[a-z][a-z0-9-]{0,63}:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const viewIdPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const networkPattern = /^[a-z][a-z0-9-]{0,31}$/u;

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function isSafeText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  }
  return true;
}

function boundedString(maxBytes: number, label: string) {
  return Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      value.trim() === value && isSafeText(value) && utf8Length(value) <= maxBytes
        ? undefined
        : `Expected ${label} to be bounded canonical UTF-8`,
    ),
  );
}

function patternString(maxBytes: number, pattern: RegExp, label: string) {
  return boundedString(maxBytes, label).check(
    Schema.makeFilter((value) =>
      pattern.test(value) ? undefined : `Expected ${label} to match its canonical grammar`,
    ),
  );
}

function integerRange(minimum: number, maximum: number, label: string) {
  return Schema.Int.check(
    Schema.makeFilter((value) =>
      Number.isSafeInteger(value) && value >= minimum && value <= maximum
        ? undefined
        : `Expected ${label} to be an integer from ${minimum} through ${maximum}`,
    ),
  );
}

const SafeInteger = integerRange(0, Number.MAX_SAFE_INTEGER, "safe integer");
const PositiveSafeInteger = integerRange(1, Number.MAX_SAFE_INTEGER, "positive safe integer");
const Identity = boundedString(HNS_CONTROL_OBSERVER_CONFIGURATION_IDENTITY_MAX_BYTES, "identity");
const ConfigurationReference = boundedString(
  HNS_CONTROL_OBSERVER_CONFIGURATION_REFERENCE_MAX_BYTES,
  "provider configuration reference",
);
const RegistryReference = patternString(
  HNS_CONTROL_OBSERVER_CONFIGURATION_IDENTITY_MAX_BYTES,
  registryReferencePattern,
  "registry reference",
);
const ViewId = patternString(64, viewIdPattern, "required view id");
const Network = patternString(32, networkPattern, "chain network");
const OwnershipSource = Schema.Literals(sourceValues);

const ChainSchema = Schema.Struct({
  driver_reference: RegistryReference,
  network: Network,
  genesis_block_hash: Sha256Hex,
  minimum_verification_progress_millionths: integerRange(
    1,
    1_000_000,
    "minimum verification progress millionths",
  ),
  maximum_tip_age_seconds: SafeInteger,
  maximum_future_tip_seconds: SafeInteger,
  expected_block_interval_seconds: PositiveSafeInteger,
  minimum_safe_remaining_blocks: PositiveSafeInteger,
  expiry_safety_blocks: SafeInteger,
  response_max_bytes: integerRange(
    1,
    HNS_CONTROL_OBSERVER_HSD_RESPONSE_MAX_BYTES,
    "HSD response byte limit",
  ),
});

const AuthoritativeDnsSchema = Schema.Struct({
  driver_reference: RegistryReference,
  required_view_ids: Schema.Array(ViewId),
  require_dnssec: Schema.Literal(true),
  require_all_views: Schema.Literal(true),
  response_max_bytes: integerRange(
    1,
    HNS_CONTROL_OBSERVER_DNS_RESPONSE_MAX_BYTES,
    "DNS response byte limit",
  ),
});

const AuthorityInventorySchema = Schema.Struct({
  registry_reference: RegistryReference,
  maximum_inventory_lifetime_seconds: integerRange(
    1,
    HNS_AUTHORITY_EVIDENCE_MAX_LIFETIME_SECONDS,
    "maximum authority inventory lifetime seconds",
  ),
  response_max_bytes: integerRange(1, 65_536, "authority inventory response byte limit"),
});

const ConfigurationSchema = Schema.Struct({
  version: Schema.Literal(HNS_CONTROL_OBSERVER_CONFIGURATION_VERSION),
  provider_id: Schema.Literal("hns.owner.v1"),
  provider_configuration_reference: ConfigurationReference,
  provider_configuration_version: Identity,
  environment: Identity,
  ownership_sources: Schema.Array(OwnershipSource),
  chain: ChainSchema,
  authoritative_dns: Schema.NullOr(AuthoritativeDnsSchema),
  evidence_lease_seconds: PositiveSafeInteger,
  observer_deadline_ms: integerRange(
    1,
    HNS_CONTROL_OBSERVER_DEADLINE_MAX_MS,
    "observer deadline milliseconds",
  ),
  observer_reservation_lease_seconds: integerRange(
    HNS_CONTROL_OBSERVER_RESERVATION_LEASE_MIN_SECONDS,
    HNS_CONTROL_OBSERVER_RESERVATION_LEASE_MAX_SECONDS,
    "observer reservation lease seconds",
  ),
  snapshot_store_reference: RegistryReference,
});

const ConfigurationV2Schema = Schema.Struct({
  version: Schema.Literal(HNS_CONTROL_OBSERVER_CONFIGURATION_V2_VERSION),
  provider_id: Schema.Literal("hns.owner.v1"),
  provider_configuration_reference: ConfigurationReference,
  provider_configuration_version: Identity,
  environment: Identity,
  ownership_sources: Schema.Array(OwnershipSource),
  chain: ChainSchema,
  authoritative_dns: Schema.NullOr(AuthoritativeDnsSchema),
  authority_inventory: Schema.NullOr(AuthorityInventorySchema),
  evidence_lease_seconds: PositiveSafeInteger,
  observer_deadline_ms: integerRange(
    1,
    HNS_CONTROL_OBSERVER_DEADLINE_MAX_MS,
    "observer deadline milliseconds",
  ),
  observer_reservation_lease_seconds: integerRange(
    HNS_CONTROL_OBSERVER_RESERVATION_LEASE_MIN_SECONDS,
    HNS_CONTROL_OBSERVER_RESERVATION_LEASE_MAX_SECONDS,
    "observer reservation lease seconds",
  ),
  snapshot_store_reference: RegistryReference,
});

const configurationKeys = [
  "version",
  "provider_id",
  "provider_configuration_reference",
  "provider_configuration_version",
  "environment",
  "ownership_sources",
  "chain",
  "authoritative_dns",
  "evidence_lease_seconds",
  "observer_deadline_ms",
  "observer_reservation_lease_seconds",
  "snapshot_store_reference",
] as const;
const chainKeys = [
  "driver_reference",
  "network",
  "genesis_block_hash",
  "minimum_verification_progress_millionths",
  "maximum_tip_age_seconds",
  "maximum_future_tip_seconds",
  "expected_block_interval_seconds",
  "minimum_safe_remaining_blocks",
  "expiry_safety_blocks",
  "response_max_bytes",
] as const;
const authoritativeDnsKeys = [
  "driver_reference",
  "required_view_ids",
  "require_dnssec",
  "require_all_views",
  "response_max_bytes",
] as const;
const configurationV2Keys = [
  "version",
  "provider_id",
  "provider_configuration_reference",
  "provider_configuration_version",
  "environment",
  "ownership_sources",
  "chain",
  "authoritative_dns",
  "authority_inventory",
  "evidence_lease_seconds",
  "observer_deadline_ms",
  "observer_reservation_lease_seconds",
  "snapshot_store_reference",
] as const;
const authorityInventoryKeys = [
  "registry_reference",
  "maximum_inventory_lifetime_seconds",
  "response_max_bytes",
] as const;

export type HnsControlObserverConfigurationV1 = Schema.Schema.Type<typeof ConfigurationSchema>;
export type HnsControlObserverConfigurationV2 = Schema.Schema.Type<typeof ConfigurationV2Schema>;

export type HnsControlObserverDecodedConfiguration = Readonly<{
  readonly configuration_bytes: Uint8Array;
  readonly configuration: HnsControlObserverConfigurationV1;
  readonly configuration_digest: Sha256HexValue;
}>;

export type HnsControlObserverDecodedConfigurationV2 = Readonly<{
  readonly configuration_bytes: Uint8Array;
  readonly configuration: HnsControlObserverConfigurationV2;
  readonly configuration_digest: Sha256HexValue;
}>;

export type HnsControlObserverDecodedCompatibleConfiguration =
  | HnsControlObserverDecodedConfiguration
  | HnsControlObserverDecodedConfigurationV2;

export type HnsControlObserverConfigurationResolverPort = Readonly<{
  /** Must reject promptly and perform no later write when `signal` aborts. */
  readonly resolve: (
    identity: Readonly<{
      readonly reference: string;
      readonly version: string;
    }>,
    options: Readonly<{ readonly deadline_ms: number; readonly signal: AbortSignal }>,
  ) => Promise<Uint8Array | null>;
}>;

export type HnsControlObserverRuntimeCapabilities = Readonly<{
  readonly provider_id: "hns.owner.v1";
  readonly environment: string;
  readonly chain_driver_reference: string;
  readonly authoritative_dns_driver_reference: string | null;
  readonly snapshot_store_reference: string;
}>;

export type HnsControlObserverRuntimeCapabilitiesV2 = HnsControlObserverRuntimeCapabilities &
  Readonly<{
    readonly authority_inventory_registry_reference: string;
    readonly authority_inventory_runtime_capability_set_digest: Sha256HexValue;
  }>;

export type HnsControlObserverConfigurationAuthority = Readonly<{
  readonly provider_id: "hns.owner.v1";
  readonly provider_configuration_reference: string;
  readonly provider_configuration_version: string;
  readonly provider_configuration_digest: Sha256HexValue;
  readonly environment: string;
  readonly ownership_source?: HnsOwnershipSource;
}>;

export class HnsControlObserverConfigurationError extends Error {
  readonly name = "HnsControlObserverConfigurationError";

  constructor(
    readonly reason:
      | "invalid_document"
      | "not_found"
      | "identity_mismatch"
      | "digest_mismatch"
      | "capability_mismatch",
    message: string,
  ) {
    super(message);
  }
}

function decodeSchema<T>(schema: Schema.ConstraintDecoder<T>, value: unknown, message: string): T {
  const decoded = Schema.decodeUnknownOption(schema, exactParseOptions)(value);
  if (Option.isNone(decoded)) {
    throw new HnsControlObserverConfigurationError("invalid_document", message);
  }
  return decoded.value;
}

function assertObjectOrder(value: unknown, expected: ReadonlyArray<string>, label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HnsControlObserverConfigurationError(
      "invalid_document",
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new HnsControlObserverConfigurationError(
      "invalid_document",
      `${label} members are reordered`,
    );
  }
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function assertConfigurationInvariants(configuration: HnsControlObserverConfigurationV1): void {
  const sources = [...configuration.ownership_sources];
  const sourceKey = sources.join(",");
  if (
    sourceKey !== "hns_parent_chain_txt" &&
    sourceKey !== "owner_authoritative_dns_txt" &&
    sourceKey !== "hns_parent_chain_txt,owner_authoritative_dns_txt"
  ) {
    throw new HnsControlObserverConfigurationError(
      "invalid_document",
      "HNS observer ownership sources are not a canonical ordered set",
    );
  }
  const hasAuthoritativeDns = sources.includes("owner_authoritative_dns_txt");
  if (hasAuthoritativeDns !== (configuration.authoritative_dns !== null)) {
    throw new HnsControlObserverConfigurationError(
      "invalid_document",
      "HNS observer authoritative DNS policy does not match its source set",
    );
  }
  if (
    configuration.authoritative_dns !== null &&
    configuration.authoritative_dns.driver_reference === configuration.chain.driver_reference
  ) {
    throw new HnsControlObserverConfigurationError(
      "invalid_document",
      "HNS observer chain and authoritative DNS drivers must be distinct",
    );
  }
  const reservationMinimum = Math.ceil(configuration.observer_deadline_ms / 1_000) + 3;
  if (configuration.observer_reservation_lease_seconds < reservationMinimum) {
    throw new HnsControlObserverConfigurationError(
      "invalid_document",
      "HNS observer reservation lease is shorter than the operation deadline margin",
    );
  }
  const views = configuration.authoritative_dns?.required_view_ids;
  if (views !== undefined) {
    if (views.length === 0 || views.length > HNS_CONTROL_OBSERVER_CONFIGURATION_VIEW_MAX_COUNT) {
      throw new HnsControlObserverConfigurationError(
        "invalid_document",
        "HNS observer required DNS view count is invalid",
      );
    }
    for (let index = 1; index < views.length; index += 1) {
      if (compareUtf8(views[index - 1] ?? "", views[index] ?? "") >= 0) {
        throw new HnsControlObserverConfigurationError(
          "invalid_document",
          "HNS observer required DNS views are duplicated or reordered",
        );
      }
    }
  }
}

function assertConfigurationV2Invariants(configuration: HnsControlObserverConfigurationV2): void {
  const { authority_inventory: authorityInventory, ...shared } = configuration;
  assertConfigurationInvariants({
    ...shared,
    version: HNS_CONTROL_OBSERVER_CONFIGURATION_VERSION,
  });
  const hasOwnerAuthoritativeSource = configuration.ownership_sources.includes(
    "owner_authoritative_dns_txt",
  );
  if (hasOwnerAuthoritativeSource !== (authorityInventory !== null)) {
    throw new HnsControlObserverConfigurationError(
      "invalid_document",
      "HNS observer authority inventory policy does not match its source set",
    );
  }
  if (
    authorityInventory !== null &&
    (authorityInventory.registry_reference === configuration.chain.driver_reference ||
      authorityInventory.registry_reference === configuration.authoritative_dns?.driver_reference ||
      authorityInventory.registry_reference === configuration.snapshot_store_reference)
  ) {
    throw new HnsControlObserverConfigurationError(
      "invalid_document",
      "HNS observer authority inventory registry must be a distinct capability",
    );
  }
}

async function sha256Bytes(bytes: Uint8Array): Promise<Sha256HexValue> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return Schema.decodeUnknownSync(Sha256Hex)(hex);
}

export async function decodeHnsControlObserverConfigurationBytes(
  value: unknown,
): Promise<HnsControlObserverDecodedConfiguration> {
  if (!(value instanceof Uint8Array)) {
    throw new HnsControlObserverConfigurationError(
      "invalid_document",
      "HNS observer configuration must be exact bytes",
    );
  }
  const configurationBytes = new Uint8Array(value);
  let json: unknown;
  try {
    json = decodeStrictHnsJsonBytes(
      configurationBytes,
      HNS_CONTROL_OBSERVER_CONFIGURATION_MAX_BYTES,
    );
  } catch (error) {
    if (error instanceof HnsOwnerResponseDecodeError) {
      throw new HnsControlObserverConfigurationError("invalid_document", error.message);
    }
    throw error;
  }
  assertObjectOrder(json, configurationKeys, "HNS observer configuration");
  const raw = json as Record<string, unknown>;
  assertObjectOrder(raw.chain, chainKeys, "HNS observer chain configuration");
  if (raw.authoritative_dns !== null) {
    assertObjectOrder(
      raw.authoritative_dns,
      authoritativeDnsKeys,
      "HNS observer authoritative DNS configuration",
    );
  }
  const configuration = decodeSchema(
    ConfigurationSchema,
    json,
    "HNS observer configuration failed its strict schema",
  );
  assertConfigurationInvariants(configuration);
  return {
    configuration_bytes: configurationBytes,
    configuration,
    configuration_digest: await sha256Bytes(configurationBytes),
  };
}

export async function encodeHnsControlObserverConfiguration(
  input: HnsControlObserverConfigurationV1,
): Promise<Uint8Array> {
  return (await decodeHnsControlObserverConfigurationBytes(encoder.encode(JSON.stringify(input))))
    .configuration_bytes;
}

export async function decodeHnsControlObserverConfigurationV2Bytes(
  value: unknown,
): Promise<HnsControlObserverDecodedConfigurationV2> {
  if (!(value instanceof Uint8Array)) {
    throw new HnsControlObserverConfigurationError(
      "invalid_document",
      "HNS observer configuration-v2 must be exact bytes",
    );
  }
  const configurationBytes = new Uint8Array(value);
  let json: unknown;
  try {
    json = decodeStrictHnsJsonBytes(
      configurationBytes,
      HNS_CONTROL_OBSERVER_CONFIGURATION_MAX_BYTES,
    );
  } catch (error) {
    if (error instanceof HnsOwnerResponseDecodeError) {
      throw new HnsControlObserverConfigurationError("invalid_document", error.message);
    }
    throw error;
  }
  assertObjectOrder(json, configurationV2Keys, "HNS observer configuration-v2");
  const raw = json as Record<string, unknown>;
  assertObjectOrder(raw.chain, chainKeys, "HNS observer chain configuration");
  if (raw.authoritative_dns !== null) {
    assertObjectOrder(
      raw.authoritative_dns,
      authoritativeDnsKeys,
      "HNS observer authoritative DNS configuration",
    );
  }
  if (raw.authority_inventory !== null) {
    assertObjectOrder(
      raw.authority_inventory,
      authorityInventoryKeys,
      "HNS observer authority inventory configuration",
    );
  }
  const configuration = decodeSchema(
    ConfigurationV2Schema,
    json,
    "HNS observer configuration-v2 failed its strict schema",
  );
  assertConfigurationV2Invariants(configuration);
  return {
    configuration_bytes: configurationBytes,
    configuration,
    configuration_digest: await sha256Bytes(configurationBytes),
  };
}

export async function encodeHnsControlObserverConfigurationV2(
  input: HnsControlObserverConfigurationV2,
): Promise<Uint8Array> {
  return (await decodeHnsControlObserverConfigurationV2Bytes(encoder.encode(JSON.stringify(input))))
    .configuration_bytes;
}

export async function decodeHnsControlObserverCompatibleConfigurationBytes(
  value: unknown,
): Promise<HnsControlObserverDecodedCompatibleConfiguration> {
  if (!(value instanceof Uint8Array)) {
    throw new HnsControlObserverConfigurationError(
      "invalid_document",
      "HNS observer configuration must be exact bytes",
    );
  }
  let json: unknown;
  try {
    json = decodeStrictHnsJsonBytes(value, HNS_CONTROL_OBSERVER_CONFIGURATION_MAX_BYTES);
  } catch (error) {
    if (error instanceof HnsOwnerResponseDecodeError) {
      throw new HnsControlObserverConfigurationError("invalid_document", error.message);
    }
    throw error;
  }
  const version =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>).version
      : undefined;
  if (version === HNS_CONTROL_OBSERVER_CONFIGURATION_VERSION) {
    return decodeHnsControlObserverConfigurationBytes(value);
  }
  if (version === HNS_CONTROL_OBSERVER_CONFIGURATION_V2_VERSION) {
    return decodeHnsControlObserverConfigurationV2Bytes(value);
  }
  throw new HnsControlObserverConfigurationError(
    "invalid_document",
    "HNS observer configuration version is unsupported",
  );
}

export async function resolveHnsControlObserverConfiguration(
  input: Readonly<{
    readonly authority: HnsControlObserverConfigurationAuthority;
    readonly capabilities: HnsControlObserverRuntimeCapabilities;
    readonly resolver: HnsControlObserverConfigurationResolverPort;
    readonly deadline_ms: number;
    readonly signal: AbortSignal;
  }>,
): Promise<HnsControlObserverDecodedConfiguration> {
  if (input.signal.aborted) throw new Error("HNS observer configuration resolution aborted");
  const bytes = await input.resolver.resolve(
    {
      reference: input.authority.provider_configuration_reference,
      version: input.authority.provider_configuration_version,
    },
    { deadline_ms: input.deadline_ms, signal: input.signal },
  );
  if (input.signal.aborted) throw new Error("HNS observer configuration resolution aborted");
  if (bytes === null) {
    throw new HnsControlObserverConfigurationError(
      "not_found",
      "HNS observer configuration was not found",
    );
  }
  const decoded = await decodeHnsControlObserverConfigurationBytes(bytes);
  const configuration = decoded.configuration;
  if (decoded.configuration_digest !== input.authority.provider_configuration_digest) {
    throw new HnsControlObserverConfigurationError(
      "digest_mismatch",
      "HNS observer configuration digest does not match authority",
    );
  }
  if (
    configuration.provider_configuration_reference !==
      input.authority.provider_configuration_reference ||
    configuration.provider_configuration_version !==
      input.authority.provider_configuration_version ||
    configuration.provider_id !== input.authority.provider_id ||
    configuration.environment !== input.authority.environment ||
    (input.authority.ownership_source !== undefined &&
      !configuration.ownership_sources.includes(input.authority.ownership_source))
  ) {
    throw new HnsControlObserverConfigurationError(
      "identity_mismatch",
      "HNS observer configuration identity does not match authority",
    );
  }
  if (
    input.capabilities.provider_id !== configuration.provider_id ||
    input.capabilities.environment !== configuration.environment ||
    input.capabilities.chain_driver_reference !== configuration.chain.driver_reference ||
    input.capabilities.snapshot_store_reference !== configuration.snapshot_store_reference ||
    input.capabilities.authoritative_dns_driver_reference !==
      (configuration.authoritative_dns?.driver_reference ?? null)
  ) {
    throw new HnsControlObserverConfigurationError(
      "capability_mismatch",
      "HNS observer runtime capabilities do not match configuration",
    );
  }
  return decoded;
}

export async function resolveHnsControlObserverConfigurationV2(
  input: Readonly<{
    readonly authority: HnsControlObserverConfigurationAuthority;
    readonly capabilities: HnsControlObserverRuntimeCapabilitiesV2;
    readonly resolver: HnsControlObserverConfigurationResolverPort;
    readonly deadline_ms: number;
    readonly signal: AbortSignal;
  }>,
): Promise<HnsControlObserverDecodedConfigurationV2> {
  if (input.signal.aborted) throw new Error("HNS observer configuration-v2 resolution aborted");
  const bytes = await input.resolver.resolve(
    {
      reference: input.authority.provider_configuration_reference,
      version: input.authority.provider_configuration_version,
    },
    { deadline_ms: input.deadline_ms, signal: input.signal },
  );
  if (input.signal.aborted) throw new Error("HNS observer configuration-v2 resolution aborted");
  if (bytes === null) {
    throw new HnsControlObserverConfigurationError(
      "not_found",
      "HNS observer configuration-v2 was not found",
    );
  }
  const decoded = await decodeHnsControlObserverConfigurationV2Bytes(bytes);
  const configuration = decoded.configuration;
  if (decoded.configuration_digest !== input.authority.provider_configuration_digest) {
    throw new HnsControlObserverConfigurationError(
      "digest_mismatch",
      "HNS observer configuration-v2 digest does not match authority",
    );
  }
  if (
    configuration.provider_configuration_reference !==
      input.authority.provider_configuration_reference ||
    configuration.provider_configuration_version !==
      input.authority.provider_configuration_version ||
    configuration.provider_id !== input.authority.provider_id ||
    configuration.environment !== input.authority.environment ||
    (input.authority.ownership_source !== undefined &&
      !configuration.ownership_sources.includes(input.authority.ownership_source))
  ) {
    throw new HnsControlObserverConfigurationError(
      "identity_mismatch",
      "HNS observer configuration-v2 identity does not match authority",
    );
  }
  if (
    input.capabilities.provider_id !== configuration.provider_id ||
    input.capabilities.environment !== configuration.environment ||
    input.capabilities.chain_driver_reference !== configuration.chain.driver_reference ||
    input.capabilities.snapshot_store_reference !== configuration.snapshot_store_reference ||
    input.capabilities.authoritative_dns_driver_reference !==
      (configuration.authoritative_dns?.driver_reference ?? null) ||
    configuration.authority_inventory === null ||
    input.capabilities.authority_inventory_registry_reference !==
      configuration.authority_inventory.registry_reference
  ) {
    throw new HnsControlObserverConfigurationError(
      "capability_mismatch",
      "HNS observer runtime capabilities do not match configuration-v2",
    );
  }
  return decoded;
}
