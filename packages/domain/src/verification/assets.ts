import { Schema } from "effect";
import { NonNegativeIntegerString } from "./scalars.ts";

/** CAIP identifiers remain opaque non-empty strings at this domain boundary. */
export const CaipChainId = Schema.NonEmptyString;
export type CaipChainId = Schema.Schema.Type<typeof CaipChainId>;

export const CaipAssetId = Schema.NonEmptyString;
export type CaipAssetId = Schema.Schema.Type<typeof CaipAssetId>;

export const CaipAccountId = Schema.NonEmptyString;
export type CaipAccountId = Schema.Schema.Type<typeof CaipAccountId>;

export const MatchSemantics = Schema.Literals(["exact", "normalized"]);
export type MatchSemantics = Schema.Schema.Type<typeof MatchSemantics>;

const AssetDescriptorFields = {
  schema_version: Schema.NonEmptyString,
  chain_id: CaipChainId,
  asset_id: CaipAssetId,
  contract_address: Schema.NonEmptyString,
  normalized_match: Schema.NonEmptyString,
  match_semantics: MatchSemantics,
};

export const AssetCollectionDescriptor = Schema.Struct({
  kind: Schema.Literal("collection"),
  ...AssetDescriptorFields,
});
export type AssetCollectionDescriptor = Schema.Schema.Type<typeof AssetCollectionDescriptor>;

export const AssetTokenDescriptor = Schema.Struct({
  kind: Schema.Literal("token"),
  ...AssetDescriptorFields,
  token_id: NonNegativeIntegerString,
});
export type AssetTokenDescriptor = Schema.Schema.Type<typeof AssetTokenDescriptor>;

/** Collection gates never manufacture a token-id sentinel. */
export const AssetDescriptor = Schema.Union([AssetCollectionDescriptor, AssetTokenDescriptor]);
export type AssetDescriptor = Schema.Schema.Type<typeof AssetDescriptor>;
