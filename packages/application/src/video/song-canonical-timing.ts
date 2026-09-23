/**
 * Measuring a song's canonical duration, once per song post and audio revision.
 *
 * The measurement is the renderer's: the prober decodes the canonical audio the
 * way the renderer will, at 48 kHz, and counts samples. That is the only number
 * containment may be checked against, so a measurement that cannot be taken is
 * left pending or recorded as failed — it is never replaced by an estimate.
 *
 * The prober is a port. Which host runs it is the Spec 013 U.2 execution path;
 * selecting that path authorizes no execution on staging by itself.
 */

/** A song revision waiting to be measured, with the bytes it must be measured from. */
export type PendingSongTiming = Readonly<{
  songPostId: string;
  audioRevision: number;
  canonicalAudioSha256: string;
  audioAssetRef: string;
}>;

export type CanonicalSongProbe =
  | Readonly<{ ok: true; durationSamples: number }>
  /** Permanent for these bytes: the revision cannot back a video. */
  | Readonly<{
      ok: false;
      permanent: true;
      failureCode: "source_digest_mismatch" | "undecodable_audio";
    }>
  /** Transient: the measurement is retried and the revision stays pending. */
  | Readonly<{ ok: false; permanent: false; failureCode: "probe_unavailable" }>;

export interface CanonicalSongProber {
  readonly identity: string;
  readonly policyRevision: number;
  /**
   * Reads the canonical audio, verifies it is the expected bytes, decodes it at
   * 48 kHz as the renderer will, and returns the decoded sample count.
   */
  readonly measure: (input: PendingSongTiming) => Promise<CanonicalSongProbe>;
}

/** One song revision named by an operator for measurement. */
export type SongTimingTarget = Readonly<{ songPostId: string; audioRevision: number }>;

export interface SongCanonicalTimingStore {
  /** Claims up to `limit` pending revisions, skipping any another worker holds. */
  readonly claimPending: (limit: number) => Promise<readonly PendingSongTiming[]>;
  /**
   * Claims exactly the named revision under the same lease and locking as
   * `claimPending`, or returns null when it is absent, not pending, leased or
   * locked by another worker. No other revision is read or changed.
   */
  readonly claimPendingFor: (target: SongTimingTarget) => Promise<PendingSongTiming | null>;
  /** Records a measured fact. Idempotent for an identical measurement. */
  readonly complete: (
    input: PendingSongTiming &
      Readonly<{ durationSamples: number; proberIdentity: string; proberPolicyRevision: number }>,
  ) => Promise<void>;
  readonly fail: (input: PendingSongTiming & Readonly<{ failureCode: string }>) => Promise<void>;
}

export type SongTimingMeasurementOutcome = Readonly<{
  measured: number;
  failed: number;
  deferred: number;
}>;

type ClaimedMeasurement =
  | Readonly<{ status: "measured"; durationSamples: number }>
  | Readonly<{ status: "failed"; failureCode: string }>
  | Readonly<{ status: "deferred" }>;

/** Measures one claimed revision and records the fact, a permanent failure, or nothing. */
async function measureClaimed(
  services: Readonly<{ store: SongCanonicalTimingStore; prober: CanonicalSongProber }>,
  pending: PendingSongTiming,
): Promise<ClaimedMeasurement> {
  let probe: CanonicalSongProbe;
  try {
    probe = await services.prober.measure(pending);
  } catch {
    // An unexplained prober fault is treated as transient: the revision stays
    // pending and is retried, rather than being declared unusable on a guess.
    probe = { ok: false, permanent: false, failureCode: "probe_unavailable" };
  }
  if (probe.ok) {
    if (!Number.isSafeInteger(probe.durationSamples) || probe.durationSamples < 1) {
      await services.store.fail({ ...pending, failureCode: "undecodable_audio" });
      return { status: "failed", failureCode: "undecodable_audio" };
    }
    await services.store.complete({
      ...pending,
      durationSamples: probe.durationSamples,
      proberIdentity: services.prober.identity,
      proberPolicyRevision: services.prober.policyRevision,
    });
    return { status: "measured", durationSamples: probe.durationSamples };
  }
  if (probe.permanent) {
    await services.store.fail({ ...pending, failureCode: probe.failureCode });
    return { status: "failed", failureCode: probe.failureCode };
  }
  return { status: "deferred" };
}

/** One pass over pending revisions. Safe to run concurrently and to repeat. */
export async function measurePendingSongTimings(
  services: Readonly<{
    store: SongCanonicalTimingStore;
    prober: CanonicalSongProber;
    limit?: number;
  }>,
): Promise<SongTimingMeasurementOutcome> {
  const claimed = await services.store.claimPending(services.limit ?? 8);
  let measured = 0;
  let failed = 0;
  let deferred = 0;
  for (const pending of claimed) {
    const outcome = await measureClaimed(services, pending);
    if (outcome.status === "measured") measured += 1;
    else if (outcome.status === "failed") failed += 1;
    else deferred += 1;
  }
  return { measured, failed, deferred };
}

export type SongTimingTargetOutcome = ClaimedMeasurement | Readonly<{ status: "not_claimed" }>;

/**
 * Measures only the named revision. Nothing else is claimed, so an operator can
 * measure one song without draining whatever else is pending. `not_claimed`
 * covers an absent, already concluded, leased or locked revision; a repeat
 * after a completed measurement is therefore a no-op.
 */
export async function measureSongTiming(
  services: Readonly<{ store: SongCanonicalTimingStore; prober: CanonicalSongProber }>,
  target: SongTimingTarget,
): Promise<SongTimingTargetOutcome> {
  const pending = await services.store.claimPendingFor(target);
  if (pending === null) return { status: "not_claimed" };
  return measureClaimed(services, pending);
}
