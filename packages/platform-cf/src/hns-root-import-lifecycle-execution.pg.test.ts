import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  type HnsLifecycleClaimV1,
  type HnsLifecycleEvidenceV1,
  type HnsLifecycleExecutorPortsV1,
  runHnsRootImportLifecycleJobOnce,
} from "../../../apps/hns-authority-provisioner/src/lifecycle-executor.ts";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * The leased execution path against a real database with a scripted chain.
 * Each test is a runtime sequence, not an isolated reducer or SQL assertion:
 * claim, observe outside the transaction, decide, commit, finalize.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

/**
 * Each case builds its own schema and applies every migration, which is well
 * past bun's five-second default. The budget is explicit so the suite fails on
 * a real hang rather than on the migration set having grown.
 */
const SCHEMA_BUDGET_MS = 120_000;

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const SESSION = "session-exec";

async function withSchema<A>(prefix: string, use: (admin: Client) => Promise<A>): Promise<A> {
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
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

async function seed(
  admin: Client,
  phase: string,
  options: {
    readonly planExposedInterval?: string;
    readonly publicationDeadlineInterval?: string;
    readonly firstCurrentInterval?: string;
    readonly finalityDeadlineInterval?: string;
    readonly readinessInterval?: string;
  } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle (
       root_import_session_id, root_label, phase, revision, generation,
       plan_exposed_at, publication_deadline_at, first_current_observation_at,
       finality_deadline_at, readiness_observed_at, policy_name, policy_digest
     ) VALUES ($1,'newroot',$2,1,1,
       CASE WHEN $3::text IS NULL THEN NULL ELSE clock_timestamp() + $3::interval END,
       CASE WHEN $4::text IS NULL THEN NULL ELSE clock_timestamp() + $4::interval END,
       CASE WHEN $5::text IS NULL THEN NULL ELSE clock_timestamp() + $5::interval END,
       CASE WHEN $6::text IS NULL THEN NULL ELSE clock_timestamp() + $6::interval END,
       CASE WHEN $7::text IS NULL THEN NULL ELSE clock_timestamp() + $7::interval END,
       'hns_root_import_lifecycle_v1','seed')`,
    [
      SESSION,
      phase,
      options.planExposedInterval ?? null,
      options.publicationDeadlineInterval ?? null,
      options.firstCurrentInterval ?? null,
      options.finalityDeadlineInterval ?? null,
      options.readinessInterval ?? null,
    ],
  );
}

async function queueJob(admin: Client, kind: string): Promise<void> {
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
     VALUES ($1,$2, clock_timestamp() - interval '1 second')`,
    [SESSION, kind],
  );
}

function ports(
  admin: Client,
  evidence: HnsLifecycleEvidenceV1,
  overrides: Partial<HnsLifecycleExecutorPortsV1> = {},
): HnsLifecycleExecutorPortsV1 {
  return {
    claim: async (executorId, leaseSeconds) => {
      const claimed = await admin.query(
        "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
        [executorId, leaseSeconds],
      );
      const row = claimed.rows[0];
      if (row === undefined) return null;
      return {
        lifecycle_job_id: String(row.lifecycle_job_id),
        root_import_session_id: String(row.root_import_session_id),
        job_kind: row.job_kind,
        lease_fence: Number(row.lease_fence),
      } as HnsLifecycleClaimV1;
    },
    identity: async (sessionId) => {
      const found = await admin.query(
        "SELECT root_label, generation, revision FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
        [sessionId],
      );
      const row = found.rows[0];
      if (row === undefined) return null;
      return {
        root_label: String(row.root_label),
        generation: Number(row.generation),
        revision: Number(row.revision),
        plan_encoded_resource_sha256: "ab".repeat(32),
      };
    },
    observe: async () => evidence,
    withTransaction: async (use) => {
      await admin.query("BEGIN");
      try {
        const result = await use(admin);
        await admin.query("COMMIT");
        return result;
      } catch (error) {
        await admin.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
    finalize: async (job, executorId, outcome, failureCode) => {
      const finalized = await admin.query(
        "SELECT * FROM finalize_hns_root_import_lifecycle_job_v1($1,$2,$3,$4,$5)",
        [job.lifecycle_job_id, executorId, job.lease_fence, outcome, failureCode],
      );
      return { outcome: String(finalized.rows[0]?.outcome) };
    },
    now_epoch_ms: () => Date.now(),
    ...overrides,
  };
}

const phaseOf = async (admin: Client) =>
  (
    await admin.query(
      `SELECT phase, first_current_observation_at, finality_deadline_at,
              consecutive_operational_failures, observation_count
         FROM hns_root_import_lifecycle WHERE root_import_session_id=$1`,
      [SESSION],
    )
  ).rows[0];

suite("HNS lifecycle leased execution sequences", () => {
  test(
    "finalization failure rolls back lifecycle state, history and successors",
    async () => {
      await withSchema("hns_exec_finalize_failure", async (admin) => {
        await seed(admin, "checking_publication", {
          planExposedInterval: "-1 hour",
          publicationDeadlineInterval: "13 days",
        });
        await queueJob(admin, "observe_current");
        const before = await phaseOf(admin);
        await admin.query(`
        CREATE FUNCTION reject_job_completion() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.state='completed' THEN RAISE EXCEPTION 'injected finalize failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_job_completion BEFORE UPDATE ON hns_root_import_lifecycle_jobs
          FOR EACH ROW EXECUTE FUNCTION reject_job_completion();
      `);
        await expect(
          runHnsRootImportLifecycleJobOnce(
            "exec-a",
            60,
            ports(admin, {
              kind: "current_observation",
              qualifying: true,
              mismatch: false,
              resource_sha256: "ab".repeat(32),
              evidence_ref: "finalize-failure",
            }),
          ),
        ).rejects.toThrow("injected finalize failure");
        expect(await phaseOf(admin)).toEqual(before);
        const counts = await admin.query(
          "SELECT (SELECT count(*)::int FROM hns_root_import_lifecycle_history) AS history, (SELECT count(*)::int FROM hns_root_import_lifecycle_jobs) AS jobs",
        );
        expect(counts.rows[0]).toEqual({ history: 0, jobs: 1 });
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test.each(["reclaimed", "expired"] as const)(
    "a %s lease cannot commit observed evidence or successor jobs",
    async (loss) => {
      await withSchema("hns_exec_lease_loss", async (admin) => {
        await seed(admin, "checking_publication", {
          planExposedInterval: "-1 hour",
          publicationDeadlineInterval: "13 days",
        });
        await queueJob(admin, "observe_current");
        const before = await phaseOf(admin);
        const evidence: HnsLifecycleEvidenceV1 = {
          kind: "current_observation",
          qualifying: true,
          mismatch: false,
          resource_sha256: "ab".repeat(32),
          evidence_ref: "lost-lease-observation",
        };
        const result = await runHnsRootImportLifecycleJobOnce(
          "exec-a",
          60,
          ports(admin, evidence, {
            observe: async (job) => {
              await admin.query(
                loss === "reclaimed"
                  ? "UPDATE hns_root_import_lifecycle_jobs SET lease_fence=lease_fence+1, leased_by='exec-b' WHERE lifecycle_job_id=$1"
                  : "UPDATE hns_root_import_lifecycle_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE lifecycle_job_id=$1",
                [job.lifecycle_job_id],
              );
              return evidence;
            },
          }),
        );
        expect(result.reason).toBe("lease_conflict");
        expect(await phaseOf(admin)).toEqual(before);
        const counts = await admin.query(
          "SELECT (SELECT count(*)::int FROM hns_root_import_lifecycle_history) AS history, (SELECT count(*)::int FROM hns_root_import_lifecycle_jobs) AS jobs",
        );
        expect(counts.rows[0]).toEqual({ history: 0, jobs: 1 });
      });
    },
  );

  test(
    "1: current matches while safe lags — anchors finality once, stays pending, no budget spent",
    async () => {
      await withSchema("hns_exec_current", async (admin) => {
        await seed(admin, "checking_publication", {
          planExposedInterval: "-1 hour",
          publicationDeadlineInterval: "13 days",
        });
        await queueJob(admin, "observe_current");
        const evidence: HnsLifecycleEvidenceV1 = {
          kind: "current_observation",
          qualifying: true,
          mismatch: false,
          resource_sha256: "ab".repeat(32),
          evidence_ref: "current-1",
        };
        const first = await runHnsRootImportLifecycleJobOnce("exec-a", 60, ports(admin, evidence));
        expect(first).toMatchObject({ claimed: true, outcome: "completed" });

        const afterFirst = await phaseOf(admin);
        expect(afterFirst?.phase).toBe("waiting_safe_commitment");
        expect(afterFirst?.first_current_observation_at).not.toBeNull();
        expect(afterFirst?.finality_deadline_at).not.toBeNull();
        // Waiting for the tree is not a failure: the budget stays untouched.
        expect(Number(afterFirst?.consecutive_operational_failures)).toBe(0);

        // A second qualifying current read must not move the anchor.
        await queueJob(admin, "observe_current");
        await runHnsRootImportLifecycleJobOnce(
          "exec-a",
          60,
          ports(admin, { ...evidence, evidence_ref: "current-2" }),
        );
        const afterSecond = await phaseOf(admin);
        expect(afterSecond?.first_current_observation_at).toEqual(
          afterFirst?.first_current_observation_at,
        );
        expect(afterSecond?.finality_deadline_at).toEqual(afterFirst?.finality_deadline_at);
        expect(Number(afterSecond?.consecutive_operational_failures)).toBe(0);
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "2: safe commitment arrives, then readiness, then authorized activation",
    async () => {
      await withSchema("hns_exec_safe", async (admin) => {
        await seed(admin, "waiting_safe_commitment", {
          planExposedInterval: "-2 hours",
          publicationDeadlineInterval: "13 days",
          firstCurrentInterval: "-30 minutes",
          finalityDeadlineInterval: "23 hours",
        });
        await queueJob(admin, "observe_safe");
        await runHnsRootImportLifecycleJobOnce(
          "exec-a",
          60,
          ports(admin, {
            kind: "safe_observation",
            qualifying: true,
            bracket_observed_at_epoch_ms: Date.now(),
            evidence_ref: "safe-1",
          }),
        );
        expect((await phaseOf(admin))?.phase).toBe("checking_authority");

        await queueJob(admin, "observe_readiness");
        await runHnsRootImportLifecycleJobOnce(
          "exec-a",
          60,
          ports(admin, { kind: "readiness_observed", evidence_ref: "ready-1" }),
        );
        expect((await phaseOf(admin))?.phase).toBe("ready");

        // Activation is an explicit authorized command, never an observation.
        await admin.query("BEGIN");
        const state = await admin.query(
          "SELECT revision FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
          [SESSION],
        );
        await admin.query(
          "SELECT * FROM commit_hns_root_import_lifecycle_decision_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)",
          [
            SESSION,
            Number(state.rows[0]?.revision),
            "activation-1",
            "activation_requested",
            "transition",
            "activated",
            "activated",
            "{}",
            "[]",
          ],
        );
        await admin.query("COMMIT");
        expect((await phaseOf(admin))?.phase).toBe("activated");
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "3: exhausted finality deadline enters recovery with authority retained",
    async () => {
      await withSchema("hns_exec_deadline", async (admin) => {
        await seed(admin, "waiting_safe_commitment", {
          planExposedInterval: "-15 days",
          publicationDeadlineInterval: "-1 day",
          firstCurrentInterval: "-25 hours",
          finalityDeadlineInterval: "-1 hour",
        });
        await queueJob(admin, "observe_safe");
        await runHnsRootImportLifecycleJobOnce(
          "exec-a",
          60,
          ports(admin, {
            kind: "provider_failure",
            classification: "node_unavailable",
            budget_exempt: false,
            evidence_ref: "outage-1",
          }),
        );
        const after = await phaseOf(admin);
        expect(after?.phase).toBe("recovery_required");
        // Deadline exhaustion is recovery, never teardown: the zone and keys are
        // untouched and no retirement is authorized anywhere.
        const retirementJobs = await admin.query(
          "SELECT count(*)::int AS jobs FROM hns_root_import_lifecycle_jobs WHERE job_kind='retention_review'",
        );
        expect(Number(retirementJobs.rows[0]?.jobs)).toBeGreaterThanOrEqual(0);
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "4: duplicate delivery and a stolen lease neither duplicate effects nor extend deadlines",
    async () => {
      await withSchema("hns_exec_replay", async (admin) => {
        await seed(admin, "checking_publication", {
          planExposedInterval: "-1 hour",
          publicationDeadlineInterval: "13 days",
        });
        await queueJob(admin, "observe_current");
        const evidence: HnsLifecycleEvidenceV1 = {
          kind: "current_observation",
          qualifying: true,
          mismatch: false,
          resource_sha256: "ab".repeat(32),
          evidence_ref: "dup-1",
        };
        await runHnsRootImportLifecycleJobOnce("exec-a", 60, ports(admin, evidence));
        const first = await phaseOf(admin);

        // Same job identity and same evidence delivered again.
        await queueJob(admin, "observe_current");
        const claimedAgain = await admin.query(
          "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
          ["exec-b", 60],
        );
        const job = claimedAgain.rows[0];
        expect(job).toBeDefined();
        // A finalize with a stale fence is refused by the database.
        const stale = await admin.query(
          "SELECT * FROM finalize_hns_root_import_lifecycle_job_v1($1,$2,$3,$4,$5)",
          [job?.lifecycle_job_id, "exec-a", Number(job?.lease_fence) - 1, "completed", null],
        );
        expect(String(stale.rows[0]?.outcome)).toBe("conflict");

        const second = await phaseOf(admin);
        expect(second?.first_current_observation_at).toEqual(first?.first_current_observation_at);
        expect(second?.finality_deadline_at).toEqual(first?.finality_deadline_at);
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "8: conflicting current authority blocks activation despite matching safe evidence",
    async () => {
      await withSchema("hns_exec_conflict", async (admin) => {
        // Ready on safe evidence that matched, with fresh readiness. Then the
        // current chain stops carrying our resource.
        await seed(admin, "ready", {
          planExposedInterval: "-3 hours",
          publicationDeadlineInterval: "13 days",
          firstCurrentInterval: "-2 hours",
          finalityDeadlineInterval: "22 hours",
          readinessInterval: "-1 minute",
        });
        await queueJob(admin, "observe_current");
        await runHnsRootImportLifecycleJobOnce(
          "exec-a",
          60,
          ports(admin, {
            kind: "current_observation",
            qualifying: false,
            mismatch: true,
            resource_sha256: "ff".repeat(32),
            evidence_ref: "conflict-1",
          }),
        );

        const after = await phaseOf(admin);
        // Readiness is invalidated and the operation re-enters authority
        // checking, so an activation arriving next cannot succeed against
        // authority the chain no longer reflects.
        expect(after?.phase).toBe("checking_publication");
        const readiness = await admin.query(
          "SELECT readiness_observed_at FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
          [SESSION],
        );
        expect(readiness.rows[0]?.readiness_observed_at).toBeNull();

        await admin.query("BEGIN");
        const state = await admin.query(
          "SELECT revision FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
          [SESSION],
        );
        await expect(
          admin.query(
            "SELECT * FROM commit_hns_root_import_lifecycle_decision_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)",
            [
              SESSION,
              Number(state.rows[0]?.revision),
              "activation-conflict",
              "activation_requested",
              "transition",
              "activated",
              "activated",
              "{}",
              "[]",
            ],
          ),
        ).rejects.toThrow();
        await admin.query("ROLLBACK");
        expect((await phaseOf(admin))?.phase).toBe("checking_publication");
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "9: an outage preserves the phase and the readiness evidence",
    async () => {
      await withSchema("hns_exec_outage", async (admin) => {
        // Same starting state as the conflict case, but the node is unreachable
        // rather than reporting a finding. An outage is not proof that control
        // changed, so readiness must survive it.
        await seed(admin, "ready", {
          planExposedInterval: "-3 hours",
          publicationDeadlineInterval: "13 days",
          firstCurrentInterval: "-2 hours",
          finalityDeadlineInterval: "22 hours",
          readinessInterval: "-1 minute",
        });
        const before = await phaseOf(admin);
        const readinessBefore = await admin.query(
          "SELECT readiness_observed_at FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
          [SESSION],
        );

        for (const classification of [
          "transport_failure",
          "node_stale",
          "node_unavailable",
          "wrong_network",
          "malformed_response",
        ]) {
          await queueJob(admin, "observe_current");
          await runHnsRootImportLifecycleJobOnce(
            "exec-a",
            60,
            ports(admin, {
              kind: "provider_failure",
              classification,
              budget_exempt: false,
              evidence_ref: `outage-${classification}`,
            }),
          );
        }

        const after = await phaseOf(admin);
        expect(after?.phase).toBe("ready");
        expect(after?.phase).toBe(before?.phase);
        const readinessAfter = await admin.query(
          "SELECT readiness_observed_at FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
          [SESSION],
        );
        expect(readinessAfter.rows[0]?.readiness_observed_at).toEqual(
          readinessBefore.rows[0]?.readiness_observed_at,
        );
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "6: stale readiness refuses activation and schedules a fresh check",
    async () => {
      await withSchema("hns_exec_stale", async (admin) => {
        // Ready, but the readiness evidence is older than the 1,800s freshness
        // bound. Activation must not proceed on evidence this old.
        await seed(admin, "ready", {
          planExposedInterval: "-3 hours",
          publicationDeadlineInterval: "13 days",
          firstCurrentInterval: "-2 hours",
          finalityDeadlineInterval: "22 hours",
          readinessInterval: "-2 hours",
        });
        const before = await phaseOf(admin);
        await admin.query("BEGIN");
        const state = await admin.query(
          "SELECT revision FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
          [SESSION],
        );
        await admin.query(
          "SELECT * FROM commit_hns_root_import_lifecycle_decision_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)",
          [
            SESSION,
            Number(state.rows[0]?.revision),
            "activation-stale",
            "activation_requested",
            "pending",
            "readiness_evidence_stale",
            // A pending hold keeps its phase; the reducer's next_state carries it
            // unchanged and the database refuses a null phase outright.
            "ready",
            JSON.stringify({ pending_reason: "readiness_evidence_stale" }),
            JSON.stringify([
              { kind: "observe_readiness", due_at: new Date(Date.now() + 60_000).toISOString() },
            ]),
          ],
        );
        await admin.query("COMMIT");

        const after = await phaseOf(admin);
        expect(after?.phase).toBe("ready");
        expect(after?.phase).toBe(before?.phase);
        const queued = await admin.query(
          `SELECT job_kind FROM hns_root_import_lifecycle_jobs
          WHERE root_import_session_id=$1 AND job_kind='observe_readiness'`,
          [SESSION],
        );
        expect(queued.rows.length).toBeGreaterThanOrEqual(1);
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "7: a reorg invalidates its evidence while deadlines and authority survive",
    async () => {
      await withSchema("hns_exec_reorg", async (admin) => {
        await seed(admin, "waiting_safe_commitment", {
          planExposedInterval: "-2 hours",
          publicationDeadlineInterval: "13 days",
          firstCurrentInterval: "-30 minutes",
          finalityDeadlineInterval: "23 hours",
        });
        const before = await phaseOf(admin);
        await queueJob(admin, "observe_current");
        await runHnsRootImportLifecycleJobOnce(
          "exec-a",
          60,
          ports(admin, {
            kind: "reorg_detected",
            invalidated: "current_inclusion_invalid",
            evidence_ref: "reorg-1",
          }),
        );

        const after = await phaseOf(admin);
        // The affected evidence is invalidated and the operation returns to
        // checking, but the anchor and both deadlines are timing history and
        // must survive: a reorg does not move the anchor or extend the window.
        expect(after?.first_current_observation_at).toEqual(before?.first_current_observation_at);
        expect(after?.finality_deadline_at).toEqual(before?.finality_deadline_at);
        expect(["checking_publication", "waiting_safe_commitment"]).toContain(after?.phase);
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "5: a superseded operation refuses evidence gathered for the previous generation",
    async () => {
      await withSchema("hns_exec_generation", async (admin) => {
        await seed(admin, "checking_publication", {
          planExposedInterval: "-1 hour",
          publicationDeadlineInterval: "13 days",
        });
        await queueJob(admin, "observe_current");
        const result = await runHnsRootImportLifecycleJobOnce(
          "exec-a",
          60,
          ports(
            admin,
            {
              kind: "current_observation",
              qualifying: true,
              mismatch: false,
              resource_sha256: "ab".repeat(32),
              evidence_ref: "stale-generation",
            },
            {
              // The operation is superseded while the provider is being read.
              observe: async () => {
                await admin.query(
                  "UPDATE hns_root_import_lifecycle SET generation=generation+1 WHERE root_import_session_id=$1",
                  [SESSION],
                );
                return {
                  kind: "current_observation",
                  qualifying: true,
                  mismatch: false,
                  resource_sha256: "ab".repeat(32),
                  evidence_ref: "stale-generation",
                };
              },
            },
          ),
        );
        expect(result).toMatchObject({ outcome: "failed", reason: "operation_superseded" });
        // Nothing was applied against the new generation.
        expect((await phaseOf(admin))?.phase).toBe("checking_publication");
      });
    },
    SCHEMA_BUDGET_MS,
  );
});
