import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * The observation-write fence, boundary by boundary.
 *
 * Migration 0145 fenced the writer against the job lease and stopped there.
 * Its own review found that the fence did not check the job kind, the
 * operation generation, or the decision that accepted the reading, and that
 * the caller supplied both the observation time and the summary. Since the
 * function is SECURITY DEFINER and granted to the runtime role, the holder of
 * any still-valid lease could write server evidence that the public
 * projection reports. This suite drives every boundary the completed fence
 * claims to enforce, and asserts that each refusal leaves the stored summary
 * and the lifecycle row unchanged.
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

/** An operation waiting on safe commitment; every case starts from here. */
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
    readonly outcome?: "transition" | "pending" | "rejection";
    readonly targetPhase?: string | null;
    readonly revision?: number;
  },
): Promise<void> {
  await admin.query(
    `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1(
       $1,$2,$3,'safe_observation',$4,'fence-decision',$5,'{}'::jsonb,'[]'::jsonb)`,
    [
      session,
      input.revision ?? 1,
      input.eventId,
      input.outcome ?? "pending",
      input.targetPhase === undefined ? "checking_publication" : input.targetPhase,
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
    readonly generation?: number;
    readonly freshnessSeconds?: number;
    readonly session?: string;
    readonly holder?: string;
    readonly fence?: number;
  },
) =>
  admin.query<{ readonly outcome: string }>(
    `SELECT record_hns_root_import_lifecycle_observation_v1(
       $1,$2,$3,$4,$5,$6,3300,3248,3295,$7::timestamptz,$8,$9,$10) AS outcome`,
    [
      input.session ?? session,
      input.job.lifecycle_job_id,
      input.holder ?? executor,
      input.fence ?? Number(input.job.lease_fence),
      input.view ?? "safe",
      "b".repeat(64),
      input.observedAt ?? new Date().toISOString(),
      input.eventId ?? "fence-decision",
      input.generation ?? 1,
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
    "records the summary and stamps its own recorded time",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        await commitDecision(admin, { eventId: "fence-decision" });
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
        await commitDecision(admin, { eventId: "fence-decision" });
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
        await commitDecision(admin, { eventId: "fence-decision" });
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
        await commitDecision(admin, { eventId: "fence-decision" });
        const refused = await record(admin, { job, view: "safe" });
        expect(refused.rows[0]?.outcome).toBe("job_kind_mismatch");
        expectUnchanged(await stored(admin));
      });
    },
    BUDGET_MS,
  );

  test(
    "refuses a lease issued against a superseded generation",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        await commitDecision(admin, { eventId: "fence-decision" });
        // Adoption is the only production writer that increases the
        // generation, and the guard permits the increase. A lease taken under
        // the old generation must not write against the new one.
        await admin.query(
          "UPDATE hns_root_import_lifecycle SET generation = 2 WHERE root_import_session_id = $1",
          [session],
        );
        const refused = await record(admin, { job, generation: 1 });
        expect(refused.rows[0]?.outcome).toBe("generation_conflict");
        expectUnchanged(await stored(admin));
      });
    },
    BUDGET_MS,
  );

  test(
    "refuses a missing, refused, or superseded decision",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        await commitDecision(admin, { eventId: "fence-decision" });
        // No history row at all cannot substitute for a decision.
        expect((await record(admin, { job, eventId: "no-such-event" })).rows[0]?.outcome).toBe(
          "decision_conflict",
        );
        // A rejection is recorded history, but not an accepted observation.
        await commitDecision(admin, {
          eventId: "refused-event",
          outcome: "rejection",
          revision: 2,
        });
        expect((await record(admin, { job, eventId: "refused-event" })).rows[0]?.outcome).toBe(
          "decision_conflict",
        );
        // A decision the operation has already moved past is not current.
        await commitDecision(admin, {
          eventId: "later-event",
          revision: 2,
        });
        expect((await record(admin, { job, eventId: "fence-decision" })).rows[0]?.outcome).toBe(
          "decision_conflict",
        );
        expectUnchanged(await stored(admin));
      });
    },
    BUDGET_MS,
  );

  test(
    "refuses a future observation and an observation past its freshness bound",
    async () => {
      await withSchema(async (admin) => {
        await seedLifecycle(admin);
        const job = await claimJob(admin, "observe_safe");
        const future = new Date(Date.now() + 3_600_000).toISOString();
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
