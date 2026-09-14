import type {
  HnsStagingPostMigrationRefusal,
  HnsStagingPostMigrationResult,
} from "./staging-hns-post-migration-contract.ts";
import { HnsStagingPostMigrationRefused } from "./staging-hns-post-migration-entry.ts";
import {
  executeKaraokeFenceRelease,
  type KaraokeReleaseSurface,
  type KaraokeReleaseSurfaces,
  type KaraokeSurfaceReceipt,
} from "./staging-karaoke-release-operation.ts";

/** One completed reset, held by the process that produced it. The hook closes
 * over live execution state, refuses a second attempt, and asserts a fresh
 * fence before it verifies, so the paired deployment has to happen inside this
 * process while its fence is still held. */
export interface StagingResetCompletion {
  completeAfterPairedRelease(verifyServingPair: () => Promise<void>): Promise<void>;
}

/** Restores the fences this executor may have to put back. Reinstating ingress
 * alone stops inbound HTTP and nothing else, so the database fence is part of
 * the same path and is never optional. */
export interface StagingRefence {
  ingress(): Promise<void>;
  database(): Promise<void>;
  /** Re-pauses delivery and removes schedules again. Needed because the
   * producers surface can fail partway, after some queues have already
   * resumed.
   *
   * It must re-establish the fenced condition as a fixed target — every queue
   * paused, no producer Worker holding a schedule — and must not reconcile
   * towards whatever survived the partial run. A partial failure is exactly
   * when the live state feels most authoritative and is least trustworthy:
   * what is readable then is prior state, not reviewed state. */
  producers(): Promise<void>;
  /** Stops and verifies the named staging unit, bound to the same reviewed
   * host as its start. Required whenever this attempt started the unit or may
   * have started it; a release that needs the stop and binds no port records
   * it as failed rather than not-required. */
  service?(): Promise<void>;
}

export type RefenceOutcome = "restored" | "failed" | "not-required";

/** Raised when the release operation itself escapes — a reporting callback
 * throwing outside its protected block — after recovery has run. The original
 * failure is the cause; the receipts, per-fence outcomes and any failure to
 * record them travel with it, because a caller that receives only the original
 * error never learns which fence was left down. */
export class StagingResetReleaseFailure extends Error {
  constructor(
    readonly receipts: readonly KaraokeSurfaceReceipt[],
    readonly refenced: RefencedOutcomes | undefined,
    readonly recordingFailure: string | undefined,
    /** The delegated entry point's success result, when it applied before the
     * failure that produced this error. */
    readonly hnsResult: HnsStagingPostMigrationResult | undefined,
    /** The delegated entry point's structured refusal, when one failed the
     * release or preceded the failure. */
    readonly hnsRefusal: HnsStagingPostMigrationRefusal | undefined,
    options: { cause: unknown },
  ) {
    super("staging_release_failed_after_recovery", options);
    this.name = "StagingResetReleaseFailure";
  }
}

export type RefencedOutcomes = {
  readonly producers: RefenceOutcome;
  readonly ingress: RefenceOutcome;
  readonly database: RefenceOutcome;
  /** Present when the HNS entry point was invoked. `not-required` is written
   * only for a confirmed pre-start refusal; a start that may have happened is
   * never reported as not-required merely because no disposition came back. */
  readonly service?: RefenceOutcome;
};

export type StagingResetReleaseOutcome =
  | {
      readonly disposition: "released";
      readonly receipts: readonly KaraokeSurfaceReceipt[];
      readonly releasedAt: string;
      /** The delegated entry point's success result, when this window ran it. */
      readonly hnsResult?: HnsStagingPostMigrationResult;
    }
  | {
      readonly disposition: "unresolved";
      readonly receipts: readonly KaraokeSurfaceReceipt[];
      readonly failedSurface: KaraokeReleaseSurface | null;
      /** Absent when no surface was attempted, so nothing had to be put back. */
      readonly refenced?: RefencedOutcomes;
      /** Present when the recovery outcomes could not be recorded, so the
       * caller knows the durable copy is missing rather than assuming it. */
      readonly recordingFailure?: string;
      /** The entry point's success result when it applied before a later
       * surface failed; its structured refusal when that is what failed. */
      readonly hnsResult?: HnsStagingPostMigrationResult;
      readonly hnsRefusal?: HnsStagingPostMigrationRefusal;
    };

/** The delegated HNS post-migration entry point, invoked in process after the
 * database surface has released and before ingress opens. The live binding
 * supplies the real call over its reviewed ports; tests supply a fake, so the
 * executor itself needs no database. */
export interface StagingHnsDelegation {
  run(): Promise<HnsStagingPostMigrationResult>;
}

/** Entry-point steps that cannot have started the staging unit. A refusal
 * there is a confirmed pre-start refusal, so no service stop is required. The
 * `service` step is deliberately excluded: a start whose acknowledgment was
 * lost may still have changed host state, so an absent disposition is never
 * proof that the unit did not start. */
const HNS_PRE_SERVICE_STEPS: ReadonlySet<string> = new Set([
  "target_and_ledger",
  "identities",
  "grants",
  "privilege_matrix",
  "bundle",
  "probe",
]);

function hnsRefusalIsConfirmedPreStart(refusal: HnsStagingPostMigrationRefusal): boolean {
  return (
    refusal.service_disposition === undefined &&
    refusal.recovery === undefined &&
    HNS_PRE_SERVICE_STEPS.has(refusal.step) &&
    !(refusal.completed_results ?? []).some((result) => result.step === "service")
  );
}

/** Carries one reset through to a completed release in a single process.
 *
 * Ordering is the plan's, not this module's: versions, database, ingress,
 * producers. Two conditions the release operation cannot observe are supplied
 * as gates. Reset completion runs before the database surface, while the
 * producer fence is still held and no request can reach the pair. Product
 * acceptance runs before the producers surface, once ingress is open, because
 * signup needs the ingress the fence was blocking.
 *
 * Nothing here retries. A failure keeps the receipts that completed, leaves the
 * remaining surfaces unreleased, and — if ingress had already opened — puts the
 * HTTP and database fences back rather than merely stopping, because a broken
 * pairing left reachable is the condition this whole sequence exists to end.
 */
export async function executeStagingResetRelease(input: {
  readonly plan: unknown;
  readonly surfaces: KaraokeReleaseSurfaces;
  readonly reset: StagingResetCompletion;
  /** Signup and the persona-contract read through the real client. Rejects to
   * refuse the release; its rejection is not a retryable condition. */
  readonly acceptance: () => Promise<void>;
  readonly refence: StagingRefence;
  /** The delegated HNS post-migration entry point. Absent when this window
   * runs without the HNS cutover; when present it must finish before the
   * ingress surface executes. */
  readonly hns?: StagingHnsDelegation;
  /** Receives the per-fence recovery outcomes so they reach durable evidence.
   * It is called on both exits, including the one that rethrows a reporting
   * failure, because otherwise a failed re-fence disappears behind the original
   * error and nobody learns a fence was left down. Its own failure never
   * replaces or masks that error. */
  readonly onRecovery?: (refenced: RefencedOutcomes) => void | Promise<void>;
  readonly now?: () => string;
  readonly onAttempt?: Parameters<typeof executeKaraokeFenceRelease>[0]["onAttempt"];
}): Promise<StagingResetReleaseOutcome> {
  const released = new Map<KaraokeReleaseSurface, KaraokeSurfaceReceipt>();
  // A surface whose execution began may have changed remote state even when no
  // receipt came back: a lost response leaves the mutation applied and
  // unrecorded. Attempts, not receipts, decide what has to be put back.
  const attempted = new Set<KaraokeReleaseSurface>();
  let failedSurface: KaraokeReleaseSurface | null = null;
  let completionCalled = false;
  let acceptanceRefused = false;
  let completionRefused = false;
  let hnsInvoked = false;
  let hnsGateRefused = false;
  let hnsServiceStopRequired = false;
  let hnsResult: HnsStagingPostMigrationResult | undefined;
  let hnsRefusal: HnsStagingPostMigrationRefusal | undefined;

  const recover = async (): Promise<{
    refenced: RefencedOutcomes | undefined;
    recordingFailure: string | undefined;
  }> => {
    // Producers only if its execution began: a refused acceptance gate stops
    // before the surface runs and resumes nothing.
    const producersTouched = attempted.has("producers") && !acceptanceRefused;
    // The operation reports the ingress intent before it runs the beforeSurface
    // hook, so an HNS gate refusal leaves an attempt recorded for a surface
    // that never ran. An ingress surface that actually began and lost its
    // receipt still needs its fence.
    const ingressTouched = attempted.has("ingress") && (released.has("ingress") || !hnsGateRefused);
    // Database independently of ingress: grant restoration can commit and then
    // lose its confirmation, leaving runtime privileges restored under an
    // unresolved release.
    const databaseTouched = attempted.has("database") && !completionRefused;
    // The unit is stopped whenever the HNS call may have started it. A
    // confirmed pre-start refusal is the only case where nothing started.
    const serviceTouched = hnsInvoked && hnsServiceStopRequired;
    if (!producersTouched && !ingressTouched && !databaseTouched && !hnsInvoked)
      return { refenced: undefined, recordingFailure: undefined };
    const refenced: {
      producers: RefenceOutcome;
      ingress: RefenceOutcome;
      database: RefenceOutcome;
      service?: RefenceOutcome;
    } = {
      producers: producersTouched ? "restored" : "not-required",
      ingress: ingressTouched ? "restored" : "not-required",
      database: databaseTouched ? "restored" : "not-required",
      ...(hnsInvoked
        ? { service: (serviceTouched ? "restored" : "not-required") as RefenceOutcome }
        : {}),
    };
    // Writers first, then HTTP, then the database. Each is independent, so one
    // failing never leaves the others unattempted.
    if (producersTouched)
      try {
        await input.refence.producers();
      } catch {
        refenced.producers = "failed";
      }
    // The unit stops before the database is re-fenced, and a failed or unbound
    // stop is recorded without suppressing the remaining recovery.
    if (serviceTouched)
      try {
        if (input.refence.service === undefined)
          throw new Error("staging_release_service_refence_unbound");
        await input.refence.service();
      } catch {
        refenced.service = "failed";
      }
    if (ingressTouched)
      try {
        await input.refence.ingress();
      } catch {
        refenced.ingress = "failed";
      }
    if (databaseTouched)
      try {
        await input.refence.database();
      } catch {
        refenced.database = "failed";
      }
    // Report before returning or rethrowing, so the outcomes are durable even
    // when the caller never sees this function's return value. Recording is an
    // opportunity, not a guarantee, so its failure is carried rather than
    // swallowed.
    let recordingFailure: string | undefined;
    try {
      await input.onRecovery?.(refenced);
    } catch (error) {
      recordingFailure = error instanceof Error ? error.message : String(error);
    }
    return { refenced, recordingFailure };
  };

  let result: Awaited<ReturnType<typeof executeKaraokeFenceRelease>>;
  try {
    result = await executeKaraokeFenceRelease({
      plan: input.plan,
      surfaces: input.surfaces,
      ...(input.now === undefined ? {} : { now: input.now }),
      onAttempt: (record) => {
        // Report the intent before recording it. Reporting runs outside the
        // operation's protected block, so a failed journal write aborts before
        // the surface executes, and a surface that never ran must not be
        // counted as attempted.
        if (record.phase === "intent") {
          input.onAttempt?.(record);
          attempted.add(record.surface);
          return;
        }
        if (record.phase === "released" && record.receipt)
          released.set(record.surface, record.receipt);
        if (record.phase === "uncertain") failedSurface = record.surface;
        input.onAttempt?.(record);
      },
      async beforeSurface(surface) {
        if (surface === "database") {
          // The serving pair is proven by the versions receipt, not by an
          // assertion that a deployment happened somewhere.
          if (completionCalled) throw new Error("staging_release_completion_reentered");
          completionCalled = true;
          try {
            await input.reset.completeAfterPairedRelease(async () => {
              if (!released.has("versions"))
                throw new Error("staging_release_versions_receipt_missing");
            });
          } catch (error) {
            // Refused before the surface ran, so no grant was restored and the
            // database fence was never lifted.
            completionRefused = true;
            throw error;
          }
        }
        if (surface === "ingress" && input.hns !== undefined) {
          // The entry point verifies the ledger and the grants the database
          // surface just restored, and it must finish before ingress opens.
          if (!released.has("database") || hnsInvoked) {
            hnsGateRefused = true;
            throw new Error(
              hnsInvoked
                ? "staging_release_hns_reentered"
                : "staging_release_hns_before_database_receipt",
            );
          }
          // Record the intent before the call: a start whose acknowledgment is
          // lost can still have changed host state, so recovery must not infer
          // "not started" from anything the call does or does not return.
          hnsInvoked = true;
          try {
            hnsResult = await input.hns.run();
            hnsServiceStopRequired = true;
          } catch (error) {
            // A refusal before the surface ran leaves ingress not-required;
            // whether the unit may have started is a separate question decided
            // by how far the entry point got.
            hnsGateRefused = true;
            if (error instanceof HnsStagingPostMigrationRefused) {
              hnsRefusal = error.refusal;
              hnsServiceStopRequired = !hnsRefusalIsConfirmedPreStart(error.refusal);
            } else {
              hnsServiceStopRequired = true;
            }
            throw error;
          }
        }
        if (surface === "producers") {
          if (!released.has("ingress"))
            throw new Error("staging_release_acceptance_before_ingress");
          try {
            await input.acceptance();
          } catch (error) {
            // A refused acceptance stops before the surface runs, so delivery was
            // never resumed and the producer fence needs no restoration.
            acceptanceRefused = true;
            throw error;
          }
        }
      },
    });
  } catch (error) {
    // The operation reports attempts through a caller-supplied callback, and a
    // callback that throws escapes its protected block entirely. Remote state
    // may already have changed, so recovery runs on the tracked attempts and
    // the original failure is preserved rather than replaced by a recovery
    // error.
    const recovery = await recover().catch(() => ({
      refenced: undefined,
      recordingFailure: "recovery_failed",
    }));
    throw new StagingResetReleaseFailure(
      [...released.values()],
      recovery.refenced,
      recovery.recordingFailure,
      hnsResult,
      hnsRefusal,
      { cause: error },
    );
  }

  if (result.disposition === "released")
    return {
      disposition: "released",
      receipts: result.receipts,
      releasedAt: result.releasedAt,
      ...(hnsResult === undefined ? {} : { hnsResult }),
    };

  // Ingress open and producers unreleased is the state that must not persist,
  // whether acceptance refused or the producers surface itself failed.
  const { refenced, recordingFailure } = await recover();
  return {
    disposition: "unresolved",
    receipts: result.receipts,
    failedSurface,
    ...(refenced === undefined ? {} : { refenced }),
    ...(recordingFailure === undefined ? {} : { recordingFailure }),
    ...(hnsResult === undefined ? {} : { hnsResult }),
    ...(hnsRefusal === undefined ? {} : { hnsRefusal }),
  };
}
