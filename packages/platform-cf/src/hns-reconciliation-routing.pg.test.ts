import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { makePostgresHnsRootImportLifecycleQueue } from "../../../apps/hns-authority-provisioner/src/lifecycle-queue.ts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const PLAN_SHA = "a".repeat(64);

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema(
  use: (connection: string, admin: Client) => Promise<void>,
): Promise<void> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = `api_next_hns_reconcile_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  try {
    const scoped = connectionForSchema(connectionString, schema);
    await applyPostgresTestBaselineConnection({ connectionString: scoped });
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await use(scoped, admin);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

/**
 * Seeds the persisted failure payload: one failed job of the given kind, the
 * provider-failure decision that requested reconciliation, and the queued
 * reconcile job its requested work created.
 */
async function seedReconcileFixture(
  admin: Client,
  input: {
    readonly phase: "checking_authority" | "recovery_required";
    readonly failedKind: string;
  },
): Promise<void> {
  await admin.query("BEGIN");
  try {
    await admin.query(
      `INSERT INTO hns_root_import_lifecycle (
         root_import_session_id, root_label, phase, revision, generation,
         plan_exposed_at, publication_deadline_at, first_current_observation_at,
         finality_deadline_at, policy_name, policy_digest, plan_encoded_resource_sha256,
         pending_reason, next_check_at
       ) VALUES (
         'reconcile-session','exampleroot',$1,2,1,
         clock_timestamp() - interval '1 day', clock_timestamp() + interval '13 days',
         CASE WHEN $1 = 'checking_authority' THEN clock_timestamp() - interval '1 hour' END,
         CASE WHEN $1 = 'checking_authority' THEN clock_timestamp() + interval '23 hours' END,
         'hns_root_import_lifecycle_v1','reconcile',$2,
         'provider_failure:transport_failure', clock_timestamp() + interval '60 seconds'
       )`,
      [input.phase, PLAN_SHA],
    );
    const failed = await admin.query<{ lifecycle_job_id: string }>(
      `INSERT INTO hns_root_import_lifecycle_jobs (
         root_import_session_id, job_kind, due_at, state, failure_code, completed_at, generation
       ) VALUES (
         'reconcile-session',$1,clock_timestamp() - interval '2 minutes','failed',
         'provider_failure',clock_timestamp() - interval '2 minutes',1
       ) RETURNING lifecycle_job_id`,
      [input.failedKind],
    );
    // The decision writer inserts requested work before its own history row,
    // so the reconcile job is seeded first and the failure history row after
    // it. The routing lookup must bind to the scheduling decision from that
    // ordering, not from a history row that happens to precede the job.
    await admin.query(
      `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at, generation)
       VALUES ('reconcile-session','reconcile_provider',clock_timestamp() - interval '1 second',1)`,
    );
    await admin.query(
      `INSERT INTO hns_root_import_lifecycle_history (
         root_import_session_id, event_id, event_name, outcome, prior_phase, new_phase,
         decision_reason, requested_work, revision_after, recorded_at,
         lifecycle_job_id, lease_fence, generation
       ) VALUES (
         'reconcile-session','failure:reconcile','provider_failure','pending',$1,$1,
         'provider_failure:transport_failure',
         jsonb_build_array(jsonb_build_object(
           'kind','reconcile_provider',
           'due_at',(clock_timestamp() - interval '1 second')
         )),
         3, clock_timestamp(), $2, 0, 1
       )`,
      [input.phase, Number(failed.rows[0]?.lifecycle_job_id)],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

suite("HNS lifecycle reconciliation routing", () => {
  test("a current-view failure routes a fresh current observation and preserves the hold", async () => {
    await withSchema(async (connection, admin) => {
      await seedReconcileFixture(admin, {
        phase: "checking_authority",
        failedKind: "observe_current",
      });
      const queue = makePostgresHnsRootImportLifecycleQueue(connection, async () => ({
        kind: "none",
        evidence_ref: "reconciliation-fixture",
      }));
      const claim = await queue.claim("lifecycle-executor", 60);
      if (claim === null) throw new Error("no reconcile job was claimable");
      expect(await queue.reconcile?.(claim, "lifecycle-executor")).toMatchObject({
        outcome: "completed",
        reason: "reconcile_current_to_observe_current",
      });
      const jobs = await admin.query<{ job_kind: string; state: string }>(
        `SELECT job_kind, state FROM hns_root_import_lifecycle_jobs
          WHERE root_import_session_id='reconcile-session' ORDER BY lifecycle_job_id`,
      );
      expect(jobs.rows).toEqual([
        { job_kind: "observe_current", state: "failed" },
        { job_kind: "reconcile_provider", state: "completed" },
        { job_kind: "observe_current", state: "queued" },
      ]);
      const history = await admin.query<{
        event_name: string;
        outcome: string;
        decision_reason: string;
      }>(
        `SELECT event_name, outcome, decision_reason FROM hns_root_import_lifecycle_history
          WHERE root_import_session_id='reconcile-session' AND event_name='reconcile_routed'`,
      );
      expect(history.rows).toEqual([
        {
          event_name: "reconcile_routed",
          outcome: "pending",
          decision_reason: "reconcile_current_to_observe_current",
        },
      ]);
      // Routing records work, not evidence: the failure hold is preserved and
      // no observation summary is bound.
      const lifecycle = await admin.query<{ pending_reason: string; revision: string }>(
        `SELECT pending_reason, revision FROM hns_root_import_lifecycle
          WHERE root_import_session_id='reconcile-session'`,
      );
      expect(lifecycle.rows[0]).toMatchObject({
        pending_reason: "provider_failure:transport_failure",
        revision: "3",
      });
    });
  }, 30_000);

  test("a readiness failure routes readiness work", async () => {
    await withSchema(async (connection, admin) => {
      await seedReconcileFixture(admin, {
        phase: "checking_authority",
        failedKind: "observe_readiness",
      });
      const queue = makePostgresHnsRootImportLifecycleQueue(connection, async () => ({
        kind: "none",
        evidence_ref: "reconciliation-fixture",
      }));
      const claim = await queue.claim("lifecycle-executor", 60);
      if (claim === null) throw new Error("no reconcile job was claimable");
      expect(await queue.reconcile?.(claim, "lifecycle-executor")).toMatchObject({
        outcome: "completed",
        reason: "reconcile_readiness_to_observe_readiness",
      });
      expect(
        (
          await admin.query<{ count: number }>(
            `SELECT count(*)::integer AS count FROM hns_root_import_lifecycle_jobs
              WHERE root_import_session_id='reconcile-session'
                AND job_kind='observe_readiness' AND state='queued'`,
          )
        ).rows[0]?.count,
      ).toBe(1);
    });
  }, 30_000);

  test("a superseded phase records a named disposition and schedules nothing", async () => {
    await withSchema(async (connection, admin) => {
      await seedReconcileFixture(admin, {
        phase: "recovery_required",
        failedKind: "observe_current",
      });
      const queue = makePostgresHnsRootImportLifecycleQueue(connection, async () => ({
        kind: "none",
        evidence_ref: "reconciliation-fixture",
      }));
      const claim = await queue.claim("lifecycle-executor", 60);
      if (claim === null) throw new Error("no reconcile job was claimable");
      expect(await queue.reconcile?.(claim, "lifecycle-executor")).toMatchObject({
        outcome: "completed",
        reason: "reconcile_superseded_recovery_required",
      });
      expect(
        (
          await admin.query<{ count: number }>(
            `SELECT count(*)::integer AS count FROM hns_root_import_lifecycle_jobs
              WHERE root_import_session_id='reconcile-session' AND state='queued'`,
          )
        ).rows[0]?.count,
      ).toBe(0);
      expect(
        (
          await admin.query<{ decision_reason: string }>(
            `SELECT decision_reason FROM hns_root_import_lifecycle_history
              WHERE root_import_session_id='reconcile-session' AND event_name='reconcile_routed'`,
          )
        ).rows[0]?.decision_reason,
      ).toBe("reconcile_superseded_recovery_required");
    });
  }, 30_000);

  test("an unrecognized failed responsibility records a named disposition", async () => {
    await withSchema(async (connection, admin) => {
      await seedReconcileFixture(admin, {
        phase: "checking_authority",
        failedKind: "retention_review",
      });
      const queue = makePostgresHnsRootImportLifecycleQueue(connection, async () => ({
        kind: "none",
        evidence_ref: "reconciliation-fixture",
      }));
      const claim = await queue.claim("lifecycle-executor", 60);
      if (claim === null) throw new Error("no reconcile job was claimable");
      expect(await queue.reconcile?.(claim, "lifecycle-executor")).toMatchObject({
        outcome: "completed",
        reason: "reconcile_responsibility_unknown",
      });
    });
  }, 30_000);
});
