export type TranslationOriginV1 = "machine" | "human";

export type ContentTranslationPolicyV1 = "none" | "human_only" | "machine_allowed" | "hybrid";

export type TranslationSourceIdentityV1 = Readonly<{
  sourceUnitKind: "post" | "comment" | "community_text" | "lyric_line";
  sourceUnitId: string;
  fieldKey: string;
  sourceRevision: number;
  sourceHash: string;
  targetLanguage: string;
  translationPolicyVersion: string;
}>;

export type TranslationCommitLeaseV1 = Readonly<{
  status: "pending" | "leased" | "succeeded" | "failed" | "stale" | "policy_blocked";
  leaseToken: string | null;
  leaseExpiresAtMs: number | null;
}>;

export type TranslationCommitAuthoritySnapshotV1 = TranslationSourceIdentityV1 &
  Readonly<{
    moderationState: "allow" | "block";
    authorPolicy: ContentTranslationPolicyV1;
    rightsState: "not_required" | "allowed" | "blocked";
  }>;

export type TranslationCommitStaleReasonV1 =
  | "job_not_leased"
  | "lease_mismatch"
  | "lease_expired"
  | "source_identity_changed"
  | "target_language_changed"
  | "translation_policy_changed"
  | "moderation_state_changed"
  | "author_policy_changed"
  | "rights_state_changed"
  | "moderation_blocked"
  | "author_policy_blocked"
  | "rights_blocked";

export type TranslationCommitDecisionV1 =
  | Readonly<{ _tag: "commit" }>
  | Readonly<{ _tag: "stale"; reason: TranslationCommitStaleReasonV1 }>;

const sameSourceIdentity = (
  expected: TranslationSourceIdentityV1,
  current: TranslationCommitAuthoritySnapshotV1,
): boolean =>
  expected.sourceUnitKind === current.sourceUnitKind &&
  expected.sourceUnitId === current.sourceUnitId &&
  expected.fieldKey === current.fieldKey &&
  expected.sourceRevision === current.sourceRevision &&
  expected.sourceHash === current.sourceHash;

const authorPolicyAllows = (
  policy: ContentTranslationPolicyV1,
  origin: TranslationOriginV1,
): boolean =>
  policy === "hybrid" ||
  (policy === "human_only" && origin === "human") ||
  policy === "machine_allowed";

export const decideTranslationCommitV1 = (input: {
  expected: TranslationCommitAuthoritySnapshotV1;
  current: TranslationCommitAuthoritySnapshotV1;
  lease: TranslationCommitLeaseV1;
  submittedLeaseToken: string;
  nowMs: number;
  origin: TranslationOriginV1;
}): TranslationCommitDecisionV1 => {
  if (input.lease.status !== "leased") return { _tag: "stale", reason: "job_not_leased" };
  if (input.lease.leaseToken === null || input.lease.leaseToken !== input.submittedLeaseToken) {
    return { _tag: "stale", reason: "lease_mismatch" };
  }
  if (input.lease.leaseExpiresAtMs === null || input.lease.leaseExpiresAtMs <= input.nowMs) {
    return { _tag: "stale", reason: "lease_expired" };
  }
  if (!sameSourceIdentity(input.expected, input.current)) {
    return { _tag: "stale", reason: "source_identity_changed" };
  }
  if (input.expected.targetLanguage !== input.current.targetLanguage) {
    return { _tag: "stale", reason: "target_language_changed" };
  }
  if (input.expected.translationPolicyVersion !== input.current.translationPolicyVersion) {
    return { _tag: "stale", reason: "translation_policy_changed" };
  }
  if (input.expected.moderationState !== input.current.moderationState) {
    return { _tag: "stale", reason: "moderation_state_changed" };
  }
  if (input.expected.authorPolicy !== input.current.authorPolicy) {
    return { _tag: "stale", reason: "author_policy_changed" };
  }
  if (input.expected.rightsState !== input.current.rightsState) {
    return { _tag: "stale", reason: "rights_state_changed" };
  }
  if (input.current.moderationState !== "allow") {
    return { _tag: "stale", reason: "moderation_blocked" };
  }
  if (!authorPolicyAllows(input.current.authorPolicy, input.origin)) {
    return { _tag: "stale", reason: "author_policy_blocked" };
  }
  if (
    input.current.rightsState === "blocked" ||
    (input.current.sourceUnitKind === "lyric_line" && input.current.rightsState !== "allowed")
  ) {
    return { _tag: "stale", reason: "rights_blocked" };
  }
  return { _tag: "commit" };
};
