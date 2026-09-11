import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

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

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const shaA = "a".repeat(64);
const communityId = "community_123e4567-e89b-42d3-a456-426614174099";

type Shape = Readonly<{
  readonly session: string;
  readonly label: string;
  readonly status: string;
  readonly provisionCompletedMinutesAgo: number | null;
  readonly provisionState: string;
  readonly activated: boolean;
  readonly readiness: boolean;
  readonly observing: boolean;
  readonly plan: boolean;
  readonly provisioned: boolean;
}>;

const shapes: readonly Shape[] = [
  {
    session: "migration-preparing",
    label: "prepare1",
    status: "provisioning",
    provisionCompletedMinutesAgo: null,
    provisionState: "queued",
    activated: false,
    readiness: false,
    observing: false,
    plan: false,
    provisioned: true,
  },
  {
    session: "migration-awaiting",
    label: "await2",
    status: "awaiting_owner_update",
    provisionCompletedMinutesAgo: 60,
    provisionState: "completed",
    activated: false,
    readiness: false,
    observing: false,
    plan: true,
    provisioned: true,
  },
  {
    session: "migration-observing",
    label: "observe3",
    status: "observing",
    provisionCompletedMinutesAgo: 30,
    provisionState: "completed",
    activated: false,
    readiness: false,
    observing: true,
    plan: true,
    provisioned: true,
  },
  {
    session: "migration-ready",
    label: "readyfour",
    status: "ready",
    provisionCompletedMinutesAgo: 20,
    provisionState: "completed",
    activated: false,
    readiness: true,
    observing: true,
    plan: true,
    provisioned: true,
  },
  {
    session: "migration-activated",
    label: "activate5",
    status: "activated",
    provisionCompletedMinutesAgo: 10,
    provisionState: "completed",
    activated: true,
    readiness: true,
    observing: true,
    plan: true,
    provisioned: true,
  },
  {
    session: "migration-failed",
    label: "failedsix",
    status: "failed",
    provisionCompletedMinutesAgo: 90,
    provisionState: "completed",
    activated: false,
    readiness: false,
    observing: true,
    plan: true,
    provisioned: true,
  },
  {
    session: "migration-expired",
    label: "expired7",
    status: "expired",
    provisionCompletedMinutesAgo: 120,
    provisionState: "completed",
    activated: false,
    readiness: false,
    observing: false,
    plan: true,
    provisioned: true,
  },
];

async function seedShape(admin: Client, shape: Shape): Promise<void> {
  const planBytes = Buffer.from('{"version":"pirate-hns-root-import-publish-plan-v1"}');
  const readinessBytes = Buffer.from('{"readiness":true}');
  const requestBytes = Buffer.from(
    `{"root_import_session_id":"${shape.session}","root_label":"${shape.label}"}`,
  );
  const requestSha256 = createHash("sha256").update(requestBytes).digest("hex");
  const planSha256 = createHash("sha256").update(planBytes).digest("hex");
  const readinessSha256 = createHash("sha256").update(readinessBytes).digest("hex");
  const resultSha256 = createHash("sha256").update(requestBytes).digest("hex");
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
       readiness_result_bytes, readiness_result_sha256, activated_community_id,
       expires_at
     ) VALUES (
       $1,'migration-actor','migration-intent','migration-ceremony',
       $2,1,1,$3,'pirate-verification=migration',$4,1,
       'start-key-' || $1,$5,$6,
       $7,$8,$9,$10,
       $11,$12,$13,
       $14,$15,$16,
       $17,$18,$19,
       clock_timestamp() + interval '30 days'
     )`,
    [
      shape.session,
      `namespace-${shape.session}`,
      shape.label,
      shape.status,
      shaA,
      `provision-${shape.session}`,
      shape.provisioned ? "community_provisional" : null,
      shape.provisioned ? shaA : null,
      shape.provisioned ? `idem-${shape.session}` : null,
      shape.provisioned ? shaA : null,
      shape.plan ? planBytes : null,
      shape.plan ? planSha256 : null,
      shape.observing ? shaA : null,
      shape.observing ? `observation-${shape.session}` : null,
      shape.observing ? `obs-idem-${shape.session}` : null,
      shape.observing ? shaA : null,
      shape.readiness ? readinessBytes : null,
      shape.readiness ? readinessSha256 : null,
      shape.activated ? communityId : null,
    ],
  );
  await admin.query(
    `INSERT INTO hns_authority_provision_jobs (
       provision_job_id, root_import_session_id, operation_kind,
       request_bytes, request_sha256, state, attempt_count,
       publish_plan_bytes, publish_plan_sha256, result_bytes, result_sha256,
       created_at, completed_at
     ) VALUES (
       $1,$2,'provision_root_v1',$3,$4,$5,1,
       $6,$7,
       CASE WHEN $5 = 'completed' THEN $3::bytea END,
       CASE WHEN $5 = 'completed' THEN $8 END,
       clock_timestamp() - interval '6 hours',
       CASE WHEN $9::int IS NULL THEN NULL
         ELSE clock_timestamp() - interval '5 hours' END
     )`,
    [
      `provision-${shape.session}`,
      shape.session,
      requestBytes,
      requestSha256,
      shape.provisionState,
      shape.plan ? planBytes : null,
      shape.plan ? planSha256 : null,
      resultSha256,
      shape.provisionCompletedMinutesAgo,
    ],
  );
}

/** The exact backfill statement of migration 0137, re-run on demand. */
async function backfill(admin: Client): Promise<void> {
  const migrationSql = await readFile(
    fileURLToPath(
      new URL(
        "../../../db/postgres/migrations/0137_hns_root_import_lifecycle.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const start = migrationSql.indexOf(
    "INSERT INTO hns_root_import_lifecycle (\n  root_import_session_id",
  );
  if (start < 0) throw new Error("backfill statement not found in migration 0137");
  await admin.query(migrationSql.slice(start));
}

suite("HNS root-import lifecycle migration matrix (T13)", () => {
  test(
    "maps every existing-session shape forward with conservative retention",
    async () => {
      const schema = `hns_lifecycle_t13_${randomUUID().replaceAll("-", "")}`;
      const admin = new Client({ connectionString });
      await admin.connect();
      try {
        await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
        await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
        for (const migration of await loadPostgresMigrations()) {
          await admin.query(migration.sql);
        }
        // Minimal FK-valid parents; replica role skips the heavier session FKs.
        await admin.query("BEGIN");
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query("INSERT INTO users (user_id) VALUES ('migration-actor')");
        await admin.query(
          `INSERT INTO communities (community_id,display_name,status,created_by_user_id,
           canonical_route_binding_id,route_authority_version,route_slug,created_at,updated_at)
         VALUES ($1,'Lifecycle migration','active','migration-actor',
           NULL,'optional_route_v2',NULL,clock_timestamp(),clock_timestamp())`,
          [communityId],
        );
        for (const shape of shapes) {
          await seedShape(admin, shape);
        }
        await admin.query("COMMIT");

        // A job leased during the rollout keeps executing under its existing
        // envelope; the lifecycle migration must not disturb it.
        await admin.query(
          `UPDATE hns_authority_provision_jobs
            SET state='leased', leased_by='rollout-executor',
                lease_fence=3, lease_expires_at=clock_timestamp() + interval '1 minute'
          WHERE provision_job_id='provision-migration-preparing'`,
        );

        await backfill(admin);

        const mapped = await admin.query(
          `SELECT lifecycle.root_import_session_id, lifecycle.phase, lifecycle.pending_reason,
                lifecycle.plan_exposed_at, lifecycle.publication_deadline_at,
                lifecycle.readiness_observed_at,
                provision.completed_at
           FROM hns_root_import_lifecycle AS lifecycle
           LEFT JOIN hns_authority_provision_jobs AS provision
             ON provision.provision_job_id =
                (SELECT provision_job_id FROM hns_root_import_sessions s
                  WHERE s.root_import_session_id = lifecycle.root_import_session_id)
          ORDER BY lifecycle.root_import_session_id`,
        );
        const bySession = new Map(mapped.rows.map((row) => [row.root_import_session_id, row]));
        expect(bySession.get("migration-preparing")).toMatchObject({
          phase: "preparing",
          pending_reason: "preparing_retained_authority",
        });
        const awaiting = bySession.get("migration-awaiting");
        expect(awaiting?.phase).toBe("awaiting_publication");
        expect(Number(awaiting?.publication_deadline_at - awaiting?.plan_exposed_at)).toBe(
          1_209_600_000,
        );
        expect(Number(awaiting?.plan_exposed_at - awaiting?.completed_at)).toBe(0);
        expect(bySession.get("migration-observing")).toMatchObject({
          phase: "checking_publication",
          pending_reason: "migration_fresh_current_read_required",
        });
        expect(bySession.get("migration-ready")?.phase).toBe("ready");
        expect(bySession.get("migration-ready")?.readiness_observed_at).not.toBeNull();
        expect(bySession.get("migration-activated")).toMatchObject({
          phase: "activated",
          readiness_observed_at: expect.anything(),
        });
        expect(bySession.get("migration-failed")).toMatchObject({
          phase: "recovery_required",
          pending_reason: "recovery_required_retained_authority",
        });
        expect(bySession.get("migration-expired")).toMatchObject({
          phase: "recovery_required",
          pending_reason: "recovery_required_retained_authority",
        });
        // The finality anchor is never backdated: fresh reads are required.
        for (const row of mapped.rows) {
          expect(row.first_current_observation_at ?? null).toBeNull();
        }
        // No lifecycle job was invented for leased rollout work.
        const lifecycleJobs = await admin.query(
          "SELECT count(*)::int AS count FROM hns_root_import_lifecycle_jobs",
        );
        expect(lifecycleJobs.rows[0].count).toBe(0);
        const leasedEnvelope = await admin.query(
          `SELECT state, leased_by, lease_fence FROM hns_authority_provision_jobs
          WHERE provision_job_id='provision-migration-preparing'`,
        );
        expect(leasedEnvelope.rows[0]).toMatchObject({
          state: "leased",
          leased_by: "rollout-executor",
          lease_fence: "3",
        });

        // The backfill is idempotent.
        await backfill(admin);
        const again = await admin.query(
          "SELECT count(*)::int AS count FROM hns_root_import_lifecycle",
        );
        expect(again.rows[0].count).toBe(shapes.length);
      } finally {
        await admin.query("ROLLBACK").catch(() => undefined);
        await admin
          .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
          .catch(() => undefined);
        await admin.end();
      }
    },
    SCHEMA_BUDGET_MS,
  );
});
