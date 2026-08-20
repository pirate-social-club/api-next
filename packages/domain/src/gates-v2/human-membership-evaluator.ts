import { Schema } from "effect";
import type {
  Assertion,
  EvidenceBundle,
  EvidenceReceipt,
  SameSubjectBindingGroup,
  SubjectKey,
} from "../verification/index.ts";
import {
  Assurance,
  CanonicalIsoInstant,
  EvidenceBundle as EvidenceBundleSchema,
} from "../verification/index.ts";
import type {
  EvaluatorReason,
  EvaluatorWitness,
  EvidenceAvailability,
  EvidenceUnavailableReason,
} from "./evaluator.ts";
import { sha256Hex } from "./sha256.ts";

export type HumanMembershipRequiredClaim = "human.personhood" | "credential.subject_unique";

export type CuratedHumanMembershipPolicy = Readonly<{
  readonly policy_version_id: "curated-human-membership-v1";
  readonly policy_key: "curated-human-membership";
  readonly policy_revision: 1;
  readonly policy_hash: string;
  readonly requirements: readonly [
    Readonly<{ readonly claim_id: "human.personhood" }>,
    Readonly<{ readonly claim_id: "credential.subject_unique" }>,
  ];
  readonly required_assurance: "provider_attested";
  readonly co_reference: "same_subject";
  readonly freshness: "unexpired_at_evaluation";
}>;

export const CURATED_HUMAN_MEMBERSHIP_POLICY_CANONICAL_PREIMAGE =
  '{"co_reference":"same_subject","freshness":"unexpired_at_evaluation","policy_key":"curated-human-membership","policy_version_id":"curated-human-membership-v1","required_assurance":"provider_attested","requirements":[{"claim_id":"human.personhood"},{"claim_id":"credential.subject_unique"}],"revision":1}' as const;

export const CURATED_HUMAN_MEMBERSHIP_POLICY: CuratedHumanMembershipPolicy = {
  policy_version_id: "curated-human-membership-v1",
  policy_key: "curated-human-membership",
  policy_revision: 1,
  policy_hash: "4ac57c1db6ca01acf054a096a06963716716647b676fa7be41bb45d4e70d3a46",
  requirements: [{ claim_id: "human.personhood" }, { claim_id: "credential.subject_unique" }],
  required_assurance: "provider_attested",
  co_reference: "same_subject",
  freshness: "unexpired_at_evaluation",
};

type DecisionMetadata = Readonly<{
  readonly policy_version_id: string;
  readonly policy_revision: number;
  readonly policy_hash: string;
  readonly winning_witness: readonly EvaluatorWitness[];
  readonly trace: readonly string[];
}>;

export type CuratedHumanMembershipPass = DecisionMetadata & { readonly outcome: "pass" };
export type CuratedHumanMembershipFail = DecisionMetadata &
  Readonly<{
    readonly outcome: "fail";
    readonly reason: "policy_invalid" | "invalid_evidence" | "conflicting_evidence";
  }>;
export type CuratedHumanMembershipNeedsEvidence = DecisionMetadata &
  Readonly<{
    readonly outcome: "needs_evidence";
    readonly reasons: readonly EvaluatorReason[];
    readonly claim_ids: readonly HumanMembershipRequiredClaim[];
  }>;
export type CuratedHumanMembershipIndeterminate = DecisionMetadata &
  Readonly<{
    readonly outcome: "indeterminate";
    readonly reason: EvidenceUnavailableReason;
  }>;
export type CuratedHumanMembershipEvaluation =
  | CuratedHumanMembershipPass
  | CuratedHumanMembershipFail
  | CuratedHumanMembershipNeedsEvidence
  | CuratedHumanMembershipIndeterminate;

export type CuratedHumanMembershipEvaluatorInput = Readonly<{
  readonly policy: CuratedHumanMembershipPolicy;
  readonly evidence: EvidenceAvailability;
  readonly now: CanonicalIsoInstant;
}>;

const REQUIRED_CLAIMS = [
  "human.personhood",
  "credential.subject_unique",
] as const satisfies readonly HumanMembershipRequiredClaim[];
const EVIDENCE_UNAVAILABLE_REASONS = new Set<EvidenceUnavailableReason>([
  "provider_unavailable",
  "evidence_store_unavailable",
  "snapshot_unavailable",
]);
const CANONICAL_ISO_INSTANT =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;
const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

const CuratedHumanMembershipPolicySchema = Schema.Struct({
  policy_version_id: Schema.Literal("curated-human-membership-v1"),
  policy_key: Schema.Literal("curated-human-membership"),
  policy_revision: Schema.Literal(1),
  policy_hash: Schema.String,
  requirements: Schema.Tuple([
    Schema.Struct({ claim_id: Schema.Literal("human.personhood") }),
    Schema.Struct({ claim_id: Schema.Literal("credential.subject_unique") }),
  ]),
  required_assurance: Schema.Literal("provider_attested"),
  co_reference: Schema.Literal("same_subject"),
  freshness: Schema.Literal("unexpired_at_evaluation"),
});

const EvidenceAvailabilitySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("available"), bundle: EvidenceBundleSchema }),
  Schema.Struct({
    kind: Schema.Literal("indeterminate"),
    reason: Schema.Literals([
      "provider_unavailable",
      "evidence_store_unavailable",
      "snapshot_unavailable",
    ]),
  }),
]);

const CuratedHumanMembershipEvaluatorInputSchema = Schema.Struct({
  policy: CuratedHumanMembershipPolicySchema,
  evidence: EvidenceAvailabilitySchema,
  now: CanonicalIsoInstant,
});

export function humanMembershipPolicyCanonicalPreimage(
  policy: CuratedHumanMembershipPolicy,
): string {
  return JSON.stringify({
    co_reference: policy.co_reference,
    freshness: policy.freshness,
    policy_key: policy.policy_key,
    policy_version_id: policy.policy_version_id,
    required_assurance: policy.required_assurance,
    requirements: [
      { claim_id: policy.requirements[0]?.claim_id },
      { claim_id: policy.requirements[1]?.claim_id },
    ],
    revision: policy.policy_revision,
  });
}

function isCanonicalIsoInstant(value: unknown): value is CanonicalIsoInstant {
  if (typeof value !== "string" || !CANONICAL_ISO_INSTANT.test(value)) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validPolicy(policy: CuratedHumanMembershipPolicy): boolean {
  return (
    hasExactKeys(policy, [
      "policy_version_id",
      "policy_key",
      "policy_revision",
      "policy_hash",
      "requirements",
      "required_assurance",
      "co_reference",
      "freshness",
    ]) &&
    hasExactKeys(policy.requirements[0], ["claim_id"]) &&
    hasExactKeys(policy.requirements[1], ["claim_id"]) &&
    /^[0-9a-f]{64}$/u.test(policy.policy_hash) &&
    sha256Hex(humanMembershipPolicyCanonicalPreimage(policy)) === policy.policy_hash
  );
}

function metadata(
  policy: CuratedHumanMembershipPolicy,
  trace: readonly string[],
): DecisionMetadata {
  return {
    policy_version_id: policy.policy_version_id,
    policy_revision: policy.policy_revision,
    policy_hash: policy.policy_hash,
    winning_witness: [],
    trace,
  };
}

function metadataFromUnknown(policy: unknown): DecisionMetadata {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return {
      policy_version_id: "",
      policy_revision: 0,
      policy_hash: "",
      winning_witness: [],
      trace: [],
    };
  }
  const record = policy as Readonly<Record<string, unknown>>;
  return {
    policy_version_id: typeof record.policy_version_id === "string" ? record.policy_version_id : "",
    policy_revision:
      typeof record.policy_revision === "number" && Number.isSafeInteger(record.policy_revision)
        ? record.policy_revision
        : 0,
    policy_hash: typeof record.policy_hash === "string" ? record.policy_hash : "",
    winning_witness: [],
    trace: [],
  };
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function fail(
  policy: CuratedHumanMembershipPolicy,
  reason: CuratedHumanMembershipFail["reason"],
  trace: readonly string[],
): CuratedHumanMembershipFail {
  return { outcome: "fail", reason, ...metadata(policy, trace) };
}

function failWithMetadata(
  decisionMetadata: DecisionMetadata,
  reason: CuratedHumanMembershipFail["reason"],
  trace: readonly string[],
): CuratedHumanMembershipFail {
  return { outcome: "fail", reason, ...decisionMetadata, trace };
}

function needsEvidence(
  policy: CuratedHumanMembershipPolicy,
  reasons: readonly EvaluatorReason[],
  claimIds: readonly HumanMembershipRequiredClaim[],
): CuratedHumanMembershipNeedsEvidence {
  const uniqueReasons = sortedUnique(reasons);
  return {
    outcome: "needs_evidence",
    reasons: uniqueReasons,
    claim_ids: REQUIRED_CLAIMS.filter((claimId) => claimIds.includes(claimId)),
    ...metadata(policy, uniqueReasons),
  };
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

function freshnessReasons(observedAt: string, now: string, expiresAt?: string): EvaluatorReason[] {
  const reasons: EvaluatorReason[] = [];
  if (observedAt > now) reasons.push("observed_in_future");
  if (expiresAt !== undefined && expiresAt <= now) reasons.push("evidence_expired");
  return reasons;
}

function sameSubjectBinding(
  evidence: EvidenceBundle,
  assertions: readonly Assertion[],
): SameSubjectBindingGroup | undefined {
  const bindingIds = new Set(assertions.map((assertion) => assertion.binding_group_id));
  if (bindingIds.size !== 1) return undefined;
  const binding = evidence.binding_groups.find(
    (group) => group.id === assertions[0]?.binding_group_id,
  );
  return binding?.kind === "same_subject" ? binding : undefined;
}

function hasDuplicateIds(values: readonly Readonly<{ readonly id: string }>[]): boolean {
  return new Set(values.map((value) => value.id)).size !== values.length;
}

function evaluateAvailable(
  policy: CuratedHumanMembershipPolicy,
  evidence: EvidenceBundle,
  now: CanonicalIsoInstant,
): CuratedHumanMembershipEvaluation {
  const requiredClaimSet = new Set<string>(REQUIRED_CLAIMS);
  if (evidence.assertions.some((assertion) => !requiredClaimSet.has(assertion.claim_id))) {
    return fail(policy, "invalid_evidence", ["assertion_invalid"]);
  }
  const referencedReceiptIds = new Set(
    evidence.assertions.map((assertion) => assertion.evidence_receipt_id),
  );
  const referencedSubjectKeyIds = new Set(
    evidence.assertions.flatMap((assertion) =>
      assertion.subject_key_id === undefined ? [] : [assertion.subject_key_id],
    ),
  );
  const referencedBindingIds = new Set(
    evidence.assertions.map((assertion) => assertion.binding_group_id),
  );
  if (
    evidence.receipts.some((receipt) => !referencedReceiptIds.has(receipt.id)) ||
    evidence.subject_keys.some((subjectKey) => !referencedSubjectKeyIds.has(subjectKey.id)) ||
    evidence.binding_groups.some((binding) => !referencedBindingIds.has(binding.id))
  ) {
    return fail(policy, "invalid_evidence", ["binding_mismatch"]);
  }
  if (
    hasDuplicateIds(evidence.assertions) ||
    hasDuplicateIds(evidence.receipts) ||
    hasDuplicateIds(evidence.subject_keys) ||
    hasDuplicateIds(evidence.binding_groups) ||
    REQUIRED_CLAIMS.some(
      (claimId) =>
        evidence.assertions.filter((assertion) => assertion.claim_id === claimId).length > 1,
    )
  ) {
    return fail(policy, "conflicting_evidence", ["conflicting_evidence"]);
  }

  const required = REQUIRED_CLAIMS.map((claimId) =>
    evidence.assertions.find((assertion) => assertion.claim_id === claimId),
  );
  const missing = REQUIRED_CLAIMS.filter((_, index) => required[index] === undefined);
  if (missing.length > 0) return needsEvidence(policy, ["required_claim_missing"], missing);

  const assertions = required.filter(
    (assertion): assertion is Assertion => assertion !== undefined,
  );
  const invalidReasons: EvaluatorReason[] = [];
  const needsReasons: EvaluatorReason[] = [];
  const affectedNeeds = new Set<HumanMembershipRequiredClaim>();
  const receipts: EvidenceReceipt[] = [];
  const subjectKeys: SubjectKey[] = [];

  for (const assertion of assertions) {
    const claimId = assertion.claim_id as HumanMembershipRequiredClaim;
    if (!Schema.is(Assurance)(assertion.assurance)) invalidReasons.push("assertion_invalid");
    else if (assertion.assurance !== policy.required_assurance) {
      needsReasons.push("wrong_assurance");
      affectedNeeds.add(claimId);
    }
    if (
      !isCanonicalIsoInstant(assertion.observed_at) ||
      (assertion.expires_at !== undefined && !isCanonicalIsoInstant(assertion.expires_at))
    ) {
      invalidReasons.push("assertion_invalid");
    } else {
      const freshness = freshnessReasons(assertion.observed_at, now, assertion.expires_at);
      needsReasons.push(...freshness);
      if (freshness.length > 0) affectedNeeds.add(claimId);
    }

    const receipt = evidence.receipts.find(
      (candidate) => candidate.id === assertion.evidence_receipt_id,
    );
    const subjectKey =
      assertion.subject_key_id === undefined
        ? undefined
        : evidence.subject_keys.find((candidate) => candidate.id === assertion.subject_key_id);
    if (receipt === undefined) invalidReasons.push("receipt_missing");
    else {
      receipts.push(receipt);
      if (
        receipt.proof_session_id !== evidence.proof_session_id ||
        receipt.subject_key_id !== assertion.subject_key_id
      ) {
        invalidReasons.push("receipt_mismatch");
      }
      if (
        !isCanonicalIsoInstant(receipt.observed_at) ||
        (receipt.expires_at !== undefined && !isCanonicalIsoInstant(receipt.expires_at))
      ) {
        invalidReasons.push("assertion_invalid");
      } else {
        const freshness = freshnessReasons(receipt.observed_at, now, receipt.expires_at);
        needsReasons.push(...freshness);
        if (freshness.length > 0) affectedNeeds.add(claimId);
      }
    }
    if (subjectKey === undefined) invalidReasons.push("subject_key_missing");
    else {
      subjectKeys.push(subjectKey);
      if (receipt !== undefined && !receiptMatchesSubjectKey(receipt, subjectKey)) {
        invalidReasons.push("subject_key_mismatch");
      }
    }
  }

  const personhood = assertions.find((assertion) => assertion.claim_id === "human.personhood");
  const subjectUnique = assertions.find(
    (assertion) => assertion.claim_id === "credential.subject_unique",
  );
  if (
    personhood?.claim_id !== "human.personhood" ||
    personhood.value.personhood !== true ||
    subjectUnique?.claim_id !== "credential.subject_unique" ||
    subjectUnique.value.subject_unique !== true
  ) {
    invalidReasons.push("assertion_invalid");
  }

  const binding = sameSubjectBinding(evidence, assertions);
  if (binding === undefined) {
    invalidReasons.push("binding_mismatch");
  } else if (
    subjectKeys.length !== assertions.length ||
    subjectKeys.some((subjectKey) => subjectKey.id !== binding.subject_key_id)
  ) {
    invalidReasons.push("binding_mismatch");
  }

  if (invalidReasons.length > 0) {
    return fail(policy, "invalid_evidence", sortedUnique(invalidReasons));
  }
  if (needsReasons.length > 0) {
    return needsEvidence(policy, needsReasons, [...affectedNeeds]);
  }
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

/** Pure provider-neutral evaluation of the conservative v1 human membership policy. */
export function evaluateCuratedHumanMembership(input: unknown): CuratedHumanMembershipEvaluation {
  let fallbackMetadata = metadataFromUnknown(undefined);
  try {
    const rawInput =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Readonly<Record<string, unknown>>)
        : undefined;
    fallbackMetadata = metadataFromUnknown(rawInput?.policy);

    let decoded: CuratedHumanMembershipEvaluatorInput;
    try {
      decoded = Schema.decodeUnknownSync(
        CuratedHumanMembershipEvaluatorInputSchema,
        STRICT_PARSE_OPTIONS,
      )(input);
    } catch {
      const policyDecoded = Schema.decodeUnknownOption(CuratedHumanMembershipPolicySchema)(
        rawInput?.policy,
      );
      return policyDecoded._tag === "None"
        ? failWithMetadata(fallbackMetadata, "policy_invalid", ["policy_invalid"])
        : failWithMetadata(fallbackMetadata, "invalid_evidence", ["assertion_invalid"]);
    }

    if (!validPolicy(decoded.policy)) {
      return fail(decoded.policy, "policy_invalid", ["policy_invalid"]);
    }
    if (!isCanonicalIsoInstant(decoded.now)) {
      return fail(decoded.policy, "invalid_evidence", ["assertion_invalid"]);
    }
    if (decoded.evidence.kind === "indeterminate") {
      if (!EVIDENCE_UNAVAILABLE_REASONS.has(decoded.evidence.reason)) {
        return fail(decoded.policy, "invalid_evidence", ["assertion_invalid"]);
      }
      return {
        outcome: "indeterminate",
        reason: decoded.evidence.reason,
        ...metadata(decoded.policy, [decoded.evidence.reason]),
      };
    }
    return evaluateAvailable(decoded.policy, decoded.evidence.bundle, decoded.now);
  } catch {
    return failWithMetadata(fallbackMetadata, "invalid_evidence", ["assertion_invalid"]);
  }
}
