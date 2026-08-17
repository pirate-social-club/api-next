import { Schema } from "effect";
import { AssetDescriptor } from "./assets.ts";
import {
  Assurance,
  CanonicalClaimIdentifier,
  NamedIssuerActionScope,
  NamedIssuerScope,
  SubjectBindingIntent,
  SubjectScope,
} from "./claims";
import {
  CanonicalIsoInstant,
  DocumentGenderMarker,
  Iso3166Alpha2,
  NonNegativeIntegerString,
  Sha256Hex,
} from "./scalars.ts";

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
  subject_binding_intent: SubjectBindingIntent,
  protocol_version: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  status: ProofSessionStatus,
  started_at: CanonicalIsoInstant,
  expires_at: CanonicalIsoInstant,
  completed_at: Schema.optional(CanonicalIsoInstant),
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
  evidence_kind: Schema.NonEmptyString,
  evidence_hash: Sha256Hex,
  observed_at: CanonicalIsoInstant,
  expires_at: Schema.optional(CanonicalIsoInstant),
  subject_key_id: Schema.optional(Schema.NonEmptyString),
});
export type EvidenceReceipt = Schema.Schema.Type<typeof EvidenceReceipt>;

/** Uniqueness keys always require an explicit relying-party scope. */
export const SubjectKey = Schema.Struct({
  id: Schema.NonEmptyString,
  issuer: Schema.NonEmptyString,
  method: Schema.NonEmptyString,
  scope: Schema.Union([NamedIssuerScope, NamedIssuerActionScope]),
  subject_digest: Sha256Hex,
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

const AssertionFields = {
  id: Schema.NonEmptyString,
  subject_key_id: Schema.optional(Schema.NonEmptyString),
  evidence_receipt_id: Schema.NonEmptyString,
  assurance: Assurance,
  binding_group_id: Schema.NonEmptyString,
  observed_at: CanonicalIsoInstant,
  expires_at: Schema.optional(CanonicalIsoInstant),
};

const assertion = <Claim extends CanonicalClaimIdentifier, Value extends Schema.Top>(
  claim_id: Claim,
  value: Value,
) =>
  Schema.Struct({
    ...AssertionFields,
    claim_id: Schema.Literal(claim_id),
    value,
  });

/** The discriminator and value are decoded together; arbitrary JSON cannot masquerade as a claim. */
export const Assertion = Schema.Union([
  assertion("human.live", Schema.Struct({ live: Schema.Literal(true) })),
  assertion("human.personhood", Schema.Struct({ personhood: Schema.Literal(true) })),
  assertion("human.unique", Schema.Struct({ unique: Schema.Literal(true) })),
  assertion("credential.subject_unique", Schema.Struct({ subject_unique: Schema.Literal(true) })),
  assertion("document.valid", Schema.Struct({ valid: Schema.Literal(true) })),
  assertion("document.holder_bound", Schema.Struct({ holder_bound: Schema.Literal(true) })),
  assertion(
    "age.minimum",
    Schema.Struct({
      minimum_age: NonNegativeIntegerString.check(
        Schema.makeFilter((value) =>
          BigInt(value) <= 150n ? undefined : "Expected an age no greater than 150",
        ),
      ),
    }),
  ),
  assertion("nationality.allowed", Schema.Struct({ nationality: Iso3166Alpha2 })),
  assertion("gender.marker", Schema.Struct({ gender: DocumentGenderMarker })),
  assertion(
    "asset.ownership",
    Schema.Struct({
      owned: Schema.Literal(true),
      descriptor: AssetDescriptor,
      quantity: NonNegativeIntegerString,
    }),
  ),
  assertion(
    "disclosed.predicate",
    Schema.Struct({ predicate: Schema.NonEmptyString, value: Schema.Json }),
  ),
]);
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
