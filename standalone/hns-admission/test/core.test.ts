import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, type State } from "../src/ceremony.ts";
import {
  safeEntryHeight,
  agree,
  type Observation,
} from "../src/observation.ts";
import {
  delegationRecord,
  challengeRecord,
  preflight,
  parseDelegation,
} from "../src/records.ts";
import {
  bindingDigest,
  consentHash,
  challengeDigest,
  type Binding,
} from "../src/protocol.ts";
import { hash, address, binding, state, observation } from "./fixtures.ts";
const delegation = {
  chainId: 6343,
  registry: address,
  controller: address,
  communityId: hash,
};
const expected = {
  ...delegation,
  network: "regtest",
  genesis: hash,
  challenge: challengeRecord(hash),
  resourceDigest: hash,
  ownershipEpoch: hash,
};
test("mature proof survives consent expiry and late publication observations retain the valid window", () => {
  let s = advance(state(), { type: "Consent", now: 1, deadline: 259200 });
  s = advance(s, {
    type: "Observed",
    now: 10000,
    includedAt: 1000,
    ownershipEpoch: hash,
    safe: true,
    transferPending: false,
  });
  s = advance(s, { type: "Tick", now: 259200 });
  assert.equal(s.phase, "AwaitingConsent");
  assert.equal(s.maturedAt, 10000);
  s = advance(s, { type: "Consent", now: 259201, deadline: 400000 });
  assert.equal(s.consented, true);
  const unavailable = advance(state(), { type: "Tick", now: 180000 });
  assert.equal(unavailable.phase, "Expired");
  const recovered = advance(unavailable, {
    type: "Observed",
    now: 180001,
    includedAt: 162000,
    ownershipEpoch: hash,
    safe: true,
    transferPending: false,
  });
  assert.equal(recovered.phase, "AwaitingConsent"); // publication was timely; consent has not yet been supplied.
  assert.equal(recovered.firstIncludedAt, 162000);
});
test("canonical record size and malformed alternate encoding", () => {
  const record = delegationRecord(delegation);
  assert.equal(record.length, 106);
  assert.equal(challengeRecord(hash).length, 47);
  assert.deepEqual(parseDelegation(record), delegation);
  assert.throws(() => parseDelegation(record + "="));
  assert.throws(() => delegationRecord({ ...delegation, chainId: 4294967296 }));
});
test("whole-resource overflow refuses instructions and retains existing records", async () => {
  const existing = [{ type: "TXT", txt: ["a".repeat(250), "b".repeat(150)] }];
  await assert.rejects(
    () => preflight(existing, delegation, hash),
    /resource_too_large/,
  );
  assert.equal(existing.length, 1);
  await assert.rejects(
    () =>
      preflight(
        [{ type: "TXT", txt: [challengeRecord(hash)] }],
        delegation,
        hash,
      ),
    /delegation_conflict/,
  );
});
test("literal mainnet boundary expectations include both sides of the 12-block branch", () => {
  for (const [height, expected] of [
    [35, 35],
    [36, 36],
    [37, 36],
    [47, 36],
    [48, 48],
    [71, 71],
    [72, 72],
    [73, 72],
    [83, 72],
    [84, 84],
  ])
    assert.equal(safeEntryHeight(height, 36), expected);
  assert.equal(safeEntryHeight(14, 5), 10);
});
test("disagreement, missing observers and matching older tips remain unavailable", () => {
  const a = observation();
  assert.deepEqual(
    agree(a, { ...a, tipHash: "0x" + "33".repeat(32) }, 1000, expected),
    { status: "unavailable", reason: "observer_disagreement" },
  );
  assert.equal(agree(a, null, 1000, expected).status, "unavailable");
  assert.equal(
    agree({ ...a, tipTime: 0 }, { ...a, tipTime: 0 }, 1000, expected).status,
    "verified",
  );
  assert.deepEqual(
    agree(
      { ...a, tipTime: 0, fetchedAt: 22000 },
      { ...a, tipTime: 0, fetchedAt: 22000 },
      22000,
      expected,
    ),
    { status: "unavailable", reason: "chain_freshness_unconfirmed" },
  );
});
test("pending transfer, ownership change and safe-root maturity have distinct outcomes", () => {
  const a = observation();
  assert.deepEqual(
    agree(
      { ...a, transferPending: true },
      { ...a, transferPending: true },
      1000,
      expected,
    ),
    { status: "waiting", reason: "transfer_pending" },
  );
  assert.deepEqual(
    agree(a, a, 1000, { ...expected, ownershipEpoch: "0x" + "33".repeat(32) }),
    { status: "denied", reason: "ownership_changed" },
  );
  assert.equal(
    agree(
      { ...a, inclusionHeight: 49 },
      { ...a, inclusionHeight: 49 },
      1000,
      expected,
    ).status,
    "waiting",
  );
});
test("publication at hour 45 gets a separate maturity window", () => {
  let s = advance(state(), { type: "Consent", now: 1, deadline: 259200 });
  s = advance(s, {
    type: "Observed",
    now: 162000,
    includedAt: 162000,
    ownershipEpoch: hash,
    safe: false,
    transferPending: false,
  });
  s = advance(s, { type: "Tick", now: 180000 });
  assert.equal(s.phase, "Maturing");
  s = advance(s, {
    type: "Observed",
    now: 190000,
    includedAt: 162000,
    ownershipEpoch: hash,
    safe: true,
    transferPending: false,
  });
  assert.equal(s.phase, "ReadyToSubmit");
  assert.equal(s.condition, "submission_not_enabled");
});
test("outages never suppress expiry, cancellation, or authority change", () => {
  let s = advance(state(), {
    type: "Unavailable",
    now: 100,
    reason: "observer_timeout",
  });
  assert.equal(s.phase, "AwaitingConsent");
  assert.equal(advance(s, { type: "Tick", now: 172800 }).phase, "Expired");
  assert.equal(advance(s, { type: "Cancel", now: 101 }).phase, "Cancelled");
  assert.equal(
    advance(s, {
      type: "Observed",
      now: 102,
      includedAt: 100,
      ownershipEpoch: "0x" + "33".repeat(32),
      safe: true,
      transferPending: false,
    }).phase,
    "Suspended",
  );
});
test("a slightly future-dated canonical inclusion waits without expiring the ceremony", () => {
  const s = advance(state(), {
    type: "Observed",
    now: 100,
    includedAt: 111,
    ownershipEpoch: hash,
    safe: true,
    transferPending: false,
  });
  assert.equal(s.phase, "AwaitingConsent");
  assert.equal(s.condition, "observer_stale");
  let nearDeadline = advance(
    { ...state(), consented: true, phase: "AwaitingPublication" },
    {
      type: "Observed",
      now: 172790,
      includedAt: 172799,
      ownershipEpoch: hash,
      safe: true,
      transferPending: false,
    },
  );
  nearDeadline = advance(nearDeadline, { type: "Tick", now: 172801 });
  assert.equal(nearDeadline.phase, "Maturing");
  assert.equal(nearDeadline.firstIncludedAt, 172799);
});
test("binding and consent domains change for chain, install and expiry", async () => {
  const digest = bindingDigest(binding);
  assert.notEqual(bindingDigest({ ...binding, chainId: 1 }), digest);
  assert.notEqual(
    bindingDigest({ ...binding, installationId: "0x" + "33".repeat(32) }),
    digest,
  );
  const fields = {
    ceremonyId: hash,
    bindingDigest: digest,
    resourceDigest: hash,
    nonce: hash,
    issuedAt: 0,
    deadline: 72,
  };
  assert.notEqual(
    consentHash(binding, fields),
    consentHash(binding, { ...fields, deadline: 73 }),
  );
  assert.equal((await challengeDigest(hash, digest, hash, 172800)).length, 66);
});
