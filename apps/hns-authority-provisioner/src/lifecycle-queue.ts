import {
  type HnsRetainedAuthorityReferenceV1,
  hnsRetainedAuthorityFromPlanDocumentV1,
} from "@pirate/application/namespace-ownership";
import { Client } from "pg";
import type {
  HnsLifecycleClaimV1,
  HnsLifecycleEvidenceV1,
  HnsLifecycleExecutorPortsV1,
} from "./lifecycle-executor.ts";
import type {
  HnsLifecycleReadinessContextV1,
  HnsLifecycleReadinessPortsV1,
} from "./lifecycle-readiness.ts";
import type {
  HnsRootReadinessObservationConfig,
  HnsRootReadinessObservationPorts,
} from "./observe-root.ts";
import type { HnsRetentionReviewerPortsV1 } from "./retention-reviewer.ts";

/**
 * The lifecycle runner's ports, backed by the control-plane database.
 *
 * Everything the runner needs about an operation is read from the lifecycle
 * row itself, including the exposed plan's encoded-resource digest. Reaching
 * across into the legacy session tables to decide what the operation asserts
 * would reintroduce the coupling this lane is removing, and the digest that
 * lives there is inside a plan document rather than a column.
 *
 * Each port opens its own connection, matching the provision and observation
 * queues. The transaction port is the exception: it holds one connection for
 * the whole transaction, because the runner's fencing depends on the row locks
 * it takes staying held until it commits.
 */

const JOB_KINDS = [
  "observe_current",
  "observe_safe",
  "observe_readiness",
  "reconcile_provider",
  "retention_review",
] as const;

/**
 * How old an observation may be when the transaction that persists it runs.
 * The policy's observation cadence is 900 s and the runner observes inside a
 * 60 s lease, so this is the cadence rather than the lease: it bounds a
 * reading that sat across a stalled transaction without refusing an
 * observation that was simply produced a little earlier than the commit.
 */
const OBSERVATION_EVIDENCE_FRESHNESS_SECONDS = 900;

type JobKind = (typeof JOB_KINDS)[number];

function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

/** BIGINT arrives as a string from node-postgres; anything else is a defect. */
function safePositiveInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

type ReconcileResponsibilityV1 = "current" | "safe" | "readiness";

const RECONCILE_RESPONSIBILITY_BY_JOB_KIND: Readonly<Record<string, ReconcileResponsibilityV1>> = {
  observe_current: "current",
  observe_safe: "safe",
  observe_readiness: "readiness",
};

/**
 * The fresh work a reconciled responsibility may schedule from a phase.
 * Anything unsupported is a named disposition with no work rather than a job
 * the phase cannot accept.
 */
function reconcileWorkKind(
  responsibility: ReconcileResponsibilityV1,
  phase: string,
): "observe_current" | "observe_safe" | "observe_readiness" | null {
  if (responsibility === "current") {
    return [
      "awaiting_publication",
      "checking_publication",
      "waiting_safe_commitment",
      "checking_authority",
      "ready",
    ].includes(phase)
      ? "observe_current"
      : null;
  }
  if (responsibility === "safe") {
    return [
      "checking_publication",
      "waiting_safe_commitment",
      "checking_authority",
      "ready",
    ].includes(phase)
      ? "observe_safe"
      : null;
  }
  return phase === "checking_authority" || phase === "ready" ? "observe_readiness" : null;
}

async function withClient<A>(
  connectionString: string,
  use: (client: Client) => Promise<A>,
): Promise<A> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export type HnsLifecycleObservePortV1 = (
  job: HnsLifecycleClaimV1,
  identity: Readonly<{
    readonly root_label: string;
    readonly plan_encoded_resource_sha256: string | null;
  }>,
) => Promise<HnsLifecycleEvidenceV1>;

export function makePostgresHnsRootImportLifecycleQueue(
  connectionString: string,
  observe: HnsLifecycleObservePortV1,
): HnsLifecycleExecutorPortsV1 {
  if (connectionString.trim() !== connectionString || connectionString.length === 0) {
    throw new Error("HNS lifecycle queue configuration is invalid");
  }
  return {
    claim: (executorId, leaseSeconds) =>
      withClient(connectionString, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1, $2)",
          [executorId, leaseSeconds],
        );
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) throw new Error("HNS lifecycle queue returned multiple jobs");
        const row = result.rows[0];
        const leaseFence = safePositiveInteger(row?.lease_fence);
        const jobId = safePositiveInteger(row?.lifecycle_job_id);
        const generation = safePositiveInteger(row?.generation);
        if (
          jobId === null ||
          typeof row?.root_import_session_id !== "string" ||
          !isJobKind(row.job_kind) ||
          leaseFence === null ||
          generation === null
        ) {
          throw new Error("HNS lifecycle queue returned an invalid job");
        }
        return {
          lifecycle_job_id: String(jobId),
          root_import_session_id: row.root_import_session_id,
          job_kind: row.job_kind,
          lease_fence: leaseFence,
          generation,
        };
      }),
    identity: (rootImportSessionId) =>
      withClient(connectionString, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT root_label, generation, revision, plan_encoded_resource_sha256
             FROM hns_root_import_lifecycle WHERE root_import_session_id = $1`,
          [rootImportSessionId],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || row === undefined) return null;
        const generation = safePositiveInteger(row.generation);
        const revision = safePositiveInteger(row.revision);
        if (typeof row.root_label !== "string" || generation === null || revision === null) {
          throw new Error("HNS lifecycle queue returned an invalid operation identity");
        }
        // A null digest is a real state: the plan has not been exposed yet, or
        // it predates this column. It makes observations non-qualifying, which
        // is the safe direction — never a silently qualifying match.
        const digest =
          typeof row.plan_encoded_resource_sha256 === "string" &&
          /^[0-9a-f]{64}$/u.test(row.plan_encoded_resource_sha256)
            ? row.plan_encoded_resource_sha256
            : null;
        if (row.plan_encoded_resource_sha256 !== null && digest === null) {
          throw new Error("HNS lifecycle queue returned an invalid plan digest");
        }
        return {
          root_label: row.root_label,
          generation,
          revision,
          plan_encoded_resource_sha256: digest,
        };
      }),
    observe,
    reconcile: (job, executorId) =>
      withClient(connectionString, async (client) => {
        await client.query("BEGIN");
        try {
          // The claimed job is validated under its own fence before anything
          // else, exactly as the observation transaction does.
          const owned = await client.query<Record<string, unknown>>(
            `SELECT lifecycle_job_id, created_at FROM hns_root_import_lifecycle_jobs
              WHERE lifecycle_job_id=$1 AND root_import_session_id=$2
                AND job_kind='reconcile_provider' AND state='leased' AND leased_by=$3
                AND lease_fence=$4 AND lease_expires_at > clock_timestamp()
              FOR UPDATE`,
            [job.lifecycle_job_id, job.root_import_session_id, executorId, job.lease_fence],
          );
          if (owned.rows.length !== 1) {
            await client.query("ROLLBACK");
            return { outcome: "retry" as const, reason: "reconcile_lease_conflict" };
          }
          const claimedAt = owned.rows[0]?.created_at;
          const lifecycle = await client.query<Record<string, unknown>>(
            `SELECT phase, revision, pending_reason, next_check_at
               FROM hns_root_import_lifecycle WHERE root_import_session_id=$1 FOR UPDATE`,
            [job.root_import_session_id],
          );
          const row = lifecycle.rows[0];
          const revision = safePositiveInteger(row?.revision);
          if (lifecycle.rows.length !== 1 || row === undefined || revision === null) {
            await client.query("ROLLBACK");
            return { outcome: "failed" as const, reason: "reconcile_lifecycle_absent" };
          }
          const phase = typeof row.phase === "string" ? row.phase : null;
          if (phase === null) {
            await client.query("ROLLBACK");
            return { outcome: "failed" as const, reason: "reconcile_lifecycle_invalid" };
          }
          // The failure being reconciled is the decision that requested this
          // exact job. The decision writer inserts its requested-work rows
          // before its own history row, so the scheduling decision's
          // `recorded_at` follows the job's `created_at`; the first matching
          // history row at or after creation is that decision, and the locked
          // lifecycle row makes interleaving decisions impossible.
          const failed = await client.query<Record<string, unknown>>(
            `SELECT failed.job_kind AS failed_job_kind
               FROM hns_root_import_lifecycle_history AS history
               JOIN hns_root_import_lifecycle_jobs AS failed
                 ON failed.lifecycle_job_id = history.lifecycle_job_id
              WHERE history.root_import_session_id=$1
                AND history.requested_work @> '[{"kind":"reconcile_provider"}]'::jsonb
                AND history.recorded_at >= $2
              ORDER BY history.recorded_at ASC, history.history_id ASC
              LIMIT 1`,
            [job.root_import_session_id, claimedAt],
          );
          const failedJobKind = failed.rows[0]?.failed_job_kind;
          const responsibility =
            typeof failedJobKind === "string"
              ? RECONCILE_RESPONSIBILITY_BY_JOB_KIND[failedJobKind]
              : undefined;
          const workKind =
            responsibility === undefined ? null : reconcileWorkKind(responsibility, phase);
          const disposition =
            responsibility === undefined
              ? "reconcile_responsibility_unknown"
              : workKind === null
                ? `reconcile_superseded_${phase}`
                : `reconcile_${responsibility}_to_${workKind}`;
          const decision = await client.query<Record<string, unknown>>(
            `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1(
               $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
            [
              job.root_import_session_id,
              revision,
              `reconcile:${job.lifecycle_job_id}:${job.lease_fence}`,
              "reconcile_routed",
              "pending",
              disposition,
              phase,
              JSON.stringify({
                pending_reason: row.pending_reason,
                next_check_at:
                  row.next_check_at instanceof Date ? row.next_check_at.toISOString() : null,
              }),
              JSON.stringify(
                workKind === null ? [] : [{ kind: workKind, due_at: new Date().toISOString() }],
              ),
              job.lifecycle_job_id,
              job.lease_fence,
            ],
          );
          const decisionOutcome = decision.rows[0]?.outcome;
          if (decisionOutcome !== "pending" && decisionOutcome !== "replay") {
            await client.query("ROLLBACK");
            return { outcome: "retry" as const, reason: `reconcile_${String(decisionOutcome)}` };
          }
          const finalized = await client.query<Record<string, unknown>>(
            "SELECT * FROM finalize_hns_root_import_lifecycle_job_v1($1,$2,$3,$4,$5)",
            [job.lifecycle_job_id, executorId, job.lease_fence, "completed", null],
          );
          if (finalized.rows[0]?.outcome !== "completed") {
            await client.query("ROLLBACK");
            return { outcome: "retry" as const, reason: "reconcile_finalize_refused" };
          }
          await client.query("COMMIT");
          return { outcome: "completed" as const, reason: disposition };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }),
    record_observation: async (client, job, executorId, decisionEventId, summary) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT record_hns_root_import_lifecycle_observation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS outcome`,
        [
          job.root_import_session_id,
          job.lifecycle_job_id,
          executorId,
          job.lease_fence,
          summary.view,
          summary.resource_sha256,
          summary.tip_height,
          summary.update_inclusion_height,
          summary.commitment_height,
          new Date(summary.observed_at_epoch_ms),
          decisionEventId,
          OBSERVATION_EVIDENCE_FRESHNESS_SECONDS,
        ],
      );
      if (result.rows[0]?.outcome !== "recorded") {
        // Throwing rolls the decision back with it: a committed transition
        // whose evidence was not persisted would project a phase the server
        // cannot account for, and a refusal that was silently ignored would
        // hide a decision the operation did not actually accept.
        throw new Error("HNS lifecycle observation evidence was not recorded");
      }
    },
    withTransaction: (use) =>
      withClient(connectionString, async (client) => {
        await client.query("BEGIN");
        try {
          const result = await use(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }),
    finalize: (job, executorId, outcome, failureCode) =>
      withClient(connectionString, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          "SELECT * FROM finalize_hns_root_import_lifecycle_job_v1($1,$2,$3,$4,$5)",
          [job.lifecycle_job_id, executorId, job.lease_fence, outcome, failureCode],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || row === undefined || typeof row.outcome !== "string") {
          throw new Error("HNS lifecycle finalizer returned no result");
        }
        return { outcome: row.outcome };
      }),
    now_epoch_ms: () => Date.now(),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The retention reviewer's ports.
 *
 * `authority` is the one place the lifecycle reaches into the legacy session
 * tables, and deliberately so: what the retained plan asserts on the name lives
 * inside the plan document those tables hold, and there is no lifecycle-side
 * copy of it. Every failure to establish it — no plan, an unreadable plan, a
 * digest that does not match the stored bytes — returns a null authority, which
 * the reviewer records as unknown provenance and retains. Nothing here infers
 * an absent reference from a missing plan.
 */
export function makePostgresHnsRetentionReviewerPorts(
  connectionString: string,
  observeChain: HnsRetentionReviewerPortsV1["observe_chain"],
  finalize: HnsRetentionReviewerPortsV1["finalize"],
): HnsRetentionReviewerPortsV1 {
  if (connectionString.trim() !== connectionString || connectionString.length === 0) {
    throw new Error("HNS retention reviewer configuration is invalid");
  }
  return {
    authority: (rootImportSessionId) =>
      withClient(connectionString, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT lifecycle.root_label, lifecycle.generation,
                  session.publish_plan_bytes, session.publish_plan_sha256
             FROM hns_root_import_lifecycle AS lifecycle
             LEFT JOIN hns_root_import_sessions AS session
               ON session.root_import_session_id = lifecycle.root_import_session_id
            WHERE lifecycle.root_import_session_id = $1`,
          [rootImportSessionId],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || row === undefined) return null;
        const generation = safePositiveInteger(row.generation);
        if (typeof row.root_label !== "string" || generation === null) {
          throw new Error("HNS retention reviewer read an invalid operation identity");
        }
        let authority: HnsRetainedAuthorityReferenceV1 | null = null;
        const planBytes =
          row.publish_plan_bytes instanceof Uint8Array ? row.publish_plan_bytes : null;
        const planDigest =
          typeof row.publish_plan_sha256 === "string" ? row.publish_plan_sha256 : null;
        if (planBytes !== null && planDigest !== null) {
          try {
            if ((await sha256Hex(planBytes)) === planDigest) {
              authority = hnsRetainedAuthorityFromPlanDocumentV1(planBytes);
            }
          } catch {
            authority = null;
          }
        }
        return { root_label: row.root_label, generation, authority };
      }),
    observe_chain: observeChain,
    record: (input) =>
      withClient(connectionString, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT * FROM record_hns_root_import_retention_review_v1(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            input.root_import_session_id,
            input.lifecycle_job_id,
            input.executor_id,
            input.lease_fence,
            input.expected_generation,
            input.reason,
            input.evidence_ref,
            input.current_observed_at_epoch_ms === null
              ? null
              : new Date(input.current_observed_at_epoch_ms),
            input.safe_observed_at_epoch_ms === null
              ? null
              : new Date(input.safe_observed_at_epoch_ms),
            input.current_resource_sha256,
            input.safe_resource_sha256,
            new Date(input.next_review_at_epoch_ms),
          ],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || row === undefined || typeof row.outcome !== "string") {
          throw new Error("HNS retention review writer returned no result");
        }
        return { outcome: row.outcome };
      }),
    finalize,
    now_epoch_ms: () => Date.now(),
  };
}

/**
 * The lifecycle readiness performer's database ports.
 *
 * The context read reaches the legacy session and provision tables for the
 * same reason the retention reviewer does: the exposed plan and its provision
 * result live there, and the lifecycle row deliberately does not duplicate
 * them. Every failure to establish the context is reported as an absent
 * operation rather than an invented one, and the plan bytes are checked
 * against their stored digest before probes run.
 */
export function makePostgresHnsLifecycleReadinessPorts(
  connectionString: string,
  observe: HnsRootReadinessObservationPorts,
  config: HnsRootReadinessObservationConfig,
  finalize: HnsLifecycleExecutorPortsV1["finalize"],
): HnsLifecycleReadinessPortsV1 {
  if (connectionString.trim() !== connectionString || connectionString.length === 0) {
    throw new Error("HNS lifecycle readiness configuration is invalid");
  }
  return {
    context: (rootImportSessionId) =>
      withClient(connectionString, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT session.namespace_session_id, session.root_label, session.challenge_txt_value,
                  session.ownership_result_sha256, session.publish_plan_sha256,
                  session.publish_plan_bytes, session.expires_at,
                  provision.result_sha256 AS provision_result_sha256,
                  provision.result_bytes AS provision_result_bytes,
                  lifecycle.revision AS lifecycle_revision, lifecycle.phase,
                  lifecycle.plan_encoded_resource_sha256 AS effective_plan_encoded_sha256
             FROM hns_root_import_lifecycle AS lifecycle
             JOIN hns_root_import_sessions AS session
               ON session.root_import_session_id = lifecycle.root_import_session_id
             JOIN hns_authority_provision_jobs AS provision
               ON provision.provision_job_id = session.provision_job_id
            WHERE lifecycle.root_import_session_id = $1`,
          [rootImportSessionId],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || row === undefined) return null;
        const revision = safePositiveInteger(row.lifecycle_revision);
        const publishPlanBytes =
          row.publish_plan_bytes instanceof Uint8Array ? row.publish_plan_bytes : null;
        const provisionResultBytes =
          row.provision_result_bytes instanceof Uint8Array ? row.provision_result_bytes : null;
        const publishPlanSha256 =
          typeof row.publish_plan_sha256 === "string" ? row.publish_plan_sha256 : null;
        const provisionResultSha256 =
          typeof row.provision_result_sha256 === "string" ? row.provision_result_sha256 : null;
        const ownershipResultSha256 =
          typeof row.ownership_result_sha256 === "string" ? row.ownership_result_sha256 : null;
        const effectivePlanEncodedSha256 =
          typeof row.effective_plan_encoded_sha256 === "string"
            ? row.effective_plan_encoded_sha256
            : null;
        if (
          revision === null ||
          publishPlanBytes === null ||
          provisionResultBytes === null ||
          !(row.expires_at instanceof Date) ||
          typeof row.namespace_session_id !== "string" ||
          typeof row.root_label !== "string" ||
          typeof row.challenge_txt_value !== "string" ||
          typeof row.phase !== "string" ||
          publishPlanSha256 === null ||
          provisionResultSha256 === null ||
          ownershipResultSha256 === null ||
          !/^[0-9a-f]{64}$/u.test(publishPlanSha256) ||
          !/^[0-9a-f]{64}$/u.test(provisionResultSha256) ||
          !/^[0-9a-f]{64}$/u.test(ownershipResultSha256) ||
          effectivePlanEncodedSha256 === null ||
          !/^[0-9a-f]{64}$/u.test(effectivePlanEncodedSha256) ||
          (await sha256Hex(publishPlanBytes)) !== publishPlanSha256 ||
          (await sha256Hex(provisionResultBytes)) !== provisionResultSha256
        ) {
          throw new Error("HNS lifecycle readiness read an invalid operation");
        }
        const context: HnsLifecycleReadinessContextV1 = {
          lifecycle_revision: revision,
          phase: row.phase,
          namespace_session_id: row.namespace_session_id,
          root_label: row.root_label,
          challenge_txt_value: row.challenge_txt_value,
          ownership_result_sha256: ownershipResultSha256,
          publish_plan_sha256: publishPlanSha256,
          publish_plan_bytes: publishPlanBytes,
          provision_result_sha256: provisionResultSha256,
          provision_result_bytes: provisionResultBytes,
          effective_plan_encoded_resource_sha256: effectivePlanEncodedSha256,
          expires_at: row.expires_at.toISOString(),
        };
        return context;
      }),
    observe,
    config,
    record: (input) =>
      withClient(connectionString, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT * FROM commit_hns_root_import_readiness_v1($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.root_import_session_id,
            input.lifecycle_job_id,
            input.executor_id,
            input.lease_fence,
            input.expected_revision,
            input.result_bytes,
            input.result_sha256,
          ],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || row === undefined || typeof row.outcome !== "string") {
          throw new Error("HNS lifecycle readiness writer returned no result");
        }
        const revision = row.revision === null ? null : safePositiveInteger(row.revision);
        return { outcome: row.outcome, revision };
      }),
    finalize,
    now_epoch_ms: () => Date.now(),
  };
}

/**
 * The earliest persisted lifecycle due time, or null when no job is waiting.
 * Reclaimable expired leases count as due now, so a crashed executor's work is
 * picked up on the next sweep rather than at its original due time.
 */
export async function nextHnsLifecycleJobDueEpochMs(
  connectionString: string,
): Promise<number | null> {
  return withClient(connectionString, async (client) => {
    const result = await client.query<{ readonly due_at: Date | null }>(
      `SELECT MIN(due_at) AS due_at FROM hns_root_import_lifecycle_jobs
        WHERE state = 'queued'
           OR (state = 'leased' AND lease_expires_at <= clock_timestamp())`,
    );
    const dueAt = result.rows[0]?.due_at;
    return dueAt === null || dueAt === undefined ? null : dueAt.getTime();
  });
}
