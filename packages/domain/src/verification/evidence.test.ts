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
  protocol_version: "zkpassport-v2",
  environment: "production",
  provenance_kind: "proof_session",
  evidence_hash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
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
      provenance_kind: "proof_session",
      evidence_hash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
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
        value: { minimum_age: 18 },
        observed_at: "2026-08-17T00:00:00.000Z",
      }),
    ];
    expect(sharedAssertions.map((assertion) => assertion.binding_group_id)).toEqual([
      "binding-1",
      "binding-1",
    ]);
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
      method: "document-nullifier",
      scope: {
        kind: "named",
        scope_semantics: "issuer_rp_scope",
        issuer: "zkpassport",
        rp_scope: "pirate.example",
      },
      requested_claim_ids: ["document.valid", "credential.subject_unique"],
      protocol_version: "zkpassport-v2",
      environment: "production",
      status: "completed",
      started_at: "2026-08-17T00:00:00.000Z",
      expires_at: "2026-08-18T00:00:00.000Z",
    });
    expect(session.scope.kind).toBe("named");
    expect(session.requested_claim_ids).toEqual(["document.valid", "credential.subject_unique"]);
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
        requested_claim_ids: [],
        protocol_version: "fake-v2",
        environment: "test",
        status: "pending",
        started_at: "2026-08-17T00:00:00.000Z",
        expires_at: "2026-08-18T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
