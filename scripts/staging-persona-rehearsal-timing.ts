const MINUTE_MS = 60_000;

/**
 * r16 proved that the reviewed 808 removal batches can exceed two hours at
 * ordinary provider latency before replay begins. Keep the child deadline
 * below its marker validity and the outer supervisor deadline, while all
 * three remain below the launcher's six-hour provider-branch lifetime.
 */
export const REHEARSAL_PROCESS_TIMEOUT_MS = 225 * MINUTE_MS;
export const REHEARSAL_VALIDITY_MS = 240 * MINUTE_MS;
export const REHEARSAL_SUPERVISOR_TIMEOUT_MS = 240 * MINUTE_MS;

export const REHEARSAL_CLEANUP_MARGIN_MS =
  REHEARSAL_SUPERVISOR_TIMEOUT_MS - REHEARSAL_PROCESS_TIMEOUT_MS;
