/**
 * Shared recovery eligibility for song media work.
 *
 * Candidate selection, the missing-Workflow sweep and the alerting/health SQL
 * all consume these definitions so that a published song whose current,
 * exact-bound alignment is still pending counts as required work everywhere.
 * Persistence and jobs must agree: adding "published" to only one status list
 * would admit completed or inapplicable work, and sharing only the old live
 * status literal would preserve the defect.
 */

export const MEDIA_LIVE_SUBMISSION_STATES = [
  "processing",
  "action_required",
  "manual_review",
] as const;

export const MEDIA_TERMINAL_SUBMISSION_STATES = [
  "blocked",
  "processing_failed",
  "abandoned",
] as const;

const liveStatesSql = `(${MEDIA_LIVE_SUBMISSION_STATES.map((state) => `'${state}'`).join(",")})`;

/**
 * Exact-bound pending alignment for a published submission. The projection must
 * match the submission's post, audio and analysis revisions and its published
 * lyrics revision, and carry the submission's current audio hash through the
 * publication lineage. Unavailable alignment is required work only when an
 * exact operator-authorized recovery remains requested.
 */
export const pendingPublishedAlignmentSql = (submission: string): string => `(
  ${submission}.status='published'
  AND EXISTS (
    SELECT 1
      FROM media_alignment_projections alignment
      JOIN media_publication_projections publication
        ON publication.community_id=${submission}.community_id
       AND publication.actor_user_id=${submission}.actor_user_id
       AND publication.submission_id=${submission}.submission_id
       AND publication.operation_id=${submission}.operation_id
       AND publication.post_id=${submission}.post_id
     WHERE alignment.community_id=${submission}.community_id
       AND alignment.actor_user_id=${submission}.actor_user_id
       AND alignment.submission_id=${submission}.submission_id
       AND alignment.operation_id=${submission}.operation_id
       AND alignment.post_id=${submission}.post_id
       AND alignment.audio_revision=${submission}.audio_revision
       AND alignment.analysis_revision=${submission}.analysis_revision
       AND publication.lyrics_revision IS NOT NULL
       AND alignment.lyrics_revision IS NOT DISTINCT FROM publication.lyrics_revision
       AND alignment.canonical_audio_sha256=publication.canonical_audio_sha256
       AND (alignment.status='pending' OR (
         alignment.status='unavailable' AND EXISTS (
           SELECT 1 FROM media_alignment_recovery_actions recovery
            WHERE recovery.community_id=alignment.community_id
              AND recovery.actor_user_id=alignment.actor_user_id
              AND recovery.submission_id=alignment.submission_id
              AND recovery.operation_id=alignment.operation_id
              AND recovery.post_id=alignment.post_id
              AND recovery.audio_revision=alignment.audio_revision
              AND recovery.analysis_revision=alignment.analysis_revision
              AND recovery.lyrics_revision=alignment.lyrics_revision
              AND recovery.canonical_audio_sha256=alignment.canonical_audio_sha256
              AND recovery.state='requested')))))`;

/**
 * Required media recovery work: a submission still moving through the media
 * pipeline, or a published submission whose exact alignment is still pending.
 */
export const mediaRecoveryRequiredSql = (submission: string): string =>
  `(${submission}.status IN ${liveStatesSql} OR ${pendingPublishedAlignmentSql(submission)})`;

export const isMediaTerminalSubmissionStatus = (status: string): boolean =>
  (MEDIA_TERMINAL_SUBMISSION_STATES as readonly string[]).includes(status);
