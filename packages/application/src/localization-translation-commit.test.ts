import { describe, expect, test } from "bun:test";
import {
  decideTranslationCommitV1,
  type TranslationCommitAuthoritySnapshotV1,
  type TranslationCommitLeaseV1,
  type TranslationSourceIdentityV1,
} from "./localization-translation-commit";

const sourceIdentity: TranslationSourceIdentityV1 = {
  sourceUnitKind: "post",
  sourceUnitId: "post_1",
  fieldKey: "body",
  sourceRevision: 2,
  sourceHash: "a".repeat(64),
  targetLanguage: "es",
  translationPolicyVersion: "translation-policy-v1",
};

const current: TranslationCommitAuthoritySnapshotV1 = {
  ...sourceIdentity,
  moderationState: "allow",
  authorPolicy: "machine_allowed",
  rightsState: "not_required",
};

const expected = current;

const lease: TranslationCommitLeaseV1 = {
  status: "leased",
  leaseToken: "lease_1",
  leaseExpiresAtMs: 2_000,
};

const decide = (overrides: Partial<Parameters<typeof decideTranslationCommitV1>[0]> = {}) =>
  decideTranslationCommitV1({
    expected,
    current,
    lease,
    submittedLeaseToken: "lease_1",
    nowMs: 1_000,
    origin: "machine",
    ...overrides,
  });

describe("translation commit stale-write fence", () => {
  test("commits only an exact, live, policy-authorized lease", () => {
    expect(decide()).toEqual({ _tag: "commit" });
  });

  test.each([
    ["terminal replay", { lease: { ...lease, status: "succeeded" as const } }, "job_not_leased"],
    ["wrong lease", { submittedLeaseToken: "lease_other" }, "lease_mismatch"],
    ["expired lease", { nowMs: 2_000 }, "lease_expired"],
    [
      "changed source hash",
      { current: { ...current, sourceHash: "b".repeat(64) } },
      "source_identity_changed",
    ],
    [
      "changed target",
      { current: { ...current, targetLanguage: "fr" } },
      "target_language_changed",
    ],
    [
      "changed policy revision",
      { current: { ...current, translationPolicyVersion: "translation-policy-v2" } },
      "translation_policy_changed",
    ],
    [
      "changed moderation state",
      { current: { ...current, moderationState: "block" as const } },
      "moderation_state_changed",
    ],
    [
      "changed author policy",
      { current: { ...current, authorPolicy: "human_only" as const } },
      "author_policy_changed",
    ],
    [
      "changed rights state",
      { current: { ...current, rightsState: "blocked" as const } },
      "rights_state_changed",
    ],
  ] as const)("rejects %s as stale", (_label, overrides, reason) => {
    expect(decide(overrides)).toEqual({ _tag: "stale", reason });
  });

  test("allows a human result under human-only policy", () => {
    expect(
      decide({
        origin: "human",
        expected: { ...expected, authorPolicy: "human_only" },
        current: { ...current, authorPolicy: "human_only" },
      }),
    ).toEqual({ _tag: "commit" });
  });

  test.each([
    ["blocked moderation", { ...current, moderationState: "block" as const }, "moderation_blocked"],
    ["none author policy", { ...current, authorPolicy: "none" as const }, "author_policy_blocked"],
    ["blocked rights", { ...current, rightsState: "blocked" as const }, "rights_blocked"],
  ] as const)("rejects a dispatch snapshot with %s", (_label, snapshot, reason) => {
    expect(decide({ expected: snapshot, current: snapshot })).toEqual({ _tag: "stale", reason });
  });

  test("requires an explicit allowed rights snapshot for lyric lines", () => {
    const lyric = { ...current, sourceUnitKind: "lyric_line" as const };
    expect(decide({ expected: lyric, current: lyric })).toEqual({
      _tag: "stale",
      reason: "rights_blocked",
    });
  });
});
