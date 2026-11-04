import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { digest, validateChallengeOnlyPlan } = require("./hns-staging-bob-challenge-plan.cjs") as {
  digest: (bytes: Uint8Array) => string;
  validateChallengeOnlyPlan: (
    session: unknown,
    bytes: Uint8Array,
    plan: unknown,
    now: number,
  ) => { readonly newChallenge: string };
};

function fixture() {
  const old = { type: "TXT", txt: ["pirate-verification=old"] };
  const fresh = { type: "TXT", txt: ["pirate-verification=fresh"] };
  const unchanged = [
    { type: "NS", ns: "ns1.8s28." },
    { type: "NS", ns: "ns2.8s28." },
    { type: "GLUE4", ns: "ns1.8s28.", address: "81.15.150.167" },
    { type: "GLUE4", ns: "ns2.8s28.", address: "94.103.168.209" },
    { type: "DS", keyTag: 1, algorithm: 13, digestType: 2, digest: "a".repeat(64) },
    { type: "DS", keyTag: 1, algorithm: 13, digestType: 4, digest: "b".repeat(96) },
    { type: "TXT", txt: ["unrelated=value"] },
  ];
  const plan = {
    version: "pirate-hns-root-import-publish-plan-v1",
    replacement_semantics: "complete_resource",
    acknowledgement_required: true,
    current_records: [...unchanged, old],
    preserved_records: unchanged,
    removed_conflicts: [old],
    added_records: [fresh],
    replacement_records: [...unchanged, fresh],
    encoded_resource_sha256: "c".repeat(64),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  const session = {
    root: "8s28",
    sessionId: "hns-root-import-test",
    planSha256: digest(bytes),
    publicationDeadline: "2026-09-29T00:00:00.000Z",
  };
  return { bytes, plan, session };
}

describe("staging Bob challenge-only publish plan", () => {
  test("accepts one TXT replacement while preserving the signed staging delegation", () => {
    const { bytes, plan, session } = fixture();
    expect(
      validateChallengeOnlyPlan(session, bytes, plan, Date.parse("2026-09-28T12:00:00Z"))
        .newChallenge,
    ).toBe("pirate-verification=fresh");
  });

  test("refuses changed delegation and unrelated records", () => {
    const { bytes, plan, session } = fixture();
    plan.replacement_records[2] = { type: "GLUE4", ns: "ns1.8s28.", address: "127.0.0.1" };
    expect(() =>
      validateChallengeOnlyPlan(session, bytes, plan, Date.parse("2026-09-28T12:00:00Z")),
    ).toThrow("unrelated_record_changed");
  });

  test("refuses extra challenge additions and stale publication", () => {
    const { bytes, plan, session } = fixture();
    plan.added_records.push({ type: "TXT", txt: ["pirate-verification=another"] });
    expect(() =>
      validateChallengeOnlyPlan(session, bytes, plan, Date.parse("2026-09-28T12:00:00Z")),
    ).toThrow("not_one_challenge_swap");
    const fresh = fixture();
    expect(() =>
      validateChallengeOnlyPlan(
        fresh.session,
        fresh.bytes,
        fresh.plan,
        Date.parse("2026-09-29T00:00:00Z"),
      ),
    ).toThrow("session_identity_or_deadline");
  });
});
