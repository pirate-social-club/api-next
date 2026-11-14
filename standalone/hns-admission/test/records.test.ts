import { test } from "node:test";
import assert from "node:assert/strict";
import {
  preflight,
  delegationRecord,
  routingRecord,
  inspectRecords,
} from "../src/records.ts";
import { binding, hash } from "./fixtures.ts";
test("routing and per-chain delegation coexistence preserve unrelated NS/DS and forbid ambiguous authority", async () => {
  const d = {
    chainId: binding.chainId,
    registry: binding.registry,
    controller: binding.controller,
    communityId: binding.communityId,
  };
  const other = { ...d, chainId: 1 };
  const records = [
    { type: "NS", ns: "ns1.example." },
    { type: "TXT", txt: [delegationRecord(other)] },
  ];
  const plan = await preflight(records, d, hash);
  assert.deepEqual(plan.records.slice(0, records.length), records);
  assert.ok(plan.records.some((r) => r.ns === routingRecord(binding)));
  assert.equal(
    inspectRecords(plan.records, binding).delegation,
    delegationRecord(d),
  );
  assert.throws(
    () => inspectRecords(plan.records, other),
    /delegation_target_inactive/,
  );
  await assert.rejects(
    () =>
      preflight(
        [
          { type: "TXT", txt: [delegationRecord(other)] },
          { type: "TXT", txt: [delegationRecord(other)] },
        ],
        d,
        hash,
      ),
    /delegation_conflict/,
  );
  await assert.rejects(
    () => preflight([{ type: "NS", ns: "bad._evm." }], d, hash),
    /delegation_conflict/,
  );
  await assert.rejects(
    () =>
      preflight(
        [
          { type: "NS", ns: routingRecord(binding) },
          { type: "NS", ns: routingRecord(binding) },
        ],
        d,
        hash,
      ),
    /delegation_conflict/,
  );
  await assert.rejects(
    () =>
      preflight(
        [
          {
            type: "NS",
            ns: routingRecord({ ...binding, registry: "0x" + "33".repeat(20) }),
          },
        ],
        d,
        hash,
      ),
    /delegation_conflict/,
  );
  await assert.rejects(
    () => preflight(plan.records, d, hash),
    /delegation_conflict/,
    "never silently replace another ceremony's freshness challenge",
  );
});
