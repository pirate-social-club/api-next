/**
 * Pure Spec 013 song-creation machine.  Persistence and provider adapters use
 * this module as a reducer; this file intentionally has no Effect or platform
 * dependency and performs no I/O.
 */

export type MediaTrack = "song";
export type MediaCreationStatus =
  | "processing"
  | "action_required"
  | "manual_review"
  | "published"
  | "blocked"
  | "processing_failed"
  | "abandoned";
export type MediaProcessingPhase =
  | "reserve"
  | "awaiting_upload"
  | "finalize"
  | "analysis"
  | "decision"
  | "publish";

export type MediaCreationEvent =
  | "submission_reserved"
  | "text_input_bound"
  | "media_reservation_issued"
  | "finalize_requested"
  | "author_cancelled"
  | "reservation_expired"
  | "upload_finalized"
  | "upload_expectation_mismatch_recorded"
  | "upload_source_precondition_failed"
  | "seal_conflict_recorded"
  | "blocking_analysis_completed"
  | "review_exhaustion_recorded"
  | "media_failure_recorded"
  | "publication_allowed"
  | "reference_required"
  | "review_required"
  | "policy_blocked"
  | "reference_bound"
  | "action_deadline_elapsed"
  | "moderator_approved"
  | "moderator_blocked"
  | "publication_committed"
  | "technical_exhaustion_recorded"
  | "retry_authorized";

export type MediaFailureReason =
  | "invalid_media"
  | "unsupported_media"
  | "probe_failed"
  | "hash_failed"
  | "transform_failed"
  | "publication_failed"
  | "upload_seal_conflict";
export type MediaAbandonReason =
  | "upload_reservation_expired"
  | "upload_expectation_mismatch"
  | "upload_source_changed_before_finalize"
  | "reference_window_expired"
  | "author_cancelled_before_finalize";

export type MediaSubmissionState = Readonly<{
  submissionId: string;
  operationId: string;
  actorId: string;
  track: MediaTrack;
  creationRevision: number;
  status: MediaCreationStatus;
  phase: MediaProcessingPhase | null;
  reservationId: string | null;
  immutableRef: string | null;
  retryCount: 0 | 1 | 2 | 3;
  retryable: boolean | null;
  lastSafePhase: MediaProcessingPhase | null;
  failureReason: MediaFailureReason | null;
  abandonReason: MediaAbandonReason | null;
  heldRevision: number | null;
  referenceRequestRef: string | null;
  actionExpiresAt: string | null;
  reviewRef: string | null;
  postId: string | null;
}>;

export type MediaTransitionCommand = Readonly<{
  event: MediaCreationEvent;
  actorId: string;
  expectedRevision: number;
  reservationId?: string;
  immutableRef?: string;
  referenceRequestRef?: string;
  actionExpiresAt?: string;
  reviewRef?: string;
  postId?: string;
  submissionId?: string;
  operationId?: string;
  failureReason?: MediaFailureReason;
  abandonReason?: MediaAbandonReason;
  retryable?: boolean;
  retryPhase?: MediaProcessingPhase;
  moderator?: boolean;
}>;

export type MediaSubmissionRejection =
  | { readonly _tag: "action_expired"; readonly submission_id: string }
  | {
      readonly _tag: "actor_not_authorized";
      readonly reason_code:
        | "active_membership_required"
        | "moderator_role_required"
        | "submission_owner_required";
    }
  | {
      readonly _tag: "analysis_evidence_stale";
      readonly expected_revision: number;
      readonly actual_revision: number;
    }
  | {
      readonly _tag: "capability_unavailable";
      readonly capability: "track" | "locked_delivery";
      readonly track: Exclude<MediaTrack, "song">;
    }
  | { readonly _tag: "idempotency_conflict"; readonly submission_id: string }
  | {
      readonly _tag: "reference_binding_invalid";
      readonly reason_code:
        | "asset_not_found"
        | "asset_not_referenceable"
        | "content_hash_mismatch"
        | "evidence_revision_mismatch"
        | "reference_kind_mismatch";
    }
  | {
      readonly _tag: "decision_evidence_invalid";
      readonly reason_code:
        | "required_stage_missing"
        | "input_hash_mismatch"
        | "policy_revision_mismatch"
        | "adapter_revision_mismatch";
    }
  | {
      readonly _tag: "retry_not_allowed";
      readonly reason_code:
        | "failure_not_retryable"
        | "retry_limit_reached"
        | "revision_superseded"
        | "terminal_status";
    }
  | { readonly _tag: "stale_revision"; readonly expected: number; readonly actual: number }
  | {
      readonly _tag: "transition_not_allowed";
      readonly state: MediaCreationStatus | "none";
      readonly event: MediaCreationEvent;
    }
  | {
      readonly _tag: "upload_not_finalized";
      readonly reservation_id: string;
      readonly reason_code: "object_missing" | "ownership_mismatch";
    };

export type MediaTransitionResult =
  | { readonly ok: true; readonly state: MediaSubmissionState }
  | { readonly ok: false; readonly rejection: MediaSubmissionRejection };

const nonEmpty = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const phase = (
  value: MediaProcessingPhase | undefined,
  fallback: MediaProcessingPhase,
): MediaProcessingPhase => value ?? fallback;

/** Returns the durable status/phase pair used by public projections. */
export const stateOf = (
  state: Pick<MediaSubmissionState, "status" | "phase">,
): MediaCreationStatus => state.status;

export const statusPhaseOf = (
  state: Pick<MediaSubmissionState, "status" | "phase">,
): { readonly status: MediaCreationStatus; readonly phase: MediaProcessingPhase | null } => ({
  status: state.status,
  phase: state.phase,
});

/** Returns null for a valid state and a stable defect code otherwise. */
export function mediaSubmissionInvariant(state: MediaSubmissionState): string | null {
  if (!nonEmpty(state.submissionId) || !nonEmpty(state.operationId) || !nonEmpty(state.actorId))
    return "identity";
  if (
    state.track !== "song" ||
    !Number.isSafeInteger(state.creationRevision) ||
    state.creationRevision < 1
  )
    return "revision";
  if (!Number.isInteger(state.retryCount) || state.retryCount < 0 || state.retryCount > 3)
    return "retry_count";
  if (state.status === "processing" && state.phase === null) return "processing_phase";
  if (state.status !== "processing" && state.phase !== null) return "terminal_phase";
  if (
    state.status === "action_required" &&
    (!nonEmpty(state.referenceRequestRef) || !nonEmpty(state.actionExpiresAt))
  )
    return "action_required";
  if (
    state.status === "manual_review" &&
    (!nonEmpty(state.reviewRef) || state.heldRevision !== state.creationRevision)
  )
    return "manual_review";
  if (state.status === "published" && !nonEmpty(state.postId)) return "published_post";
  if (
    state.status === "processing_failed" &&
    (!nonEmpty(state.failureReason) || state.retryable === null)
  )
    return "failed_reason";
  if (state.status === "processing_failed" && state.lastSafePhase === null) return "failed_phase";
  if (state.status === "abandoned" && !nonEmpty(state.abandonReason)) return "abandon_reason";
  if ((state.status === "blocked" || state.status === "abandoned") && state.postId !== null)
    return "terminal_post";
  return null;
}

const rejectTransition = (
  state: MediaSubmissionState | null,
  command: MediaTransitionCommand,
): MediaTransitionResult => ({
  ok: false,
  rejection: {
    _tag: "transition_not_allowed",
    state: state?.status ?? "none",
    event: command.event,
  },
});

const base = (
  state: MediaSubmissionState,
  patch: Partial<MediaSubmissionState>,
): MediaSubmissionState => ({ ...state, ...patch });

/**
 * Applies one explicitly named posting event. Every optimistic fence is
 * checked before the event table, so stale retries never mutate a row.
 */
export function transition(
  current: MediaSubmissionState | null,
  command: MediaTransitionCommand,
): MediaTransitionResult {
  if (!nonEmpty(command.actorId))
    return {
      ok: false,
      rejection: { _tag: "actor_not_authorized", reason_code: "submission_owner_required" },
    };
  if (current === null) {
    if (command.event !== "submission_reserved" || command.expectedRevision !== 0)
      return rejectTransition(current, command);
    const state: MediaSubmissionState = {
      submissionId: command.submissionId ?? "",
      operationId: command.operationId ?? "",
      actorId: command.actorId,
      track: "song",
      creationRevision: 1,
      status: "processing",
      phase: "reserve",
      reservationId: null,
      immutableRef: null,
      retryCount: 0,
      retryable: null,
      lastSafePhase: null,
      failureReason: null,
      abandonReason: null,
      heldRevision: null,
      referenceRequestRef: null,
      actionExpiresAt: null,
      reviewRef: null,
      postId: null,
    };
    return mediaSubmissionInvariant(state) === null
      ? { ok: true, state }
      : rejectTransition(current, command);
  }
  if (mediaSubmissionInvariant(current) !== null) return rejectTransition(current, command);
  if (command.expectedRevision !== current.creationRevision) {
    return {
      ok: false,
      rejection: {
        _tag: "stale_revision",
        expected: command.expectedRevision,
        actual: current.creationRevision,
      },
    };
  }
  if (current.actorId !== command.actorId && !command.moderator) {
    return {
      ok: false,
      rejection: { _tag: "actor_not_authorized", reason_code: "submission_owner_required" },
    };
  }
  const sameReservation =
    command.reservationId === undefined ||
    command.event === "media_reservation_issued" ||
    command.reservationId === current.reservationId;
  const sameObject =
    command.immutableRef === undefined ||
    command.event === "upload_finalized" ||
    command.immutableRef === current.immutableRef;
  if (!sameReservation || !sameObject) return rejectTransition(current, command);

  let next: MediaSubmissionState | null = null;
  switch (command.event) {
    case "media_reservation_issued":
      if (
        current.status === "processing" &&
        current.phase === "reserve" &&
        nonEmpty(command.reservationId)
      )
        next = base(current, { phase: "awaiting_upload", reservationId: command.reservationId });
      break;
    case "finalize_requested":
      if (
        current.status === "processing" &&
        current.phase === "awaiting_upload" &&
        nonEmpty(current.reservationId)
      )
        next = base(current, { phase: "finalize" });
      break;
    case "author_cancelled":
      if (
        current.status === "processing" &&
        (current.phase === "reserve" || current.phase === "awaiting_upload")
      )
        next = base(current, {
          status: "abandoned",
          phase: null,
          abandonReason: command.abandonReason ?? "author_cancelled_before_finalize",
        });
      break;
    case "reservation_expired":
      if (current.status === "processing" && current.phase === "awaiting_upload")
        next = base(current, {
          status: "abandoned",
          phase: null,
          abandonReason: "upload_reservation_expired",
        });
      break;
    case "upload_finalized":
      if (
        current.status === "processing" &&
        current.phase === "finalize" &&
        nonEmpty(command.immutableRef)
      )
        next = base(current, { phase: "analysis", immutableRef: command.immutableRef });
      break;
    case "upload_expectation_mismatch_recorded":
      if (
        current.status === "processing" &&
        (current.phase === "awaiting_upload" || current.phase === "finalize")
      )
        next = base(current, {
          status: "abandoned",
          phase: null,
          abandonReason: "upload_expectation_mismatch",
        });
      break;
    case "upload_source_precondition_failed":
      if (
        current.status === "processing" &&
        (current.phase === "awaiting_upload" || current.phase === "finalize")
      )
        next = base(current, {
          status: "abandoned",
          phase: null,
          abandonReason: "upload_source_changed_before_finalize",
        });
      break;
    case "seal_conflict_recorded":
      if (current.status === "processing" && current.phase === "finalize")
        next = base(current, {
          status: "processing_failed",
          phase: null,
          failureReason: "upload_seal_conflict",
          retryable: false,
          lastSafePhase: "finalize",
        });
      break;
    case "blocking_analysis_completed":
      if (current.status === "processing" && current.phase === "analysis")
        next = base(current, { phase: "decision" });
      break;
    case "review_exhaustion_recorded":
    case "review_required":
      if (
        current.status === "processing" &&
        (current.phase === "analysis" || current.phase === "decision") &&
        nonEmpty(command.reviewRef)
      )
        next = base(current, {
          status: "manual_review",
          phase: null,
          reviewRef: command.reviewRef,
          heldRevision: current.creationRevision,
        });
      break;
    case "media_failure_recorded":
    case "technical_exhaustion_recorded":
      if (
        current.status === "processing" &&
        current.phase !== null &&
        nonEmpty(command.failureReason)
      )
        next = base(current, {
          status: "processing_failed",
          phase: null,
          failureReason: command.failureReason,
          retryable: command.retryable ?? false,
          lastSafePhase: current.phase,
        });
      break;
    case "publication_allowed":
      if (current.status === "processing" && current.phase === "decision")
        next = base(current, { phase: "publish" });
      break;
    case "reference_required":
      if (
        current.status === "processing" &&
        current.phase === "decision" &&
        nonEmpty(command.referenceRequestRef) &&
        nonEmpty(command.actionExpiresAt)
      )
        next = base(current, {
          status: "action_required",
          phase: null,
          referenceRequestRef: command.referenceRequestRef,
          actionExpiresAt: command.actionExpiresAt,
        });
      break;
    case "policy_blocked":
      if (current.status === "processing" && current.phase === "decision")
        next = base(current, { status: "blocked", phase: null });
      break;
    case "reference_bound":
      if (
        current.status === "action_required" &&
        nonEmpty(current.actionExpiresAt) &&
        Date.parse(current.actionExpiresAt) > Date.now() &&
        nonEmpty(current.referenceRequestRef)
      )
        next = base(current, {
          status: "processing",
          phase: "analysis",
          creationRevision: current.creationRevision + 1,
          referenceRequestRef: null,
          actionExpiresAt: null,
          heldRevision: null,
        });
      break;
    case "action_deadline_elapsed":
      if (current.status === "action_required")
        next = base(current, {
          status: "abandoned",
          phase: null,
          abandonReason: "reference_window_expired",
        });
      break;
    case "moderator_approved":
      if (
        current.status === "manual_review" &&
        current.heldRevision === current.creationRevision &&
        command.moderator
      )
        next = base(current, {
          status: "processing",
          phase: "publish",
          reviewRef: null,
          heldRevision: null,
        });
      break;
    case "moderator_blocked":
      if (
        current.status === "manual_review" &&
        current.heldRevision === current.creationRevision &&
        command.moderator
      )
        next = base(current, {
          status: "blocked",
          phase: null,
          reviewRef: null,
          heldRevision: null,
        });
      break;
    case "publication_committed":
      if (
        current.status === "processing" &&
        current.phase === "publish" &&
        nonEmpty(command.postId)
      )
        next = base(current, { status: "published", phase: null, postId: command.postId });
      break;
    case "retry_authorized":
      if (current.status !== "processing_failed")
        return {
          ok: false,
          rejection: { _tag: "retry_not_allowed", reason_code: "terminal_status" },
        };
      if (current.retryable !== true)
        return {
          ok: false,
          rejection: { _tag: "retry_not_allowed", reason_code: "failure_not_retryable" },
        };
      if (current.retryCount >= 3)
        return {
          ok: false,
          rejection: { _tag: "retry_not_allowed", reason_code: "retry_limit_reached" },
        };
      next = base(current, {
        status: "processing",
        phase: phase(command.retryPhase, current.lastSafePhase ?? "analysis"),
        creationRevision: current.creationRevision + 1,
        retryCount: (current.retryCount + 1) as 0 | 1 | 2 | 3,
        failureReason: null,
        retryable: null,
      });
      break;
    case "text_input_bound":
      if (current.status === "processing" && current.phase === "reserve")
        next = base(current, { phase: "analysis" });
      break;
    case "submission_reserved":
      break;
  }
  if (next === null) return rejectTransition(current, command);
  return mediaSubmissionInvariant(next) === null
    ? { ok: true, state: next }
    : rejectTransition(current, command);
}

export const applyMediaSubmissionEvent = transition;
export const createMediaSubmissionState = (
  input: Readonly<{
    readonly submissionId: string;
    readonly operationId: string;
    readonly actorId: string;
  }>,
): MediaSubmissionState => ({
  submissionId: input.submissionId,
  operationId: input.operationId,
  actorId: input.actorId,
  track: "song",
  creationRevision: 1,
  status: "processing",
  phase: "reserve",
  reservationId: null,
  immutableRef: null,
  retryCount: 0,
  retryable: null,
  failureReason: null,
  abandonReason: null,
  lastSafePhase: null,
  heldRevision: null,
  referenceRequestRef: null,
  actionExpiresAt: null,
  reviewRef: null,
  postId: null,
});
export const assertMediaSubmissionInvariant = (state: MediaSubmissionState): void => {
  const issue = mediaSubmissionInvariant(state);
  if (issue !== null) throw new Error(`media_submission_invariant:${issue}`);
};

export const allowedTransitions: Readonly<
  Record<MediaCreationStatus, readonly MediaCreationStatus[]>
> = {
  processing: [
    "processing",
    "action_required",
    "manual_review",
    "published",
    "blocked",
    "processing_failed",
    "abandoned",
  ],
  action_required: ["processing", "abandoned"],
  manual_review: ["processing", "blocked"],
  published: ["published"],
  blocked: ["blocked"],
  processing_failed: ["processing_failed", "processing"],
  abandoned: ["abandoned"],
};
export const mediaSubmissionMachine = {
  stateOf,
  allowedTransitions,
  assertInvariants: assertMediaSubmissionInvariant,
  transition,
} as const;

export type PostTrack = MediaTrack;
export type PostCreationStatus = MediaCreationStatus;
export type PostProcessingPhase = MediaProcessingPhase;
export type PostCreationEvent = MediaCreationEvent;
export type PostCreationRejection = MediaSubmissionRejection;
