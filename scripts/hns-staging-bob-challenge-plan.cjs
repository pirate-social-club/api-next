"use strict";

const { createHash } = require("node:crypto");

const ROOT = "8s28";
const SERVERS = [
  { type: "NS", ns: "ns1.8s28." },
  { type: "NS", ns: "ns2.8s28." },
  { type: "GLUE4", ns: "ns1.8s28.", address: "81.15.150.167" },
  { type: "GLUE4", ns: "ns2.8s28.", address: "94.103.168.209" },
];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function refuse(reason) {
  throw new Error("hns_bob_challenge_plan_refused:" + reason);
}

function challenge(record) {
  if (record?.type !== "TXT" || !Array.isArray(record.txt) || record.txt.length !== 1) return null;
  const value = record.txt[0];
  return typeof value === "string" && /^pirate-verification=[a-z0-9_-]+$/u.test(value)
    ? value
    : null;
}

function validateChallengeOnlyPlan(session, planBytes, plan, now = Date.now()) {
  if (session?.root !== ROOT
    || typeof session.sessionId !== "string"
    || session.planSha256 !== digest(planBytes)
    || !Number.isFinite(Date.parse(session.publicationDeadline))
    || now >= Date.parse(session.publicationDeadline)) {
    refuse("session_identity_or_deadline");
  }
  if (plan?.version !== "pirate-hns-root-import-publish-plan-v1"
    || plan.replacement_semantics !== "complete_resource"
    || plan.acknowledgement_required !== true
    || !Array.isArray(plan.current_records)
    || !Array.isArray(plan.preserved_records)
    || !Array.isArray(plan.removed_conflicts)
    || !Array.isArray(plan.added_records)
    || !Array.isArray(plan.replacement_records)) {
    refuse("publish_plan_shape");
  }
  const oldChallenges = plan.current_records.filter((record) => challenge(record) !== null);
  if (oldChallenges.length !== 1 || plan.added_records.length !== 1
    || challenge(plan.added_records[0]) === null
    || challenge(oldChallenges[0]) === challenge(plan.added_records[0])
    || !equal(plan.removed_conflicts, oldChallenges)) {
    refuse("not_one_challenge_swap");
  }
  const unchanged = plan.current_records.filter((record) => challenge(record) === null);
  if (!equal(plan.preserved_records, unchanged)
    || !equal(plan.replacement_records, [...unchanged, plan.added_records[0]])) {
    refuse("unrelated_record_changed");
  }
  for (const expected of SERVERS) {
    if (unchanged.filter((record) => equal(record, expected)).length !== 1) {
      refuse("staging_delegation_changed");
    }
  }
  if (unchanged.filter((record) => record?.type === "NS").length !== 2
    || unchanged.filter((record) => record?.type === "GLUE4" || record?.type === "GLUE6").length !== 2) {
    refuse("staging_delegation_changed");
  }
  const ds = unchanged.filter((record) => record?.type === "DS");
  if (ds.length !== 2
    || ds[0]?.keyTag !== ds[1]?.keyTag
    || ds[0]?.algorithm !== ds[1]?.algorithm
    || !equal(ds.map((record) => record.digestType).sort(), [2, 4])) {
    refuse("staging_ds_changed");
  }
  if (typeof plan.encoded_resource_sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(plan.encoded_resource_sha256)) {
    refuse("encoded_resource_digest");
  }
  return Object.freeze({
    root: ROOT,
    oldChallenge: challenge(oldChallenges[0]),
    newChallenge: challenge(plan.added_records[0]),
    currentRecords: plan.current_records,
    replacementRecords: plan.replacement_records,
    planSha256: session.planSha256,
    sessionId: session.sessionId,
    publicationDeadline: session.publicationDeadline,
    encodedResourceSha256: plan.encoded_resource_sha256,
  });
}

module.exports = { digest, equal, validateChallengeOnlyPlan };
