import type {
  Assertion,
  Assurance,
  CanonicalIsoInstant,
  EvidenceBundle,
  EvidenceReceipt,
  SameSubjectBindingGroup,
  SubjectKey,
} from "../verification/index.ts";
import { sha256Hex } from "./sha256.ts";

export type EvidenceUnavailableReason =
  | "provider_unavailable"
  | "evidence_store_unavailable"
  | "snapshot_unavailable";

/** Evidence availability is explicit; a missing bundle is not a provider failure. */
export type EvidenceAvailability =
  | { readonly kind: "available"; readonly bundle: EvidenceBundle }
  | { readonly kind: "indeterminate"; readonly reason: EvidenceUnavailableReason };

export type GatesV2EvaluationOutcome = "pass" | "fail" | "needs_evidence" | "indeterminate";

export type EvaluatorReason =
  | "policy_invalid"
  | "required_claim_missing"
  | "assertion_invalid"
  | "wrong_assurance"
  | "age_below_threshold"
  | "age_not_canonical"
  | "binding_missing"
  | "binding_mismatch"
  | "binding_invalid"
  | "receipt_missing"
  | "receipt_mismatch"
  | "subject_key_missing"
  | "subject_key_mismatch"
  | "observed_in_future"
  | "evidence_expired"
  | "conflicting_evidence";

export type RequiredClaim = "age.minimum" | "credential.subject_unique" | "document.valid";

export type CuratedAgePolicy = Readonly<{
  readonly policy_version_id: string;
  readonly policy_key: string;
  readonly policy_revision: number;
  readonly policy_hash: string;
  readonly minimum_age: string;
  readonly requirements: readonly [
    Readonly<{ readonly claim_id: "age.minimum"; readonly minimum_age: string }>,
    Readonly<{ readonly claim_id: "credential.subject_unique" }>,
    Readonly<{ readonly claim_id: "document.valid" }>,
  ];
  readonly required_assurance: Assurance;
  readonly co_reference: "same_subject";
  readonly freshness: "unexpired_at_evaluation";
}>;

/**
 * UTF-8 SHA-256 preimage for the reviewed first policy revision. Keys and
 * requirements are deliberately ordered; changing any byte requires a new
 * revision and hash.
 */
export const CURATED_AGE_18_POLICY_CANONICAL_PREIMAGE =
  '{"co_reference":"same_subject","freshness":"unexpired_at_evaluation","minimum_age":"18","policy_key":"curated-age","policy_version_id":"curated-age-v1","required_assurance":"document_zk","requirements":[{"claim_id":"age.minimum","minimum_age":"18"},{"claim_id":"credential.subject_unique"},{"claim_id":"document.valid"}],"revision":1}' as const;

export const CURATED_AGE_18_POLICY: CuratedAgePolicy = {
  policy_version_id: "curated-age-v1",
  policy_key: "curated-age",
  policy_revision: 1,
  policy_hash: "6c2c4bfa0b842cc8afea19d0df3f576fa5d1779162b235d922be6cb3f39f11a0",
  minimum_age: "18",
  requirements: [
    { claim_id: "age.minimum", minimum_age: "18" },
    { claim_id: "credential.subject_unique" },
    { claim_id: "document.valid" },
  ],
  required_assurance: "document_zk",
  co_reference: "same_subject",
  freshness: "unexpired_at_evaluation",
};

export type EvaluatorWitness = Readonly<{
  readonly assertion_ids: readonly string[];
  readonly evidence_receipt_ids: readonly string[];
  readonly subject_key_id: string;
  readonly binding_group_id: string;
}>;

type DecisionMetadata = Readonly<{
  readonly policy_version_id: string;
  readonly policy_revision: number;
  readonly policy_hash: string;
  /** JSON array shape matches decision_records.winning_witness. */
  readonly winning_witness: readonly EvaluatorWitness[];
  /** JSON array shape matches decision_records.trace. */
  readonly trace: readonly string[];
}>;

export type CuratedAgePass = DecisionMetadata & { readonly outcome: "pass" };

export type CuratedAgeFail = DecisionMetadata &
  Readonly<{
    readonly outcome: "fail";
    readonly reason:
      | "policy_invalid"
      | "invalid_evidence"
      | "conflicting_evidence"
      | "age_below_threshold";
    readonly assertion_id?: string;
  }>;

export type CuratedAgeNeedsEvidence = DecisionMetadata &
  Readonly<{
    readonly outcome: "needs_evidence";
    readonly reasons: readonly EvaluatorReason[];
    readonly claim_ids: readonly RequiredClaim[];
  }>;

export type CuratedAgeIndeterminate = DecisionMetadata &
  Readonly<{
    readonly outcome: "indeterminate";
    readonly reason: EvidenceUnavailableReason;
  }>;

export type CuratedAgeEvaluation =
  | CuratedAgePass
  | CuratedAgeFail
  | CuratedAgeNeedsEvidence
  | CuratedAgeIndeterminate;

export type CuratedAgeEvaluatorInput = Readonly<{
  readonly policy: CuratedAgePolicy;
  readonly evidence: EvidenceAvailability;
  readonly now: CanonicalIsoInstant;
}>;

/** Stable age-18 aliases retained while callers move to the policy-driven names. */
export type CuratedAge18Policy = CuratedAgePolicy;
export type CuratedAge18Pass = CuratedAgePass;
export type CuratedAge18Fail = CuratedAgeFail;
export type CuratedAge18NeedsEvidence = CuratedAgeNeedsEvidence;
export type CuratedAge18Indeterminate = CuratedAgeIndeterminate;
export type CuratedAge18Evaluation = CuratedAgeEvaluation;
export type CuratedAge18EvaluatorInput = CuratedAgeEvaluatorInput;

const REQUIRED_CLAIMS = [
  "age.minimum",
  "credential.subject_unique",
  "document.valid",
] as const satisfies readonly RequiredClaim[];
const ASSURANCES = new Set<Assurance>([
  "holder_live",
  "personhood",
  "document_zk",
  "provider_attested",
]);
const UNAVAILABLE_REASONS = new Set<EvidenceUnavailableReason>([
  "provider_unavailable",
  "evidence_store_unavailable",
  "snapshot_unavailable",
]);

function canonicalUnsignedInteger(value: string): bigint | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function policyCanonicalPreimage(policy: CuratedAgePolicy): string {
  return JSON.stringify({
    co_reference: policy.co_reference,
    freshness: policy.freshness,
    minimum_age: policy.minimum_age,
    policy_key: policy.policy_key,
    policy_version_id: policy.policy_version_id,
    required_assurance: policy.required_assurance,
    requirements: [
      {
        claim_id: policy.requirements[0].claim_id,
        minimum_age: policy.requirements[0].minimum_age,
      },
      { claim_id: policy.requirements[1].claim_id },
      { claim_id: policy.requirements[2].claim_id },
    ],
    revision: policy.policy_revision,
  });
}

function validPolicy(policy: CuratedAgePolicy): boolean {
  const threshold = canonicalUnsignedInteger(policy.minimum_age);
  return (
    policy.policy_version_id.trim() === policy.policy_version_id &&
    policy.policy_version_id.length > 0 &&
    policy.policy_key.trim() === policy.policy_key &&
    policy.policy_key.length > 0 &&
    Number.isSafeInteger(policy.policy_revision) &&
    policy.policy_revision > 0 &&
    /^[0-9a-f]{64}$/.test(policy.policy_hash) &&
    threshold !== undefined &&
    threshold > 0n &&
    policy.requirements.length === 3 &&
    policy.requirements[0]?.claim_id === "age.minimum" &&
    policy.requirements[0].minimum_age === policy.minimum_age &&
    policy.requirements[1]?.claim_id === "credential.subject_unique" &&
    policy.requirements[2]?.claim_id === "document.valid" &&
    ASSURANCES.has(policy.required_assurance) &&
    policy.co_reference === "same_subject" &&
    policy.freshness === "unexpired_at_evaluation" &&
    sha256Hex(policyCanonicalPreimage(policy)) === policy.policy_hash
  );
}

function metadata(policy: CuratedAgePolicy, trace: readonly string[]): DecisionMetadata {
  return {
    policy_version_id: policy.policy_version_id,
    policy_revision: policy.policy_revision,
    policy_hash: policy.policy_hash,
    winning_witness: [],
    trace,
  };
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function fail(
  policy: CuratedAgePolicy,
  reason: CuratedAgeFail["reason"],
  trace: readonly string[],
  assertionId?: string,
): CuratedAgeFail {
  return {
    outcome: "fail",
    reason,
    ...metadata(policy, trace),
    ...(assertionId === undefined ? {} : { assertion_id: assertionId }),
  };
}

function needsEvidence(
  policy: CuratedAgePolicy,
  reasons: readonly EvaluatorReason[],
  claimIds: readonly RequiredClaim[],
): CuratedAgeNeedsEvidence {
  const uniqueReasons = sortedUnique(reasons);
  return {
    outcome: "needs_evidence",
    reasons: uniqueReasons,
    claim_ids: REQUIRED_CLAIMS.filter((claimId) => claimIds.includes(claimId)),
    ...metadata(policy, uniqueReasons),
  };
}

function assertionForClaim(
  assertions: readonly Assertion[],
  claimId: RequiredClaim,
): Assertion | undefined {
  return assertions.find((assertion) => assertion.claim_id === claimId);
}

function receiptForAssertion(
  receipts: readonly EvidenceReceipt[],
  assertion: Assertion,
): EvidenceReceipt | undefined {
  return receipts.find((receipt) => receipt.id === assertion.evidence_receipt_id);
}

function subjectKeyForAssertion(
  subjectKeys: readonly SubjectKey[],
  assertion: Assertion,
): SubjectKey | undefined {
  return assertion.subject_key_id == null
    ? undefined
    : subjectKeys.find((subjectKey) => subjectKey.id === assertion.subject_key_id);
}

function sameSubjectBinding(
  evidence: EvidenceBundle,
  assertions: readonly Assertion[],
): SameSubjectBindingGroup | undefined {
  const bindingIds = new Set(assertions.map((assertion) => assertion.binding_group_id));
  if (bindingIds.size !== 1) return undefined;
  const bindingGroupId = assertions[0]?.binding_group_id;
  const binding = evidence.binding_groups.find((group) => group.id === bindingGroupId);
  return binding?.kind === "same_subject" ? binding : undefined;
}

function freshnessReasons(observedAt: string, now: string, expiresAt?: string): EvaluatorReason[] {
  const reasons: EvaluatorReason[] = [];
  if (observedAt > now) reasons.push("observed_in_future");
  if (expiresAt != null && expiresAt <= now) reasons.push("evidence_expired");
  return reasons;
}

function canonicalIsoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sameSubjectScope(
  receiptScope: EvidenceReceipt["scope"],
  subjectScope: SubjectKey["scope"],
): boolean {
  if (
    receiptScope.kind !== "named" ||
    receiptScope.issuer !== subjectScope.issuer ||
    receiptScope.scope_semantics !== subjectScope.scope_semantics ||
    receiptScope.rp_scope !== subjectScope.rp_scope
  )
    return false;
  if (
    receiptScope.scope_semantics === "issuer_rp_action_scope" &&
    subjectScope.scope_semantics === "issuer_rp_action_scope"
  )
    return receiptScope.action_scope === subjectScope.action_scope;
  return (
    receiptScope.scope_semantics === "issuer_rp_scope" &&
    subjectScope.scope_semantics === "issuer_rp_scope"
  );
}

function receiptMatchesSubjectKey(receipt: EvidenceReceipt, subjectKey: SubjectKey): boolean {
  return (
    receipt.subject_key_id === subjectKey.id &&
    receipt.issuer === subjectKey.issuer &&
    receipt.method === subjectKey.method &&
    receipt.issuer === receipt.scope.issuer &&
    subjectKey.issuer === subjectKey.scope.issuer &&
    sameSubjectScope(receipt.scope, subjectKey.scope)
  );
}

function hasDuplicateIds(values: readonly Readonly<{ readonly id: string }>[]): boolean {
  return new Set(values.map((value) => value.id)).size !== values.length;
}

/** Pure, provider-neutral evaluation of the bounded curated-age vertical. */
function evaluateCuratedAgeUnsafe(input: CuratedAgeEvaluatorInput): CuratedAgeEvaluation {
  const { policy, evidence: availability, now } = input;
  if (!validPolicy(policy)) return fail(policy, "policy_invalid", ["policy_invalid"]);
  if (availability.kind === "indeterminate") {
    if (!UNAVAILABLE_REASONS.has(availability.reason))
      return fail(policy, "invalid_evidence", ["assertion_invalid"]);
    return {
      outcome: "indeterminate",
      reason: availability.reason,
      ...metadata(policy, [availability.reason]),
    };
  }

  const evidence = availability.bundle;
  if (
    hasDuplicateIds(evidence.assertions) ||
    hasDuplicateIds(evidence.receipts) ||
    hasDuplicateIds(evidence.subject_keys) ||
    hasDuplicateIds(evidence.binding_groups)
  )
    return fail(policy, "conflicting_evidence", ["conflicting_evidence"]);

  const duplicateRequiredClaim = REQUIRED_CLAIMS.some(
    (claimId) =>
      evidence.assertions.filter((assertion) => assertion.claim_id === claimId).length > 1,
  );
  if (duplicateRequiredClaim) return fail(policy, "conflicting_evidence", ["conflicting_evidence"]);

  const required = REQUIRED_CLAIMS.map((claimId) =>
    assertionForClaim(evidence.assertions, claimId),
  );
  const missingClaims = REQUIRED_CLAIMS.filter((_, index) => required[index] == null);
  if (missingClaims.length > 0)
    return needsEvidence(policy, ["required_claim_missing"], missingClaims);

  const assertions = required as Assertion[];
  const invalidReasons: EvaluatorReason[] = [];
  const needsReasons: EvaluatorReason[] = [];
  const affectedNeeds = new Set<RequiredClaim>();
  const receipts: EvidenceReceipt[] = [];
  const subjectKeys: SubjectKey[] = [];

  for (const assertion of assertions) {
    const claimId = assertion.claim_id as RequiredClaim;
    if (!ASSURANCES.has(assertion.assurance)) {
      invalidReasons.push("assertion_invalid");
    } else if (assertion.assurance !== policy.required_assurance) {
      needsReasons.push("wrong_assurance");
      affectedNeeds.add(claimId);
    }
    if (
      !canonicalIsoInstant(assertion.observed_at) ||
      (assertion.expires_at !== undefined && !canonicalIsoInstant(assertion.expires_at))
    ) {
      invalidReasons.push("assertion_invalid");
    } else {
      const assertionFreshness = freshnessReasons(assertion.observed_at, now, assertion.expires_at);
      needsReasons.push(...assertionFreshness);
      if (assertionFreshness.length > 0) affectedNeeds.add(claimId);
    }

    const receipt = receiptForAssertion(evidence.receipts, assertion);
    if (receipt == null) {
      invalidReasons.push("receipt_missing");
    } else {
      receipts.push(receipt);
      if (
        !canonicalIsoInstant(receipt.observed_at) ||
        (receipt.expires_at !== undefined && !canonicalIsoInstant(receipt.expires_at))
      ) {
        invalidReasons.push("receipt_mismatch");
      } else {
        const receiptFreshness = freshnessReasons(receipt.observed_at, now, receipt.expires_at);
        needsReasons.push(...receiptFreshness);
        if (receiptFreshness.length > 0) affectedNeeds.add(claimId);
      }
      if (receipt.proof_session_id !== evidence.proof_session_id)
        invalidReasons.push("receipt_mismatch");
      if (receipt.subject_key_id !== assertion.subject_key_id)
        invalidReasons.push("subject_key_mismatch");
    }

    const subjectKey = subjectKeyForAssertion(evidence.subject_keys, assertion);
    if (subjectKey == null) {
      invalidReasons.push("subject_key_missing");
    } else {
      subjectKeys.push(subjectKey);
      if (receipt != null && !receiptMatchesSubjectKey(receipt, subjectKey))
        invalidReasons.push("subject_key_mismatch");
    }
  }

  const binding = sameSubjectBinding(evidence, assertions);
  if (binding == null) {
    const bindingIds = new Set(assertions.map((assertion) => assertion.binding_group_id));
    invalidReasons.push(bindingIds.size === 1 ? "binding_missing" : "binding_mismatch");
  } else if (
    subjectKeys.length !== assertions.length ||
    subjectKeys.some((subjectKey) => subjectKey.id !== binding.subject_key_id)
  ) {
    invalidReasons.push("binding_mismatch");
  }

  const age = assertions.find((assertion) => assertion.claim_id === "age.minimum");
  let underageAssertionId: string | undefined;
  if (age?.claim_id !== "age.minimum") {
    invalidReasons.push("assertion_invalid");
  } else {
    const assertedAge = canonicalUnsignedInteger(age.value.minimum_age);
    const policyAge = canonicalUnsignedInteger(policy.minimum_age);
    if (assertedAge === undefined || policyAge === undefined)
      invalidReasons.push("age_not_canonical");
    else if (assertedAge < policyAge) underageAssertionId = age.id;
  }

  const credential = assertions.find(
    (assertion) => assertion.claim_id === "credential.subject_unique",
  );
  if (
    credential?.claim_id !== "credential.subject_unique" ||
    credential.value.subject_unique !== true
  )
    invalidReasons.push("assertion_invalid");

  const document = assertions.find((assertion) => assertion.claim_id === "document.valid");
  if (document?.claim_id !== "document.valid" || document.value.valid !== true)
    invalidReasons.push("assertion_invalid");

  if (invalidReasons.length > 0)
    return fail(policy, "invalid_evidence", sortedUnique(invalidReasons));
  if (needsReasons.length > 0) return needsEvidence(policy, needsReasons, [...affectedNeeds]);
  if (underageAssertionId !== undefined)
    return fail(policy, "age_below_threshold", ["age_below_threshold"], underageAssertionId);
  if (binding === undefined) return fail(policy, "invalid_evidence", ["binding_invalid"]);

  const witness: EvaluatorWitness = {
    assertion_ids: sortedUnique(assertions.map((assertion) => assertion.id)),
    evidence_receipt_ids: sortedUnique(receipts.map((receipt) => receipt.id)),
    subject_key_id: binding.subject_key_id,
    binding_group_id: binding.id,
  };
  return {
    outcome: "pass",
    ...metadata(policy, ["policy_valid", "required_claims_valid", "same_subject_valid"]),
    winning_witness: [witness],
  };
}

/** Total runtime boundary: malformed decoded-looking input fails, never throws. */
export function evaluateCuratedAge(input: CuratedAgeEvaluatorInput): CuratedAgeEvaluation {
  try {
    return evaluateCuratedAgeUnsafe(input);
  } catch {
    return fail(input.policy, "invalid_evidence", ["assertion_invalid"]);
  }
}

export const evaluateCuratedAge18 = evaluateCuratedAge;
export const evaluateAge18 = evaluateCuratedAge;
