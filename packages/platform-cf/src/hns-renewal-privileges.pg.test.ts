import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;
const signatures = [
  "schedule_hns_root_health_renewals_v1(integer,integer,integer)",
  "claim_hns_root_health_renewal_job_v1(text,integer)",
  "prepare_hns_root_inventory_renewal_v1(text,text,bigint,text,text,bytea,text,text)",
  "finalize_hns_root_health_renewal_job_v1(text,text,bigint,text,text,bytea,text,text)",
];
const calls = [
  "schedule_hns_root_health_renewals_v1(1,259200,7200)",
  "claim_hns_root_health_renewal_job_v1('privilege-test',60)",
  "prepare_hns_root_inventory_renewal_v1('missing','privilege-test',1,'invalid','failed',NULL,NULL,'observation_failed')",
  "finalize_hns_root_health_renewal_job_v1('missing','privilege-test',1,'invalid','failed',NULL,NULL,'observation_failed')",
];

suite("HNS renewal execution privileges on PostgreSQL 17", () => {
  test("upgrades PUBLIC execution to explicit grants while retaining read-only monitoring", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `hns_acl_${suffix}`;
    const reader = `hns_reader_${suffix}`;
    const executor = `hns_executor_${suffix}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    // Transactional DDL leaves no roles, schema or grant changes after the test.
    await admin.query("BEGIN");
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET LOCAL search_path TO ${schema}, pg_temp`);
      const migrations = await loadPostgresMigrations();
      const repair = migrations.find(
        (m) => m.version === "0126_hns_renewal_execution_privileges.sql",
      );
      if (!repair) throw new Error("Privilege repair migration is missing");
      for (const migration of migrations) {
        if (migration.version < repair.version) await admin.query(migration.sql);
      }
      await admin.query(`CREATE ROLE ${reader} NOLOGIN`);
      await admin.query(`CREATE ROLE ${executor} NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${reader}, ${executor}`);
      await admin.query(`GRANT SELECT ON hns_root_health_renewal_jobs TO ${reader}`);
      for (const signature of signatures) {
        const before = await admin.query(
          "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
          [reader, signature],
        );
        expect(before.rows).toEqual([{ allowed: true }]);
        await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${executor}`);
      }
      await admin.query(repair.sql);
      for (const signature of signatures) {
        const after = await admin.query(
          `SELECT
          has_function_privilege($1,$3,'EXECUTE') AS reader,
          has_function_privilege($2,$3,'EXECUTE') AS executor,
          has_function_privilege(current_user,$3,'EXECUTE') AS owner`,
          [reader, executor, signature],
        );
        expect(after.rows).toEqual([{ reader: false, executor: true, owner: true }]);
      }
      await admin.query(`SET LOCAL ROLE ${reader}`);
      expect((await admin.query("SELECT * FROM hns_root_health_renewal_jobs")).rows).toEqual([]);
      for (const call of calls) {
        await admin.query("SAVEPOINT denied_call");
        await expect(admin.query(`SELECT * FROM ${call}`)).rejects.toMatchObject({ code: "42501" });
        await admin.query("ROLLBACK TO SAVEPOINT denied_call");
      }
      await admin.query("RESET ROLE");
      expect(
        (await admin.query("SELECT * FROM hns_root_health_renewal_scheduler_heartbeat")).rows,
      ).toEqual([]);
      await admin.query(`SET LOCAL ROLE ${executor}`);
      // No table write grants: this succeeds only through the admitted definer.
      expect((await admin.query(`SELECT * FROM ${calls[0]}`)).rows).toHaveLength(1);
      expect((await admin.query(`SELECT * FROM ${calls[1]}`)).rows).toEqual([]);
      await admin.query("RESET ROLE");
      expect(
        (await admin.query("SELECT * FROM hns_root_health_renewal_scheduler_heartbeat")).rows,
      ).toHaveLength(1);
      await admin.query(repair.sql);
      expect(
        (
          await admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            executor,
            signatures[0],
          ])
        ).rows,
      ).toEqual([{ allowed: true }]);
    } finally {
      await admin.query("ROLLBACK");
      await admin.end();
    }
  }, 120_000);
});
