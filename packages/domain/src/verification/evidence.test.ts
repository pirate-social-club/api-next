import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  Assertion,
  BindingGroup,
  EvidenceBundle,
  EvidenceReceipt,
  ProofSession,
  SameReceiptBindingGroup,
  SameSubjectBindingGroup,
  SubjectKey,
} from "./evidence";

const subjectKey = {
  id: "subject-1",
  issuer: "zkpassport",
  method: "document-nullifier",
  scope: {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: "zkpassport",
    rp_scope: "pirate.example",
  },
  subject_digest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
};

const receipt = {
  id: "receipt-1",
  proof_session_id: "session-1",
  provider_id: "zkpassport",
  issuer: "zkpassport",
  method: "document-nullifier",
  scope: {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: "zkpassport",
    rp_scope: "pirate.example",
  },
  provider_configuration: { kind: "dynamic", reference: "zk-query", version: "1" },
  protocol_version: "zkpassport-v2",
  environment: "production",
  provenance_kind: "proof_session",
  evidence_kind: "document",
  evidence_hash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  metadata: { credential_type: "passport", source_attestation_id: "1" },
  observed_at: "2026-08-17T00:00:00.000Z",
  expires_at: "2026-08-18T00:00:00.000Z",
  subject_key_id: "subject-1",
};

describe("verification evidence ledger shapes", () => {
  test("subject keys cannot omit relying-party scope", () => {
    expect(Schema.decodeUnknownSync(SubjectKey)(subjectKey)).toMatchObject({
      scope: { rp_scope: "pirate.example", scope_semantics: "issuer_rp_scope" },
    });
    expect(() =>
      Schema.decodeUnknownSync(SubjectKey)({
        id: "subject-1",
        issuer: "zkpassport",
        method: "document-nullifier",
        scope: {
          kind: "named",
          scope_semantics: "issuer_rp_scope",
          issuer: "zkpassport",
          rp_scope: "",
        },
        subject_digest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      }),
    ).toThrow();
  });

  test("receipt metadata is provider-neutral and auditable", () => {
    expect(Schema.decodeUnknownSync(EvidenceReceipt)(receipt)).toMatchObject({
      protocol_version: "zkpassport-v2",
      environment: "production",
      issuer: "zkpassport",
      provider_configuration: { kind: "dynamic", reference: "zk-query", version: "1" },
      provenance_kind: "proof_session",
      evidence_kind: "document",
      evidence_hash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      metadata: { credential_type: "passport", source_attestation_id: "1" },
    });
    expect(() =>
      Schema.decodeUnknownSync(EvidenceReceipt)({
        ...receipt,
        scope: undefined,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EvidenceReceipt)({
        ...receipt,
        evidence_hash: "sha256:not-canonical",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EvidenceReceipt)({
        ...receipt,
        metadata: { invalid: Number.POSITIVE_INFINITY },
      }),
    ).toThrow();
  });

  test("binding groups make co-reference an explicit witness property", () => {
    const sameSubject = {
      id: "binding-1",
      kind: "same_subject",
      subject_key_id: "subject-1",
    } as const;
    const sameReceipt = {
      id: "binding-2",
      kind: "same_receipt",
      evidence_receipt_id: "receipt-1",
    } as const;

    expect(Schema.decodeUnknownSync(SameSubjectBindingGroup)(sameSubject)).toEqual(sameSubject);
    expect(Schema.decodeUnknownSync(SameReceiptBindingGroup)(sameReceipt)).toEqual(sameReceipt);
    expect(Schema.decodeUnknownSync(BindingGroup)(sameSubject)).toEqual(sameSubject);
    expect(() =>
      Schema.decodeUnknownSync(BindingGroup)({ id: "binding-1", kind: "same_subject" }),
    ).toThrow();

    const sharedAssertions = [
      Schema.decodeUnknownSync(Assertion)({
        id: "assertion-personhood",
        subject_key_id: "subject-1",
        evidence_receipt_id: "receipt-1",
        claim_id: "human.personhood",
        assurance: "personhood",
        binding_group_id: "binding-1",
        value: { personhood: true },
        observed_at: "2026-08-17T00:00:00.000Z",
      }),
      Schema.decodeUnknownSync(Assertion)({
        id: "assertion-age",
        subject_key_id: "subject-1",
        evidence_receipt_id: "receipt-1",
        claim_id: "age.minimum",
        assurance: "document_zk",
        binding_group_id: "binding-1",
        value: { minimum_age: "18" },
        observed_at: "2026-08-17T00:00:00.000Z",
      }),
    ];
    expect(sharedAssertions.map((assertion) => assertion.binding_group_id)).toEqual([
      "binding-1",
      "binding-1",
    ]);
  });

  test("binds each canonical claim discriminator to its value schema", () => {
    const common = {
      id: "assertion-holder",
      subject_key_id: "subject-1",
      evidence_receipt_id: "receipt-1",
      assurance: "document_zk",
      binding_group_id: "binding-1",
      observed_at: "2026-08-17T00:00:00.000Z",
    } as const;

    expect(
      Schema.decodeUnknownSync(Assertion)({
        ...common,
        claim_id: "document.holder_bound",
        value: { holder_bound: true },
      }).claim_id,
    ).toBe("document.holder_bound");
    expect(() =>
      Schema.decodeUnknownSync(Assertion)({
        ...common,
        claim_id: "document.holder_bound",
        value: { live: true },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Assertion)({
        ...common,
        claim_id: "age.minimum",
        value: { minimum_age: "151" },
      }),
    ).toThrow();
    for (const minimum_age of [18, "01", "-1", "1.5"]) {
      expect(() =>
        Schema.decodeUnknownSync(Assertion)({
          ...common,
          claim_id: "age.minimum",
          value: { minimum_age },
        }),
      ).toThrow();
    }
    expect(
      Schema.decodeUnknownSync(Assertion)({
        ...common,
        claim_id: "nationality.allowed",
        value: { allowed: true },
      }).value,
    ).toEqual({ allowed: true });
    expect(
      Schema.decodeUnknownSync(Assertion)({
        ...common,
        claim_id: "nationality.allowed",
        value: { allowed: true, disclosed_nationality: "GE" },
      }).value,
    ).toEqual({ allowed: true, disclosed_nationality: "GE" });
    for (const value of [{ allowed: false }, { nationality: "GE" }]) {
      expect(() =>
        Schema.decodeUnknownSync(Assertion)({
          ...common,
          claim_id: "nationality.allowed",
          value,
        }),
      ).toThrow();
    }
  });

  test("aggregates an adapter verification result without enforcing relationships", () => {
    const bundle = Schema.decodeUnknownSync(EvidenceBundle)({
      id: "bundle-1",
      proof_session_id: "session-1",
      receipts: [receipt],
      subject_keys: [subjectKey],
      binding_groups: [
        {
          id: "binding-1",
          kind: "same_subject",
          subject_key_id: "subject-1",
        },
      ],
      assertions: [
        {
          id: "assertion-unique",
          subject_key_id: "subject-1",
          evidence_receipt_id: "receipt-1",
          claim_id: "credential.subject_unique",
          assurance: "document_zk",
          binding_group_id: "binding-1",
          value: { subject_unique: true },
          observed_at: "2026-08-17T00:00:00.000Z",
        },
      ],
    });
    expect(bundle.receipts).toHaveLength(1);
    expect(bundle.subject_keys).toHaveLength(1);
    expect(bundle.binding_groups).toHaveLength(1);
    expect(bundle.assertions).toHaveLength(1);
  });

  test("ZKPassport document assertions can carry credential subject uniqueness without liveness", () => {
    const session = Schema.decodeUnknownSync(ProofSession)({
      id: "session-1",
      actor_id: "user-1",
      intent_id: "intent-1",
      request_hash: "1111111111111111111111111111111111111111111111111111111111111111",
      provider_id: "zkpassport",
      upstream_session_ref: "zk-request-1",
      method: "document-nullifier",
      scope: {
        kind: "named",
        scope_semantics: "issuer_rp_scope",
        issuer: "zkpassport",
        rp_scope: "pirate.example",
      },
      request_mode: "dynamic",
      provider_configuration: { kind: "dynamic", reference: "zk-query", version: "1" },
      requested_requirements: [
        { claim_id: "credential.subject_unique" },
        { claim_id: "document.valid" },
      ],
      requested_claim_ids: ["credential.subject_unique", "document.valid"],
      subject_binding_intent: "establish",
      protocol_version: "zkpassport-v2",
      environment: "production",
      status: "completed",
      started_at: "2026-08-17T00:00:00.000Z",
      expires_at: "2026-08-18T00:00:00.000Z",
    });
    expect(session.scope.kind).toBe("named");
    expect(session.upstream_session_ref).toBe("zk-request-1");
    expect(session.requested_claim_ids).toEqual(["credential.subject_unique", "document.valid"]);
    expect(session.expires_at).toBe("2026-08-18T00:00:00.000Z");

    const key = Schema.decodeUnknownSync(SubjectKey)(subjectKey);
    const assertion = Schema.decodeUnknownSync(Assertion)({
      id: "assertion-unique",
      subject_key_id: "subject-1",
      evidence_receipt_id: "receipt-1",
      claim_id: "credential.subject_unique",
      assurance: "document_zk",
      binding_group_id: "binding-1",
      value: { subject_unique: true },
      observed_at: "2026-08-17T00:00:00.000Z",
    });
    expect(key.scope.kind).toBe("named");
    expect(assertion.claim_id).toBe("credential.subject_unique");
    expect(assertion.assurance).toBe("document_zk");
  });

  test("proof sessions require at least one requested claim", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProofSession)({
        id: "session-empty",
        actor_id: "user-1",
        intent_id: "intent-1",
        request_hash: "1".repeat(64),
        provider_id: "test.fake",
        method: "document",
        scope: {
          kind: "named",
          scope_semantics: "issuer_rp_scope",
          issuer: "test.fake",
          rp_scope: "pirate.example",
        },
        request_mode: "dynamic",
        provider_configuration: { kind: "dynamic", reference: "fake-query", version: "1" },
        requested_requirements: [],
        requested_claim_ids: [],
        subject_binding_intent: "establish",
        protocol_version: "fake-v2",
        environment: "test",
        status: "pending",
        started_at: "2026-08-17T00:00:00.000Z",
        expires_at: "2026-08-18T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
