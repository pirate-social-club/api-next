import type {
  Assertion,
  CanonicalIsoInstant,
  EvidenceBundle,
  EvidenceReceipt,
  SameSubjectBindingGroup,
  SubjectKey,
} from "../verification/index.ts";

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
  | "evidence_not_fresh"
  | "conflicting_evidence";

/** The fixed, provider-neutral first vertical policy. */
export const CURATED_AGE_18_POLICY = {
  id: "curated-age-18",
  version: 1,
  requirements: [
    { claim_id: "age.minimum", minimum_age: "18" },
    { claim_id: "credential.subject_unique" },
    { claim_id: "document.valid" },
  ] as const,
  required_assurance: "document_zk",
  co_reference: "same_subject",
  freshness: "unexpired_at_evaluation",
} as const;

export type CuratedAge18Policy = typeof CURATED_AGE_18_POLICY;

export type EvaluatorWitness = {
  readonly assertion_ids: readonly string[];
  readonly evidence_receipt_ids: readonly string[];
  readonly subject_key_id: string;
  readonly binding_group_id: string;
};

export type CuratedAge18Pass = {
  readonly outcome: "pass";
  readonly policy: CuratedAge18Policy;
  readonly witness: EvaluatorWitness;
};

export type CuratedAge18Fail = {
  readonly outcome: "fail";
  readonly policy: CuratedAge18Policy;
  readonly reason: "age_below_threshold";
  readonly assertion_id: string;
  readonly witness: null;
};

export type CuratedAge18NeedsEvidence = {
  readonly outcome: "needs_evidence";
  readonly policy: CuratedAge18Policy;
  readonly reasons: readonly EvaluatorReason[];
  readonly claim_ids: readonly RequiredClaim[];
  readonly witness: null;
};

export type CuratedAge18Indeterminate = {
  readonly outcome: "indeterminate";
  readonly policy: CuratedAge18Policy;
  readonly reason: EvidenceUnavailableReason | "conflicting_evidence";
  readonly witness: null;
};

export type CuratedAge18Evaluation =
  | CuratedAge18Pass
  | CuratedAge18Fail
  | CuratedAge18NeedsEvidence
  | CuratedAge18Indeterminate;

export type CuratedAge18EvaluatorInput = {
  readonly evidence: EvidenceAvailability;
  readonly now: CanonicalIsoInstant;
};

const REQUIRED_CLAIMS = CURATED_AGE_18_POLICY.requirements.map(
  (requirement) => requirement.claim_id,
);
type RequiredClaim = (typeof REQUIRED_CLAIMS)[number];

function needsEvidence(
  policy: CuratedAge18Policy,
  reasons: readonly EvaluatorReason[],
  claimIds: readonly RequiredClaim[],
): CuratedAge18NeedsEvidence {
  return {
    outcome: "needs_evidence",
    policy,
    reasons: [...new Set(reasons)].sort() as EvaluatorReason[],
    claim_ids: REQUIRED_CLAIMS.filter((claimId) => claimIds.includes(claimId)),
    witness: null,
  };
}

function indeterminate(
  policy: CuratedAge18Policy,
  reason: CuratedAge18Indeterminate["reason"],
): CuratedAge18Indeterminate {
  return { outcome: "indeterminate", policy, reason, witness: null };
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

function sameSubjectScope(
  receiptScope: EvidenceReceipt["scope"],
  subjectScope: SubjectKey["scope"],
): boolean {
  if (
    receiptScope.kind !== "named" ||
    receiptScope.issuer !== subjectScope.issuer ||
    receiptScope.scope_semantics !== subjectScope.scope_semantics ||
    receiptScope.rp_scope !== subjectScope.rp_scope
  ) {
    return false;
  }
  if (
    receiptScope.scope_semantics === "issuer_rp_action_scope" &&
    subjectScope.scope_semantics === "issuer_rp_action_scope"
  ) {
    return receiptScope.action_scope === subjectScope.action_scope;
  }
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

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Evaluate the fixed curated age-18 policy over normalized evidence.
 * There is no provider branch, I/O, persistence, or implicit clock access.
 */
export function evaluateCuratedAge18(input: CuratedAge18EvaluatorInput): CuratedAge18Evaluation {
  const { evidence: availability, now } = input;
  const policy = CURATED_AGE_18_POLICY;
  if (availability.kind === "indeterminate") {
    return indeterminate(policy, availability.reason);
  }

  const evidence = availability.bundle;
  const duplicateRequiredClaim = REQUIRED_CLAIMS.some(
    (claimId) =>
      evidence.assertions.filter((assertion) => assertion.claim_id === claimId).length > 1,
  );
  if (duplicateRequiredClaim) return indeterminate(policy, "conflicting_evidence");

  const required = REQUIRED_CLAIMS.map((claimId) =>
    assertionForClaim(evidence.assertions, claimId),
  );
  const missingClaims = REQUIRED_CLAIMS.filter((_, index) => required[index] == null);
  if (missingClaims.length > 0) {
    return needsEvidence(policy, ["required_claim_missing"], missingClaims);
  }
  const assertions = required as Assertion[];
  const reasons: EvaluatorReason[] = [];
  const affectedClaims = new Set<RequiredClaim>();
  const receipts: EvidenceReceipt[] = [];
  const subjectKeys: SubjectKey[] = [];

  for (const assertion of assertions) {
    if (assertion.assurance !== policy.required_assurance) {
      reasons.push("wrong_assurance");
      affectedClaims.add(assertion.claim_id as RequiredClaim);
    }
    const assertionFreshness = freshnessReasons(assertion.observed_at, now, assertion.expires_at);
    reasons.push(...assertionFreshness);
    if (assertionFreshness.length > 0) affectedClaims.add(assertion.claim_id as RequiredClaim);

    const receipt = receiptForAssertion(evidence.receipts, assertion);
    if (receipt == null) {
      reasons.push("receipt_missing");
      affectedClaims.add(assertion.claim_id as RequiredClaim);
    } else {
      receipts.push(receipt);
      const receiptFreshness = freshnessReasons(receipt.observed_at, now, receipt.expires_at);
      reasons.push(...receiptFreshness);
      if (receiptFreshness.length > 0) affectedClaims.add(assertion.claim_id as RequiredClaim);
      if (receipt.proof_session_id !== evidence.proof_session_id) {
        reasons.push("receipt_mismatch");
        affectedClaims.add(assertion.claim_id as RequiredClaim);
      }
      if (receipt.subject_key_id !== assertion.subject_key_id) {
        reasons.push("subject_key_mismatch");
        affectedClaims.add(assertion.claim_id as RequiredClaim);
      }
    }

    const subjectKey = subjectKeyForAssertion(evidence.subject_keys, assertion);
    if (subjectKey == null) {
      reasons.push("subject_key_missing");
      affectedClaims.add(assertion.claim_id as RequiredClaim);
    } else {
      subjectKeys.push(subjectKey);
      if (receipt != null && !receiptMatchesSubjectKey(receipt, subjectKey)) {
        reasons.push("subject_key_mismatch");
        affectedClaims.add(assertion.claim_id as RequiredClaim);
      }
    }
  }

  const binding = sameSubjectBinding(evidence, assertions);
  if (binding == null) {
    reasons.push("binding_missing");
    for (const claimId of REQUIRED_CLAIMS) affectedClaims.add(claimId);
  } else if (subjectKeys.some((subjectKey) => subjectKey.id !== binding.subject_key_id)) {
    reasons.push("binding_mismatch");
    for (const claimId of REQUIRED_CLAIMS) affectedClaims.add(claimId);
  }

  const age = assertions.find((assertion) => assertion.claim_id === "age.minimum");
  let underageAssertionId: string | undefined;
  if (age?.claim_id === "age.minimum") {
    try {
      if (BigInt(age.value.minimum_age) < BigInt(18)) {
        underageAssertionId = age.id;
      }
    } catch {
      reasons.push("age_not_canonical");
      affectedClaims.add("age.minimum");
    }
  }

  const credential = assertions.find(
    (assertion) => assertion.claim_id === "credential.subject_unique",
  );
  if (
    credential?.claim_id === "credential.subject_unique" &&
    credential.value.subject_unique !== true
  ) {
    reasons.push("assertion_invalid");
    affectedClaims.add("credential.subject_unique");
  }
  const document = assertions.find((assertion) => assertion.claim_id === "document.valid");
  if (document?.claim_id === "document.valid" && document.value.valid !== true) {
    reasons.push("assertion_invalid");
    affectedClaims.add("document.valid");
  }

  if (reasons.length > 0) return needsEvidence(policy, reasons, [...affectedClaims]);
  if (underageAssertionId != null) {
    return {
      outcome: "fail",
      policy,
      reason: "age_below_threshold",
      assertion_id: underageAssertionId,
      witness: null,
    };
  }
  const subjectKeyId = binding?.subject_key_id;
  if (subjectKeyId == null || binding == null) {
    return needsEvidence(policy, ["binding_invalid"], REQUIRED_CLAIMS);
  }

  return {
    outcome: "pass",
    policy,
    witness: {
      assertion_ids: sortedUnique(assertions.map((assertion) => assertion.id)),
      evidence_receipt_ids: sortedUnique(receipts.map((receipt) => receipt.id)),
      subject_key_id: subjectKeyId,
      binding_group_id: binding.id,
    },
  };
}

export const evaluateAge18 = evaluateCuratedAge18;
