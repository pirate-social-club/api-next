import {
  hnsRootImportLifecycleDeadlinePatchV1,
  hnsRootImportLifecycleStateFromRowV1,
} from "@pirate/application/namespace-ownership";
import {
  decideHnsRootImportLifecycleBatchV1,
  HNS_ROOT_IMPORT_POLICY_V1,
  type HnsRootImportLifecycleEventV1,
  type HnsRootImportLifecycleStateV1,
  type HnsRootImportReorgInvalidationV1,
} from "@pirate/domain";
import type { LifecycleTransactionClient } from "./lifecycle-transition.ts";
import type { HnsRetentionReviewerResultV1 } from "./retention-reviewer.ts";

/**
 * One leased lifecycle job: claim, observe, decide, commit, finalize.
 *
 * The order is the point. Provider observation happens with no transaction
 * held, so a slow or hanging node cannot pin a row lock; the transaction opens
 * only once the evidence is in hand. Finalization is fenced three ways — the
 * lease fence the database checks, the operation generation and revision read
 * under the row lock, and the event identity derived from the job and its
 * evidence — so a lost lease, a superseded operation, or a duplicate delivery
 * cannot apply an effect twice or extend a deadline.
 */

type HnsLifecycleJobKindV1 =
  | "observe_current"
  | "observe_safe"
  | "observe_readiness"
  | "reconcile_provider"
  | "schedule_activation_window"
  | "retention_review";

export type HnsLifecycleClaimV1 = Readonly<{
  readonly lifecycle_job_id: string;
  readonly root_import_session_id: string;
  readonly job_kind: HnsLifecycleJobKindV1;
  readonly lease_fence: number;
  /** The operation generation the job was scheduled under. */
  readonly generation: number;
}>;

/** What the runner needs about the operation before it observes anything. */
type HnsLifecycleOperationIdentityV1 = Readonly<{
  readonly root_label: string;
  readonly generation: number;
  readonly revision: number;
  readonly plan_encoded_resource_sha256: string | null;
}>;

/**
 * The accepted observation, as the public projection needs it.
 *
 * Tip height, UPDATE inclusion height and commitment height are separate
 * fields because they are separate facts; conflating them has already produced
 * a defect on this lane, and a projection that reports the wrong one tells an
 * owner their name is included when it is not.
 */
type HnsLifecycleObservationSummaryV1 = Readonly<{
  readonly view: "current" | "safe";
  readonly resource_sha256: string;
  readonly tip_height: number;
  readonly update_inclusion_height: number | null;
  readonly commitment_height: number | null;
  readonly observed_at_epoch_ms: number;
}>;

/** Evidence a provider read produced, already classified. */
export type HnsLifecycleEvidenceV1 =
  | Readonly<{
      readonly kind: "current_observation";
      readonly qualifying: boolean;
      readonly mismatch: boolean;
      readonly resource_sha256: string | null;
      readonly summary?: HnsLifecycleObservationSummaryV1;
      readonly evidence_ref: string;
    }>
  | Readonly<{
      readonly kind: "safe_observation";
      readonly qualifying: boolean;
      readonly bracket_observed_at_epoch_ms: number;
      readonly summary?: HnsLifecycleObservationSummaryV1;
      readonly evidence_ref: string;
    }>
  | Readonly<{ readonly kind: "readiness_observed"; readonly evidence_ref: string }>
  | Readonly<{
      readonly kind: "provider_failure";
      readonly classification: string;
      readonly budget_exempt: boolean;
      readonly evidence_ref: string;
    }>
  | Readonly<{
      readonly kind: "reorg_detected";
      readonly invalidated: HnsRootImportReorgInvalidationV1;
      readonly evidence_ref: string;
    }>
  | Readonly<{ readonly kind: "none"; readonly evidence_ref: string }>;

export type HnsLifecycleExecutorPortsV1 = Readonly<{
  readonly claim: (executorId: string, leaseSeconds: number) => Promise<HnsLifecycleClaimV1 | null>;
  readonly identity: (
    rootImportSessionId: string,
  ) => Promise<HnsLifecycleOperationIdentityV1 | null>;
  /** Runs outside any transaction. */
  readonly observe: (
    job: HnsLifecycleClaimV1,
    identity: HnsLifecycleOperationIdentityV1,
  ) => Promise<HnsLifecycleEvidenceV1>;
  readonly withTransaction: <A>(
    use: (client: LifecycleTransactionClient) => Promise<A>,
  ) => Promise<A>;
  readonly finalize: (
    job: HnsLifecycleClaimV1,
    executorId: string,
    outcome: "completed" | "failed" | "retry",
    failureCode: string | null,
  ) => Promise<Readonly<{ readonly outcome: string }>>;
  /**
   * Handles a claimed `retention_review` job. Reviews produce durable evidence
   * and their own schedule rather than a lifecycle transition, so they are
   * dispatched here instead of being pushed through the evidence reducer,
   * which has no event for them and would silently complete the job having
   * inspected nothing.
   */
  /**
   * Persists the accepted observation summary inside the runner's own
   * transaction, bound to the decision event identity that accepted it. The
   * SQL fence compares the claimed job's own scheduled generation to the
   * operation row, so no caller-supplied generation participates. Optional so
   * a caller that only decides — the composed-path harness — needs no store.
   */
  readonly record_observation?: (
    client: LifecycleTransactionClient,
    job: HnsLifecycleClaimV1,
    executorId: string,
    decisionEventId: string,
    summary: HnsLifecycleObservationSummaryV1,
  ) => Promise<void>;
  readonly review?: (
    job: HnsLifecycleClaimV1,
    executorId: string,
  ) => Promise<HnsRetentionReviewerResultV1>;
  /**
   * Handles a claimed `observe_readiness` job. Readiness has its own atomic
   * acceptance statement — result bytes and digest, session readiness, the
   * lifecycle transition and job completion commit together — so it is
   * dispatched here rather than through the generic evidence reducer.
   */
  readonly readiness?: (
    job: HnsLifecycleClaimV1,
    executorId: string,
  ) => Promise<HnsLifecycleReadinessResultV1>;
  readonly now_epoch_ms: () => number;
}>;

export type HnsLifecycleReadinessResultV1 = Readonly<{
  readonly outcome: "completed" | "failed" | "retry";
  readonly reason: string;
}>;

export type HnsLifecycleExecutorResultV1 = Readonly<{
  readonly claimed: boolean;
  readonly outcome: "completed" | "failed" | "retry" | "idle";
  readonly reason: string;
}>;

/**
 * Deadlines the operation has already passed, expressed as events.
 *
 * The batch decider orders a qualifying observation ahead of a deadline, so an
 * inclusion that lands during an outage is recovery evidence rather than a
 * deadline reset. Raising both and letting it order them keeps that precedence
 * in one place.
 */
function dueDeadlineEvents(
  state: HnsRootImportLifecycleStateV1,
  nowEpochMs: number,
  eventPrefix: string,
): HnsRootImportLifecycleEventV1[] {
  const events: HnsRootImportLifecycleEventV1[] = [];
  if (
    state.publication_deadline_at_epoch_ms !== null &&
    nowEpochMs >= state.publication_deadline_at_epoch_ms
  ) {
    events.push({
      event: "deadline_reached",
      deadline: "publication",
      event_id: `${eventPrefix}:deadline:publication:${state.publication_deadline_at_epoch_ms}`,
      occurred_at_epoch_ms: nowEpochMs,
    });
  }
  if (
    state.finality_deadline_at_epoch_ms !== null &&
    nowEpochMs >= state.finality_deadline_at_epoch_ms
  ) {
    events.push({
      event: "deadline_reached",
      deadline: "finality",
      event_id: `${eventPrefix}:deadline:finality:${state.finality_deadline_at_epoch_ms}`,
      occurred_at_epoch_ms: nowEpochMs,
    });
  }
  return events;
}

function evidenceEvent(
  evidence: HnsLifecycleEvidenceV1,
  eventPrefix: string,
  nowEpochMs: number,
): HnsRootImportLifecycleEventV1 | null {
  const base = {
    event_id: `${eventPrefix}:${evidence.evidence_ref}`,
    occurred_at_epoch_ms: nowEpochMs,
  };
  switch (evidence.kind) {
    case "current_observation":
      return {
        ...base,
        event: "current_observation",
        qualifying: evidence.qualifying,
        mismatch: evidence.mismatch,
        resource_sha256: evidence.resource_sha256,
      };
    case "safe_observation":
      return {
        ...base,
        event: "safe_observation",
        qualifying: evidence.qualifying,
        bracket_observed_at_epoch_ms: evidence.bracket_observed_at_epoch_ms,
      };
    case "readiness_observed":
      return { ...base, event: "readiness_observed" };
    case "provider_failure":
      return {
        ...base,
        event: "provider_failure",
        classification: evidence.classification,
        budget_exempt: evidence.budget_exempt,
      };
    case "reorg_detected":
      return { ...base, event: "reorg_detected", invalidated: evidence.invalidated };
    default:
      return null;
  }
}

export async function runHnsRootImportLifecycleJobOnce(
  executorId: string,
  leaseSeconds: number,
  ports: HnsLifecycleExecutorPortsV1,
): Promise<HnsLifecycleExecutorResultV1> {
  const job = await ports.claim(executorId, leaseSeconds);
  if (job === null) return { claimed: false, outcome: "idle", reason: "no_due_job" };

  if (job.job_kind === "retention_review" && ports.review !== undefined) {
    const reviewed = await ports.review(job, executorId);
    return { claimed: true, outcome: reviewed.outcome, reason: reviewed.reason };
  }

  if (job.job_kind === "observe_readiness") {
    if (ports.readiness === undefined) {
      // A declared job without a performer is never marked successfully
      // performed.
      await ports.finalize(job, executorId, "failed", "readiness_performer_absent");
      return { claimed: true, outcome: "failed", reason: "readiness_performer_absent" };
    }
    const readiness = await ports.readiness(job, executorId);
    return { claimed: true, outcome: readiness.outcome, reason: readiness.reason };
  }

  const identity = await ports.identity(job.root_import_session_id);
  if (identity === null) {
    // No operation behind the job. Reported, never inferred.
    await ports.finalize(job, executorId, "failed", "lifecycle_absent");
    return { claimed: true, outcome: "failed", reason: "lifecycle_absent" };
  }

  // Outside any transaction: a hanging provider must not hold a row lock.
  let evidence: HnsLifecycleEvidenceV1;
  try {
    evidence = await ports.observe(job, identity);
  } catch {
    evidence = {
      kind: "provider_failure",
      classification: "transport_failure",
      budget_exempt: false,
      evidence_ref: `observe_threw:${job.lifecycle_job_id}`,
    };
  }

  const nowEpochMs = ports.now_epoch_ms();
  const eventPrefix = `job:${job.lifecycle_job_id}:fence:${job.lease_fence}`;

  const applied = await ports.withTransaction(async (client) => {
    // Lock and validate the job before accepting evidence. A finalize-only
    // fence is too late: the state and successor jobs would already exist.
    const owned = await client.query(
      `SELECT lifecycle_job_id FROM hns_root_import_lifecycle_jobs
        WHERE lifecycle_job_id=$1 AND root_import_session_id=$2
          AND job_kind=$3 AND state='leased' AND leased_by=$4
          AND lease_fence=$5 AND lease_expires_at > clock_timestamp()
        FOR UPDATE`,
      [job.lifecycle_job_id, job.root_import_session_id, job.job_kind, executorId, job.lease_fence],
    );
    if (owned.rows.length !== 1) {
      return { committed: 0, reason: "lease_conflict" } as const;
    }
    const loaded = await client.query<Record<string, unknown>>(
      `SELECT phase, revision, generation, plan_exposed_at, publication_deadline_at,
              first_current_observation_at, finality_deadline_at, readiness_observed_at,
              pending_reason, next_check_at, observation_count,
              consecutive_operational_failures, last_useful_error, last_useful_error_at,
              terminal_decided_at
         FROM hns_root_import_lifecycle
        WHERE root_import_session_id=$1
          FOR UPDATE`,
      [job.root_import_session_id],
    );
    const row = loaded.rows[0];
    if (loaded.rows.length !== 1 || row === undefined) {
      return { committed: 0, reason: "lifecycle_absent" } as const;
    }
    // Generation and revision fence: the observation was gathered for one
    // operation. If it was superseded while the provider was being read, the
    // evidence describes a different operation and must not be applied.
    if (
      Number(row.generation) !== identity.generation ||
      Number(row.revision) !== identity.revision
    ) {
      return { committed: 0, reason: "operation_superseded" } as const;
    }
    const appliedEvents = await client.query<{ readonly event_id: string }>(
      "SELECT event_id FROM hns_root_import_lifecycle_history WHERE root_import_session_id=$1",
      [job.root_import_session_id],
    );
    let state = hnsRootImportLifecycleStateFromRowV1(
      row,
      appliedEvents.rows.map((entry) => entry.event_id),
    );

    const events: HnsRootImportLifecycleEventV1[] = [];
    const observed = evidenceEvent(evidence, eventPrefix, nowEpochMs);
    if (observed !== null) events.push(observed);
    events.push(...dueDeadlineEvents(state, nowEpochMs, eventPrefix));
    if (events.length === 0) return { committed: 0, reason: "no_evidence" } as const;

    const decisions = decideHnsRootImportLifecycleBatchV1(
      state,
      events,
      HNS_ROOT_IMPORT_POLICY_V1,
      nowEpochMs,
    );
    const summary =
      evidence.kind === "current_observation" || evidence.kind === "safe_observation"
        ? evidence.summary
        : undefined;
    let committed = 0;
    let lastReason = "no_decision";
    // The accepted observation and the revision its own decision committed at.
    // The summary is persisted only when that decision is the last change to
    // the operation in this batch: a later transition has superseded it, and
    // the SQL fence refuses a summary bound to a revision the operation has
    // already moved past.
    let recordableObservation: Readonly<{
      readonly decision_event_id: string;
      readonly revision_after: number;
      readonly summary: HnsLifecycleObservationSummaryV1;
    }> | null = null;
    for (const [index, decision] of decisions.entries()) {
      const event = [...events].sort((left, right) => {
        const qualifying = (candidate: HnsRootImportLifecycleEventV1): number =>
          (candidate.event === "current_observation" || candidate.event === "safe_observation") &&
          (candidate as { readonly qualifying?: boolean }).qualifying === true
            ? 0
            : 1;
        const byKind = qualifying(left) - qualifying(right);
        return byKind === 0 ? left.occurred_at_epoch_ms - right.occurred_at_epoch_ms : byKind;
      })[index];
      if (event === undefined) break;
      const accepted =
        decision.outcome.kind === "transition" || decision.outcome.kind === "pending";
      if (
        observed !== null &&
        event.event_id === observed.event_id &&
        accepted &&
        summary !== undefined
      ) {
        recordableObservation = {
          decision_event_id: event.event_id,
          revision_after: state.revision + 1,
          summary,
        };
      } else {
        recordableObservation = null;
      }
      const next = decision.next_state;
      await client.query(
        "SELECT * FROM commit_hns_root_import_lifecycle_decision_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::bigint,$11::bigint)",
        [
          job.root_import_session_id,
          state.revision,
          event.event_id,
          event.event,
          decision.outcome.kind,
          decision.outcome.reason,
          next === null ? null : next.phase,
          next === null ? "{}" : hnsRootImportLifecycleDeadlinePatchV1(next, state),
          JSON.stringify(
            decision.requested_work.map((work) => ({
              kind: work.kind,
              due_at: new Date(work.due_at_epoch_ms).toISOString(),
            })),
          ),
          job.lifecycle_job_id,
          job.lease_fence,
        ],
      );
      if (next !== null) state = { ...next, revision: state.revision + 1 };
      committed += 1;
      lastReason = decision.outcome.reason;
    }
    // The accepted observation is persisted with the decision that accepted
    // it, so the public projection reports server evidence rather than the
    // client's inference. Nothing is written when no decision was committed,
    // when the observation was replayed or refused, or when a later decision
    // in the same batch already superseded its revision.
    if (
      committed > 0 &&
      ports.record_observation !== undefined &&
      recordableObservation !== null &&
      recordableObservation.revision_after === state.revision
    ) {
      await ports.record_observation(
        client,
        job,
        executorId,
        recordableObservation.decision_event_id,
        recordableObservation.summary,
      );
    }
    const outcome = evidence.kind === "provider_failure" ? "retry" : "completed";
    const finalized = await client.query<{ readonly outcome: string }>(
      "SELECT * FROM finalize_hns_root_import_lifecycle_job_v1($1,$2,$3,$4,$5)",
      [
        job.lifecycle_job_id,
        executorId,
        job.lease_fence,
        outcome,
        outcome === "completed" ? null : lastReason,
      ],
    );
    if (finalized.rows[0]?.outcome !== outcome) {
      // Throw so the caller rolls back state, history and requested work too.
      throw new Error("HNS lifecycle finalization conflict");
    }
    return { committed, reason: lastReason, finalized: true } as const;
  });

  if (applied.reason === "lease_conflict") {
    return { claimed: true, outcome: "failed", reason: "lease_conflict" };
  }
  const outcome =
    applied.reason === "lifecycle_absent" || applied.reason === "operation_superseded"
      ? "failed"
      : evidence.kind === "provider_failure"
        ? "retry"
        : "completed";
  if (!("finalized" in applied)) {
    await ports.finalize(job, executorId, outcome, outcome === "completed" ? null : applied.reason);
  }
  return { claimed: true, outcome, reason: applied.reason };
}
