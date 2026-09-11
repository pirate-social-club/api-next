import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * The observation-write fence, boundary by boundary, against the completed
 * provenance model.
 *
 * Migration 0148 fenced the writer against the job lease and the accepted
 * decision's revision and phase, and its review found the openings this suite
 * now covers: the decision carried no job, fence or generation provenance;
 * generation was a caller assertion; the clock was read before the locks; a
 * NULL fence slipped the OR chain; and a future observation was tolerated by
 * thirty seconds. Migration 0149 adds the provenance columns, stamps jobs
 * with their scheduling generation, re-reads the clock after both locks and
 * validates every argument for NULL. Every refusal here must leave the
 * stored summary, the lifecycle row and the authorization state unchanged.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

/** Each case builds a schema and applies every migration. */
const BUDGET_MS = 180_000;

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const session = "fence-session";
const executor = "fence-executor";
const digest = "a".repeat(64);

async function withSchema<A>(use: (admin: Client) => Promise<A>): Promise<A> {
  const schema = `hns_fence_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`SET search_path TO ${quote(schema)}`);
    for (const migration of await loadPostgresMigrations()) await admin.query(migration.sql);
    return await use(admin);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

/** An operation waiting on publication evidence; every case starts here. */
async function seedLifecycle(admin: Client, revision = 1): Promise<void> {
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle (
       root_import_session_id, root_label, phase, revision, generation,
       plan_exposed_at, publication_deadline_at,
       policy_name, policy_digest, plan_encoded_resource_sha256
     ) VALUES ($1,'fenced','checking_publication',$2,1,
       clock_timestamp() - interval '1 day', clock_timestamp() + interval '13 days',
       'hns_root_import_lifecycle_v1','fence',$3)`,
    [session, revision, digest],
  );
}

/** Queues one job and claims it, returning the claimed row. */
async function claimJob(admin: Client, jobKind: "observe_current" | "observe_safe") {
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
       VALUES ($1,$2,clock_timestamp() - interval '1 second')`,
    [session, jobKind],
  );
  const claimed = await admin.query<Record<string, unknown>>(
    "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
    [executor, 60],
  );
  expect(claimed.rows.length).toBe(1);
  return claimed.rows[0] as Record<string, unknown>;
}

async function commitDecision(
  admin: Client,
  input: {
    readonly eventId: string;
    readonly job?: Record<string, unknown>;
    readonly eventName?: string;
    readonly outcome?: "transition" | "pending" | "rejection";
    readonly targetPhase?: string | null;
    readonly revision?: number;
    readonly provenanceJobId?: string | number | null;
    readonly provenanceFence?: number | null;
  },
): Promise<void> {
  await admin.query(
    `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1(
       $1,$2,$3,$4,$5,'fence-decision',$6,'{}'::jsonb,'[]'::jsonb,$7::bigint,$8::bigint)`,
    [
      session,
      input.revision ?? 1,
      input.eventId,
      input.eventName ?? "safe_observation",
      input.outcome ?? "pending",
      input.targetPhase === undefined ? "checking_publication" : input.targetPhase,
      input.provenanceJobId === undefined
        ? (input.job?.lifecycle_job_id ?? null)
        : input.provenanceJobId,
      input.provenanceFence === undefined
        ? input.job === undefined
          ? null
          : Number(input.job.lease_fence)
        : input.provenanceFence,
    ],
  );
}

const record = (
  admin: Client,
  input: {
    readonly job: Record<string, unknown>;
    readonly view?: string;
    readonly observedAt?: string;
    readonly eventId?: string;
    readonly freshnessSeconds?: number;
    readonly session?: string | null;
    readonly holder?: string;
    readonly fence?: number | null;
  },
) =>
  admin.query<{ readonly outcome: string }>(
    `SELECT record_hns_root_import_lifecycle_observation_v1(
       $1,$2,$3,$4,$5,$6,3300,3248,3295,$7::timestamptz,$8,$9) AS outcome`,
    [
      input.session === undefined ? session : input.session,
      input.job.lifecycle_job_id,
      input.holder ?? executor,
      input.fence === undefined ? Number(input.job.lease_fence) : input.fence,
      input.view ?? "safe",
      "b".repeat(64),
      input.observedAt ?? new Date().toISOString(),
      input.eventId ?? "fence-decision",
      input.freshnessSeconds ?? 3_600,
    ],
  );

/** The stored summary and identity, for refusal-unchanged assertions. */
async function stored(admin: Client) {
  const result = await admin.query<Record<string, unknown>>(
    `SELECT phase, revision, generation, last_observation_view,
            last_observation_resource_sha256, last_observation_at,
            last_observation_recorded_at
       FROM hns_root_import_lifecycle WHERE root_import_session_id = $1`,
    [session],
  );
  return result.rows[0] as Record<string, unknown>;
}

const expectUnchanged = (row: Record<string, unknown>) => {
  expect(row.last_observation_view).toBeNull();
  expect(row.last_observation_resource_sha256).toBeNull();
  expect(row.last_observation_at).toBeNull();
  expect(row.last_observation_recorded_at).toBeNull();
};

suite("the observation writer accepts only an accepted decision on a live lease", () => {
  test(
    "records a pending decision's summary and stamps its own recorded time",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        await commitDecision(admin, { eventId: "fence-decision", job });
        const observedAt = new Date(Date.now() - 120_000).toISOString();
        const before = await admin.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
        const beforeNow = before.rows[0]?.now;
        if (beforeNow === undefined) throw new Error("database clock was not read");
        const written = await record(admin, { job, observedAt });
        expect(written.rows[0]?.outcome).toBe("recorded");
        const row = await stored(admin);
        expect(row.last_observation_view).toBe("safe");
        // The observation keeps the caller's moment; the record time is the
        // database's and is after the observation, not supplied by the caller.
        expect((row.last_observation_at as Date).getTime()).toBeLessThan(beforeNow.getTime());
        expect((row.last_observation_recorded_at as Date).getTime()).toBeGreaterThanOrEqual(
          beforeNow.getTime(),
        );
      });
    },
    BUDGET_MS,
  );

  test(
    "refuses a job belonging to another operation",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        await commitDecision(admin, { eventId: "fence-decision", job });
        const refused = await record(admin, { job, session: "another-session" });
        expect(refused.rows[0]?.outcome).toBe("lease_conflict");
        expectUnchanged(await stored(admin));
      });
    },
    BUDGET_MS,
  );

  test(
    "refuses another holder, another fence, and an expired lease",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        await commitDecision(admin, { eventId: "fence-decision", job });
        expect((await record(admin, { job, holder: "other-executor" })).rows[0]?.outcome).toBe(
          "lease_conflict",
        );
        expect(
          (await record(admin, { job, fence: Number(job.lease_fence) + 1 })).rows[0]?.outcome,
        ).toBe("lease_conflict");
        await admin.query(
          `UPDATE hns_root_import_lifecycle_jobs SET lease_expires_at = clock_timestamp() - interval '1 second'
            WHERE lifecycle_job_id = $1`,
          [job.lifecycle_job_id],
        );
        expect((await record(admin, { job })).rows[0]?.outcome).toBe("lease_conflict");
        expectUnchanged(await stored(admin));
      });
    },
    BUDGET_MS,
  );

  test(
    "refuses a view the claimed job kind does not perform",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_current");
        await commitDecision(admin, { eventId: "fence-decision", job });
        const refused = await record(admin, { job, view: "safe" });
        expect(refused.rows[0]?.outcome).toBe("job_kind_mismatch");
        expectUnchanged(await stored(admin));
      });
    },
    BUDGET_MS,
  );

  test(
    "refuses a NULL session and a NULL fence explicitly",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        await commitDecision(admin, { eventId: "fence-decision", job });
        // A NULL session or fence once made the comparison chain evaluate to
        // NULL and fall through. Both are now rejected as invalid evidence.
        await expect(record(admin, { job, session: null })).rejects.toThrow(
          /invalid HNS lifecycle observation evidence/u,
        );
        await expect(record(admin, { job, fence: null })).rejects.toThrow(
          /invalid HNS lifecycle observation evidence/u,
        );
        expectUnchanged(await stored(admin));
      });
    },
    BUDGET_MS,
  );

  test(
    "refuses a job whose scheduled generation is not the operation's",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        await commitDecision(admin, { eventId: "fence-decision", job });
        // Adoption is the only production writer that increases the
        // generation. The job was scheduled under generation 1 and the
        // operation is now generation 2, so it describes a different
        // operation and must not write.
        await admin.query(
          "UPDATE hns_root_import_lifecycle SET generation = 2 WHERE root_import_session_id = $1",
          [session],
        );
        const refused = await record(admin, { job });
        expect(refused.rows[0]?.outcome).toBe("generation_conflict");
        expectUnchanged(await stored(admin));
        // And the stale job is not claimable: expired, it is disposed with a
        // named failure rather than handed out again.
        await admin.query(
          `UPDATE hns_root_import_lifecycle_jobs SET lease_expires_at = clock_timestamp() - interval '1 second'
            WHERE lifecycle_job_id = $1`,
          [job.lifecycle_job_id],
        );
        const reclaimed = await admin.query<Record<string, unknown>>(
          "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
          [executor, 60],
        );
        expect(reclaimed.rows).toHaveLength(0);
        const disposed = await admin.query<Record<string, unknown>>(
          "SELECT state, failure_code FROM hns_root_import_lifecycle_jobs WHERE lifecycle_job_id = $1",
          [job.lifecycle_job_id],
        );
        expect(disposed.rows[0]).toMatchObject({
          state: "failed",
          failure_code: "generation_superseded",
        });
      });
    },
    BUDGET_MS,
  );

  test(
    "refuses a decision bound to another job, fence or generation",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        // Another job on the same operation committed this event.
        await commitDecision(admin, {
          eventId: "other-job-decision",
          job,
          provenanceJobId: 999_999,
        });
        expect((await record(admin, { job, eventId: "other-job-decision" })).rows[0]?.outcome).toBe(
          "decision_conflict",
        );
        // The same job id but a different lease fence.
        await commitDecision(admin, {
          eventId: "other-fence-decision",
          job,
          revision: 2,
          provenanceFence: Number(job.lease_fence) + 1,
        });
        expect(
          (await record(admin, { job, eventId: "other-fence-decision" })).rows[0]?.outcome,
        ).toBe("decision_conflict");
        // A decision whose recorded generation does not match the operation.
        await commitDecision(admin, { eventId: "fence-decision", job, revision: 3 });
        await admin.query(
          `UPDATE hns_root_import_lifecycle_history SET generation = 999
            WHERE event_id = 'fence-decision'`,
        );
        expect((await record(admin, { job })).rows[0]?.outcome).toBe("decision_conflict");
        expectUnchanged(await stored(admin));
      });
    },
    BUDGET_MS,
  );

  test(
    "refuses a missing, refused, superseded, or wrong-view decision",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        await commitDecision(admin, { eventId: "fence-decision", job });
        // No history row at all cannot substitute for a decision.
        expect((await record(admin, { job, eventId: "no-such-event" })).rows[0]?.outcome).toBe(
          "decision_conflict",
        );
        // A rejection is recorded history, but not an accepted observation.
        await commitDecision(admin, {
          eventId: "refused-event",
          job,
          outcome: "rejection",
          revision: 2,
        });
        expect((await record(admin, { job, eventId: "refused-event" })).rows[0]?.outcome).toBe(
          "decision_conflict",
        );
        // A decision the operation has already moved past is not current.
        await commitDecision(admin, { eventId: "later-event", job, revision: 2 });
        expect((await record(admin, { job })).rows[0]?.outcome).toBe("decision_conflict");
        // A current-view event cannot accept a safe-view summary.
        await commitDecision(admin, {
          eventId: "wrong-view-event",
          job,
          eventName: "current_observation",
          revision: 3,
        });
        expect((await record(admin, { job, eventId: "wrong-view-event" })).rows[0]?.outcome).toBe(
          "decision_conflict",
        );
        expectUnchanged(await stored(admin));
      });
    },
    BUDGET_MS,
  );

  test(
    "refuses a future observation strictly and an observation past its freshness bound",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        // Five seconds ahead is still in the future: the 0148 thirty-second
        // skew allowance was unratified and is removed.
        const future = new Date(Date.now() + 5_000).toISOString();
        expect((await record(admin, { job, observedAt: future })).rows[0]?.outcome).toBe(
          "observation_in_future",
        );
        const stale = new Date(Date.now() - 7_200_000).toISOString();
        expect(
          (await record(admin, { job, observedAt: stale, freshnessSeconds: 60 })).rows[0]?.outcome,
        ).toBe("observation_stale");
        expectUnchanged(await stored(admin));
      });
    },
    BUDGET_MS,
  );
});
