import { Schema } from "effect";
import {
  Assurance,
  CanonicalClaimIdentifier,
  NamedIssuerActionScope,
  NamedIssuerScope,
  SubjectScope,
} from "./claims";

export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export type Sha256Hex = Schema.Schema.Type<typeof Sha256Hex>;

export const ProofSessionStatus = Schema.Literals(["pending", "completed", "failed", "expired"]);
export type ProofSessionStatus = Schema.Schema.Type<typeof ProofSessionStatus>;

/** A provider session is an envelope; it is not itself an assertion. */
export const ProofSession = Schema.Struct({
  id: Schema.NonEmptyString,
  actor_id: Schema.NonEmptyString,
  intent_id: Schema.NonEmptyString,
  request_hash: Sha256Hex,
  provider_id: Schema.NonEmptyString,
  method: Schema.NonEmptyString,
  scope: SubjectScope,
  requested_claim_ids: Schema.NonEmptyArray(CanonicalClaimIdentifier),
  protocol_version: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  status: ProofSessionStatus,
  started_at: Schema.NonEmptyString,
  expires_at: Schema.NonEmptyString,
  completed_at: Schema.optional(Schema.NonEmptyString),
});
export type ProofSession = Schema.Schema.Type<typeof ProofSession>;

/**
 * Receipts are append-only evidence references. The response itself stays out
 * of the domain object; its issuer, explicit scope, hash, protocol metadata,
 * and provenance kind make replay/audit provenance explicit without coupling
 * this package to a provider SDK.
 */
export const EvidenceReceipt = Schema.Struct({
  id: Schema.NonEmptyString,
  proof_session_id: Schema.NonEmptyString,
  provider_id: Schema.NonEmptyString,
  issuer: Schema.NonEmptyString,
  method: Schema.NonEmptyString,
  scope: SubjectScope,
  protocol_version: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  provenance_kind: Schema.Literal("proof_session"),
  evidence_hash: Sha256Hex,
  observed_at: Schema.NonEmptyString,
  expires_at: Schema.optional(Schema.NonEmptyString),
  subject_key_id: Schema.optional(Schema.NonEmptyString),
});
export type EvidenceReceipt = Schema.Schema.Type<typeof EvidenceReceipt>;

/** Uniqueness keys always require an explicit relying-party scope. */
export const SubjectKey = Schema.Struct({
  id: Schema.NonEmptyString,
  issuer: Schema.NonEmptyString,
  method: Schema.NonEmptyString,
  scope: Schema.Union([NamedIssuerScope, NamedIssuerActionScope]),
  subject_digest: Schema.NonEmptyString,
});
export type SubjectKey = Schema.Schema.Type<typeof SubjectKey>;

export const SameSubjectBindingGroup = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literal("same_subject"),
  subject_key_id: Schema.NonEmptyString,
});
export type SameSubjectBindingGroup = Schema.Schema.Type<typeof SameSubjectBindingGroup>;

export const SameReceiptBindingGroup = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literal("same_receipt"),
  evidence_receipt_id: Schema.NonEmptyString,
});
export type SameReceiptBindingGroup = Schema.Schema.Type<typeof SameReceiptBindingGroup>;

/**
 * A binding group is the co-reference boundary. A policy requiring age and
 * personhood together must select assertions in one of these groups rather
 * than combining unrelated provider responses.
 */
export const BindingGroup = Schema.Union([SameSubjectBindingGroup, SameReceiptBindingGroup]);
export type BindingGroup = Schema.Schema.Type<typeof BindingGroup>;

export const Assertion = Schema.Struct({
  id: Schema.NonEmptyString,
  subject_key_id: Schema.optional(Schema.NonEmptyString),
  evidence_receipt_id: Schema.NonEmptyString,
  claim_id: CanonicalClaimIdentifier,
  assurance: Assurance,
  binding_group_id: Schema.NonEmptyString,
  value: Schema.Json,
  observed_at: Schema.NonEmptyString,
  expires_at: Schema.optional(Schema.NonEmptyString),
});
export type Assertion = Schema.Schema.Type<typeof Assertion>;

/** Structural adapter result; cross-record conformance is checked separately. */
export const EvidenceBundle = Schema.Struct({
  id: Schema.NonEmptyString,
  proof_session_id: Schema.NonEmptyString,
  receipts: Schema.Array(EvidenceReceipt),
  subject_keys: Schema.Array(SubjectKey),
  binding_groups: Schema.Array(BindingGroup),
  assertions: Schema.Array(Assertion),
});
export type EvidenceBundle = Schema.Schema.Type<typeof EvidenceBundle>;
