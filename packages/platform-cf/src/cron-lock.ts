/**
 * Pure lease semantics for the scheduled-cron lock, ported from
 * `api/services/api/src/lib/scheduled-cron-lease.ts`. No `cloudflare:workers`
 * import, so it is unit-testable off the Durable Object.
 */

export const CRON_LOCK_NAME = "scheduled-cron-main";

export interface LeaseRecord {
  readonly owner: string;
  readonly expiresAt: number;
}

export interface LeaseDecision {
  readonly acquired: boolean;
  readonly lease: LeaseRecord | null;
}

/**
 * Decides whether `owner` may hold the lease given the current record.
 * Acquires when the lease is free, expired, or already owned by the same
 * owner (renewal); denies only when held by a DIFFERENT owner and not yet
 * expired.
 */
export function evaluateLease(
  current: LeaseRecord | null,
  ttlMs: number,
  owner: string,
  now: number,
): LeaseDecision {
  const heldByOther = current !== null && current.expiresAt > now && current.owner !== owner;
  if (heldByOther) return { acquired: false, lease: current };
  return { acquired: true, lease: { expiresAt: now + ttlMs, owner } };
}
