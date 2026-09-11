import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * One execution owner per root-import operation, settled in SQL.
 *
 * The older readiness-observation path and the lifecycle runner could each
 * claim work for the same operation. Both read the same chain and both drive
 * the same authority, and no lock spans claim, observation and finalization, so
 * ordering alone could not separate them. Migration 0141 makes a lifecycle row
 * the ownership record: the older path yields the whole operation, and the
 * lifecycle runner waits out any legacy lease that was already in flight.
 *
 * The plan digest is checked here too, because it is what qualification
 * compares against and it is now write-once state on the same row.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const shaA = "a".repeat(64);
const digestOne = "1".repeat(64);
const digestTwo = "2".repeat(64);

/**
 * Each case builds its own schema and applies every migration, which is well
 * past bun's five-second default. The budget is explicit so the suite fails on
 * a real hang rather than on the migration set having grown.
 */
const SCHEMA_BUDGET_MS = 120_000;

type SessionFixture = Readonly<{
  readonly session: string;
  readonly label: string;
  /** Whether a lifecycle row claims ownership of the operation. */
  readonly lifecycle: boolean;
}>;

/**
 * A session in `observing` with a completed provision job and a queued
 * readiness-observation job: the exact shape the older claim path selects.
 */
async function seedObservingSession(admin: Client, fixture: SessionFixture): Promise<void> {
  const planBytes = Buffer.from(
    JSON.stringify({
      version: "pirate-hns-root-import-publish-plan-v1",
      encoded_resource_sha256: digestOne,
    }),
  );
  const planSha256 = createHash("sha256").update(planBytes).digest("hex");
  const requestBytes = Buffer.from(`{"root_import_session_id":"${fixture.session}"}`);
  const requestSha256 = createHash("sha256").update(requestBytes).digest("hex");
  await admin.query(
    `INSERT INTO hns_root_import_sessions (
       root_import_session_id, actor_id, creation_intent_id, ceremony_intent_id,
       namespace_session_id, ownership_generation, ownership_expected_revision,
       root_label, challenge_txt_value, status, revision,
       start_idempotency_key, start_request_sha256, provision_job_id,
       provision_authorization_kind, provision_authorization_sha256,
       provision_idempotency_key, provision_poll_request_sha256,
       publish_plan_bytes, publish_plan_sha256, ownership_result_sha256,
       observation_job_id, observation_idempotency_key, observation_request_sha256,
       expires_at
     ) VALUES (
       $1,'ownership-actor','ownership-intent','ownership-ceremony',
       $2,1,1,$3,'pirate-verification=ownership','observing',1,
       'start-' || $1,$4,'provision-' || $1,
       'namespace_ownership',$4,'idem-' || $1,$4,
       $5,$6,$4,
       'observation-' || $1,'obs-idem-' || $1,$4,
       clock_timestamp() + interval '30 days'
     )`,
    [fixture.session, `namespace-${fixture.session}`, fixture.label, shaA, planBytes, planSha256],
  );
  await admin.query(
    `INSERT INTO hns_authority_provision_jobs (
       provision_job_id, root_import_session_id, operation_kind,
       request_bytes, request_sha256, state, attempt_count,
       publish_plan_bytes, publish_plan_sha256, result_bytes, result_sha256,
       created_at, updated_at, completed_at
     ) VALUES (
       'provision-' || $1,$1,'provision_root_v1',$2,$3,'completed',1,
       $4,$5,$2,$3,
       clock_timestamp() - interval '2 hours',
       clock_timestamp() - interval '1 hour',
       clock_timestamp() - interval '1 hour'
     )`,
    [fixture.session, requestBytes, requestSha256, planBytes, planSha256],
  );
  await admin.query(
    `INSERT INTO hns_root_import_observation_jobs (
       observation_job_id, root_import_session_id, operation_kind,
       request_bytes, request_sha256, state, attempt_count
     ) VALUES ('observation-' || $1,$1,'observe_root_v1',$2,$3,'queued',0)`,
    [fixture.session, requestBytes, requestSha256],
  );
  if (fixture.lifecycle) {
    await admin.query(
      `INSERT INTO hns_root_import_lifecycle (
         root_import_session_id, root_label, phase, revision, generation,
         plan_exposed_at, publication_deadline_at, pending_reason,
         policy_name, policy_digest
       ) VALUES ($1,$2,'checking_publication',1,1,
         clock_timestamp() - interval '1 hour', clock_timestamp() + interval '13 days',
         'awaiting_publication','hns_root_import_lifecycle_v1','ownership')`,
      [fixture.session, fixture.label],
    );
  }
}

async function schemaWithMigrations(admin: Client, schema: string): Promise<void> {
  await admin.query(`CREATE SCHEMA ${quote(schema)}`);
  await admin.query(`SET search_path TO ${quote(schema)}`);
  for (const migration of await loadPostgresMigrations()) await admin.query(migration.sql);
  // Minimal FK-valid parent; the replica role skips the heavier session FKs.
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  await admin.query("INSERT INTO users (user_id) VALUES ('ownership-actor')");
}

suite("one execution owner per HNS root-import operation on PostgreSQL 17", () => {
  test(
    "a lifecycle-managed operation is still claimable for readiness work",
    async () => {
      const schema = `hns_ownership_ready_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
      const admin = new Client({ connectionString });
      await admin.connect();
      try {
        await schemaWithMigrations(admin, schema);
        await seedObservingSession(admin, {
          session: "readiness-owned",
          label: "readyowned",
          lifecycle: true,
        });
        await admin.query("COMMIT");
        // 0141 excluded this claim and 0147 withdrew that. The lifecycle runner
        // implements chain observation only; the readiness leg is the live DNS
        // and gateway check that moves a session to `ready`, and nothing else
        // performs it. Excluding it meant no community operation could ever
        // become ready.
        const claimed = await admin.query(
          "SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)",
          ["readiness-executor", 60],
        );
        expect(claimed.rows).toHaveLength(1);
        expect(claimed.rows[0]?.root_import_session_id).toBe("readiness-owned");
        expect(claimed.rows[0]?.operation_kind).toBe("observe_root_v1");
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "the lifecycle runner waits out a legacy lease that was already in flight",
    async () => {
      const schema = `hns_ownership_race_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const admin = new Client({ connectionString });
      await admin.connect();
      try {
        await schemaWithMigrations(admin, schema);
        await seedObservingSession(admin, {
          session: "raced-operation",
          label: "racedname",
          lifecycle: false,
        });
        await admin.query("COMMIT");

        // The legacy path takes the operation first, as it may while no
        // lifecycle row exists.
        const legacy = await admin.query(
          "SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)",
          ["legacy-executor", 60],
        );
        expect(legacy.rows).toHaveLength(1);

        // Ownership transfers mid-flight.
        await admin.query(
          `INSERT INTO hns_root_import_lifecycle (
           root_import_session_id, root_label, phase, revision, generation,
           plan_exposed_at, publication_deadline_at, pending_reason,
           policy_name, policy_digest
         ) VALUES ('raced-operation','racedname','checking_publication',1,1,
           clock_timestamp() - interval '1 hour', clock_timestamp() + interval '13 days',
           'awaiting_publication','hns_root_import_lifecycle_v1','ownership')`,
        );
        await admin.query(
          `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
           VALUES ('raced-operation','observe_current', clock_timestamp() - interval '1 second')`,
        );

        // The lifecycle runner declines while the legacy lease is live.
        const contended = await admin.query(
          "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
          ["lifecycle-executor", 60],
        );
        expect(contended.rows).toHaveLength(0);

        // Once that lease lapses, the operation is the lifecycle runner's.
        await admin.query(
          `UPDATE hns_root_import_observation_jobs
            SET lease_expires_at = clock_timestamp() - interval '1 second'
          WHERE root_import_session_id = 'raced-operation'`,
        );
        const drained = await admin.query(
          "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
          ["lifecycle-executor", 60],
        );
        expect(drained.rows).toHaveLength(1);
        expect(drained.rows[0]?.job_kind).toBe("observe_current");
        // The legacy readiness job remains claimable: 0147 withdrew the
        // ownership transfer, because the lifecycle runner does not perform
        // readiness work and excluding it left nobody who did. The fence that
        // survives is the one proven above — the lifecycle waits for an
        // in-flight legacy lease rather than observing alongside it.
        const reclaimed = await admin.query(
          "SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)",
          ["legacy-executor", 60],
        );
        expect(reclaimed.rows).toHaveLength(1);
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "the operation's plan digest is write-once, in SQL and against direct updates",
    async () => {
      const schema = `hns_ownership_dig_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const admin = new Client({ connectionString });
      await admin.connect();
      try {
        await schemaWithMigrations(admin, schema);
        await admin.query("COMMIT");
        await admin.query(
          `INSERT INTO hns_root_import_lifecycle (
           root_import_session_id, root_label, phase, revision, generation,
           plan_exposed_at, publication_deadline_at, pending_reason,
           policy_name, policy_digest
         ) VALUES ('digest-operation','digestname','checking_publication',1,1,
           clock_timestamp() - interval '1 hour', clock_timestamp() + interval '13 days',
           'awaiting_publication','hns_root_import_lifecycle_v1','ownership')`,
        );

        const set = await admin.query(
          "SELECT set_hns_root_import_lifecycle_plan_digest_v1($1,$2) AS outcome",
          ["digest-operation", digestOne],
        );
        expect(set.rows[0]?.outcome).toBe("set");
        const replayed = await admin.query(
          "SELECT set_hns_root_import_lifecycle_plan_digest_v1($1,$2) AS outcome",
          ["digest-operation", digestOne],
        );
        expect(replayed.rows[0]?.outcome).toBe("replayed");
        await expect(
          admin.query("SELECT set_hns_root_import_lifecycle_plan_digest_v1($1,$2)", [
            "digest-operation",
            digestTwo,
          ]),
        ).rejects.toThrow(/plan digest is immutable/u);
        await expect(
          admin.query(
            `UPDATE hns_root_import_lifecycle SET plan_encoded_resource_sha256 = $1
            WHERE root_import_session_id = 'digest-operation'`,
            [digestTwo],
          ),
        ).rejects.toThrow(/plan digest is immutable/u);
        const absent = await admin.query(
          "SELECT set_hns_root_import_lifecycle_plan_digest_v1($1,$2) AS outcome",
          ["no-such-operation", digestOne],
        );
        expect(absent.rows[0]?.outcome).toBe("lifecycle_absent");
        await expect(
          admin.query("SELECT set_hns_root_import_lifecycle_plan_digest_v1($1,$2)", [
            "digest-operation",
            "not-a-digest",
          ]),
        ).rejects.toThrow(/invalid HNS lifecycle plan digest/u);

        const stored = await admin.query(
          `SELECT plan_encoded_resource_sha256 FROM hns_root_import_lifecycle
          WHERE root_import_session_id = 'digest-operation'`,
        );
        expect(stored.rows[0]?.plan_encoded_resource_sha256).toBe(digestOne);
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "the 0141 backfill takes the digest from an already-exposed plan, and nothing else",
    async () => {
      const schema = `hns_ownership_bf_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const admin = new Client({ connectionString });
      await admin.connect();
      try {
        await schemaWithMigrations(admin, schema);
        await seedObservingSession(admin, {
          session: "backfill-with-plan",
          label: "backfill1",
          lifecycle: true,
        });
        await seedObservingSession(admin, {
          session: "backfill-no-lifecycle",
          label: "backfill2",
          lifecycle: false,
        });
        await admin.query("COMMIT");
        // A second operation whose lifecycle row has no session behind it at
        // all: the backfill must leave its digest null rather than invent one.
        await admin.query(
          `INSERT INTO hns_root_import_lifecycle (
           root_import_session_id, root_label, phase, revision, generation,
           plan_exposed_at, publication_deadline_at, pending_reason,
           policy_name, policy_digest
         ) VALUES ('backfill-orphan','backfill3','checking_publication',1,1,
           clock_timestamp() - interval '1 hour', clock_timestamp() + interval '13 days',
           'awaiting_publication','hns_root_import_lifecycle_v1','ownership')`,
        );
        await admin.query(
          `UPDATE hns_root_import_lifecycle SET plan_encoded_resource_sha256 = NULL
          WHERE root_import_session_id IN ('backfill-with-plan','backfill-orphan')`,
        );

        const migrationSql = await readFile(
          fileURLToPath(
            new URL(
              "../../../db/postgres/migrations/0141_hns_lifecycle_execution_ownership.sql",
              import.meta.url,
            ),
          ),
          "utf8",
        );
        const start = migrationSql.indexOf("UPDATE hns_root_import_lifecycle AS lifecycle");
        const end = migrationSql.indexOf("^[0-9a-f]{64}$';", start) + "^[0-9a-f]{64}$';".length;
        if (start < 0 || end <= start) throw new Error("backfill statement not found in 0141");
        await admin.query(migrationSql.slice(start, end));

        const rows = await admin.query(
          `SELECT root_import_session_id, plan_encoded_resource_sha256
           FROM hns_root_import_lifecycle ORDER BY root_import_session_id`,
        );
        const byId = new Map(
          rows.rows.map((row) => [row.root_import_session_id, row.plan_encoded_resource_sha256]),
        );
        expect(byId.get("backfill-with-plan")).toBe(digestOne);
        expect(byId.get("backfill-orphan")).toBeNull();
        expect(byId.has("backfill-no-lifecycle")).toBe(false);
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
    },
    SCHEMA_BUDGET_MS,
  );
});
