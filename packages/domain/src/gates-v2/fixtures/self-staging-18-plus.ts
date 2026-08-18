import type { EvidenceBundle } from "../../verification/index.ts";

/**
 * Synthetic, redacted development evidence derived from the staging report.
 *
 * This is intentionally not a captured ceremony: all identifiers are local
 * fixture labels and there is no real session, nullifier, proof, passport, or
 * document data. Do not describe this fixture as physical-document evidence.
 */
export const SELF_STAGING_18_PLUS_DEVELOPMENT_EVIDENCE: EvidenceBundle = {
  id: "fixture-self-staging-18-plus",
  proof_session_id: "fixture-proof-session-redacted",
  receipts: [
    {
      id: "fixture-receipt-age-document",
      proof_session_id: "fixture-proof-session-redacted",
      provider_id: "self.pass",
      issuer: "self.pass",
      method: "document",
      scope: {
        kind: "named",
        scope_semantics: "issuer_rp_scope",
        issuer: "self.pass",
        rp_scope: "pirate-social",
      },
      provider_configuration: {
        kind: "dynamic",
        reference: "fixture-self-staging-configuration",
        version: "1.2.0-beta.1",
      },
      protocol_version: "self-pass-v1",
      environment: "staging",
      provenance_kind: "proof_session",
      evidence_kind: "self.pass.attestation.1",
      evidence_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      observed_at: "2026-08-18T08:00:00.000Z",
      subject_key_id: "fixture-subject-key-redacted",
      metadata: {
        credential_type: "passport",
        source_attestation_id: "1",
      },
    },
  ],
  subject_keys: [
    {
      id: "fixture-subject-key-redacted",
      issuer: "self.pass",
      method: "document",
      scope: {
        kind: "named",
        scope_semantics: "issuer_rp_scope",
        issuer: "self.pass",
        rp_scope: "pirate-social",
      },
      subject_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  ],
  binding_groups: [
    {
      id: "fixture-same-subject-binding",
      kind: "same_subject",
      subject_key_id: "fixture-subject-key-redacted",
    },
  ],
  assertions: [
    {
      id: "fixture-assertion-age-18",
      claim_id: "age.minimum",
      value: { minimum_age: "18" },
      subject_key_id: "fixture-subject-key-redacted",
      evidence_receipt_id: "fixture-receipt-age-document",
      assurance: "document_zk",
      binding_group_id: "fixture-same-subject-binding",
      observed_at: "2026-08-18T08:00:00.000Z",
    },
    {
      id: "fixture-assertion-subject-unique",
      claim_id: "credential.subject_unique",
      value: { subject_unique: true },
      subject_key_id: "fixture-subject-key-redacted",
      evidence_receipt_id: "fixture-receipt-age-document",
      assurance: "document_zk",
      binding_group_id: "fixture-same-subject-binding",
      observed_at: "2026-08-18T08:00:00.000Z",
    },
    {
      id: "fixture-assertion-document-valid",
      claim_id: "document.valid",
      value: { valid: true },
      subject_key_id: "fixture-subject-key-redacted",
      evidence_receipt_id: "fixture-receipt-age-document",
      assurance: "document_zk",
      binding_group_id: "fixture-same-subject-binding",
      observed_at: "2026-08-18T08:00:00.000Z",
    },
  ],
};

export const SELF_STAGING_18_PLUS_EVALUATION_NOW = "2026-08-18T12:00:00.000Z";
