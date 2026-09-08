/**
 * Spec 013 Gate A: plan, attempt and accepted-master binding checks.
 *
 * These are typed identity and containment rules only. Nothing here accepts a
 * provider claim as a verified fact, resolves an unresolved ratification gate,
 * or authorizes abandonment or replacement rendering.
 */

import {
  type AcceptedMasterRevision,
  type CanonicalSongReference,
  SONG_VIDEO_SAMPLE_RATE_HZ,
  type SongVideoOperationalPolicy,
  type SongVideoRenderAttempt,
  type SongVideoRenderPlan,
} from "@pirate/domain";

/** Rejection reasons surface structurally through PlanCheck. */
type PlanRejection =
  | "invalid_timeline"
  | "canonical_song_interval_uncovered"
  | "song_reference_required"
  | "song_fields_not_permitted";

export type PlanCheck =
  | Readonly<{ accepted: true; clipEndSamples: number }>
  | Readonly<{ accepted: false; reason: PlanRejection }>;

/** Rejection reasons surface structurally through MasterCheck. */
type MasterRejection =
  | "plan_mismatch"
  | "attempt_mismatch"
  | "unverified_source"
  | "incomplete_render_decision"
  | "decision_does_not_match_plan"
  | "master_exceeds_configured_ceiling"
  | "identity_substituted";

export type MasterCheck =
  | Readonly<{ accepted: true; masterRevisionId: string }>
  | Readonly<{ accepted: false; reason: MasterRejection }>;

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * Containment in integer sample coordinates, with no tolerance: the selected
 * interval must lie inside the canonical song. A one-sample overrun fails.
 * This constrains time only and says nothing about bytes.
 */
export function checkRenderPlan(plan: SongVideoRenderPlan): PlanCheck {
  const { song, clipStartSamples, clipDurationSamples } = plan;
  if (
    !isNonEmpty(plan.planId) ||
    !isNonEmpty(song.songPostId) ||
    !isNonEmpty(song.songAssetId) ||
    !isCount(song.audioRevision) ||
    !isCount(clipStartSamples) ||
    !Number.isSafeInteger(song.songDurationSamples) ||
    !Number.isSafeInteger(clipDurationSamples) ||
    song.songDurationSamples < 1 ||
    clipDurationSamples < 1
  ) {
    return { accepted: false, reason: "invalid_timeline" };
  }
  const clipEndSamples = clipStartSamples + clipDurationSamples;
  if (!Number.isSafeInteger(clipEndSamples) || clipEndSamples > song.songDurationSamples) {
    return { accepted: false, reason: "canonical_song_interval_uncovered" };
  }
  return { accepted: true, clipEndSamples };
}

/** Convenience for callers holding milliseconds; conversion is exact or it fails. */
export function clipSamplesFromMs(milliseconds: number): number | null {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const samples = (milliseconds * SONG_VIDEO_SAMPLE_RATE_HZ) / 1_000;
  return Number.isSafeInteger(samples) ? samples : null;
}

/**
 * Intent field discipline from D.1. `original_audio` carries no song fields and
 * `song_reference` cannot omit them; the variants reject each other's fields.
 */
export function checkIntentFields(input: {
  readonly intent: "original_audio" | "song_reference";
  readonly songReferencePresent: boolean;
}): PlanCheck {
  if (input.intent === "original_audio") {
    return input.songReferencePresent
      ? { accepted: false, reason: "song_fields_not_permitted" }
      : { accepted: true, clipEndSamples: 0 };
  }
  return input.songReferencePresent
    ? { accepted: true, clipEndSamples: 0 }
    : { accepted: false, reason: "song_reference_required" };
}

/**
 * Binds a sealed master to its plan and attempt. A plan identity alone can
 * never satisfy this: the master must carry a verified source, the complete
 * render decision actually applied, and a renderer policy revision, and its
 * size must be inside the configured ceiling. The ceiling is supplied, never
 * defaulted, because it is an unresolved ratification gate.
 */
export function checkAcceptedMaster(input: {
  readonly plan: SongVideoRenderPlan;
  readonly attempt: SongVideoRenderAttempt;
  readonly master: AcceptedMasterRevision;
  readonly policy: SongVideoOperationalPolicy;
}): MasterCheck {
  const { plan, attempt, master, policy } = input;
  if (attempt.planId !== plan.planId) return { accepted: false, reason: "plan_mismatch" };
  if (master.planId !== plan.planId) return { accepted: false, reason: "plan_mismatch" };
  if (master.attemptId !== attempt.attemptId) {
    return { accepted: false, reason: "attempt_mismatch" };
  }
  if (!isNonEmpty(master.masterRevisionId)) {
    return { accepted: false, reason: "incomplete_render_decision" };
  }
  if (!isNonEmpty(master.verifiedSourceSha256)) {
    return { accepted: false, reason: "unverified_source" };
  }
  // A master that reuses the source digest as its own has had one identity
  // substituted for the other; they are distinct sealed artifacts.
  if (master.masterSha256 === master.verifiedSourceSha256) {
    return { accepted: false, reason: "identity_substituted" };
  }
  if (!isNonEmpty(master.masterSha256) || !Number.isSafeInteger(master.masterByteLength)) {
    return { accepted: false, reason: "incomplete_render_decision" };
  }
  const decision = master.decision;
  if (
    !isNonEmpty(decision.rendererIdentity) ||
    !isCount(decision.rendererPolicyRevision) ||
    !isCount(decision.clipStartSamples) ||
    !Number.isSafeInteger(decision.clipDurationSamples) ||
    decision.clipDurationSamples < 1
  ) {
    return { accepted: false, reason: "incomplete_render_decision" };
  }
  if (
    decision.clipStartSamples !== plan.clipStartSamples ||
    decision.clipDurationSamples !== plan.clipDurationSamples
  ) {
    return { accepted: false, reason: "decision_does_not_match_plan" };
  }
  if (master.masterByteLength < 1 || master.masterByteLength > policy.masterMaxBytes) {
    return { accepted: false, reason: "master_exceeds_configured_ceiling" };
  }
  return { accepted: true, masterRevisionId: master.masterRevisionId };
}

/**
 * Guards the song binding of a master against the frozen reference. A different
 * song, a different audio revision or a different asset is a rejection, not a
 * silent re-resolution.
 */
export function checkSongBinding(input: {
  readonly frozen: CanonicalSongReference;
  readonly observed: CanonicalSongReference;
}): boolean {
  const { frozen, observed } = input;
  return (
    frozen.songPostId === observed.songPostId &&
    frozen.audioRevision === observed.audioRevision &&
    frozen.songAssetId === observed.songAssetId &&
    frozen.songDurationSamples === observed.songDurationSamples
  );
}
