import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { evaluateNationality } from "./nationality-evaluator.ts";
import { compileNationalityPolicy, NationalityPolicy } from "./nationality-policy.ts";

function authoring(overrides: Record<string, unknown> = {}) {
  return {
    policy_revision: 1,
    allowed_countries: ["US"],
    evidence_lifetime: { kind: "no_age_limit" },
    // Fixtures stand in for configurations supplied by accepted server-side planning.
    provider_bindings: ["self.pass", "zkpassport"].map((provider_id) => ({
      provider_id,
      provider_configuration: { kind: "dynamic", reference: `test:${provider_id}`, version: "1" },
      method: "document",
      protocol_version: provider_id === "self.pass" ? "self-pass-v1" : "zkpassport-v2",
      scope: {
        kind: "named",
        scope_semantics: "issuer_rp_scope",
        issuer: provider_id,
        rp_scope: "test",
      },
      environment: "test",
    })),
    ...overrides,
  };
}

function policy(overrides: Record<string, unknown> = {}): NationalityPolicy {
  const result = compileNationalityPolicy(authoring(overrides));
  if (result.kind !== "compiled") throw new Error(`Fixture did not compile: ${result.reason}`);
  return result.policy;
}

function fixture(provider: "self.pass" | "zkpassport" = "zkpassport") {
  const compiled = policy();
  const binding = compiled.provider_bindings[provider === "self.pass" ? 0 : 1];
  const accountBinding = {
    account_id: "account-1",
    subject_key_id: "subject-1",
    binding_epoch: "2",
    binding_event_id: "binding-1",
  };
  return {
    policy: compiled,
    account_id: "account-1",
    now: "2026-09-12T12:00:00.000Z",
    evidence: {
      kind: "available",
      candidate: {
        proof_session: {
          ...binding,
          id: "session-1",
          actor_id: "account-1",
          intent_id: "original-intent",
          request_hash: "a".repeat(64),
          request_mode: "dynamic",
          requested_requirements: [compiled.requirement],
          requested_claim_ids: ["nationality.allowed"],
          subject_binding_intent: "establish",
          status: "completed",
          started_at: "2020-01-01T00:00:00.000Z",
          completed_at: "2020-01-01T00:01:00.000Z",
          expires_at: "2020-01-01T00:10:00.000Z",
        },
        receipt: {
          ...binding,
          id: "receipt-1",
          proof_session_id: "session-1",
          issuer: provider,
          provenance_kind: "proof_session",
          evidence_kind: "verified-document",
          evidence_hash: "b".repeat(64),
          observed_at: "2020-01-01T00:01:00.000Z",
          subject_key_id: "subject-1",
        },
        assertion: {
          id: "assertion-1",
          subject_key_id: "subject-1",
          evidence_receipt_id: "receipt-1",
          assurance: "document_zk",
          binding_group_id: "group-1",
          observed_at: "2020-01-01T00:01:00.000Z",
          claim_id: "nationality.allowed",
          value: { allowed: true },
        },
        subject_key: {
          id: "subject-1",
          issuer: provider,
          method: "document",
          scope: binding.scope,
          subject_digest: "c".repeat(64),
        },
        binding_group: { id: "group-1", kind: "same_subject", subject_key_id: "subject-1" },
        receipt_account_id: "account-1",
        assertion_account_id: "account-1",
        recorded_binding: { ...accountBinding },
        active_binding: { ...accountBinding },
        revalidation: "accepted",
      },
    },
  };
}

describe("nationality policy compilation", () => {
  test("normalizes and deduplicates valid countries before hashing", () => {
    expect(policy({ allowed_countries: [" usa ", "CA", "us", "can"] })).toEqual(
      policy({ allowed_countries: ["CA", "US"] }),
    );
    const compiled = policy();
    const preimage =
      '{"requirement":{"allowed_countries":["US"],"claim_id":"nationality.allowed"},"version":"nationality-requirement-v1"}';
    expect(compiled.requirement_hash).toBe(createHash("sha256").update(preimage).digest("hex"));
    // Frozen vectors use test-only provider bindings, not a production lifetime default.
    expect(compiled.requirement_hash).toBe(
      "3e239a80d8cc26df524c7b83c83fdaedd12fbe0a38a369f06279951402f21c6d",
    );
    expect(compiled.policy_hash).toBe(
      "db556c192d5ad9156b5bf99e619f1a0d13963a2d4e6c0d78023149155122fac7",
    );
    expect(
      Schema.decodeUnknownOption(NationalityPolicy, { onExcessProperty: "error" })(compiled)._tag,
    ).toBe("Some");
  });

  test("provider order is not author preference and does not change policy identity", () => {
    expect(policy({ provider_bindings: authoring().provider_bindings.reverse() })).toEqual(
      policy(),
    );
  });

  test.each([
    { allowed_countries: [] },
    { allowed_countries: ["ZZ"] },
    { allowed_countries: ["US", "not a country"] },
    { excluded_countries: ["US"] },
    { evidence_lifetime: undefined },
    { evidence_lifetime: {} },
    { evidence_lifetime: { kind: "max_age_seconds", seconds: 0 } },
    { evidence_lifetime: { kind: "max_age_seconds", seconds: -1 } },
    { evidence_lifetime: { kind: "max_age_seconds", seconds: 1.5 } },
    { evidence_lifetime: { kind: "max_age_seconds", seconds: Number.MAX_SAFE_INTEGER + 1 } },
    { evidence_lifetime: { kind: "no_age_limit", seconds: 10 } },
    { policy_revision: 0 },
    { provider_bindings: [] },
    { provider_bindings: authoring().provider_bindings.slice(0, 1) },
    { provider_bindings: [authoring().provider_bindings[0], authoring().provider_bindings[0]] },
  ])("rejects incomplete or unsupported policy input %j", (overrides) => {
    expect(compileNationalityPolicy(authoring(overrides)).kind).toBe("unsupported");
  });

  test("requires provider issuer and protocol parity", () => {
    const input = authoring();
    const binding = input.provider_bindings[0];
    if (binding === undefined) throw new Error("Missing fixture binding");
    binding.protocol_version = "zkpassport-v2";
    expect(compileNationalityPolicy(input).kind).toBe("unsupported");
    binding.protocol_version = "self-pass-v1";
    binding.scope.issuer = "zkpassport";
    expect(compileNationalityPolicy(input).kind).toBe("unsupported");
  });

  test("requirement identity excludes revision and lifetime; policy identity includes them", () => {
    const original = policy();
    for (const changed of [
      policy({ policy_revision: 2 }),
      policy({ evidence_lifetime: { kind: "max_age_seconds", seconds: 3600 } }),
    ]) {
      expect(changed.requirement_hash).toBe(original.requirement_hash);
      expect(changed.policy_hash).not.toBe(original.policy_hash);
    }
    expect(policy({ allowed_countries: ["CA", "US"] }).requirement_hash).not.toBe(
      original.requirement_hash,
    );
  });

  test.each(["policy_hash", "requirement_hash"] as const)("rejects tampered %s", (field) => {
    const input = fixture();
    input.policy = { ...input.policy, [field]: "0".repeat(64) };
    expect(evaluateNationality(input)).toEqual({ outcome: "fail", reason: "invalid_input" });
  });
});

describe("predicate-bound nationality evidence", () => {
  test.each(["self.pass", "zkpassport"] as const)(
    "accepts %s with explicit no age limit after ceremony timeout",
    (provider) => {
      const input = fixture(provider);
      expect(evaluateNationality(input)).toEqual({
        outcome: "pass",
        policy_hash: input.policy.policy_hash,
        requirement_hash: input.policy.requirement_hash,
        winning_witness: [
          {
            assertion_ids: ["assertion-1"],
            evidence_receipt_ids: ["receipt-1"],
            subject_key_id: "subject-1",
            binding_group_id: "group-1",
          },
        ],
      });
    },
  );

  test("permits reuse across policy revisions with the same normalized requirement", () => {
    const input = fixture();
    input.policy = policy({ policy_revision: 2, allowed_countries: ["usa", "US"] });
    expect(evaluateNationality(input).outcome).toBe("pass");
  });

  test.each([{ countries: ["CA"] }, { countries: ["CA", "US"] }])(
    "requires fresh proof for a different requested allowlist %j",
    ({ countries }) => {
      const input = fixture();
      input.policy = policy({ allowed_countries: countries });
      expect(evaluateNationality(input)).toMatchObject({
        outcome: "needs_evidence",
        reason: "requirement_changed",
      });
    },
  );

  test("does not infer a subset predicate from a larger allowlist", () => {
    const input = fixture();
    input.evidence.candidate.proof_session.requested_requirements = [
      policy({ allowed_countries: ["CA", "US"] }).requirement,
    ];
    expect(evaluateNationality(input)).toMatchObject({
      outcome: "needs_evidence",
      reason: "requirement_changed",
    });
  });

  const corruptions: [string, (input: ReturnType<typeof fixture>) => void][] = [
    [
      "different account",
      (i) => {
        i.account_id = "account-2";
      },
    ],
    [
      "different receipt owner",
      (i) => {
        i.evidence.candidate.receipt_account_id = "account-2";
      },
    ],
    [
      "different assertion owner",
      (i) => {
        i.evidence.candidate.assertion_account_id = "account-2";
      },
    ],
    [
      "stale binding epoch",
      (i) => {
        i.evidence.candidate.active_binding.binding_epoch = "3";
      },
    ],
    [
      "changed binding event",
      (i) => {
        i.evidence.candidate.active_binding.binding_event_id = "binding-2";
      },
    ],
    [
      "foreign binding subject",
      (i) => {
        i.evidence.candidate.active_binding.subject_key_id = "subject-2";
        i.evidence.candidate.recorded_binding.subject_key_id = "subject-2";
      },
    ],
    [
      "foreign session",
      (i) => {
        i.evidence.candidate.receipt.proof_session_id = "session-2";
      },
    ],
    [
      "foreign receipt",
      (i) => {
        i.evidence.candidate.assertion.evidence_receipt_id = "receipt-2";
      },
    ],
    [
      "foreign subject",
      (i) => {
        i.evidence.candidate.receipt.subject_key_id = "subject-2";
      },
    ],
    [
      "foreign binding group",
      (i) => {
        i.evidence.candidate.binding_group.subject_key_id = "subject-2";
      },
    ],
    [
      "unproven assertion",
      (i) => {
        i.evidence.candidate.assertion.value.allowed = false;
      },
    ],
    [
      "wrong assurance",
      (i) => {
        i.evidence.candidate.assertion.assurance = "provider_attested";
      },
    ],
    [
      "unfinished ceremony",
      (i) => {
        i.evidence.candidate.proof_session.status = "pending";
      },
    ],
    [
      "late completion",
      (i) => {
        i.evidence.candidate.proof_session.completed_at =
          i.evidence.candidate.proof_session.expires_at;
      },
    ],
    [
      "future completion",
      (i) => {
        i.now = "2020-01-01T00:00:30.000Z";
      },
    ],
    [
      "future assertion",
      (i) => {
        i.evidence.candidate.assertion.observed_at = "2027-01-01T00:00:00.000Z";
      },
    ],
    [
      "unbound subject",
      (i) => {
        i.evidence.candidate.proof_session.subject_binding_intent = "none";
      },
    ],
    [
      "wrong claim list",
      (i) => {
        i.evidence.candidate.proof_session.requested_claim_ids = ["age.minimum"];
      },
    ],
    [
      "mixed protocol",
      (i) => {
        i.evidence.candidate.proof_session.protocol_version = "other";
      },
    ],
    [
      "mixed environment",
      (i) => {
        i.evidence.candidate.proof_session.environment = "production";
      },
    ],
    [
      "mixed scope",
      (i) => {
        i.evidence.candidate.subject_key.scope = {
          ...i.evidence.candidate.subject_key.scope,
          rp_scope: "other",
        };
      },
    ],
  ];
  test.each(corruptions)("fails closed on %s", (_name, corrupt) => {
    const input = fixture();
    corrupt(input);
    expect(evaluateNationality(input).outcome).toBe("fail");
  });

  test("rejects disclosed-country assertions instead of creating a country profile", () => {
    const input = fixture("self.pass");
    const candidate = input.evidence.candidate;
    expect(
      evaluateNationality({
        ...input,
        evidence: {
          ...input.evidence,
          candidate: {
            ...candidate,
            assertion: {
              ...candidate.assertion,
              value: { allowed: true, disclosed_nationality: "US" },
            },
          },
        },
      }).outcome,
    ).toBe("fail");
  });

  test("rechecks accepted provider configuration even for otherwise reusable evidence", () => {
    const input = fixture();
    const bindings = authoring().provider_bindings;
    for (const binding of bindings) binding.provider_configuration.version = "2";
    input.policy = policy({ provider_bindings: bindings });
    expect(evaluateNationality(input)).toMatchObject({
      outcome: "needs_evidence",
      reason: "provider_binding_changed",
    });
  });

  test.each(["receipt", "assertion"] as const)(
    "honors explicit %s expiry even with no age limit",
    (kind) => {
      const input = fixture();
      const candidate = input.evidence.candidate;
      expect(
        evaluateNationality({
          ...input,
          evidence: {
            ...input.evidence,
            candidate: { ...candidate, [kind]: { ...candidate[kind], expires_at: input.now } },
          },
        }),
      ).toMatchObject({ outcome: "needs_evidence", reason: "expired" });
    },
  );

  test("enforces maximum age at the exact boundary and rechecks stricter consuming lifetime", () => {
    const input = fixture();
    input.policy = policy({ evidence_lifetime: { kind: "max_age_seconds", seconds: 3600 } });
    input.now = "2020-01-01T01:00:59.999Z";
    expect(evaluateNationality(input).outcome).toBe("pass");
    input.now = "2020-01-01T01:01:00.000Z";
    expect(evaluateNationality(input)).toMatchObject({
      outcome: "needs_evidence",
      reason: "expired",
    });
  });

  test.each(["revoked", "rejected"])(
    "requires fresh evidence after revalidation %s",
    (revalidation) => {
      const input = fixture();
      input.evidence.candidate.revalidation = revalidation;
      expect(evaluateNationality(input)).toMatchObject({
        outcome: "needs_evidence",
        reason: "revoked",
      });
    },
  );

  test("distinguishes missing evidence from unavailable evidence and revalidation", () => {
    const input = fixture();
    expect(
      evaluateNationality({ ...input, evidence: { kind: "available", candidate: null } }),
    ).toMatchObject({ outcome: "needs_evidence", reason: "missing" });
    expect(
      evaluateNationality({
        ...input,
        evidence: { kind: "indeterminate", reason: "provider_unavailable" },
      }),
    ).toMatchObject({ outcome: "indeterminate", reason: "provider_unavailable" });
    input.evidence.candidate.revalidation = "indeterminate";
    expect(evaluateNationality(input)).toMatchObject({
      outcome: "indeterminate",
      reason: "evidence_store_unavailable",
    });
  });

  test("missing lifetime and malformed caller data never throw or imply unlimited validity", () => {
    const input = fixture();
    expect(
      evaluateNationality({ ...input, policy: { ...input.policy, evidence_lifetime: undefined } })
        .outcome,
    ).toBe("fail");
    for (const malformed of [null, [], {}, "US", { ...input, now: "2026-02-30T00:00:00.000Z" }]) {
      expect(evaluateNationality(malformed)).toEqual({ outcome: "fail", reason: "invalid_input" });
    }
  });

  test.each(["receipt", "assertion"] as const)(
    "a fresh %s cannot refresh older evidence by replay",
    (kind) => {
      const input = fixture();
      input.policy = policy({ evidence_lifetime: { kind: "max_age_seconds", seconds: 3600 } });
      input.evidence.candidate[kind].observed_at = input.now;
      expect(evaluateNationality(input)).toMatchObject({
        outcome: "needs_evidence",
        reason: "expired",
      });
    },
  );

  test("rejects a nationality boolean attached to an age-only request", () => {
    const input = fixture();
    const candidate = input.evidence.candidate;
    expect(
      evaluateNationality({
        ...input,
        evidence: {
          ...input.evidence,
          candidate: {
            ...candidate,
            proof_session: {
              ...candidate.proof_session,
              requested_requirements: [{ claim_id: "age.minimum", minimum_age: "18" }],
              requested_claim_ids: ["age.minimum"],
            },
          },
        },
      }),
    ).toEqual({ outcome: "fail", reason: "invalid_evidence" });
  });

  test("rejects optional country fields even when explicitly undefined", () => {
    const input = fixture();
    const candidate = input.evidence.candidate;
    expect(
      evaluateNationality({
        ...input,
        evidence: {
          ...input.evidence,
          candidate: {
            ...candidate,
            assertion: {
              ...candidate.assertion,
              value: { allowed: true, disclosed_nationality: undefined },
            },
          },
        },
      }).outcome,
    ).toBe("fail");
  });
});
