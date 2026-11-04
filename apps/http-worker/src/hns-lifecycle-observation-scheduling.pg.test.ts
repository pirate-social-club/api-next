import { expect, test } from "bun:test";
import { continueHnsCommunityPublication } from "@pirate/application/namespace-ownership";
import { Effect } from "effect";
import { runHnsRootImportLifecycleJobOnce } from "../../hns-authority-provisioner/src/lifecycle-executor.ts";
import {
  type AcknowledgedImport,
  lifecyclePortsFor,
  prepareAcknowledgedImport,
} from "./hns-community-activation.pg-fixture.ts";

/**
 * Regression gate for lifecycle observation scheduling. A real provisional
 * import is started, provisioned and exposed through the production handlers
 * and executors; nothing seeds a phase or inserts a job. Plan exposure must
 * schedule exactly one current observation at the 900 s cadence, the owner's
 * acknowledgement must make that same job due, retries must add no duplicate
 * and no claimable legacy observe_root_v1 job, and the lifecycle runner must then carry
 * the operation from current observation through safe commitment to ready.
 * Only the database clock is advanced, by moving the one scheduled job's due
 * time, where the policy would otherwise wait 900 s.
 */

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

type ScheduledJob = Readonly<{
  lifecycle_job_id: string;
  job_kind: string;
  state: string;
  due_at: Date;
}>;

async function queuedJobs(base: AcknowledgedImport): Promise<readonly ScheduledJob[]> {
  const result = await base.admin.query<ScheduledJob>(
    `SELECT lifecycle_job_id::text, job_kind, state, due_at
       FROM hns_root_import_lifecycle_jobs
      WHERE root_import_session_id=$1 AND state='queued'
      ORDER BY lifecycle_job_id`,
    [base.sessionId],
  );
  return result.rows;
}

async function lifecycleRow(base: AcknowledgedImport) {
  const result = await base.admin.query<{
    phase: string;
    plan_exposed_at: Date;
    next_check_at: Date | null;
    now: Date;
  }>(
    `SELECT phase, plan_exposed_at, next_check_at, clock_timestamp() AS now
       FROM hns_root_import_lifecycle WHERE root_import_session_id=$1`,
    [base.sessionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("lifecycle row missing");
  return row;
}

/** Legacy observe_root_v1 rows: only ever recorded in the cutover disposition. */
async function legacyObservationJobs(base: AcknowledgedImport) {
  const result = await base.admin.query<{ state: string; failure_code: string | null }>(
    `SELECT state, failure_code FROM hns_root_import_observation_jobs
      WHERE root_import_session_id=$1`,
    [base.sessionId],
  );
  return result.rows;
}
const retiredOnly = [{ state: "failed", failure_code: "readiness_single_owner_cutover" }];

/** Advances the clock for the single scheduled job only; asserts it is the only one. */
async function makeOnlyJobDue(base: AcknowledgedImport, kind: string) {
  const jobs = await queuedJobs(base);
  expect(jobs.map((job) => job.job_kind)).toEqual([kind]);
  await base.admin.query(
    `UPDATE hns_root_import_lifecycle_jobs SET due_at=clock_timestamp() - interval '1 second'
      WHERE lifecycle_job_id=$1`,
    [jobs[0]?.lifecycle_job_id],
  );
}

pgTest(
  "plan exposure schedules one current observation, acknowledgement makes it due, and the runner reaches ready",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const base = await prepareAcknowledgedImport({ connectionString: url, acknowledge: false });
    try {
      const { ports } = lifecyclePortsFor(base);
      base.hsd.setRecords(base.planRecords);
      base.hsd.setSafeRecords(base.planRecords);

      // Plan exposure: exactly one observe_current at plan_exposed_at + 900 s.
      const exposed = await lifecycleRow(base);
      expect(exposed.phase).toBe("awaiting_publication");
      const [scheduled, ...others] = await queuedJobs(base);
      expect(others).toEqual([]);
      if (scheduled === undefined) throw new Error("plan exposure scheduled no lifecycle job");
      expect(scheduled.job_kind).toBe("observe_current");
      expect(scheduled.due_at.getTime()).toBe(exposed.plan_exposed_at.getTime() + 900_000);
      expect(exposed.next_check_at?.getTime()).toBe(scheduled.due_at.getTime());
      // Not due yet: the runner finds nothing to claim.
      expect(await runHnsRootImportLifecycleJobOnce("lifecycle-executor", 60, ports)).toMatchObject(
        {
          claimed: false,
        },
      );

      // Acknowledgement makes the same job due now; a retry changes nothing.
      expect((await base.acknowledge()).status).toBe(202);
      const acknowledged = await lifecycleRow(base);
      expect(acknowledged.phase).toBe("checking_publication");
      const afterAck = await queuedJobs(base);
      expect(afterAck.map((job) => job.lifecycle_job_id)).toEqual([scheduled.lifecycle_job_id]);
      expect(afterAck[0]?.due_at.getTime()).toBeLessThanOrEqual(acknowledged.now.getTime());
      expect([200, 202]).toContain((await base.acknowledge()).status);
      expect((await queuedJobs(base)).map((job) => job.lifecycle_job_id)).toEqual([
        scheduled.lifecycle_job_id,
      ]);

      // The owner published: the ownership check completes and the session
      // observes, without queuing legacy observe_root_v1 work.
      base.verifyOwnerPublication();
      for (let step = 0; step < 3; step++) {
        if (
          !(await Effect.runPromise(
            continueHnsCommunityPublication(base.services, base.services.publicationQueue),
          ))
        )
          break;
      }
      expect(((await (await base.call(base.sessionUrl)).json()) as { status: string }).status).toBe(
        "observing",
      );
      expect(await legacyObservationJobs(base)).toEqual(retiredOnly);
      expect((await queuedJobs(base)).map((job) => job.lifecycle_job_id)).toEqual([
        scheduled.lifecycle_job_id,
      ]);

      // The scheduled job is due without any clock movement: current observation.
      expect(await runHnsRootImportLifecycleJobOnce("lifecycle-executor", 60, ports)).toMatchObject(
        {
          claimed: true,
          outcome: "completed",
        },
      );
      expect((await lifecycleRow(base)).phase).toBe("waiting_safe_commitment");

      // Safe commitment, then readiness, each from its own scheduled job.
      await makeOnlyJobDue(base, "observe_safe");
      expect(await runHnsRootImportLifecycleJobOnce("lifecycle-executor", 60, ports)).toMatchObject(
        {
          claimed: true,
          outcome: "completed",
        },
      );
      expect((await lifecycleRow(base)).phase).toBe("checking_authority");
      await makeOnlyJobDue(base, "observe_readiness");
      expect(await runHnsRootImportLifecycleJobOnce("lifecycle-executor", 60, ports)).toMatchObject(
        {
          claimed: true,
          outcome: "completed",
        },
      );
      expect((await lifecycleRow(base)).phase).toBe("ready");
      expect(((await (await base.call(base.sessionUrl)).json()) as { status: string }).status).toBe(
        "ready",
      );
      expect(await legacyObservationJobs(base)).toEqual(retiredOnly);
    } finally {
      await base.cleanup();
    }
  },
  600_000,
);
