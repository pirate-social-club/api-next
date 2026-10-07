/**
 * The runner's side of the database run lease. The lease is what stops the
 * isolated stack admitting, signing and sending if this process or its machine
 * is lost: the database refuses once renewals stop, with no help from here.
 * This module only acquires, keeps renewing and releases.
 */
/** @type {Readonly<{ ttlSeconds: number, renewEveryMs: number, maxSeconds: number }>} */
export const leaseTiming = Object.freeze({
  // Long enough to miss a renewal or two, short enough to bound what a lost run can admit.
  ttlSeconds: 180,
  renewEveryMs: 40_000,
  // Placeholder, offer window, settlement and the bounded recovery, with margin.
  // The database refuses renewal past this whatever the runner asks for.
  maxSeconds: 80 * 60,
});

const refusal = (error) => error?.code === "PR003" || error?.code === "PR001";

/**
 * Acquires the lease and keeps it renewed from a timer that does not depend on
 * what the scenario is waiting for. A refused renewal means the lease is gone
 * for good, since an expired lease is never revived: the run must stop
 * initiating work. A renewal that merely could not be asked is tried again, and
 * the lease is treated as lost once its last known expiry has passed.
 *
 * @param {{
 *   lease: {
 *     acquire: (runId: string, ttlSeconds: number, maxSeconds: number) => Promise<string>,
 *     renew: (runId: string, fence: string, ttlSeconds: number) => Promise<string>,
 *     release: (runId: string, fence: string) => Promise<unknown>,
 *   },
 *   runId: string,
 *   timing?: { ttlSeconds: number, renewEveryMs: number, maxSeconds: number },
 *   now?: () => number,
 *   elapsed?: () => number,
 *   setTimer?: (callback: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: any) => void,
 *   onEvent?: (event: { kind: string, [key: string]: unknown }) => void,
 * }} options
 */
export async function holdRunLease({
  lease,
  runId,
  timing = leaseTiming,
  now = Date.now,
  // Validity is measured on a clock that only moves forward. The wall clock can
  // be set back, which would make an expired lease look live; it is kept for
  // the timestamps in evidence only.
  elapsed = () => performance.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
  onEvent = () => {},
}) {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(runId ?? "")) throw Error("Run lease identifier refused");
  const acquiredAt = now();
  const acquiredElapsed = elapsed();
  let fence = await lease.acquire(runId, timing.ttlSeconds, timing.maxSeconds);
  // Counted from before the request, so the local view never outlives the database's.
  let expiresAt = acquiredElapsed + timing.ttlSeconds * 1000;
  const deadline = acquiredElapsed + timing.maxSeconds * 1000;
  // For evidence: where the monotonic instants fall on the wall clock at acquisition.
  const wall = (instant) => new Date(acquiredAt + (instant - acquiredElapsed)).toISOString();
  let lost = null;
  let renewing = null;
  let renewals = 0;
  let released = false;
  const lose = (reason) => {
    if (lost !== null) return;
    lost = reason;
    clearTimer(timer);
    onEvent({ kind: "lost", reason, at: new Date(now()).toISOString() });
  };
  const renew = () => {
    if (lost !== null || released || renewing !== null) return renewing;
    const askedAt = elapsed();
    renewing = (async () => {
      try {
        fence = await lease.renew(runId, fence, timing.ttlSeconds);
        expiresAt = Math.min(askedAt + timing.ttlSeconds * 1000, deadline);
        renewals += 1;
        onEvent({ kind: "renewed", fence: String(fence), at: new Date(now()).toISOString() });
      } catch (error) {
        if (refusal(error)) lose("renewal refused by the database");
        else if (elapsed() >= expiresAt) lose("lease expired while renewal could not be asked");
        else onEvent({ kind: "renewal-unanswered", at: new Date(now()).toISOString() });
      } finally {
        renewing = null;
      }
    })();
    return renewing;
  };
  const timer = setTimer(() => {
    if (elapsed() >= expiresAt) lose("lease expired before it could be renewed");
    else void renew();
  }, timing.renewEveryMs);
  onEvent({ kind: "acquired", fence: String(fence), at: new Date(acquiredAt).toISOString() });
  return {
    runId,
    /** Throws once the lease is gone. Called before every step that initiates work. */
    assertHeld() {
      if (lost === null && !released && elapsed() >= expiresAt)
        lose("lease expired before it could be renewed");
      if (lost !== null) throw Error(`Run lease lost: ${lost}`);
      if (released) throw Error("Run lease already released");
    },
    renewNow: () => renew(),
    state: () => ({
      runId,
      fence: String(fence),
      renewals,
      lost,
      released,
      expiresAt: wall(expiresAt),
      absoluteDeadline: wall(deadline),
    }),
    /**
     * Stops renewing and shortens the lease to now. It is called after the brake
     * is paused, and never resumes anything. A refusal is reported, not hidden:
     * the lease then simply runs out on its own.
     */
    async release() {
      clearTimer(timer);
      if (released) return { released: true, repeated: true };
      await renewing?.catch(() => {});
      released = true;
      try {
        await lease.release(runId, fence);
        onEvent({ kind: "released", at: new Date(now()).toISOString() });
        return { released: true };
      } catch (error) {
        onEvent({ kind: "release-refused", at: new Date(now()).toISOString() });
        return { released: false, refused: refusal(error) };
      }
    },
  };
}
