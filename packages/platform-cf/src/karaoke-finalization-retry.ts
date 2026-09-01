export const KARAOKE_FINALIZATION_RETRY_BASE_MS = 30_000;
export const KARAOKE_FINALIZATION_RETRY_MAX_MS = 15 * 60_000;
export const KARAOKE_FINALIZATION_LOCAL_ATTEMPT_LIMIT = 8;

export type KaraokeFinalizationAxisState = "pending" | "stored" | "exhausted";

export interface KaraokeFinalizationFailureTransition {
  readonly attempts: number;
  readonly lastFailureAt: number;
  readonly nextAttemptAt: number;
  readonly state: Extract<KaraokeFinalizationAxisState, "pending" | "exhausted">;
}

export function karaokeFinalizationRetryDelay(attempts: number): number {
  const exponent = Math.max(0, Math.min(30, attempts - 1));
  return Math.min(
    KARAOKE_FINALIZATION_RETRY_MAX_MS,
    KARAOKE_FINALIZATION_RETRY_BASE_MS * 2 ** exponent,
  );
}

export function karaokeFinalizationFailureTransition(input: {
  readonly attempts: number;
  readonly now: number;
  readonly exhaustionEnabled: boolean;
}): KaraokeFinalizationFailureTransition {
  const attempts = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, input.attempts) + 1);
  if (input.exhaustionEnabled && attempts >= KARAOKE_FINALIZATION_LOCAL_ATTEMPT_LIMIT) {
    return { attempts, lastFailureAt: input.now, nextAttemptAt: 0, state: "exhausted" };
  }
  return {
    attempts,
    lastFailureAt: input.now,
    nextAttemptAt: input.now + karaokeFinalizationRetryDelay(attempts),
    state: "pending",
  };
}
