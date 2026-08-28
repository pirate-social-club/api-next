/** Initial revision plus at most three replacement launches. */
export const SONG_WORKFLOW_MAX_REVISION = 4;

export const songWorkflowReplacementLimitReached = (workflowRevision: number | bigint): boolean =>
  workflowRevision >= SONG_WORKFLOW_MAX_REVISION;
