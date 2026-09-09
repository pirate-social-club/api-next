import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

const signatures = [
  "commit_hns_root_import_lifecycle_decision_v1(text,bigint,text,text,text,text,text,jsonb,jsonb)",
  "claim_hns_root_import_lifecycle_job_v1(text,integer)",
  "finalize_hns_root_import_lifecycle_job_v1(bigint,text,bigint,text,text)",
  "hns_root_import_lifecycle_transition_allowed_v1(text,text)",
  "guard_hns_root_import_lifecycle_anchor_v1()",
];

suite("HNS root-import lifecycle runtime privileges on PostgreSQL 17 (T14)", () => {
  test("actual roles separately execute claim, transition, and finalization with bounded grant failures", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `hns_lifecycle_acl_${suffix.slice(0, 24)}`;
    const reader = `hns_lifecycle_reader_${suffix.slice(0, 20)}`;
    const executor = `hns_lifecycle_executor_${suffix.slice(0, 20)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    // Transactional DDL leaves no roles, schema, or grant changes behind.
    await admin.query("BEGIN");
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET LOCAL search_path TO ${schema}, pg_temp`);
      const migrations = await loadPostgresMigrations();
      const repair = migrations.find(
        (migration) => migration.version === "0138_hns_lifecycle_execution_privileges.sql",
      );
      if (!repair) throw new Error("Lifecycle privilege migration is missing");
      for (const migration of migrations) {
        if (migration.version <= repair.version) await admin.query(migration.sql);
      }
      await admin.query(`CREATE ROLE ${reader} NOLOGIN`);
      await admin.query(`CREATE ROLE ${executor} NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${reader}, ${executor}`);
      await admin.query(`GRANT SELECT ON hns_root_import_lifecycle TO ${reader}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION ${schema}.claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER) TO ${executor}`,
      );
      await admin.query(
        `GRANT EXECUTE ON FUNCTION ${schema}.finalize_hns_root_import_lifecycle_job_v1(BIGINT, TEXT, BIGINT, TEXT, TEXT) TO ${executor}`,
      );
      await admin.query(
        `GRANT EXECUTE ON FUNCTION ${schema}.commit_hns_root_import_lifecycle_decision_v1(TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO ${executor}`,
      );
      await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${executor}`);
      await admin.query(`GRANT INSERT, UPDATE, SELECT ON hns_root_import_lifecycle TO ${executor}`);
      await admin.query(`GRANT INSERT, SELECT ON hns_root_import_lifecycle_history TO ${executor}`);
      await admin.query(
        `GRANT INSERT, UPDATE, SELECT ON hns_root_import_lifecycle_jobs TO ${executor}`,
      );

      for (const signature of signatures) {
        const readerGrant = await admin.query(
          `SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed`,
          [reader, `${schema}.${signature}`],
        );
        // A status reader must not write through the lifecycle functions.
        expect(readerGrant.rows[0].allowed).toBe(false);
        const executorGrant = await admin.query(
          `SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed`,
          [executor, `${schema}.${signature}`],
        );
        if (
          signature.startsWith("commit_") ||
          signature.startsWith("claim_") ||
          signature.startsWith("finalize_")
        ) {
          expect(executorGrant.rows[0].allowed).toBe(true);
        } else {
          // The pure invariant helpers stay owner-invoked only.
          expect(executorGrant.rows[0].allowed).toBe(false);
        }
      }

      // The executor role actually executes the claim/transition/finalize
      // cycle under its own grants (SET ROLE drops owner identity).
      await admin.query(`SET LOCAL ROLE ${executor}`);
      await admin.query(
        `INSERT INTO hns_root_import_lifecycle (
           root_import_session_id, root_label, phase, revision, generation,
           plan_exposed_at, publication_deadline_at,
           policy_name, policy_digest
         ) VALUES (
           'privilege-session','privroot','awaiting_publication',1,1,
           clock_timestamp() - interval '1 hour',
           clock_timestamp() + interval '13 days',
           'hns_root_import_policy_v1','hns_root_import_policy_v1:0388a3cc')`,
      );
      const committed = await admin.query(
        `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1(
           'privilege-session', 1, 'privilege-event', 'publication_acknowledged',
           'transition', 'acknowledged', 'checking_publication', '{}'::jsonb, '[]'::jsonb)`,
      );
      expect(committed.rows[0]).toMatchObject({ outcome: "transition", replayed: false });
      await admin.query(
        `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
         VALUES ('privilege-session','observe_current', clock_timestamp() - interval '1 second')`,
      );
      const claimed = await admin.query(
        `SELECT * FROM claim_hns_root_import_lifecycle_job_v1('privilege-executor', 60)`,
      );
      expect(claimed.rows).toHaveLength(1);
      const finalized = await admin.query(
        `SELECT * FROM finalize_hns_root_import_lifecycle_job_v1($1,'privilege-executor',$2,'completed',NULL)`,
        [claimed.rows[0].lifecycle_job_id, claimed.rows[0].lease_fence],
      );
      expect(finalized.rows[0].outcome).toBe("completed");
      await admin.query("RESET ROLE");

      // A missing grant reproduces a bounded, diagnosable failure: the
      // reader role's claim attempt is denied with a specific SQLSTATE.
      await admin.query(`SET LOCAL ROLE ${reader}`);
      await admin.query("SAVEPOINT reader_denial");
      const denied = (await admin
        .query(`SELECT * FROM claim_hns_root_import_lifecycle_job_v1('reader-executor', 60)`)
        .then(
          () => undefined,
          (error: { code?: string }) => error,
        )) as { code?: string };
      expect(denied.code).toBe("42501");
      await admin.query("ROLLBACK TO SAVEPOINT reader_denial");
      await admin.query("RESET ROLE");
    } finally {
      await admin.query("ROLLBACK");
      await admin.end();
    }
  });
});
