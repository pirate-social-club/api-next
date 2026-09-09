import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

const commitDecision = `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1(
  $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`;

async function insertLifecycleRow(
  admin: Client,
  sessionId: string,
  phase: string,
  revision = 1,
): Promise<void> {
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle (
       root_import_session_id, root_label, phase, revision, generation,
       plan_exposed_at, publication_deadline_at,
       first_current_observation_at, finality_deadline_at,
       policy_name, policy_digest
     ) VALUES ($1,'newroot',$2,$3,1,
       CASE WHEN $2 IN ('awaiting_publication','checking_publication','waiting_safe_commitment','checking_authority','ready')
         THEN clock_timestamp() - interval '1 hour' END,
       CASE WHEN $2 IN ('awaiting_publication','checking_publication','waiting_safe_commitment','checking_authority','ready')
         THEN clock_timestamp() + interval '13 days' END,
       CASE WHEN $2 IN ('waiting_safe_commitment','checking_authority','ready')
         THEN clock_timestamp() - interval '30 minutes' END,
       CASE WHEN $2 IN ('waiting_safe_commitment','checking_authority','ready')
         THEN clock_timestamp() + interval '23 hours' END,
       'hns_root_import_policy_v1','hns_root_import_policy_v1:0388a3cc')`,
    [sessionId, phase, revision],
  );
}

suite("HNS root-import lifecycle atomic PostgreSQL semantics (T08)", () => {
  test("commits state, history, and requested jobs in one transaction", async () => {
    const schema = `hns_lifecycle_t08_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      for (const migration of await loadPostgresMigrations()) {
        await admin.query(migration.sql);
      }
      await insertLifecycleRow(admin, "session-atomic", "awaiting_publication");
      const decision = await admin.query(commitDecision, [
        "session-atomic",
        1,
        "event-current-1",
        "current_observation",
        "transition",
        "current_inclusion_implied_publication",
        "waiting_safe_commitment",
        JSON.stringify({
          first_current_observation_at: new Date().toISOString(),
          finality_deadline_at: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        JSON.stringify([
          { kind: "observe_safe", due_at: new Date(Date.now() + 900_000).toISOString() },
        ]),
      ]);
      expect(decision.rows[0]).toMatchObject({ outcome: "transition", replayed: false });
      expect(decision.rows[0].revision).toBe("2");
      const state = await admin.query(
        "SELECT phase, revision FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
        ["session-atomic"],
      );
      expect(state.rows[0]).toEqual({ phase: "waiting_safe_commitment", revision: "2" });
      const history = await admin.query(
        "SELECT event_name, outcome, prior_phase, new_phase, revision_after FROM hns_root_import_lifecycle_history WHERE root_import_session_id=$1",
        ["session-atomic"],
      );
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0]).toMatchObject({
        event_name: "current_observation",
        outcome: "transition",
        prior_phase: "awaiting_publication",
        new_phase: "waiting_safe_commitment",
      });
      const jobs = await admin.query(
        "SELECT job_kind, state FROM hns_root_import_lifecycle_jobs WHERE root_import_session_id=$1",
        ["session-atomic"],
      );
      expect(jobs.rows).toEqual([{ job_kind: "observe_safe", state: "queued" }]);
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
        .catch(() => undefined);
      await admin.end();
    }
  });

  test("rejects a stale expected revision as a serialization conflict", async () => {
    const schema = `hns_lifecycle_t08_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      for (const migration of await loadPostgresMigrations()) {
        await admin.query(migration.sql);
      }
      await insertLifecycleRow(admin, "session-stale", "awaiting_publication", 7);
      await expect(
        admin.query(commitDecision, [
          "session-stale",
          6,
          "event-stale-1",
          "publication_acknowledged",
          "transition",
          "acknowledged",
          "checking_publication",
          JSON.stringify({}),
          JSON.stringify([]),
        ]),
      ).rejects.toMatchObject({ code: "40001" });
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
        .catch(() => undefined);
      await admin.end();
    }
  });

  test("replays an applied event identity without changing state or duplicating history", async () => {
    const schema = `hns_lifecycle_t08_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      for (const migration of await loadPostgresMigrations()) {
        await admin.query(migration.sql);
      }
      await insertLifecycleRow(admin, "session-replay", "awaiting_publication");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await admin.query(commitDecision, [
          "session-replay",
          1,
          "event-ack-1",
          "publication_acknowledged",
          "transition",
          "acknowledged",
          "checking_publication",
          JSON.stringify({}),
          JSON.stringify([]),
        ]);
        expect(result.rows[0].replayed).toBe(attempt === 1);
        expect(result.rows[0].revision).toBe(attempt === 0 ? "2" : "2");
      }
      const history = await admin.query(
        "SELECT count(*)::int AS count FROM hns_root_import_lifecycle_history WHERE root_import_session_id=$1",
        ["session-replay"],
      );
      expect(history.rows[0].count).toBe(1);
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
        .catch(() => undefined);
      await admin.end();
    }
  });

  test("refuses a transition outside the pure table and keeps the anchor and terminal phase immutable", async () => {
    const schema = `hns_lifecycle_t08_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      for (const migration of await loadPostgresMigrations()) {
        await admin.query(migration.sql);
      }
      await insertLifecycleRow(admin, "session-invalid", "preparing");
      await expect(
        admin.query(commitDecision, [
          "session-invalid",
          1,
          "event-invalid-1",
          "activation_requested",
          "transition",
          "activated",
          "activated",
          JSON.stringify({ readiness_observed_at: new Date().toISOString() }),
          JSON.stringify([]),
        ]),
      ).rejects.toThrow(/not permitted/);

      const anchored = await admin.query(
        `UPDATE hns_root_import_lifecycle
            SET first_current_observation_at = clock_timestamp(),
                finality_deadline_at = clock_timestamp() + interval '24 hours'
          WHERE root_import_session_id='session-invalid'
          RETURNING first_current_observation_at, finality_deadline_at`,
      );
      const anchor = anchored.rows[0].first_current_observation_at;
      await expect(
        admin.query(
          `UPDATE hns_root_import_lifecycle
              SET first_current_observation_at = clock_timestamp() + interval '1 hour'
            WHERE root_import_session_id='session-invalid'`,
        ),
      ).rejects.toThrow(/immutable/);
      const retained = await admin.query(
        "SELECT first_current_observation_at FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
        ["session-invalid"],
      );
      expect(retained.rows[0].first_current_observation_at).toEqual(anchor);
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
        .catch(() => undefined);
      await admin.end();
    }
  });

  test("claims jobs in due order across roots and classes and fences finalize against lost leases", async () => {
    const schema = `hns_lifecycle_t08_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      for (const migration of await loadPostgresMigrations()) {
        await admin.query(migration.sql);
      }
      await insertLifecycleRow(admin, "session-root-a", "waiting_safe_commitment");
      await insertLifecycleRow(admin, "session-root-b", "waiting_safe_commitment");
      const now = Date.now();
      await admin.query(
        `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at) VALUES
           ('session-root-a','observe_safe',$1::timestamptz),
           ('session-root-b','observe_current',$2::timestamptz),
           ('session-root-a','observe_current',$2::timestamptz),
           ('session-root-b','reconcile_provider',$3::timestamptz)`,
        [
          new Date(now - 60_000).toISOString(),
          new Date(now - 30_000).toISOString(),
          new Date(now + 3_600_000).toISOString(),
        ],
      );
      const claims: Array<{ readonly kind: string; readonly session: string }> = [];
      for (let index = 0; index < 3; index += 1) {
        const claimed = await admin.query(
          "SELECT * FROM claim_hns_root_import_lifecycle_job_v1('executor-a', 60)",
        );
        if (claimed.rows.length === 1) {
          claims.push({
            kind: claimed.rows[0].job_kind,
            session: claimed.rows[0].root_import_session_id,
          });
        }
      }
      // Due order first; the future-due reconcile job is not claimable.
      expect(claims).toEqual([
        { kind: "observe_safe", session: "session-root-a" },
        { kind: "observe_current", session: "session-root-b" },
        { kind: "observe_current", session: "session-root-a" },
      ]);

      const reclaimed = await admin.query(
        "SELECT * FROM claim_hns_root_import_lifecycle_job_v1('executor-b', 60)",
      );
      expect(reclaimed.rows).toHaveLength(0);
      // Expire the lease by force; the reclaim gets a fresh fence.
      await admin.query(
        `UPDATE hns_root_import_lifecycle_jobs
            SET lease_expires_at = clock_timestamp() - interval '1 second'
          WHERE state='leased'`,
      );
      const stolen = await admin.query(
        "SELECT * FROM claim_hns_root_import_lifecycle_job_v1('executor-b', 60)",
      );
      expect(stolen.rows).toHaveLength(1);
      const stolenJobId = stolen.rows[0].lifecycle_job_id;
      const stolenFence = stolen.rows[0].lease_fence;
      // The dispossessed executor's stale fence cannot finalize.
      const fenced = await admin.query(
        "SELECT * FROM finalize_hns_root_import_lifecycle_job_v1($1,'executor-a',1,'completed',NULL)",
        [claims[0] ? await jobIdFor(admin, claims[0].session) : 0],
      );
      expect(fenced.rows[0].outcome).toBe("conflict");
      const finalized = await admin.query(
        "SELECT * FROM finalize_hns_root_import_lifecycle_job_v1($1,'executor-b',$2,'completed',NULL)",
        [stolenJobId, stolenFence],
      );
      expect(finalized.rows[0].outcome).toBe("completed");
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
        .catch(() => undefined);
      await admin.end();
    }
  });

  test("retains the last useful error and budget exhaustion reason on provider failures", async () => {
    const schema = `hns_lifecycle_t08_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      for (const migration of await loadPostgresMigrations()) {
        await admin.query(migration.sql);
      }
      await insertLifecycleRow(admin, "session-budget", "checking_publication");
      const pending = await admin.query(commitDecision, [
        "session-budget",
        1,
        "event-failure-8",
        "provider_failure",
        "pending",
        "operational_failure_budget_exhausted:transport_failure",
        "checking_publication",
        JSON.stringify({
          consecutive_operational_failures: 8,
          last_useful_error: "transport_failure",
          last_useful_error_at: new Date().toISOString(),
          next_check_at: new Date(Date.now() + 60_000).toISOString(),
        }),
        JSON.stringify([
          { kind: "reconcile_provider", due_at: new Date(Date.now() + 60_000).toISOString() },
        ]),
      ]);
      expect(pending.rows[0].outcome).toBe("pending");
      const state = await admin.query(
        `SELECT phase, consecutive_operational_failures, last_useful_error
           FROM hns_root_import_lifecycle WHERE root_import_session_id=$1`,
        ["session-budget"],
      );
      expect(state.rows[0]).toMatchObject({
        phase: "checking_publication",
        consecutive_operational_failures: "8",
        last_useful_error: "transport_failure",
      });
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
        .catch(() => undefined);
      await admin.end();
    }
  });
});

async function jobIdFor(admin: Client, sessionId: string): Promise<number> {
  const result = await admin.query(
    "SELECT lifecycle_job_id FROM hns_root_import_lifecycle_jobs WHERE root_import_session_id=$1 ORDER BY lifecycle_job_id LIMIT 1",
    [sessionId],
  );
  return result.rows[0].lifecycle_job_id;
}
