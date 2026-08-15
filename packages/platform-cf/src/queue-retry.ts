// The single shared queue retry-delay policy (000 §8). The old API carried
// two subtly different copies of this function (content-security consumer and
// reward-qualification wakeup consumer); both computed min 5s, doubling per
// attempt, capped at 300s with the exponent clamped to 6. api-next has
// exactly one, and adds the jitter the old runner lacked (000 §7): full
// jitter over the upper half of the window so synchronized failures do not
// stampede the producer on the shared floor.

export const QUEUE_RETRY_BASE_SECONDS = 5;
export const QUEUE_RETRY_CAP_SECONDS = 300;
const MAX_EXPONENT = 6;

/** Deterministic exponential backoff shared by every queue consumer. */
export function queueRetryBackoffSeconds(attempts: number): number {
  const exponent = Math.min(MAX_EXPONENT, Math.max(0, attempts - 1));
  return Math.min(
    QUEUE_RETRY_CAP_SECONDS,
    Math.max(QUEUE_RETRY_BASE_SECONDS, QUEUE_RETRY_BASE_SECONDS * 2 ** exponent),
  );
}

/**
 * Jittered delay for `message.retry({ delaySeconds })`: uniform over
 * [backoff/2, backoff], whole seconds, never below the base floor. `random`
 * is injectable so tests are deterministic.
 */
export function queueRetryDelaySeconds(
  attempts: number,
  random: () => number = Math.random,
): number {
  const backoff = queueRetryBackoffSeconds(attempts);
  const jittered = Math.round(backoff / 2 + random() * (backoff / 2));
  return Math.max(QUEUE_RETRY_BASE_SECONDS, Math.min(QUEUE_RETRY_CAP_SECONDS, jittered));
}
