import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;
const schema = `video_workflow_migration_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const migrationVersion = "0120_video_workflow_execution.sql";

suite("video Workflow migration refusal and replay fences", () => {
  let client: Client;
  let sql: string;
  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const migrations = await loadPostgresMigrations();
    const index = migrations.findIndex(({ version }) => version === migrationVersion);
    expect(index).toBeGreaterThan(0);
    sql = migrations[index]?.sql ?? "";
    const scoped = new URL(connectionString ?? "");
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: migrations.slice(0, index),
    });
  }, 120_000);
  afterAll(async () => {
    if (!client) return;
    await client.query("ROLLBACK");
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  });

  async function transaction(use: () => Promise<void>): Promise<void> {
    await client.query("BEGIN");
    try {
      // Deliberately install historical rows without unrelated parent fixtures.
      // CHECK, UNIQUE and primary-index enforcement remain active.
      await client.query("SET LOCAL session_replication_role = replica");
      await use();
    } finally {
      await client.query("ROLLBACK");
    }
  }

  async function attempt(request: string, creation?: number): Promise<void> {
    await client.query(
      `INSERT INTO media_video_transform_attempts
      (request_id, submission_id, operation_id, video_revision, analysis_revision,
       canonical_video_sha256, capability, submitted_at_ms, runtime_deadline_ms
       ${creation === undefined ? "" : ", creation_revision"})
      VALUES ($1,'submission','operation',1,1,$2,'frames',0,10000
       ${creation === undefined ? "" : ",$3"})`,
      creation === undefined ? [request, "a".repeat(64)] : [request, "a".repeat(64), creation],
    );
  }

  async function outbox(state: "pending" | "poll_wait" | "running"): Promise<void> {
    await client.query(
      `INSERT INTO media_video_analysis_outbox
      (effect_identity,submission_id,operation_id,video_revision,creation_revision,
       canonical_video_sha256,state,delivery_attempts,claim_owner,lease_expires_at,next_eligible_at)
      VALUES ('effect','submission','operation',1,1,$1,$2,$3,$4,$5,$6)`,
      [
        "a".repeat(64),
        state,
        state === "pending" ? 0 : 1,
        state === "running" ? "old-worker" : null,
        state === "running" ? new Date(0) : null,
        state === "poll_wait" ? new Date(0) : null,
      ],
    );
  }

  test("refuses even an unallocated historical attempt without inferring creation revision", async () => {
    await transaction(async () => {
      await attempt("historical");
      await expect(client.query(sql)).rejects.toThrow("creation revision cannot be inferred");
    });
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='media_video_transform_attempts' AND column_name='creation_revision'`,
      [schema],
    );
    expect(columns.rows).toHaveLength(0);
  });

  for (const state of ["poll_wait", "running"] as const) {
    test(`refuses old ${state} semantics, including an expired running lease`, async () => {
      await transaction(async () => {
        await outbox(state);
        await expect(client.query(sql)).rejects.toThrow("old provider waits or running leases");
      });
    });
  }

  test("preserves the request primary index and admits distinct creation attempts with submitting", async () => {
    await transaction(async () => {
      const before = await client.query(`SELECT indexrelid FROM pg_index
        WHERE indrelid='media_video_transform_attempts'::regclass AND indisprimary`);
      await client.query(sql);
      const after = await client.query(`SELECT indexrelid, indisvalid, indisready FROM pg_index
        WHERE indrelid='media_video_transform_attempts'::regclass AND indisprimary`);
      expect(after.rows[0]).toEqual({ ...before.rows[0], indisvalid: true, indisready: true });
      await attempt("first", 1);
      await attempt("retry", 2);
      await client.query(`UPDATE media_video_transform_attempts
        SET provider_job_id='task',provider_job_phase='submitting' WHERE request_id='retry'`);
      await expect(attempt("duplicate-creation", 2)).rejects.toThrow(
        "media_video_transform_attempt_creation_key",
      );
    });
  });

  test("converts untouched intents to launch accounting without inventing a launch", async () => {
    await transaction(async () => {
      await outbox("pending");
      await client.query(sql);
      const row = await client.query(`SELECT state,launch_attempts,workflow_instance_id,launched_at
        FROM media_video_analysis_outbox`);
      expect(row.rows).toEqual([
        { state: "pending", launch_attempts: 0, workflow_instance_id: null, launched_at: null },
      ]);
      await expect(
        client.query(`UPDATE media_video_analysis_outbox SET state='launched'`),
      ).rejects.toThrow("media_video_analysis_outbox_state_shape");
    });
  });
});
