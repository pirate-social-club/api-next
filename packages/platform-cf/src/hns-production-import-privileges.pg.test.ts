import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

suite("staging shared HNS runtime privileges", () => {
  test("requires an explicit release grant to the shared runtime login", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `hns_staging_acl_${suffix}`;
    const sharedRuntime = `hns_staging_runtime_${suffix}`;
    const admin = new Client({ connectionString });
    const warnings: string[] = [];
    admin.on("notice", (notice) => {
      if (notice.severity === "WARNING" && notice.message) warnings.push(notice.message);
    });
    await admin.connect();
    await admin.query("BEGIN");
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET LOCAL search_path TO ${schema}, pg_temp`);
      await admin.query(`CREATE ROLE ${sharedRuntime} NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${sharedRuntime}`);
      for (const migration of await loadPostgresMigrations()) await admin.query(migration.sql);
      expect(warnings).toContain(
        "HNS executor role absent: grant ownership-preparation EXECUTE to the observed provisioner login and verify its effective privilege before release",
      );
      const signature =
        "enqueue_hns_safe_ownership_completion_v1(text,bigint,text,bigint,bytea,text)";
      const privilege = async () =>
        (
          await admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            sharedRuntime,
            signature,
          ])
        ).rows[0]?.allowed;
      expect(await privilege()).toBe(false);
      await admin.query(`SET LOCAL ROLE ${sharedRuntime}`);
      await admin.query("SAVEPOINT before_grant");
      await expect(
        admin.query(
          "SELECT * FROM enqueue_hns_safe_ownership_completion_v1('missing',1,'executor',1,NULL,NULL)",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query("ROLLBACK TO SAVEPOINT before_grant");
      await admin.query("RESET ROLE");
      // The release runs this as the function owner after observing the actual
      // provisioner login; being an API login neither grants nor forbids access.
      await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${sharedRuntime}`);
      expect(await privilege()).toBe(true);
      expect(
        (
          await admin.query(
            "SELECT has_table_privilege($1,'hns_root_import_safe_ownership_proofs','INSERT,UPDATE,DELETE') AS writes",
            [sharedRuntime],
          )
        ).rows,
      ).toEqual([{ writes: false }]);
      await admin.query(`SET LOCAL ROLE ${sharedRuntime}`);
      expect(
        (
          await admin.query(
            "SELECT * FROM enqueue_hns_safe_ownership_completion_v1('missing',1,'executor',1,NULL,NULL)",
          )
        ).rows,
      ).toEqual([{ outcome: "invalid_proof" }]);
    } finally {
      await admin.query("ROLLBACK");
      await admin.end();
    }
  }, 120_000);
});

suite("production HNS import runtime privileges", () => {
  test("grants fenced runtime access without direct lifecycle updates", async () => {
    const schema = `hns_production_acl_${randomUUID().replaceAll("-", "")}`;
    const apiRole = "pscale_api_gfbytfmpuetx";
    const executorRole = "hns_root_import_executor_login_v1";
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query("BEGIN");
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET LOCAL search_path TO ${schema}, pg_temp`);
      await admin.query(`CREATE ROLE ${apiRole} NOLOGIN`);
      await admin.query(`CREATE ROLE ${executorRole} NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${apiRole}, ${executorRole}`);
      for (const migration of await loadPostgresMigrations()) {
        await admin.query(migration.sql);
      }

      const grants = await admin.query(
        `SELECT
          has_function_privilege($1,'commit_hns_root_import_activation_v1(text,bigint,bigint,bigint,text,text,text,timestamptz,text,boolean)','EXECUTE') AS api_activation,
          has_function_privilege($2,'enqueue_hns_safe_ownership_completion_v1(text,bigint,text,bigint,bytea,text)','EXECUTE') AS executor_safe_ownership,
          has_function_privilege($1,'enqueue_hns_safe_ownership_completion_v1(text,bigint,text,bigint,bytea,text)','EXECUTE') AS api_safe_ownership,
          has_table_privilege($2,'hns_root_import_safe_ownership_proofs','INSERT') AS executor_proof_insert,
          has_table_privilege($2,'hns_root_import_safe_ownership_proofs','UPDATE') AS executor_proof_update,
          has_table_privilege($2,'hns_root_import_safe_ownership_proofs','DELETE') AS executor_proof_delete,
          has_function_privilege($2,'commit_hns_root_import_readiness_v1(text,bigint,text,bigint,bigint,bytea,text)','EXECUTE') AS executor_readiness,
          has_function_privilege($2,'lock_hns_root_import_lifecycle_v1(text)','EXECUTE') AS executor_lifecycle_lock,
          has_function_privilege($2,'lock_hns_root_import_lifecycle_job_v1(bigint,text,text,text,bigint)','EXECUTE') AS executor_job_lock,
          has_table_privilege($2,'hns_root_import_lifecycle','SELECT') AS executor_read,
          has_table_privilege($2,'hns_root_import_lifecycle','UPDATE') AS executor_update,
          has_table_privilege($2,'hns_root_import_lifecycle_jobs','UPDATE') AS executor_job_update`,
        [apiRole, executorRole],
      );
      expect(grants.rows).toEqual([
        {
          api_activation: true,
          executor_readiness: true,
          executor_safe_ownership: true,
          api_safe_ownership: false,
          executor_proof_insert: false,
          executor_proof_update: false,
          executor_proof_delete: false,
          executor_lifecycle_lock: true,
          executor_job_lock: true,
          executor_read: true,
          executor_update: false,
          executor_job_update: false,
        },
      ]);

      await admin.query(`SET LOCAL ROLE ${executorRole}`);
      expect(
        (await admin.query("SELECT * FROM lock_hns_root_import_lifecycle_v1('missing')")).rows,
      ).toEqual([]);
      expect(
        (
          await admin.query(
            "SELECT * FROM lock_hns_root_import_lifecycle_job_v1(1,'missing','observe_current','executor',1)",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await admin.query(
            "SELECT * FROM enqueue_hns_safe_ownership_completion_v1('missing',1,'executor',1,NULL,NULL)",
          )
        ).rows,
      ).toEqual([{ outcome: "invalid_proof" }]);
      await admin.query("SAVEPOINT direct_update");
      await expect(
        admin.query("UPDATE hns_root_import_lifecycle SET generation = generation WHERE false"),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query("ROLLBACK TO SAVEPOINT direct_update");
    } finally {
      await admin.query("ROLLBACK");
      await admin.end();
    }
  }, 120_000);
});
