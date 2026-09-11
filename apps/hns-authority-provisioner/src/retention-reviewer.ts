import {
  decideHnsRetentionReviewV1,
  type HnsChainObservationResultV1,
  type HnsChainObservationViewV1,
  type HnsRetainedAuthorityReferenceV1,
  hnsRetentionReviewDueAtV1,
} from "@pirate/application/namespace-ownership";
import { HNS_ROOT_IMPORT_POLICY_V1 } from "@pirate/domain";
import type { HnsLifecycleClaimV1 } from "./lifecycle-executor.ts";

/**
 * One leased retention review: inspect both chain views, record what they
 * show, schedule the next review.
 *
 * The order matches the lifecycle runner's for the same reason — both provider
 * reads happen with no transaction held, so a hanging node cannot pin a row
 * lock — and the write is one fenced statement that commits the review, its
 * successor job and the job's completion together.
 *
 * This runner cannot authorize retiring anything. Its writer records a
 * retaining decision only; the authorization path is an operator's explicit
 * supersession, recorded elsewhere and never derived from a chain read.
 */

export type HnsRetentionReviewerPortsV1 = Readonly<{
  /**
   * The operation's generation and what its retained plan asserts on the name.
   * A null authority is unknown provenance, not an absent reference: it makes
   * the review retain.
   */
  readonly authority: (rootImportSessionId: string) => Promise<Readonly<{
    readonly root_label: string;
    readonly generation: number;
    readonly authority: HnsRetainedAuthorityReferenceV1 | null;
  }> | null>;
  /** Runs outside any transaction. */
  readonly observe_chain: (
    rootLabel: string,
    view: HnsChainObservationViewV1,
  ) => Promise<HnsChainObservationResultV1>;
  readonly record: (
    input: Readonly<{
      readonly root_import_session_id: string;
      readonly lifecycle_job_id: string;
      readonly executor_id: string;
      readonly lease_fence: number;
      readonly expected_generation: number;
      readonly reason: string;
      readonly evidence_ref: string;
      readonly current_observed_at_epoch_ms: number | null;
      readonly safe_observed_at_epoch_ms: number | null;
      readonly current_resource_sha256: string | null;
      readonly safe_resource_sha256: string | null;
      readonly next_review_at_epoch_ms: number;
    }>,
  ) => Promise<Readonly<{ readonly outcome: string }>>;
  /** Used only when the fenced write never ran or refused to complete the job. */
  readonly finalize: (
    job: HnsLifecycleClaimV1,
    executorId: string,
    outcome: "completed" | "failed" | "retry",
    failureCode: string | null,
  ) => Promise<Readonly<{ readonly outcome: string }>>;
  readonly now_epoch_ms: () => number;
}>;

export type HnsRetentionReviewerResultV1 = Readonly<{
  readonly outcome: "completed" | "failed" | "retry";
  readonly reason: string;
}>;

export async function runHnsRetentionReviewOnce(
  job: HnsLifecycleClaimV1,
  executorId: string,
  ports: HnsRetentionReviewerPortsV1,
): Promise<HnsRetentionReviewerResultV1> {
  if (job.job_kind !== "retention_review") {
    await ports.finalize(job, executorId, "failed", "not_a_retention_review");
    return { outcome: "failed", reason: "not_a_retention_review" };
  }

  const operation = await ports.authority(job.root_import_session_id);
  if (operation === null) {
    // No operation behind the job. Reported, never inferred.
    await ports.finalize(job, executorId, "failed", "lifecycle_absent");
    return { outcome: "failed", reason: "lifecycle_absent" };
  }

  const inspect = async (
    view: HnsChainObservationViewV1,
  ): Promise<HnsChainObservationResultV1 | null> => {
    try {
      return await ports.observe_chain(operation.root_label, view);
    } catch {
      // A thrown read is unavailable evidence, not an absent reference.
      return null;
    }
  };
  const [current, safe] = await Promise.all([inspect("current"), inspect("safe")]);

  const review = decideHnsRetentionReviewV1({
    authority: operation.authority,
    current,
    safe,
  });

  const recorded = await ports.record({
    root_import_session_id: job.root_import_session_id,
    lifecycle_job_id: job.lifecycle_job_id,
    executor_id: executorId,
    lease_fence: job.lease_fence,
    expected_generation: operation.generation,
    reason: review.reason,
    evidence_ref: review.evidence_ref,
    current_observed_at_epoch_ms: review.current_observed_at_epoch_ms,
    safe_observed_at_epoch_ms: review.safe_observed_at_epoch_ms,
    current_resource_sha256: review.current_resource_sha256,
    safe_resource_sha256: review.safe_resource_sha256,
    // Every review after the initial one recurs at the frozen thirty-day
    // cadence; the seven-day initial schedule is set by the terminal decision
    // that requested the first review.
    next_review_at_epoch_ms: hnsRetentionReviewDueAtV1(
      ports.now_epoch_ms(),
      HNS_ROOT_IMPORT_POLICY_V1,
      "recurring",
    ),
  });

  if (recorded.outcome === "recorded" || recorded.outcome === "replayed") {
    // The fenced write completed the job in the same transaction.
    return { outcome: "completed", reason: `${review.reason}:${recorded.outcome}` };
  }
  // A lost lease, a superseded generation or a missing lifecycle wrote
  // nothing. Retry rather than fail: the next claim re-inspects, and a review
  // that was never recorded must not end the recurrence.
  const outcome = recorded.outcome === "lease_conflict" ? "failed" : "retry";
  await ports.finalize(job, executorId, outcome, recorded.outcome);
  return { outcome, reason: recorded.outcome };
}
