import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * Migration 0219: a lifecycle observe_readiness job may take the zone
 * mutation lock, and nothing looser may. Before 0219 the lock refused every
 * lifecycle job, so readiness reconciliation could never run and a staging
 * import stayed in checking_authority (2026-09-26).
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

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

// The observing shape and its seed are copied from the lifecycle migration
// matrix (hns-root-import-lifecycle-migration.pg.test.ts).
const OBSERVING: Shape = {
  session: "readiness-lock",
  label: "observe3",
  status: "observing",
  provisionCompletedMinutesAgo: 30,
  provisionState: "completed",
  activated: false,
  readiness: false,
  observing: true,
  plan: true,
  provisioned: true,
};
const CHALLENGE = "pirate-verification=migration";

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

async function seedLifecycle(admin: Client, phase: string, generation: number): Promise<void> {
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle (
       root_import_session_id, root_label, phase, revision, generation,
       plan_exposed_at, publication_deadline_at, first_current_observation_at,
       finality_deadline_at, readiness_observed_at, policy_name, policy_digest
     ) VALUES ($1,$2,$3,1,$4,
       clock_timestamp() - interval '3 hours', clock_timestamp() + interval '13 days',
       -- The phase deadline shape: nothing observed while awaiting publication,
       -- and a readiness observation once ready.
       CASE WHEN $3 = 'awaiting_publication' THEN NULL ELSE clock_timestamp() - interval '2 hours' END,
       CASE WHEN $3 = 'awaiting_publication' THEN NULL ELSE clock_timestamp() + interval '22 hours' END,
       CASE WHEN $3 = 'ready' THEN clock_timestamp() - interval '1 minute' END,
       'hns_root_import_lifecycle_v1','seed')`,
    [OBSERVING.session, OBSERVING.label, phase, generation],
  );
}

async function seedJob(
  admin: Client,
  input: {
    readonly id: number;
    readonly kind: string;
    readonly state: string;
    readonly executor: string | null;
    readonly fence: number;
    readonly expiresIn: string | null;
    readonly generation: number;
  },
): Promise<void> {
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle_jobs (
       lifecycle_job_id, root_import_session_id, job_kind, due_at, state,
       attempt_count, leased_by, lease_expires_at, lease_fence, generation
     ) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,clock_timestamp(),$4,1,$5,
       CASE WHEN $6::text IS NULL THEN NULL ELSE clock_timestamp() + $6::interval END,
       $7,$8)`,
    [
      input.id,
      OBSERVING.session,
      input.kind,
      input.state,
      input.executor,
      input.expiresIn,
      input.fence,
      input.generation,
    ],
  );
  await admin.query("COMMIT");
}

async function admitted(
  admin: Client,
  jobId: string,
  executor: string,
  fence: number,
): Promise<boolean> {
  await admin.query("BEGIN");
  try {
    const result = await admin.query<{ admitted: boolean }>(
      "SELECT lock_hns_root_zone_mutation_v1($1,$2,false,$3,$4,$5) AS admitted",
      [OBSERVING.label, CHALLENGE, jobId, executor, fence],
    );
    return result.rows[0]?.admitted === true;
  } finally {
    await admin.query("ROLLBACK");
  }
}

async function withSeededSchema<A>(
  phase: string,
  lifecycleGeneration: number,
  use: (admin: Client) => Promise<A>,
): Promise<A> {
  const schema = `hns_readiness_lock_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    for (const migration of await loadPostgresMigrations()) await admin.query(migration.sql);
    // Minimal FK-valid parents; replica role skips the heavier session
    // triggers exactly as the lifecycle migration matrix does. CHECK
    // constraints still apply.
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("INSERT INTO users (user_id) VALUES ('migration-actor')");
    await admin.query(
      `INSERT INTO communities (community_id,display_name,status,created_by_user_id,
       canonical_route_binding_id,route_authority_version,route_slug,created_at,updated_at)
     VALUES ($1,'Readiness lock','active','migration-actor',
       NULL,'optional_route_v2',NULL,clock_timestamp(),clock_timestamp())`,
      [communityId],
    );
    await seedShape(admin, OBSERVING);
    await seedLifecycle(admin, phase, lifecycleGeneration);
    await admin.query("COMMIT");
    return await use(admin);
  } finally {
    await admin
      .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
      .catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

const leasedReadiness = {
  kind: "observe_readiness",
  state: "leased",
  executor: "exec-1",
  fence: 3,
  expiresIn: "5 minutes",
  generation: 1,
};

suite("HNS readiness zone-mutation admission (0219)", () => {
  test(
    "admits the exact leased readiness job while checking authority and once ready",
    async () => {
      for (const phase of ["checking_authority", "ready"]) {
        await withSeededSchema(phase, 1, async (admin) => {
          await seedJob(admin, { id: 41, ...leasedReadiness });
          expect(await admitted(admin, "41", "exec-1", 3)).toBe(true);
        });
      }
    },
    SCHEMA_BUDGET_MS * 2,
  );

  test(
    "refuses every other lease shape and phase",
    async () => {
      await withSeededSchema("checking_authority", 2, async (admin) => {
        await seedJob(admin, { id: 51, ...leasedReadiness, generation: 2 });
        await seedJob(admin, { id: 52, ...leasedReadiness, generation: 1 });
        await seedJob(admin, { id: 53, ...leasedReadiness, generation: 2, expiresIn: "-1 minute" });
        await seedJob(admin, {
          id: 54,
          ...leasedReadiness,
          generation: 2,
          kind: "observe_current",
        });
        await seedJob(admin, {
          id: 55,
          ...leasedReadiness,
          generation: 2,
          kind: "reconcile_provider",
        });
        // The control: the exact lease of the current generation is admitted.
        expect(await admitted(admin, "51", "exec-1", 3)).toBe(true);
        expect(await admitted(admin, "51", "other-executor", 3)).toBe(false);
        expect(await admitted(admin, "51", "exec-1", 4)).toBe(false);
        expect(await admitted(admin, "52", "exec-1", 3)).toBe(false); // stale generation
        expect(await admitted(admin, "53", "exec-1", 3)).toBe(false); // lease expired
        expect(await admitted(admin, "54", "exec-1", 3)).toBe(false); // not a readiness job
        expect(await admitted(admin, "55", "exec-1", 3)).toBe(false);
        expect(await admitted(admin, "999", "exec-1", 3)).toBe(false); // no such job
      });
      for (const phase of [
        "awaiting_publication",
        "checking_publication",
        "waiting_safe_commitment",
        "recovery_required",
      ]) {
        await withSeededSchema(phase, 1, async (admin) => {
          await seedJob(admin, { id: 61, ...leasedReadiness });
          expect(await admitted(admin, "61", "exec-1", 3)).toBe(false);
        });
      }
    },
    SCHEMA_BUDGET_MS * 6,
  );
});
