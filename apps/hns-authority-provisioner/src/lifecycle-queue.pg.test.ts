import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { nextHnsLifecycleJobDueEpochMs } from "./lifecycle-queue.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

suite("lifecycle executor wake-up on PostgreSQL 17", () => {
  test("blocked overdue work waits for leases and does not hide unrelated due work", async () => {
    const schema = `hns_wakeup_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema}`);
      // Only the scheduler's read surface is needed; no migrations or
      // production credentials are involved in this isolated fixture.
      await admin.query(`
        CREATE TABLE hns_root_import_lifecycle (
          root_import_session_id text PRIMARY KEY, generation bigint, synthetic boolean
        );
        CREATE TABLE hns_root_import_lifecycle_jobs (
          root_import_session_id text, generation bigint, state text,
          due_at timestamptz, lease_expires_at timestamptz
        );
        CREATE TABLE hns_root_import_observation_jobs (
          root_import_session_id text, state text, lease_expires_at timestamptz
        );
      `);
      const scopedUrl = new URL(connectionString ?? "");
      scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
      const nextDue = () => nextHnsLifecycleJobDueEpochMs(scopedUrl.toString());
      const now = Date.now();
      const overdue = new Date(now - 60_000);
      const future = new Date(now + 60_000);
      const later = new Date(now + 120_000);
      expect(await nextDue()).toBeNull();

      await admin.query(`INSERT INTO hns_root_import_lifecycle VALUES
        ('synthetic', 1, true), ('superseded', 2, false),
        ('blocked', 1, false), ('ready', 1, false)`);
      await admin.query(
        `INSERT INTO hns_root_import_lifecycle_jobs VALUES
        ('synthetic', 1, 'queued', $1, NULL),
        ('superseded', 1, 'queued', $1, NULL)`,
        [overdue],
      );
      expect(await nextDue()).toBeNull();

      await admin.query(
        `INSERT INTO hns_root_import_lifecycle_jobs VALUES
        ('blocked', 1, 'queued', $1, NULL)`,
        [overdue],
      );
      await admin.query(
        `INSERT INTO hns_root_import_observation_jobs VALUES
        ('blocked', 'leased', $1)`,
        [future],
      );
      expect(await nextDue()).toBe(future.getTime());

      await admin.query(
        `INSERT INTO hns_root_import_lifecycle_jobs VALUES
        ('ready', 1, 'queued', $1, NULL)`,
        [overdue],
      );
      expect(await nextDue()).toBe(overdue.getTime());

      await admin.query(`UPDATE hns_root_import_lifecycle_jobs
        SET state = 'completed' WHERE root_import_session_id = 'ready'`);
      await admin.query(
        `UPDATE hns_root_import_lifecycle_jobs
        SET state = 'leased', lease_expires_at = $1
        WHERE root_import_session_id = 'blocked'`,
        [later],
      );
      expect(await nextDue()).toBe(later.getTime());

      await admin.query(
        `UPDATE hns_root_import_lifecycle_jobs
        SET lease_expires_at = $1 WHERE root_import_session_id = 'blocked'`,
        [overdue],
      );
      await admin.query(`UPDATE hns_root_import_observation_jobs SET lease_expires_at = $1`, [
        overdue,
      ]);
      expect(await nextDue()).toBe(overdue.getTime());
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await admin.end();
    }
  });
});
