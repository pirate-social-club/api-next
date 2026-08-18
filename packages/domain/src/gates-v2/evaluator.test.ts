import { describe, expect, test } from "bun:test";
import type { EvidenceBundle } from "../verification/index.ts";
import {
  SELF_STAGING_18_PLUS_DEVELOPMENT_EVIDENCE,
  SELF_STAGING_18_PLUS_EVALUATION_NOW,
} from "./fixtures/self-staging-18-plus.ts";
import {
  CURATED_AGE_18_POLICY,
  CURATED_AGE_18_POLICY_CANONICAL_PREIMAGE,
  type CuratedAgePolicy,
  evaluateAge18,
  evaluateCuratedAge,
  evaluateCuratedAge18,
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

async function withContentHash(policy: CuratedAgePolicy): Promise<CuratedAgePolicy> {
  const preimage = JSON.stringify({
    co_reference: policy.co_reference,
    freshness: policy.freshness,
    minimum_age: policy.minimum_age,
    policy_key: policy.policy_key,
    policy_version_id: policy.policy_version_id,
    required_assurance: policy.required_assurance,
    requirements: policy.requirements,
    revision: policy.policy_revision,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage));
  return {
    ...policy,
    policy_hash: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  };
}

function evaluate(evidence: MutableEvidence, policy: CuratedAgePolicy = CURATED_AGE_18_POLICY) {
  return evaluateCuratedAge({
    policy,
    evidence: { kind: "available", bundle: evidence as unknown as EvidenceBundle },
    now,
  });
}

describe("policy-driven curated-age evaluator", () => {
  test("accepts the redacted fixture with DB-compatible decision metadata", () => {
    const evaluation = evaluate(copyEvidence());
    expect(evaluation).toMatchObject({
      outcome: "pass",
      policy_version_id: "curated-age-v1",
      policy_revision: 1,
      policy_hash: CURATED_AGE_18_POLICY.policy_hash,
      trace: ["policy_valid", "required_claims_valid", "same_subject_valid"],
      winning_witness: [
        {
          assertion_ids: [
            "fixture-assertion-age-18",
            "fixture-assertion-document-valid",
            "fixture-assertion-subject-unique",
          ],
          evidence_receipt_ids: ["fixture-receipt-age-document"],
          subject_key_id: "fixture-subject-key-redacted",
          binding_group_id: "fixture-same-subject-binding",
        },
      ],
    });
    expect(Array.isArray(evaluation.winning_witness)).toBe(true);
    expect(Array.isArray(evaluation.trace)).toBe(true);
    expect(
      SELF_STAGING_18_PLUS_DEVELOPMENT_EVIDENCE.assertions.some(
        (assertion) => assertion.claim_id === "human.unique",
      ),
    ).toBe(false);
  });

  test("pins the reviewed revision hash to its documented canonical preimage", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(CURATED_AGE_18_POLICY_CANONICAL_PREIMAGE),
    );
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(CURATED_AGE_18_POLICY.policy_hash);
    expect(Object.keys(CURATED_AGE_18_POLICY)).not.toContain("provider");
  });

  test("reads threshold and assurance from a content-bound supplied policy", async () => {
    const age21 = await withContentHash({
      ...CURATED_AGE_18_POLICY,
      policy_version_id: "curated-age-v2",
      policy_revision: 2,
      policy_hash: "0".repeat(64),
      minimum_age: "21",
      requirements: [
        { claim_id: "age.minimum", minimum_age: "21" },
        { claim_id: "credential.subject_unique" },
        { claim_id: "document.valid" },
      ],
    });
    expect(evaluate(copyEvidence(), age21)).toMatchObject({
      outcome: "fail",
      reason: "age_below_threshold",
      policy_version_id: "curated-age-v2",
      policy_revision: 2,
      policy_hash: age21.policy_hash,
      winning_witness: [],
    });

    const stronger = await withContentHash({
      ...CURATED_AGE_18_POLICY,
      policy_version_id: "curated-age-holder-live-v1",
      policy_hash: "0".repeat(64),
      required_assurance: "holder_live",
    });
    expect(evaluate(copyEvidence(), stronger)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["wrong_assurance"],
      claim_ids: ["age.minimum", "credential.subject_unique", "document.valid"],
      winning_witness: [],
    });
  });

  test("fails closed for incoherent policy metadata", () => {
    for (const policy of [
      { ...CURATED_AGE_18_POLICY, policy_hash: "not-a-hash" },
      { ...CURATED_AGE_18_POLICY, policy_hash: "c".repeat(64) },
      { ...CURATED_AGE_18_POLICY, policy_revision: 0 },
      {
        ...CURATED_AGE_18_POLICY,
        minimum_age: "21",
        requirements: CURATED_AGE_18_POLICY.requirements,
      },
    ] as CuratedAgePolicy[]) {
      expect(evaluate(copyEvidence(), policy)).toMatchObject({
        outcome: "fail",
        reason: "policy_invalid",
        winning_witness: [],
        trace: ["policy_invalid"],
      });
    }
  });

  test("keeps generic aliases byte-equivalent", () => {
    const input = {
      policy: CURATED_AGE_18_POLICY,
      evidence: {
        kind: "available" as const,
        bundle: SELF_STAGING_18_PLUS_DEVELOPMENT_EVIDENCE,
      },
      now,
    };
    expect(evaluateAge18(input)).toEqual(evaluateCuratedAge(input));
    expect(evaluateCuratedAge18(input)).toEqual(evaluateCuratedAge(input));
  });

  test("uses indeterminate only for explicit source unavailability", () => {
    for (const reason of [
      "provider_unavailable",
      "evidence_store_unavailable",
      "snapshot_unavailable",
    ] as const) {
      expect(
        evaluateCuratedAge({
          policy: CURATED_AGE_18_POLICY,
          evidence: { kind: "indeterminate", reason },
          now,
        }),
      ).toMatchObject({
        outcome: "indeterminate",
        reason,
        winning_witness: [],
        trace: [reason],
      });
    }
  });

  test("missing claims need evidence and human.unique is not a substitute", () => {
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
      winning_witness: [],
    });
  });

  test("valid evidence below the policy threshold fails", () => {
    const evidence = copyEvidence();
    const age = evidence.assertions.find((assertion) => assertion.claim_id === "age.minimum");
    if (age) (age.value as Record<string, unknown>).minimum_age = "17";
    expect(evaluate(evidence)).toMatchObject({
      outcome: "fail",
      reason: "age_below_threshold",
      assertion_id: "fixture-assertion-age-18",
      winning_witness: [],
    });
  });

  test("malformed or internally inconsistent evidence fails as invalid_evidence", () => {
    const cases: Array<(evidence: MutableEvidence) => void> = [
      (evidence) => {
        const document = evidence.assertions.find(
          (assertion) => assertion.claim_id === "document.valid",
        );
        if (document) (document.value as Record<string, unknown>).valid = false;
      },
      (evidence) => {
        const age = evidence.assertions.find((assertion) => assertion.claim_id === "age.minimum");
        if (age) (age.value as Record<string, unknown>).minimum_age = "018";
      },
      (evidence) => {
        if (evidence.assertions[0]) evidence.assertions[0].observed_at = "not-an-instant";
      },
      (evidence) => {
        if (evidence.receipts[0]) evidence.receipts[0].proof_session_id = "foreign-session";
      },
      (evidence) => {
        if (evidence.subject_keys[0]) evidence.subject_keys[0].issuer = "other.issuer";
      },
      (evidence) => {
        const document = evidence.assertions.find(
          (assertion) => assertion.claim_id === "document.valid",
        );
        if (document) document.binding_group_id = "foreign-binding";
      },
    ];
    for (const mutate of cases) {
      const evidence = copyEvidence();
      mutate(evidence);
      expect(evaluate(evidence)).toMatchObject({
        outcome: "fail",
        reason: "invalid_evidence",
        winning_witness: [],
      });
    }
  });

  test("is total over hostile runtime shapes and rejects unknown union members", () => {
    const hostileBundles = [
      (() => {
        const evidence = copyEvidence();
        evidence.assertions[0] = null as unknown as Record<string, unknown>;
        return evidence;
      })(),
      (() => {
        const evidence = copyEvidence();
        const assertion = evidence.assertions[0];
        if (!assertion) throw new Error("fixture assertion missing");
        assertion.value = null;
        return evidence;
      })(),
      (() => {
        const evidence = copyEvidence();
        const receipt = evidence.receipts[0];
        if (!receipt) throw new Error("fixture receipt missing");
        receipt.scope = null;
        return evidence;
      })(),
      (() => {
        const evidence = copyEvidence();
        const assertion = evidence.assertions[0];
        if (!assertion) throw new Error("fixture assertion missing");
        assertion.assurance = "unknown_assurance";
        return evidence;
      })(),
    ];
    for (const evidence of hostileBundles) {
      expect(() => evaluate(evidence)).not.toThrow();
      expect(evaluate(evidence)).toMatchObject({
        outcome: "fail",
        reason: "invalid_evidence",
      });
    }

    expect(
      evaluateCuratedAge({
        policy: CURATED_AGE_18_POLICY,
        evidence: { kind: "indeterminate", reason: "unknown" } as never,
        now,
      }),
    ).toMatchObject({ outcome: "fail", reason: "invalid_evidence" });
  });

  test("invalid evidence outranks an apparent underage decision", () => {
    const evidence = copyEvidence();
    const age = evidence.assertions.find((assertion) => assertion.claim_id === "age.minimum");
    if (age) (age.value as Record<string, unknown>).minimum_age = "17";
    const document = evidence.assertions.find(
      (assertion) => assertion.claim_id === "document.valid",
    );
    if (document) (document.value as Record<string, unknown>).valid = false;
    expect(evaluate(evidence)).toMatchObject({
      outcome: "fail",
      reason: "invalid_evidence",
      trace: ["assertion_invalid"],
    });
  });

  test("duplicate required claims fail as conflicting_evidence", () => {
    const evidence = copyEvidence();
    evidence.assertions.push({ ...evidence.assertions[0], id: "fixture-duplicate-age" });
    expect(evaluate(evidence)).toMatchObject({
      outcome: "fail",
      reason: "conflicting_evidence",
      winning_witness: [],
      trace: ["conflicting_evidence"],
    });
  });

  test("stale, future, and wrong-assurance evidence remain needs_evidence", () => {
    const future = copyEvidence();
    if (future.assertions[0]) future.assertions[0].observed_at = "2026-08-18T13:00:00.000Z";
    expect(evaluate(future)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["observed_in_future"],
    });

    const expired = copyEvidence();
    if (expired.receipts[0]) expired.receipts[0].expires_at = now;
    expect(evaluate(expired)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["evidence_expired"],
    });

    const wrongAssurance = copyEvidence();
    if (wrongAssurance.assertions[0]) wrongAssurance.assertions[0].assurance = "provider_attested";
    expect(evaluate(wrongAssurance)).toMatchObject({
      outcome: "needs_evidence",
      reasons: ["wrong_assurance"],
      claim_ids: ["age.minimum"],
    });
  });

  test("same-subject evidence may span multiple receipts", () => {
    const evidence = copyEvidence();
    const original = evidence.receipts[0];
    if (!original) throw new Error("fixture receipt missing");
    evidence.receipts.push({
      ...original,
      id: "fixture-receipt-second",
      evidence_hash: "c".repeat(64),
    });
    if (evidence.assertions[1])
      evidence.assertions[1].evidence_receipt_id = "fixture-receipt-second";
    expect(evaluate(evidence)).toMatchObject({
      outcome: "pass",
      winning_witness: [
        {
          evidence_receipt_ids: ["fixture-receipt-age-document", "fixture-receipt-second"],
        },
      ],
    });
  });
});
