import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type HnsChainObservationResultV1,
  preflightEncodeHnsResourceV1,
} from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import { observeProvisionalSafeOwnership } from "./provisional-safe-ownership.ts";

const now = 1_790_000_000_000;
const records = [
  { type: "NS", ns: "ns1.staging." },
  { type: "TXT", txt: ["pirate-verification=", "proof-token"] },
];
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
test("freshness is checked after the asynchronous chain observation completes", async () => {
  const { context, observation } = await fixture();
  await expect(
    observeProvisionalSafeOwnership(context, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        kind: "observed",
        observation: { ...observation, observed_at_epoch_ms: Date.now() },
      };
    }),
  ).resolves.toBeDefined();
});
async function fixture() {
  const plan = await preflightEncodeHnsResourceV1(records);
  const context = {
    root_import_session_id: "import-test",
    namespace_session_id: "namespace-test",
    root_label: "testroot",
    challenge_txt_value: "pirate-verification=proof-token",
    publish_plan_sha256: "a".repeat(64),
    plan_encoded_resource_sha256: plan.sha256,
    lifecycle_revision: 3,
    generation: 1,
  };
  const observation = {
    view: "safe" as const,
    network: "regtest",
    genesis_block_hash: "b".repeat(64),
    anchor: {
      network: "regtest",
      genesis_block_hash: "b".repeat(64),
      height: 120,
      best_block_hash: "c".repeat(64),
      median_time_past_epoch_seconds: now / 1000,
      header_time_epoch_seconds: now / 1000,
      confirmations: 12,
    },
    tip_height: 120,
    update_inclusion_height: 105,
    commitment: {
      selection_basis: "hsd_getsaferoot_compatible" as const,
      commitment_height: 108,
      commitment_block_hash: "d".repeat(64),
      commitment_tree_root: "e".repeat(64),
      tip_height: 120,
      tree_interval_blocks: 36,
      minimum_confirmations: 12,
    },
    observed_at_epoch_ms: now,
    records,
    resource_sha256: hash(canonicalJson(records)),
  };
  return { context, observation };
}

test("retains exact safe TXT, including chunks, with session, plan and generation binding", async () => {
  const { context, observation } = await fixture();
  const requested: string[] = [];
  const result = await observeProvisionalSafeOwnership(
    context,
    async (root) => {
      requested.push(root);
      return { kind: "observed", observation };
    },
    now,
  );
  expect(requested).toEqual(["testroot"]);
  const proof = JSON.parse(new TextDecoder().decode(result.proof_bytes));
  expect(proof).toMatchObject({
    version: "pirate-hns-provisional-safe-ownership-v1",
    root_import_session_id: "import-test",
    namespace_session_id: "namespace-test",
    lifecycle_revision: 3,
    generation: 1,
    challenge_value_sha256: hash(context.challenge_txt_value),
    observation: { view: "safe" },
  });
  expect(result.proof_sha256).toBe(hash(new TextDecoder().decode(result.proof_bytes)));
  expect(proof.challenge_txt_value).toBeUndefined();
});

test.each(["current", "missing_commitment", "stale", "future", "corrupt_digest"])(
  "refuses unavailable safe evidence: %s",
  async (failure) => {
    const { context, observation } = await fixture();
    const changed = {
      ...observation,
      ...(failure === "current" ? { view: "current" } : {}),
      ...(failure === "missing_commitment" ? { commitment: null } : {}),
      ...(failure === "stale" ? { observed_at_epoch_ms: now - 900_001 } : {}),
      ...(failure === "future" ? { observed_at_epoch_ms: now + 1 } : {}),
      ...(failure === "corrupt_digest" ? { resource_sha256: "f".repeat(64) } : {}),
    };
    await expect(
      observeProvisionalSafeOwnership(
        context,
        async () =>
          ({
            kind: "observed",
            observation: changed,
          }) as HnsChainObservationResultV1,
        now,
      ),
    ).rejects.toThrow("unavailable");
  },
);

test("a matching challenge cannot admit a different complete resource", async () => {
  const { context, observation } = await fixture();
  const changed = [...records, { type: "TXT", txt: ["extra"] }];
  await expect(
    observeProvisionalSafeOwnership(
      context,
      async () => ({
        kind: "observed",
        observation: {
          ...observation,
          records: changed,
          resource_sha256: hash(canonicalJson(changed)),
        },
      }),
      now,
    ),
  ).rejects.toThrow("resource_pending");
});

test("neither absent nor mismatched TXT is proof, even with a matching plan", async () => {
  for (const txt of [[], [{ type: "TXT", txt: ["pirate-verification=other"] }]]) {
    const { context, observation } = await fixture();
    const changed = [{ type: "NS", ns: "ns1.staging." }, ...txt];
    const plan = await preflightEncodeHnsResourceV1(changed);
    await expect(
      observeProvisionalSafeOwnership(
        { ...context, plan_encoded_resource_sha256: plan.sha256 },
        async () => ({
          kind: "observed",
          observation: {
            ...observation,
            records: changed,
            resource_sha256: hash(canonicalJson(changed)),
          },
        }),
        now,
      ),
    ).rejects.toThrow("resource_pending");
  }
});
