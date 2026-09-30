import { ProviderUnavailable, RewardsPaused } from "@pirate/contracts";

export const REWARD_OPERATIONS_CACHE_MS = 5_000;

/** A successful read is cached from its start time. Expired reads cannot admit work. */
export function makeRewardOperationsGuard(options: {
  readonly readRunning: () => Promise<boolean>;
  readonly now?: () => number;
}): () => Promise<void> {
  const now = options.now ?? Date.now;
  let cached: { readonly running: boolean; readonly expiresAt: number } | undefined;
  return async () => {
    if (cached === undefined || now() >= cached.expiresAt) {
      const startedAt = now();
      try {
        const running = await options.readRunning();
        cached = { running, expiresAt: startedAt + REWARD_OPERATIONS_CACHE_MS };
      } catch {
        cached = undefined;
        throw new ProviderUnavailable({ message: "Rewards control is unavailable" });
      }
    }
    if (now() >= cached.expiresAt) {
      throw new ProviderUnavailable({ message: "Rewards control is unavailable" });
    }
    if (!cached.running) {
      throw new RewardsPaused({ message: "Rewards are paused" });
    }
  };
}
