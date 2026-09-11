import { expect, test } from "bun:test";
import { hnsChainResourceDigestV1 } from "./hns-chain-observation.ts";
import {
  hnsObservedResourceMatchesEncodedPlanV1,
  preflightEncodeHnsResourceV1,
} from "./hns-resource-codec.ts";

const records = [
  { type: "NS", ns: "ns1.pirate." },
  { type: "TXT", txt: ["pirate-verification=qualification"] },
];

test("qualifies real observed records against wire bytes, not the observation JSON hash", async () => {
  const plan = await preflightEncodeHnsResourceV1(records);
  const jsonDigest = await hnsChainResourceDigestV1(records);
  expect(jsonDigest).not.toBe(plan.sha256);
  expect(await hnsObservedResourceMatchesEncodedPlanV1(records, plan.sha256)).toBe(true);
  expect(await hnsObservedResourceMatchesEncodedPlanV1(records, jsonDigest)).toBe(false);
  expect(
    await hnsObservedResourceMatchesEncodedPlanV1(
      [...records, { type: "TXT", txt: ["changed"] }],
      plan.sha256,
    ),
  ).toBe(false);
});

test("invalid encoding and unknown plan digest remain errors rather than mismatch evidence", async () => {
  const plan = await preflightEncodeHnsResourceV1(records);
  await expect(hnsObservedResourceMatchesEncodedPlanV1(records, "unknown")).rejects.toThrow();
  await expect(
    hnsObservedResourceMatchesEncodedPlanV1([{ type: "NS", ns: "" }], plan.sha256),
  ).rejects.toThrow();
});
