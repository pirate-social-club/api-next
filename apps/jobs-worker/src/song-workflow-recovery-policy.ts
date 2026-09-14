/** At most three replacement launches per submission. */
export const SONG_WORKFLOW_MAX_REPLACEMENTS = 3;

/**
 * DATA registration keeps its own workflow-revision ceiling until it has a
 * separate replacement budget; its revisions are not shared with song
 * publication and alignment phase changes.
 */
export const DATA_WORKFLOW_MAX_REVISION = 4;

/**
 * Normal publication and alignment phase changes advance the workflow revision
 * without consuming the replacement budget, so the ceiling is counted from the
 * submission's own workflow_replacement_sequence.
 */
export const songWorkflowReplacementLimitReached = (
  replacementSequence: number | bigint,
): boolean => Number(replacementSequence) >= SONG_WORKFLOW_MAX_REPLACEMENTS;

export const dataWorkflowReplacementLimitReached = (workflowRevision: number | bigint): boolean =>
  Number(workflowRevision) >= DATA_WORKFLOW_MAX_REVISION;
