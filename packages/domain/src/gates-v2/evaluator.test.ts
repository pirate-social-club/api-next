import { describe, expect, test } from "bun:test";
import type { EvidenceBundle } from "../verification/index.ts";
import {
  CURATED_AGE_18_POLICY,
  evaluateAge18,
  evaluateCuratedAge18,
  SELF_STAGING_18_PLUS_DEVELOPMENT_EVIDENCE,
  SELF_STAGING_18_PLUS_EVALUATION_NOW,
} from "./index.ts";

type MutableEvidence = {
  assertions: Array<Record<string, unknown>>;
  receipts: Array<Record<string, unknown>>;
  binding_groups: Array<Record<string, unknown>>;
  subject_keys: Array<Record<string, unknown>>;
};

const now = SELF_STAGING_18_PLUS_EVALUATION_NOW;

function copyEvidence(): MutableEvidence {
  return structuredClone(SELF_STAGING_18_PLUS_DEVELOPMENT_EVIDENCE) as unknown as MutableEvidence;
}

function evaluate(evidence: MutableEvidence) {
  return evaluateCuratedAge18({
    evidence: { kind: "available", bundle: evidence as unknown as EvidenceBundle },
    now,
  });
}

describe("curated age-18 evaluator", () => {
  test("accepts the redacted staging development fixture", () => {
    const evaluation = evaluateCuratedAge18({
      evidence: {
        kind: "available",
        bundle: SELF_STAGING_18_PLUS_DEVELOPMENT_EVIDENCE,
      },
      now,
    });
    expect(evaluation.outcome).toBe("pass");
    if (evaluation.outcome === "pass") {
      expect(evaluation.witness).toEqual({
        assertion_ids: [
          "fixture-assertion-age-18",
          "fixture-assertion-document-valid",
          "fixture-assertion-subject-unique",
        ],
        evidence_receipt_ids: ["fixture-receipt-age-document"],
        subject_key_id: "fixture-subject-key-redacted",
        binding_group_id: "fixture-same-subject-binding",
      });
    }
    expect(
      SELF_STAGING_18_PLUS_DEVELOPMENT_EVIDENCE.assertions.some(
        (assertion) => assertion.claim_id === "human.unique",
      ),
    ).toBe(false);
  });

  test("has a provider-neutral fixed policy", () => {
    expect(CURATED_AGE_18_POLICY).toMatchObject({
      requirements: [
        { claim_id: "age.minimum", minimum_age: "18" },
        { claim_id: "credential.subject_unique" },
        { claim_id: "document.valid" },
      ],
      required_assurance: "document_zk",
      co_reference: "same_subject",
      freshness: "unexpired_at_evaluation",
    });
    expect(Object.keys(CURATED_AGE_18_POLICY)).not.toContain("provider");
  });

  test("exports the stable generic alias", () => {
    expect(
      evaluateAge18({
        evidence: {
          kind: "available",
          bundle: SELF_STAGING_18_PLUS_DEVELOPMENT_EVIDENCE,
        },
        now,
      }),
    ).toEqual(
      evaluateCuratedAge18({
        evidence: {
          kind: "available",
          bundle: SELF_STAGING_18_PLUS_DEVELOPMENT_EVIDENCE,
        },
        now,
      }),
    );
  });

  test("maps every unavailable source to indeterminate", () => {
    for (const reason of [
      "provider_unavailable",
      "evidence_store_unavailable",
      "snapshot_unavailable",
    ] as const) {
      const result = evaluateCuratedAge18({
        evidence: { kind: "indeterminate", reason },
        now,
      });
      expect(result).toMatchObject({ outcome: "indeterminate", reason, witness: null });
    }
  });

  test("requires all three claims and does not substitute human.unique", () => {
    const evidence = copyEvidence();
    evidence.assertions = evidence.assertions.filter(
      (assertion) => assertion.claim_id !== "credential.subject_unique",
    );
    evidence.assertions.push({
      ...evidence.assertions[0],
      id: "fixture-human-unique-not-a-substitute",
      claim_id: "human.unique",
      value: { unique: true },
    });
    expect(evaluate(evidence)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["required_claim_missing"],
      claim_ids: ["credential.subject_unique"],
    });
  });

  test("returns the only policy failure for a valid explicit underage claim", () => {
    const evidence = copyEvidence();
    const age = evidence.assertions.find((assertion) => assertion.claim_id === "age.minimum");
    if (age) (age.value as Record<string, unknown>).minimum_age = "17";
    expect(evaluate(evidence)).toMatchObject({
      outcome: "fail",
      reason: "age_below_threshold",
      assertion_id: "fixture-assertion-age-18",
      witness: null,
    });
  });

  test("does not fail when an underage bundle has invalid required evidence", () => {
    const evidence = copyEvidence();
    const age = evidence.assertions.find((assertion) => assertion.claim_id === "age.minimum");
    if (age) (age.value as Record<string, unknown>).minimum_age = "17";
    const document = evidence.assertions.find(
      (assertion) => assertion.claim_id === "document.valid",
    );
    if (document) (document.value as Record<string, unknown>).valid = false;

    expect(evaluate(evidence)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["assertion_invalid"],
      claim_ids: ["document.valid"],
      witness: null,
    });
  });

  test("requires receipt and subject-key provenance to agree", () => {
    for (const mutate of [
      (subjectKey: Record<string, unknown>) => {
        subjectKey.issuer = "other.issuer";
      },
      (subjectKey: Record<string, unknown>) => {
        subjectKey.method = "other-method";
      },
      (subjectKey: Record<string, unknown>) => {
        (subjectKey.scope as Record<string, unknown>).rp_scope = "other-scope";
      },
    ]) {
      const evidence = copyEvidence();
      const subjectKey = evidence.subject_keys[0];
      if (!subjectKey) throw new Error("fixture subject key missing");
      mutate(subjectKey);
      expect(evaluate(evidence)).toMatchObject({
        outcome: "needs_evidence",
        reasons: ["subject_key_mismatch"],
        claim_ids: ["age.minimum", "credential.subject_unique", "document.valid"],
        witness: null,
      });
    }
  });

  test("treats wrong assurance, split co-reference, and invalid binding as needs evidence", () => {
    const wrongAssurance = copyEvidence();
    const age = wrongAssurance.assertions.find((assertion) => assertion.claim_id === "age.minimum");
    if (age) age.assurance = "provider_attested";
    expect(evaluate(wrongAssurance)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["wrong_assurance"],
      claim_ids: ["age.minimum"],
    });

    const split = copyEvidence();
    const document = split.assertions.find((assertion) => assertion.claim_id === "document.valid");
    if (document) document.binding_group_id = "fixture-other-binding";
    expect(evaluate(split)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["binding_missing"],
    });

    const invalid = copyEvidence();
    const binding = invalid.binding_groups[0];
    if (binding) binding.subject_key_id = "fixture-missing-subject";
    expect(evaluate(invalid)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["binding_mismatch"],
    });
  });

  test("marks duplicate required claims as conflicting indeterminate evidence", () => {
    const evidence = copyEvidence();
    evidence.assertions.push({ ...evidence.assertions[0], id: "fixture-duplicate-age" });
    expect(evaluate(evidence)).toMatchObject({
      outcome: "indeterminate",
      reason: "conflicting_evidence",
      witness: null,
    });
  });

  test("requires explicit freshness at the supplied evaluation instant", () => {
    const future = copyEvidence();
    const futureAssertion = future.assertions[0];
    if (futureAssertion) futureAssertion.observed_at = "2026-08-18T13:00:00.000Z";
    expect(evaluate(future)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["observed_in_future"],
    });

    const expiredAssertion = copyEvidence();
    const assertion = expiredAssertion.assertions[0];
    if (assertion) assertion.expires_at = now;
    expect(evaluate(expiredAssertion)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["evidence_expired"],
    });

    const expiredReceipt = copyEvidence();
    const receipt = expiredReceipt.receipts[0];
    if (receipt) receipt.expires_at = now;
    expect(evaluate(expiredReceipt)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["evidence_expired"],
    });
  });

  test("allows a same-subject policy witness to span multiple receipts", () => {
    const evidence = copyEvidence();
    const original = evidence.receipts[0];
    if (!original) throw new Error("fixture receipt missing");
    evidence.receipts = [
      original,
      {
        ...original,
        id: "fixture-receipt-second",
        evidence_hash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    ];
    const secondAssertion = evidence.assertions[1];
    if (secondAssertion) secondAssertion.evidence_receipt_id = "fixture-receipt-second";
    expect(evaluate(evidence)).toMatchObject({
      outcome: "pass",
      witness: {
        evidence_receipt_ids: ["fixture-receipt-age-document", "fixture-receipt-second"],
      },
    });
  });
});
