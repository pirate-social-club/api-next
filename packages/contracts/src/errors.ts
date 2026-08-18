import { Data } from "effect";

/**
 * api-next-owned v2 wire-error catalog (api-next 000 §10; 001 phase 0 step 2).
 *
 * The error body is intentionally not the former top-level envelope. It is
 * `{ error: { code, message, retryable, details? }, request_id? }`; this is a
 * clean-break contract and makes the ownership/version boundary explicit.
 * Unknown failures collapse to `internal_error` with a redacted message — raw
 * exception text can carry database URLs, shard routing, or driver internals
 * and must never reach a client.
 */

interface WireArgs {
  readonly message: string;
  readonly details?: Record<string, unknown> | null;
}

/** Gate failures always carry structured evaluation evidence. */
interface GateFailedArgs {
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export class AuthError extends Data.TaggedError("AuthError")<WireArgs> {
  readonly status = 401 as const;
  readonly code = "auth_error" as const;
  readonly retryable = false as const;
}

export class BadRequest extends Data.TaggedError("BadRequest")<WireArgs> {
  readonly status = 400 as const;
  readonly code = "bad_request" as const;
  readonly retryable = false as const;
}

export class PaymentRequired extends Data.TaggedError("PaymentRequired")<WireArgs> {
  readonly status = 402 as const;
  readonly code = "payment_required" as const;
  // api-next v2 explicitly keeps payment_required retryable.
  readonly retryable = true as const;
}

export class VerificationRequired extends Data.TaggedError("VerificationRequired")<WireArgs> {
  readonly status = 403 as const;
  readonly code = "verification_required" as const;
  readonly retryable = false as const;
}

export class EligibilityFailed extends Data.TaggedError("EligibilityFailed")<WireArgs> {
  readonly status = 403 as const;
  readonly code = "eligibility_failed" as const;
  readonly retryable = false as const;
}

export class MembershipRequired extends Data.TaggedError("MembershipRequired")<WireArgs> {
  readonly status = 403 as const;
  readonly code = "membership_required" as const;
  readonly retryable = false as const;
}

export class Banned extends Data.TaggedError("Banned")<WireArgs> {
  readonly status = 403 as const;
  readonly code = "banned" as const;
  readonly retryable = false as const;
}

export class CommentsLocked extends Data.TaggedError("CommentsLocked")<WireArgs> {
  readonly status = 403 as const;
  readonly code = "comments_locked" as const;
  readonly retryable = false as const;
}

export class GateUnsatisfied extends Data.TaggedError("GateUnsatisfied")<WireArgs> {
  readonly status = 403 as const;
  readonly code = "gate_unsatisfied" as const;
  readonly retryable = false as const;
}

export class GateFailed extends Data.TaggedError("GateFailed")<GateFailedArgs> {
  readonly status = 403 as const;
  readonly code = "gate_failed" as const;
  readonly retryable = false as const;
}

export class RateLimited extends Data.TaggedError("RateLimited")<WireArgs> {
  readonly status = 429 as const;
  readonly code = "rate_limited" as const;
  readonly retryable = true as const;
}

/** Non-retryable 409; the old `conflictError`. */
export class Conflict extends Data.TaggedError("Conflict")<WireArgs> {
  readonly status = 409 as const;
  readonly code = "conflict" as const;
  readonly retryable = false as const;
}

/** Same wire code as {@link Conflict} but retryable; the old `retryableConflictError`. */
export class RetryableConflict extends Data.TaggedError("RetryableConflict")<WireArgs> {
  readonly status = 409 as const;
  readonly code = "conflict" as const;
  readonly retryable = true as const;
}

/** A start lease is held by another request; clients may retry this request. */
export class VerificationStartInProgress extends Data.TaggedError("VerificationStartInProgress")<
  WireArgs & { readonly retry_after_seconds: number }
> {
  readonly status = 409 as const;
  readonly code = "verification_start_in_progress" as const;
  readonly retryable = true as const;
}

/** The intent already has a terminal session; callers must create a new intent. */
export class VerificationStartNewIntentRequired extends Data.TaggedError(
  "VerificationStartNewIntentRequired",
)<WireArgs> {
  readonly status = 409 as const;
  readonly code = "verification_new_intent_required" as const;
  readonly retryable = false as const;
}

/**
 * Open coded-conflict channel (old `codedConflictError`): a 409 a client can
 * act on programmatically — "quote expired, start over" must be
 * distinguishable from "already consumed, never resubmit". New codes join
 * this class; the catalog's fixed codes stay closed.
 */
export class CodedConflict extends Data.TaggedError("CodedConflict")<
  WireArgs & { readonly code: string }
> {
  readonly status = 409 as const;
  readonly retryable = false as const;
}

export class TelegramStudyUnavailable extends Data.TaggedError(
  "TelegramStudyUnavailable",
)<WireArgs> {
  readonly status = 409 as const;
  readonly code = "telegram_study_unavailable" as const;
  readonly retryable = false as const;
}

export class SongContentHashMismatch extends Data.TaggedError("SongContentHashMismatch")<WireArgs> {
  readonly status = 422 as const;
  readonly code = "song_content_hash_mismatch" as const;
  // Retrying re-downloads the same bytes and fails identically.
  readonly retryable = false as const;
}

export class AnalysisBlocked extends Data.TaggedError("AnalysisBlocked")<WireArgs> {
  readonly status = 422 as const;
  readonly code = "analysis_blocked" as const;
  readonly retryable = false as const;
}

export class CommentMediaRejected extends Data.TaggedError("CommentMediaRejected")<WireArgs> {
  readonly status = 400 as const;
  readonly code = "comment_media_rejected" as const;
  readonly retryable = false as const;
}

export class NotFound extends Data.TaggedError("NotFound")<WireArgs> {
  readonly status = 404 as const;
  readonly code = "not_found" as const;
  readonly retryable = false as const;
}

export class NamespaceUnavailable extends Data.TaggedError("NamespaceUnavailable")<WireArgs> {
  readonly status = 503 as const;
  readonly code = "namespace_unavailable" as const;
  readonly retryable = true as const;
}

export class StructuredSurfaceDisabled extends Data.TaggedError(
  "StructuredSurfaceDisabled",
)<WireArgs> {
  readonly status = 403 as const;
  readonly code = "structured_surface_disabled" as const;
  readonly retryable = false as const;
}

export class VerifierContractIncompatible extends Data.TaggedError(
  "VerifierContractIncompatible",
)<WireArgs> {
  readonly status = 503 as const;
  readonly code = "verifier_contract_incompatible" as const;
  // Only a verifier redeploy can fix this; retrying cannot.
  readonly retryable = false as const;
}

export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<WireArgs> {
  readonly status = 502 as const;
  readonly code = "provider_unavailable" as const;
  readonly retryable = true as const;
}

/**
 * Terminal provider failure — the old `providerUnavailable(msg, details,
 * retryable: false)` call sites (invalid campaign config, unsupported chain,
 * bad RPC URL, inconsistent guardrails). Same wire code as
 * {@link ProviderUnavailable}; a separate member rather than an override,
 * because a `retryable` constructor prop is silently clobbered by the class
 * field initializer, and retryability is a property of the error type
 * (000 §7), never a boolean on an instance.
 */
export class ProviderMisconfigured extends Data.TaggedError("ProviderMisconfigured")<WireArgs> {
  readonly status = 502 as const;
  readonly code = "provider_unavailable" as const;
  readonly retryable = false as const;
}

export class FundingConfirmationTimeout extends Data.TaggedError(
  "FundingConfirmationTimeout",
)<WireArgs> {
  readonly status = 504 as const;
  readonly code = "funding_confirmation_timeout" as const;
  readonly retryable = true as const;
}

export class InternalError extends Data.TaggedError("InternalError")<WireArgs> {
  readonly status = 500 as const;
  readonly code = "internal_error" as const;
  readonly retryable = false as const;
}

export class NotImplemented extends Data.TaggedError("NotImplemented")<WireArgs> {
  readonly status = 501 as const;
  readonly code = "not_implemented" as const;
  readonly retryable = false as const;
}

/** The closed catalog of fixed-code wire errors. */
export type ApiError =
  | AuthError
  | BadRequest
  | PaymentRequired
  | VerificationRequired
  | EligibilityFailed
  | MembershipRequired
  | Banned
  | CommentsLocked
  | GateUnsatisfied
  | GateFailed
  | RateLimited
  | Conflict
  | RetryableConflict
  | VerificationStartInProgress
  | VerificationStartNewIntentRequired
  | CodedConflict
  | TelegramStudyUnavailable
  | SongContentHashMismatch
  | AnalysisBlocked
  | CommentMediaRejected
  | NotFound
  | NamespaceUnavailable
  | StructuredSurfaceDisabled
  | VerifierContractIncompatible
  | ProviderUnavailable
  | ProviderMisconfigured
  | FundingConfirmationTimeout
  | InternalError
  | NotImplemented;

/** api-next-owned v2 error envelope. */
export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown> | null;
  };
  readonly request_id?: string;
}

const hasWireShape = (u: unknown): u is ApiError =>
  u instanceof Error && "status" in u && "code" in u && "retryable" in u;

/** Serialize any thrown value to the api-next v2 envelope, redacting unknowns. */
export function toErrorBody(
  error: unknown,
  requestId?: string,
): {
  readonly status: number;
  readonly body: ErrorBody;
  readonly headers?: Readonly<Record<string, string>>;
} {
  const requestIdField = requestId === undefined ? {} : { request_id: requestId };
  if (hasWireShape(error)) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details ? { details: error.details } : {}),
        },
        ...requestIdField,
      },
      ...(error.code === "verification_start_in_progress" &&
      typeof (error as { readonly retry_after_seconds?: unknown }).retry_after_seconds ===
        "number" &&
      Number.isSafeInteger(
        (error as { readonly retry_after_seconds: number }).retry_after_seconds,
      ) &&
      (error as { readonly retry_after_seconds: number }).retry_after_seconds >= 1 &&
      (error as { readonly retry_after_seconds: number }).retry_after_seconds <= 86_400
        ? {
            headers: {
              "Retry-After": String(
                (error as { readonly retry_after_seconds: number }).retry_after_seconds,
              ),
            },
          }
        : {}),
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "Internal server error",
        // Unknown failures may be transient (deploy rollover, network blip);
        // deliberate terminal failures must use a typed error above.
        retryable: true,
      },
      ...requestIdField,
    },
  };
}
