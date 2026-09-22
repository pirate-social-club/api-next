import { expect, test } from "bun:test";
import {
  type HnsChainObservationV1,
  hnsChainResourceDigestV1,
  preflightEncodeHnsResourceV1,
} from "@pirate/application/namespace-ownership";
import { observedFixtureDs } from "./chain.ts";

async function observation(): Promise<{ value: HnsChainObservationV1; digest: string }> {
  const genesis = "ae3895cf597eff05b19e02a70ceeeecb9dc72dbfe6504a50e9343a72f06a87c5";
  const records = [
    { type: "NS", ns: "ns1.pirate." },
    { type: "DS", keyTag: 12, algorithm: 13, digestType: 2, digest: "ab".repeat(32) },
  ];
  return {
    digest: (await preflightEncodeHnsResourceV1(records)).sha256,
    value: {
      view: "safe",
      network: "regtest",
      genesis_block_hash: genesis,
      anchor: {
        network: "regtest",
        genesis_block_hash: genesis,
        height: 170,
        best_block_hash: "cd".repeat(32),
        median_time_past_epoch_seconds: 100,
        header_time_epoch_seconds: 101,
        confirmations: 1,
      },
      tip_height: 170,
      update_inclusion_height: null,
      observed_at_epoch_ms: 102000,
      commitment: {
        selection_basis: "hsd_getsaferoot_compatible",
        commitment_height: 170,
        commitment_block_hash: "cd".repeat(32),
        commitment_tree_root: "ef".repeat(32),
        tip_height: 170,
        tree_interval_blocks: 5,
        minimum_confirmations: 12,
      },
      records,
      resource_sha256: await hnsChainResourceDigestV1(records),
    },
  };
}

test("DS comes from the matching complete safe resource", async () => {
  const { value, digest } = await observation();
  expect(await observedFixtureDs(value, digest)).toEqual([
    { key_tag: 12, algorithm: 13, digest_type: 2, digest: "ab".repeat(32) },
  ]);
});

test("current-only, wrong network/genesis, resource drift and absent commitment refuse", async () => {
  const { value, digest } = await observation();
  for (const drift of [
    { view: "current" as const },
    { network: "main" },
    { genesis_block_hash: "00".repeat(32) },
    { records: [] },
    { commitment: null },
  ])
    await expect(observedFixtureDs({ ...value, ...drift }, digest)).rejects.toThrow();
  await expect(observedFixtureDs(value, "00".repeat(32))).rejects.toThrow();
});

test("incorrect safe selection refuses even if records match", async () => {
  const { value, digest } = await observation();
  if (!value.commitment) throw new Error("Fixture missing commitment");
  await expect(
    observedFixtureDs(
      { ...value, commitment: { ...value.commitment, commitment_height: 165 } },
      digest,
    ),
  ).rejects.toThrow();
});
