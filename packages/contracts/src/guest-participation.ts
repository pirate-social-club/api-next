import { Schema } from "effect";

/** Nonsecret locators. A locator never supplies ownership proof. */
export const GuestIdentifierV1 = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[^\s]+$/u),
  Schema.makeFilter((value) =>
    [...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
      ? "Expected a bounded identifier"
      : undefined,
  ),
);
export const GuestCredentialIdV1 = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{21}[AQgw]$/u),
);
export const GuestAttachmentIntentIdV1 = Schema.String.check(
  Schema.isPattern(/^gai_[A-Za-z0-9_-]{21}[AQgw]$/u),
);
export const GuestSha256V1 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const GuestInstantV1 = Schema.String.check(
  Schema.isMaxLength(24),
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);
export const GuestPositiveIntegerV1 = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
export const GuestCountV1 = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const GuestAtomicAmountV1 = Schema.String.check(
  Schema.isMaxLength(78),
  Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u),
);
export const GuestDrawingIdV1 = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u),
);
export const GuestOperationKindV1 = Schema.Literals([
  "bootstrap_issue",
  "bootstrap_confirm",
  "authority_renew",
  "credential_rotate",
  "credential_acknowledge",
  "credential_cleanup",
  "attachment_intent",
  "attachment_prepare",
  "attachment_confirm",
  "study_start",
  "study_answer",
  "learning_retention",
  "learner_audio_deletion",
  "recipient_selection",
  "owner_claim",
]);
export type GuestOperationKindV1 = Schema.Schema.Type<typeof GuestOperationKindV1>;
export const GuestOperationLocatorV1 = Schema.Struct({
  operation_kind: GuestOperationKindV1,
  idempotency_key: GuestIdentifierV1,
  operation_id: Schema.NullOr(GuestIdentifierV1),
});
export type GuestOperationLocatorV1 = Schema.Schema.Type<typeof GuestOperationLocatorV1>;

export const GuestCredentialMetadataV1 = Schema.Struct({
  owner_id: GuestIdentifierV1,
  credential_id: GuestCredentialIdV1,
  credential_state: Schema.Literals([
    "pending_bootstrap",
    "pending_successor",
    "confirmed",
    "revoked",
  ]),
  session_until: Schema.NullOr(GuestInstantV1),
});
export type GuestCredentialMetadataV1 = Schema.Schema.Type<typeof GuestCredentialMetadataV1>;
const authorityFields = {
  object: Schema.Literal("guest_authority"),
  state: Schema.Literals([
    "absent",
    "pending",
    "confirmed",
    "recovery_required",
    "authority_conflict",
    "credential_cleanup_required",
  ]),
  selected: Schema.NullOr(GuestCredentialMetadataV1),
  pointer_repair: Schema.NullOr(
    Schema.Struct({
      previous_credential_id: GuestCredentialIdV1,
      credential_id: GuestCredentialIdV1,
      owner_id: GuestIdentifierV1,
    }),
  ),
};
export const GuestAuthorityV1 = Schema.Struct({
  ...authorityFields,
  proved_credentials: Schema.Array(GuestCredentialMetadataV1).check(Schema.isMaxLength(4)),
});
export const GuestCleanupAuthorityV1 = Schema.Struct({
  ...authorityFields,
  proved_credentials: Schema.Array(GuestCredentialMetadataV1).check(Schema.isMaxLength(16)),
});
export type GuestAuthorityV1 = Schema.Schema.Type<typeof GuestAuthorityV1>;
export type GuestCleanupAuthorityV1 = Schema.Schema.Type<typeof GuestCleanupAuthorityV1>;

export const GuestParticipationResultV1 = Schema.Union([
  Schema.Struct({
    state: Schema.Literals([
      "practice_only",
      "not_yet_qualified",
      "already_participating",
      "entry_closed",
      "unavailable",
      "ineligible",
    ]),
  }),
  Schema.Struct({
    state: Schema.Literal("pending_confirmation"),
    operation: GuestOperationLocatorV1,
  }),
  Schema.Struct({
    state: Schema.Literal("admitted"),
    share_id: GuestIdentifierV1,
    original_drawing_id: GuestDrawingIdV1,
    pool_leg_id: GuestIdentifierV1,
  }),
]);
export type GuestParticipationResultV1 = Schema.Schema.Type<typeof GuestParticipationResultV1>;

/** Unknown COMMIT holds this original draw, including after its safety deadline. */
export const GuestParticipationProjectionV1 = Schema.Struct({
  participation_id: GuestIdentifierV1,
  original_drawing_id: GuestDrawingIdV1,
  pool_leg_id: GuestIdentifierV1,
  admission_state: Schema.Literals([
    "pending_confirmation",
    "admitted",
    "already_participating",
    "entry_closed",
    "unavailable",
    "ineligible",
  ]),
  purchase_state: Schema.Literals([
    "not_requested",
    "held_unresolved_admission",
    "pending",
    "confirmed",
    "unavailable",
  ]),
  purchase_safety_deadline_at: GuestInstantV1,
  reconciliation_state: Schema.Literals(["pending", "resolved"]),
  purchase_deadline_passed: Schema.Boolean,
  allocation_id: Schema.NullOr(GuestIdentifierV1),
  credit_id: Schema.NullOr(GuestIdentifierV1),
  amount_atomic: Schema.NullOr(GuestAtomicAmountV1),
}).check(
  Schema.makeFilter((value) => {
    if (
      value.admission_state === "pending_confirmation" &&
      (value.reconciliation_state !== "pending" ||
        value.purchase_state !== "held_unresolved_admission" ||
        value.allocation_id !== null ||
        value.credit_id !== null ||
        value.amount_atomic !== null)
    ) {
      return "Unresolved admission holds its original draw without an allocation promise";
    }
    if (
      value.amount_atomic !== null &&
      (value.purchase_state !== "confirmed" || value.allocation_id === null)
    )
      return "Allocation requires confirmed purchase evidence";
    if (value.credit_id !== null && (value.amount_atomic === null || value.amount_atomic === "0"))
      return "Only a positive committed allocation has a credit";
    return undefined;
  }),
);
export type GuestParticipationProjectionV1 = Schema.Schema.Type<
  typeof GuestParticipationProjectionV1
>;

export const GuestProofLocatorHeadersV1 = Schema.Struct({
  "x-guest-credential-id": Schema.optional(GuestCredentialIdV1),
});
export const GuestBrowserLimitsV1 = {
  jsonBodyBytes: 4_096,
  cookieHeaderBytes: 16_384,
  credentials: 4,
  ceremonies: 4,
  cleanupCredentials: 16,
  cleanupCeremonies: 16,
  pendingSeconds: 900,
  attachmentSeconds: 900,
  learningLeaseSeconds: 3_600,
  studySessionSeconds: 86_400,
  cookieMaxAgeSeconds: 34_560_000,
  audioBodyBytes: 524_288,
  audioDurationMs: 60_000,
} as const;
