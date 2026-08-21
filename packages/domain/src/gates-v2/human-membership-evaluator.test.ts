import { describe, expect, test } from "bun:test";
import type { EvidenceBundle } from "../verification/index.ts";
import {
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  CURATED_HUMAN_MEMBERSHIP_POLICY_CANONICAL_PREIMAGE,
  evaluateCuratedHumanMembership,
  humanMembershipPolicyCanonicalPreimage,
} from "./human-membership-evaluator.ts";
import { sha256Hex } from "./sha256.ts";

const now = "2026-08-20T12:00:00.000Z";
type MutableEvidenceBundle = { -readonly [Key in keyof EvidenceBundle]: EvidenceBundle[Key] };

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing fixture value at index ${index}`);
  return value;
}

function evidence(): MutableEvidenceBundle {
  const observedAt = "2026-08-20T11:59:00.000Z";
  const expiresAt = "2026-08-20T12:05:00.000Z";
  const scope = {
    kind: "named" as const,
    scope_semantics: "issuer_rp_scope" as const,
    issuer: "https://verify.very.org",
    rp_scope: "pirate-social",
  };
  return {
    id: "bundle-very-1",
    proof_session_id: "proof-session-very-1",
    receipts: [
      {
        id: "receipt-very-1",
        proof_session_id: "proof-session-very-1",
        provider_id: "very.web",
        issuer: "https://verify.very.org",
        method: "palm_web",
        scope,
        provider_configuration: {
          kind: "dynamic",
          reference: "very-web",
          version: "1",
        },
        protocol_version: "very-web-v1",
        environment: "test",
        provenance_kind: "proof_session",
        evidence_kind: "very.web.server-verified.v1",
        evidence_hash: "a".repeat(64),
        observed_at: observedAt,
        expires_at: expiresAt,
        subject_key_id: "subject-very-1",
      },
    ],
    subject_keys: [
      {
        id: "subject-very-1",
        issuer: "https://verify.very.org",
        method: "palm_web",
        scope,
        subject_digest: "b".repeat(64),
      },
    ],
    binding_groups: [
      {
        id: "binding-very-1",
        kind: "same_subject",
        subject_key_id: "subject-very-1",
      },
    ],
    assertions: [
      {
        id: "assertion-personhood-1",
        subject_key_id: "subject-very-1",
        evidence_receipt_id: "receipt-very-1",
        claim_id: "human.personhood",
        assurance: "provider_attested",
        binding_group_id: "binding-very-1",
        value: { personhood: true },
        observed_at: observedAt,
        expires_at: expiresAt,
      },
      {
        id: "assertion-subject-unique-1",
        subject_key_id: "subject-very-1",
        evidence_receipt_id: "receipt-very-1",
        claim_id: "credential.subject_unique",
        assurance: "provider_attested",
        binding_group_id: "binding-very-1",
        value: { subject_unique: true },
        observed_at: observedAt,
        expires_at: expiresAt,
      },
    ],
  };
}

function evaluate(bundle: EvidenceBundle) {
  return evaluateCuratedHumanMembership({
    policy: CURATED_HUMAN_MEMBERSHIP_POLICY,
    evidence: { kind: "available", bundle },
    now,
  });
}

describe("curated human membership evaluator", () => {
  test("pins the exact policy preimage and passes same-subject Very evidence", () => {
    expect(humanMembershipPolicyCanonicalPreimage(CURATED_HUMAN_MEMBERSHIP_POLICY)).toBe(
      CURATED_HUMAN_MEMBERSHIP_POLICY_CANONICAL_PREIMAGE,
    );
    expect(sha256Hex(CURATED_HUMAN_MEMBERSHIP_POLICY_CANONICAL_PREIMAGE)).toBe(
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
    );
    expect(evaluate(evidence())).toMatchObject({
      outcome: "pass",
      policy_version_id: "curated-human-membership-v1",
      trace: ["policy_valid", "required_claims_valid", "same_subject_valid"],
      winning_witness: [
        {
          assertion_ids: ["assertion-personhood-1", "assertion-subject-unique-1"],
          evidence_receipt_ids: ["receipt-very-1"],
          subject_key_id: "subject-very-1",
          binding_group_id: "binding-very-1",
        },
      ],
    });
  });

  test("needs evidence when either conservative v1 claim is absent", () => {
    for (const claim of ["human.personhood", "credential.subject_unique"] as const) {
      const bundle = evidence();
      bundle.assertions = bundle.assertions.filter((assertion) => assertion.claim_id !== claim);
      expect(evaluate(bundle)).toMatchObject({
        outcome: "needs_evidence",
        reasons: ["required_claim_missing"],
        claim_ids: [claim],
        winning_witness: [],
      });
    }
  });

  test("rejects human.unique as an unrequested upgrade", () => {
    const bundle = evidence();
    bundle.assertions = [
      ...bundle.assertions,
      {
        ...requiredAt(bundle.assertions, 0),
        id: "assertion-human-unique-1",
        claim_id: "human.unique",
        value: { unique: true },
      },
    ];
    expect(evaluate(bundle)).toMatchObject({
      outcome: "fail",
      reason: "invalid_evidence",
      winning_witness: [],
    });
  });

  test("fails when claims do not bind to one subject", () => {
    const bundle = evidence();
    const second = requiredAt(bundle.assertions, 1);
    bundle.assertions = [
      requiredAt(bundle.assertions, 0),
      { ...second, binding_group_id: "binding-other", subject_key_id: "subject-other" },
    ];
    expect(evaluate(bundle)).toMatchObject({
      outcome: "fail",
      reason: "invalid_evidence",
      winning_witness: [],
    });
  });

  test("routes wrong assurance and expiry to needs_evidence", () => {
    const weak = evidence();
    weak.assertions = weak.assertions.map((assertion) => ({
      ...assertion,
      assurance: "personhood" as const,
    }));
    expect(evaluate(weak)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["wrong_assurance"],
      claim_ids: ["human.personhood", "credential.subject_unique"],
    });

    const expired = evidence();
    expired.assertions = expired.assertions.map((assertion) => ({
      ...assertion,
      expires_at: "2026-08-20T11:59:59.999Z",
    }));
    expired.receipts = expired.receipts.map((receipt) => ({
      ...receipt,
      expires_at: "2026-08-20T11:59:59.999Z",
    }));
    expect(evaluate(expired)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["evidence_expired"],
    });
  });

  test("fails closed for malformed policy, input, conflicts, and unrelated records", () => {
    expect(evaluateCuratedHumanMembership(null)).toMatchObject({
      outcome: "fail",
      reason: "policy_invalid",
    });
    expect(
      evaluateCuratedHumanMembership({
        policy: { ...CURATED_HUMAN_MEMBERSHIP_POLICY, policy_hash: "0".repeat(64) },
        evidence: { kind: "available", bundle: evidence() },
        now,
      }),
    ).toMatchObject({ outcome: "fail", reason: "policy_invalid" });

    const duplicate = evidence();
    const duplicateAssertion = requiredAt(duplicate.assertions, 0);
    duplicate.assertions = [duplicateAssertion, { ...duplicateAssertion }];
    expect(evaluate(duplicate)).toMatchObject({
      outcome: "fail",
      reason: "conflicting_evidence",
    });

    const unrelated = evidence();
    unrelated.receipts = [
      ...unrelated.receipts,
      { ...requiredAt(unrelated.receipts, 0), id: "unrelated-receipt" },
    ];
    expect(evaluate(unrelated)).toMatchObject({
      outcome: "fail",
      reason: "invalid_evidence",
    });
  });

  test("uses indeterminate only for explicit evidence-source outages", () => {
    expect(
      evaluateCuratedHumanMembership({
        policy: CURATED_HUMAN_MEMBERSHIP_POLICY,
        evidence: { kind: "indeterminate", reason: "provider_unavailable" },
        now,
      }),
    ).toMatchObject({
      outcome: "indeterminate",
      reason: "provider_unavailable",
      winning_witness: [],
    });
  });
});
