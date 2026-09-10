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
  "schedule_activation_window",
  "retention_review",
] as const;

type JobKind = (typeof JOB_KINDS)[number];

function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

/** BIGINT arrives as a string from node-postgres; anything else is a defect. */
function safePositiveInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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
        if (
          jobId === null ||
          typeof row?.root_import_session_id !== "string" ||
          !isJobKind(row.job_kind) ||
          leaseFence === null
        ) {
          throw new Error("HNS lifecycle queue returned an invalid job");
        }
        return {
          lifecycle_job_id: String(jobId),
          root_import_session_id: row.root_import_session_id,
          job_kind: row.job_kind,
          lease_fence: leaseFence,
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
    record_observation: async (client, job, executorId, summary) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT record_hns_root_import_lifecycle_observation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS outcome`,
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
        ],
      );
      if (result.rows[0]?.outcome !== "recorded") {
        // Throwing rolls the decision back with it: a committed transition
        // whose evidence was not persisted would project a phase the server
        // cannot account for.
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
