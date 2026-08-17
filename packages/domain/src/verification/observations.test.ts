import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AssetDescriptor } from "./assets.ts";
import {
  InventoryResolverManifest,
  Observation,
  ObservationValue,
  SnapshotReference,
} from "./observations";

const descriptor = {
  kind: "token",
  schema_version: "courtyard-2",
  chain_id: "eip155:137",
  asset_id: "eip155:137/erc721:0xcontract/42",
  contract_address: "0xcontract",
  token_id: "42",
  normalized_match: "collection:watch",
  match_semantics: "exact",
} as const;

describe("verification observations", () => {
  test("carry chain, aggregation, snapshot, trust, and response provenance", () => {
    const observation = Schema.decodeUnknownSync(Observation)({
      id: "observation-1",
      resolver_id: "courtyard",
      source_id: "courtyard-response-1",
      claim_id: "asset.ownership",
      subject_ref: "wallet:0xowner",
      value: {
        kind: "asset_inventory",
        chain_id: "eip155:137",
        account_id: "eip155:137:0xowner",
        asset_id: "eip155:137/erc721:0xcontract/42",
        quantity: "1",
        descriptor,
      },
      completeness: "complete",
      trust_mode: "provider_asserted",
      aggregation_mode: "sum_across_wallets",
      snapshot_ref: { kind: "provider_snapshot", reference: "courtyard:response-1" },
      source_response_hash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      descriptor_version: "courtyard-2",
      observed_at: "2026-08-17T00:00:00.000Z",
      expires_at: "2026-08-18T00:00:00.000Z",
    });

    expect(observation.value.kind).toBe("asset_inventory");
    expect(observation.aggregation_mode).toBe("sum_across_wallets");
    expect(observation.snapshot_ref.reference).toBe("courtyard:response-1");
    expect(observation.source_response_hash).toBe(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
    expect(observation.expires_at).toBe("2026-08-18T00:00:00.000Z");
  });

  test("freezes descriptor semantics as normalized, versioned data", () => {
    expect(Schema.decodeUnknownSync(AssetDescriptor)(descriptor)).toEqual(descriptor);
    expect(() =>
      Schema.decodeUnknownSync(AssetDescriptor)({
        ...descriptor,
        schema_version: "",
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(AssetDescriptor)({
        ...descriptor,
        kind: "collection",
        asset_id: "eip155:137/erc721:0xcontract",
        token_id: undefined,
      }),
    ).toMatchObject({ kind: "collection" });
    expect(() =>
      Schema.decodeUnknownSync(AssetDescriptor)({
        ...descriptor,
        token_id: "01",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AssetDescriptor)({
        ...descriptor,
        normalized_match: undefined,
      }),
    ).toThrow();
  });

  test("supports wallet balances without assuming inventory semantics", () => {
    const value = Schema.decodeUnknownSync(ObservationValue)({
      kind: "asset_balance",
      chain_id: "eip155:8453",
      account_id: "eip155:8453:0xowner",
      asset_id: "eip155:8453/erc20:0xusdc",
      amount_atomic: "1000000",
      asset_decimals: "6",
    });
    expect(value.kind).toBe("asset_balance");
    if (value.kind !== "asset_balance") throw new Error("expected asset balance observation");
    expect(value.chain_id).toBe("eip155:8453");
    expect(value.asset_id).toBe("eip155:8453/erc20:0xusdc");
    for (const amount_atomic of ["-1", "01", "1.0", "1e6"]) {
      expect(() =>
        Schema.decodeUnknownSync(ObservationValue)({
          kind: "asset_balance",
          chain_id: "eip155:8453",
          account_id: "eip155:8453:0xowner",
          asset_id: "eip155:8453/erc20:0xusdc",
          amount_atomic,
          asset_decimals: "6",
        }),
      ).toThrow();
    }
    for (const asset_decimals of [6, "01", "256"]) {
      expect(() =>
        Schema.decodeUnknownSync(ObservationValue)({
          kind: "asset_balance",
          chain_id: "eip155:8453",
          account_id: "eip155:8453:0xowner",
          asset_id: "eip155:8453/erc20:0xusdc",
          amount_atomic: "1",
          asset_decimals,
        }),
      ).toThrow();
    }
  });

  test("rejects inventory observations whose frozen descriptor identity drifts", () => {
    const base = {
      id: "observation-1",
      resolver_id: "courtyard",
      source_id: "response-1",
      claim_id: "asset.ownership",
      subject_ref: "wallet:0xowner",
      value: {
        kind: "asset_inventory",
        chain_id: "eip155:137",
        account_id: "eip155:137:0xowner",
        asset_id: descriptor.asset_id,
        quantity: "1",
        descriptor,
      },
      completeness: "complete",
      trust_mode: "provider_asserted",
      aggregation_mode: "single_wallet",
      snapshot_ref: { kind: "provider_snapshot", reference: "response-1" },
      source_response_hash: "f".repeat(64),
      descriptor_version: descriptor.schema_version,
      observed_at: "2026-08-17T00:00:00.000Z",
    } as const;
    expect(Schema.decodeUnknownSync(Observation)(base).id).toBe(base.id);
    for (const candidate of [
      { ...base, descriptor_version: "other" },
      { ...base, value: { ...base.value, asset_id: "eip155:137/erc721:0xother/42" } },
      { ...base, value: { ...base.value, chain_id: "eip155:1" } },
    ]) {
      expect(() => Schema.decodeUnknownSync(Observation)(candidate)).toThrow();
    }
  });

  test("accepts provider-local resolver manifests without a closed resolver enum", () => {
    const manifest = Schema.decodeUnknownSync(InventoryResolverManifest)({
      resolver_id: "future.inventory",
      manifest_version: "1",
      supported_observation_kinds: ["asset_inventory"],
      supported_chain_ids: ["eip155:999999"],
      trust_modes: ["onchain_pinned", "provider_asserted"],
    });
    expect(manifest.resolver_id).toBe("future.inventory");
    expect(manifest.supported_observation_kinds).toEqual(["asset_inventory"]);
    expect(manifest.supported_chain_ids).toEqual(["eip155:999999"]);
    expect(manifest.trust_modes).toEqual(["onchain_pinned", "provider_asserted"]);
  });

  test("requires an explicit snapshot reference", () => {
    expect(
      Schema.decodeUnknownSync(SnapshotReference)({
        kind: "block",
        reference: "base:123",
      }),
    ).toEqual({ kind: "block", reference: "base:123" });
    expect(() => Schema.decodeUnknownSync(SnapshotReference)({ kind: "block" })).toThrow();
  });
});
