import assert from "node:assert/strict";
import {
  buildHnsRootImportPublishPlanV1,
  type HnsChainObservationV1,
  type HnsRootDelegationDsV1,
  hnsObservedResourceMatchesEncodedPlanV1,
  hsdSafeCommitmentHeightV1,
} from "@pirate/application/namespace-ownership";
import { makeHsdRootResourceObserver } from "@pirate/platform-cf/namespace-ownership-hns-root-resource-observer";
import { Schema } from "effect";
import {
  hsdRegtestAuthorization,
  hsdRegtestGenesis,
  hsdRegtestNode,
  hsdRegtestNodeUrl,
  hsdRegtestWallet,
  hsdRegtestWalletUrl,
  requireHsdRegtestChain,
} from "../../../../packages/platform-cf/src/hns-regtest-node.pg-fixture.ts";

const Ds = Schema.Struct({
  type: Schema.Literal("DS"),
  keyTag: Schema.Number,
  algorithm: Schema.Number,
  digestType: Schema.Literals([2, 4]),
  digest: Schema.String,
});
const Update = Schema.Struct({
  hash: Schema.String,
  outputs: Schema.Array(Schema.Struct({ covenant: Schema.Struct({ action: Schema.String }) })),
});

export async function observedFixtureDs(
  observation: HnsChainObservationV1,
  expectedDigest: string,
): Promise<readonly HnsRootDelegationDsV1[]> {
  assert.equal(observation.view, "safe", "DNS trust requires the safe view");
  assert.equal(observation.network, "regtest");
  assert.equal(observation.genesis_block_hash, hsdRegtestGenesis);
  assert.ok(
    await hnsObservedResourceMatchesEncodedPlanV1(observation.records, expectedDigest),
    "Observed whole resource differs from plan",
  );
  assert.ok(observation.commitment, "Missing selected safe commitment");
  assert.equal(observation.anchor.height, observation.tip_height);
  assert.equal(observation.commitment.tip_height, observation.tip_height);
  assert.equal(observation.commitment.selection_basis, "hsd_getsaferoot_compatible");
  assert.equal(observation.commitment.tree_interval_blocks, 5);
  assert.equal(observation.commitment.minimum_confirmations, 12);
  assert.equal(
    observation.commitment.commitment_height,
    hsdSafeCommitmentHeightV1(observation.tip_height, 5, 12),
  );
  const ds = observation.records
    .filter((record) => record.type === "DS")
    .map((record) => {
      const value = Schema.decodeUnknownSync(Ds)(record);
      return {
        key_tag: value.keyTag,
        algorithm: value.algorithm,
        digest_type: value.digestType,
        digest: value.digest,
      };
    });
  assert.ok(ds.length > 0, "Chain resource has no DS anchor");
  return ds;
}

export async function publishFixtureResource(
  root: string,
  challenge: string,
  ds: readonly HnsRootDelegationDsV1[],
) {
  await requireHsdRegtestChain();
  // getwalletinfo has no network field. Read the existing public receive address
  // before allocating an address or sending any wallet mutation.
  const response = await fetch(new URL("wallet/primary/account/default", hsdRegtestWalletUrl), {
    headers: { authorization: hsdRegtestAuthorization },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(response.ok, "Regtest wallet account read failed");
  const account = Schema.decodeUnknownSync(Schema.Struct({ receiveAddress: Schema.String }))(
    await response.json(),
  );
  assert.ok(account.receiveAddress.startsWith("rs1"), "Refuse a non-regtest wallet");
  const address = Schema.decodeUnknownSync(Schema.String)(await hsdRegtestWallet("getnewaddress"));
  assert.ok(address.startsWith("rs1"));
  const mine = (count: number) => hsdRegtestNode("generatetoaddress", [count, address]);
  const observe = makeHsdRootResourceObserver({
    rpc_url: hsdRegtestNodeUrl,
    authorization: hsdRegtestAuthorization,
    chain_network: "regtest",
    genesis_block_hash: hsdRegtestGenesis,
    tree_interval_blocks: 5,
    safe_minimum_confirmations: 12,
    maximum_tip_age_seconds: 86_400,
    maximum_future_tip_seconds: 3600,
  });
  await mine(120);
  await hsdRegtestWallet("sendopen", [root]);
  await mine(8);
  await hsdRegtestWallet("sendbid", [root, 5, 10]);
  await mine(6);
  await hsdRegtestWallet("sendreveal", [root]);
  await mine(12);
  // Registration is not UPDATE. Establish R0 first, then require an actual UPDATE.
  await hsdRegtestWallet("sendupdate", [root, { records: [] }]);
  await mine(10);
  const before = await observe(root, "current");
  assert.equal(before.kind, "observed");
  if (before.kind !== "observed") throw new Error("Registered fixture is unobservable");
  const plan = await buildHnsRootImportPublishPlanV1({
    current_records: before.observation.records,
    challenge_txt_value: challenge,
    ds_records: ds,
  });
  const update = Schema.decodeUnknownSync(Update)(
    await hsdRegtestWallet("sendupdate", [root, { records: plan.replacement_records }]),
  );
  assert.ok(
    update.outputs.some((output) => output.covenant.action === "UPDATE"),
    "Expected an UPDATE covenant, not registration",
  );
  await mine(1);
  const current = await observe(root, "current");
  assert.equal(current.kind, "observed");
  if (current.kind !== "observed") throw new Error("Current resource unavailable");
  assert.ok(
    await hnsObservedResourceMatchesEncodedPlanV1(
      current.observation.records,
      plan.encoded_resource_sha256,
    ),
  );
  const earlySafe = await observe(root, "safe");
  assert.ok(
    earlySafe.kind !== "observed" ||
      !(await hnsObservedResourceMatchesEncodedPlanV1(
        earlySafe.observation.records,
        plan.encoded_resource_sha256,
      )),
    "Current inclusion must not stand in for safe evidence",
  );
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await mine(5);
    const safe = await observe(root, "safe");
    if (
      safe.kind !== "observed" ||
      !(await hnsObservedResourceMatchesEncodedPlanV1(
        safe.observation.records,
        plan.encoded_resource_sha256,
      ))
    )
      continue;
    return {
      ds: await observedFixtureDs(safe.observation, plan.encoded_resource_sha256),
      receipt: {
        network: "regtest",
        genesis: hsdRegtestGenesis,
        txid: update.hash,
        current_height: current.observation.tip_height,
        safe_height: safe.observation.tip_height,
        commitment: safe.observation.commitment,
        encoded_resource_sha256: plan.encoded_resource_sha256,
      },
    };
  }
  throw new Error("Regtest resource did not reach the maintained safe observation");
}
