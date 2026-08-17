import { Schema } from "effect";
import { AssetDescriptor, CaipAccountId, CaipAssetId, CaipChainId } from "./assets.ts";
import { CanonicalClaimIdentifier } from "./claims";
import { CanonicalIsoInstant, NonNegativeIntegerString, Sha256Hex } from "./scalars.ts";

export const ObservationKind = Schema.Literals([
  "asset_inventory",
  "asset_balance",
  "disclosed_predicate",
]);
export type ObservationKind = Schema.Schema.Type<typeof ObservationKind>;

export const TrustMode = Schema.Literals(["onchain_pinned", "provider_asserted"]);
export type TrustMode = Schema.Schema.Type<typeof TrustMode>;

/** Aggregation is declared by the observation, never inferred from an AST. */
export const AggregationMode = Schema.Literals([
  "single_wallet",
  "any_wallet",
  "sum_across_wallets",
]);
export type AggregationMode = Schema.Schema.Type<typeof AggregationMode>;

export const Completeness = Schema.Literals(["complete", "partial", "unknown"]);
export type Completeness = Schema.Schema.Type<typeof Completeness>;

export const SnapshotReference = Schema.Struct({
  kind: Schema.Literals(["block", "provider_snapshot", "receipt"]),
  reference: Schema.NonEmptyString,
});
export type SnapshotReference = Schema.Schema.Type<typeof SnapshotReference>;

/**
 * A resolver manifest describes runtime observations, not proof ceremonies.
 * `resolver_id` is data so adding a resolver never expands a provider enum.
 */
export const InventoryResolverManifest = Schema.Struct({
  resolver_id: Schema.NonEmptyString,
  manifest_version: Schema.NonEmptyString,
  supported_observation_kinds: Schema.Array(ObservationKind),
  supported_chain_ids: Schema.Array(CaipChainId),
  trust_modes: Schema.Array(TrustMode),
});
export type InventoryResolverManifest = Schema.Schema.Type<typeof InventoryResolverManifest>;

/**
 * Descriptor data is normalized and versioned at authoring time. Raw mutable
 * provider strings are intentionally not a policy input.
 */
export const AssetInventoryObservationValue = Schema.Struct({
  kind: Schema.Literal("asset_inventory"),
  chain_id: CaipChainId,
  account_id: CaipAccountId,
  asset_id: CaipAssetId,
  quantity: NonNegativeIntegerString,
  descriptor: AssetDescriptor,
});
export type AssetInventoryObservationValue = Schema.Schema.Type<
  typeof AssetInventoryObservationValue
>;

export const WalletBalanceObservationValue = Schema.Struct({
  kind: Schema.Literal("asset_balance"),
  chain_id: CaipChainId,
  account_id: CaipAccountId,
  asset_id: CaipAssetId,
  amount_atomic: NonNegativeIntegerString,
  asset_decimals: NonNegativeIntegerString.check(
    Schema.makeFilter((value) =>
      BigInt(value) <= 255n ? undefined : "Expected decimal precision no greater than 255",
    ),
  ),
});
export type WalletBalanceObservationValue = Schema.Schema.Type<
  typeof WalletBalanceObservationValue
>;

export const DisclosedPredicateObservationValue = Schema.Struct({
  kind: Schema.Literal("disclosed_predicate"),
  predicate: Schema.NonEmptyString,
  value: Schema.Json,
});
export type DisclosedPredicateObservationValue = Schema.Schema.Type<
  typeof DisclosedPredicateObservationValue
>;

export const ObservationValue = Schema.Union([
  AssetInventoryObservationValue,
  WalletBalanceObservationValue,
  DisclosedPredicateObservationValue,
]);
export type ObservationValue = Schema.Schema.Type<typeof ObservationValue>;

const ObservationFields = Schema.Struct({
  id: Schema.NonEmptyString,
  resolver_id: Schema.NonEmptyString,
  source_id: Schema.NonEmptyString,
  claim_id: CanonicalClaimIdentifier,
  subject_ref: Schema.NonEmptyString,
  value: ObservationValue,
  completeness: Completeness,
  trust_mode: TrustMode,
  aggregation_mode: AggregationMode,
  snapshot_ref: SnapshotReference,
  source_response_hash: Sha256Hex,
  descriptor_version: Schema.NonEmptyString,
  observed_at: CanonicalIsoInstant,
  expires_at: Schema.optional(CanonicalIsoInstant),
});
export const Observation = ObservationFields.check(
  Schema.makeFilter((observation) => {
    if (observation.value.kind !== "asset_inventory") return undefined;
    return observation.value.chain_id === observation.value.descriptor.chain_id &&
      observation.value.asset_id === observation.value.descriptor.asset_id &&
      observation.descriptor_version === observation.value.descriptor.schema_version
      ? undefined
      : "Expected the observation and frozen asset descriptor identities to match";
  }),
);
export type Observation = Schema.Schema.Type<typeof Observation>;
