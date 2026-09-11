import type { HnsRootImportLifecycleStateV1, HnsRootImportPhaseV1 } from "@pirate/domain";

/**
 * Coordinator-reviewed lifecycle projection for spec 012 (2026-09-09
 * amendment) "Activation and the public contract": phase, bounded pending
 * reason, the applicable deadline with its kind, server time, the accepted
 * observation summary, next_check_at with a retry hint, and permitted
 * actions with pending/retry outcomes. The server owns every lifecycle
 * decision; the client only projects it.
 */

export type HnsRootImportPermittedActionV1 =
  | "poll"
  | "acknowledge"
  | "check_publication"
  | "refresh_readiness"
  | "activate"
  | "recover";

export type HnsRootImportLifecycleDeadlineKindV1 = "publication" | "finality";

export type HnsRootImportLifecycleObservationSummaryV1 = Readonly<{
  readonly view: "current" | "safe";
  readonly resource_sha256: string;
  readonly tip_height: number;
  readonly update_inclusion_height: number | null;
  readonly commitment_height: number | null;
}>;

export type HnsRootImportLifecycleProjectionV1 = Readonly<{
  readonly phase: HnsRootImportPhaseV1 | "failed";
  readonly pending_reason: string | null;
  readonly deadline: Readonly<{
    readonly kind: HnsRootImportLifecycleDeadlineKindV1;
    readonly at: string;
  }> | null;
  readonly server_time: string;
  readonly next_check_at: string | null;
  readonly retry_hint_seconds: number | null;
  readonly permitted_actions: readonly HnsRootImportPermittedActionV1[];
  readonly observation: HnsRootImportLifecycleObservationSummaryV1 | null;
}>;

function iso(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

function permittedActions(
  phase: HnsRootImportPhaseV1 | "failed",
): HnsRootImportPermittedActionV1[] {
  switch (phase) {
    case "awaiting_publication":
      return ["poll", "acknowledge"];
    case "checking_publication":
      return ["poll", "check_publication"];
    case "checking_authority":
      return ["poll", "refresh_readiness"];
    case "ready":
      return ["poll", "activate"];
    case "recovery_required":
      return ["poll", "recover"];
    default:
      return ["poll"];
  }
}

/**
 * Projects one lifecycle state. No deadline is active in preparing,
 * checking_authority, ready, or activated; the applicable deadline carries
 * its kind. The retry hint is bounded to one hour for client polling.
 */
export function projectHnsRootImportLifecycleV1(
  state: Readonly<HnsRootImportLifecycleStateV1>,
  input: Readonly<{
    readonly server_now_epoch_ms: number;
    readonly observation?: HnsRootImportLifecycleObservationSummaryV1 | null;
  }>,
): HnsRootImportLifecycleProjectionV1 {
  let deadline: HnsRootImportLifecycleProjectionV1["deadline"] = null;
  if (state.phase === "awaiting_publication" || state.phase === "checking_publication") {
    deadline =
      state.publication_deadline_at_epoch_ms === null
        ? null
        : {
            kind: "publication",
            at: new Date(state.publication_deadline_at_epoch_ms).toISOString(),
          };
  } else if (state.phase === "waiting_safe_commitment") {
    deadline =
      state.finality_deadline_at_epoch_ms === null
        ? null
        : {
            kind: "finality",
            at: new Date(state.finality_deadline_at_epoch_ms).toISOString(),
          };
  }
  const nextCheckAt = iso(state.next_check_at_epoch_ms);
  const retryHint =
    nextCheckAt === null
      ? null
      : Math.max(
          1,
          Math.min(
            3_600,
            Math.ceil((state.next_check_at_epoch_ms! - input.server_now_epoch_ms) / 1_000),
          ),
        );
  return {
    phase: state.phase,
    pending_reason: state.pending_reason,
    deadline,
    server_time: new Date(input.server_now_epoch_ms).toISOString(),
    next_check_at: nextCheckAt,
    retry_hint_seconds: nextCheckAt === null ? null : retryHint,
    permitted_actions: permittedActions(state.phase),
    observation: input.observation ?? null,
  };
}
