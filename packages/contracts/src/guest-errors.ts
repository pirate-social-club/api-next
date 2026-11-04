import { Data, Schema } from "effect";
import { GuestIdentifierV1, GuestOperationLocatorV1 } from "./guest-participation.ts";

export const GuestBadRequestDetailsV1 = Schema.Struct({
  reason_code: Schema.Literals([
    "guest_request_invalid",
    "guest_cookie_invalid",
    "guest_cookie_limit_exceeded",
  ]),
});
export const GuestAuthDetailsV1 = Schema.Struct({
  reason_code: Schema.Literals([
    "guest_proof_required",
    "guest_proof_revoked",
    "guest_learning_lease_expired",
    "account_proof_required",
    "guest_origin_or_csrf_invalid",
  ]),
});
export const GuestConflictDetailsV1 = Schema.Union([
  Schema.Struct({
    reason_code: Schema.Literals([
      "guest_authority_conflict",
      "guest_owner_mismatch",
      "guest_recovery_required",
      "guest_credential_cleanup_required",
      "guest_ceremony_cleanup_required",
      "issuance_requires_restart",
      "reward_preview_changed",
      "idempotency_conflict",
      "attachment_target_changed",
      "recipient_selection_conflict",
    ]),
  }),
  Schema.Struct({
    reason_code: Schema.Literal("participation_conflict"),
    outcome_id: GuestIdentifierV1,
  }),
]);
export const GuestPendingDetailsV1 = Schema.Struct({
  reason_code: Schema.Literals([
    "operation_pending_confirmation",
    "learning_finalization_pending",
    "learner_audio_deletion_in_progress",
  ]),
  operation: GuestOperationLocatorV1,
  retry_after_seconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600 })),
});
export class GuestBadRequest extends Data.TaggedError("GuestBadRequest")<{
  readonly message: string;
  readonly details: Schema.Schema.Type<typeof GuestBadRequestDetailsV1>;
}> {
  static readonly detailsSchema = GuestBadRequestDetailsV1;
  static readonly detailsRequired = true;
  readonly status = 400 as const;
  readonly code = "bad_request" as const;
  readonly retryable = false as const;
}
export class GuestAuthError extends Data.TaggedError("GuestAuthError")<{
  readonly message: string;
  readonly details: Schema.Schema.Type<typeof GuestAuthDetailsV1>;
}> {
  static readonly detailsSchema = GuestAuthDetailsV1;
  static readonly detailsRequired = true;
  readonly status = 401 as const;
  readonly code = "auth_error" as const;
  readonly retryable = false as const;
}
export class GuestConflict extends Data.TaggedError("GuestConflict")<{
  readonly message: string;
  readonly details: Schema.Schema.Type<typeof GuestConflictDetailsV1>;
}> {
  static readonly detailsSchema = GuestConflictDetailsV1;
  static readonly detailsRequired = true;
  readonly status = 409 as const;
  readonly code = "conflict" as const;
  readonly retryable = false as const;
}
export class GuestPendingConflict extends Data.TaggedError("GuestPendingConflict")<{
  readonly message: string;
  readonly details: Schema.Schema.Type<typeof GuestPendingDetailsV1>;
}> {
  static readonly detailsSchema = GuestPendingDetailsV1;
  static readonly detailsRequired = true;
  static readonly retryAfterHeader = {
    minimumSeconds: 1,
    maximumSeconds: 3_600,
    pattern: "^(?:[1-9]|[1-9][0-9]|[1-9][0-9]{2}|[12][0-9]{3}|3[0-5][0-9]{2}|3600)$",
    detailsKey: "retry_after_seconds",
  } as const;
  readonly status = 409 as const;
  readonly code = "conflict" as const;
  readonly retryable = true as const;
}

/** Closed serialization also protects error messages from proof-shaped diagnostic text. */
export function closedGuestError(error: unknown) {
  const known =
    error instanceof GuestBadRequest ||
    error instanceof GuestAuthError ||
    error instanceof GuestConflict ||
    error instanceof GuestPendingConflict;
  if (!known) return undefined;
  const schema =
    error instanceof GuestBadRequest
      ? GuestBadRequestDetailsV1
      : error instanceof GuestAuthError
        ? GuestAuthDetailsV1
        : error instanceof GuestConflict
          ? GuestConflictDetailsV1
          : GuestPendingDetailsV1;
  try {
    Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(error.details);
  } catch {
    return {
      status: 500,
      error: { code: "internal_error", message: "Internal server error", retryable: false },
    };
  }
  return {
    status: error.status,
    error: {
      code: error.code,
      message:
        error instanceof GuestPendingConflict
          ? "Operation awaiting confirmation"
          : "Guest request refused",
      retryable: error.retryable,
      details: error.details,
    },
    ...(error instanceof GuestPendingConflict
      ? { headers: { "Retry-After": String(error.details.retry_after_seconds) } }
      : {}),
  };
}
