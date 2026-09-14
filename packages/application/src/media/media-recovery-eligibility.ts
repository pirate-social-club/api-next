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
 * publication lineage; a completed, unavailable or stale alignment is not
 * required work.
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
       AND alignment.status='pending'))`;

/**
 * Required media recovery work: a submission still moving through the media
 * pipeline, or a published submission whose exact alignment is still pending.
 */
export const mediaRecoveryRequiredSql = (submission: string): string =>
  `(${submission}.status IN ${liveStatesSql} OR ${pendingPublishedAlignmentSql(submission)})`;

export const isMediaTerminalSubmissionStatus = (status: string): boolean =>
  (MEDIA_TERMINAL_SUBMISSION_STATES as readonly string[]).includes(status);
