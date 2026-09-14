const MINUTE_MS = 60_000;

/**
 * The reviewed workload budget covers 808 removal roots plus 119 replay
 * batches. r16 completed 627 removal batches at ordinary provider latency
 * before its two-hour deadline. Keep the child deadline below its marker
 * validity and the outer supervisor deadline, while all three remain below
 * the provider-branch lifetime.
 */
export const REHEARSAL_PROCESS_TIMEOUT_MS = 225 * MINUTE_MS;
export const REHEARSAL_VALIDITY_MS = 240 * MINUTE_MS;
export const REHEARSAL_SUPERVISOR_TIMEOUT_MS = 240 * MINUTE_MS;
export const REHEARSAL_BRANCH_LIFETIME_MS = 360 * MINUTE_MS;

export const REHEARSAL_CLEANUP_MARGIN_MS =
  REHEARSAL_SUPERVISOR_TIMEOUT_MS - REHEARSAL_PROCESS_TIMEOUT_MS;
