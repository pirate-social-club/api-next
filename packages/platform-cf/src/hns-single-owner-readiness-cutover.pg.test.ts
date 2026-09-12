import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const actorId = "cutover-actor";
const communityId = "community_123e4567-e89b-42d3-a456-426614174077";
const planBytes = Buffer.from("single-owner-cutover-plan");
const planSha = createHash("sha256").update(planBytes).digest("hex");
const requestBytes = Buffer.from("single-owner-cutover-request");
const requestSha = createHash("sha256").update(requestBytes).digest("hex");

type SeedSessionOptions = Readonly<{
  readonly session: string;
  readonly label: string;
  readonly withLifecycle: boolean;
  readonly phase?: "checking_authority" | "ready";
  readonly readinessObservedAt?: string | null;
}>;

async function withSchema<A>(
  migrationFilter: (version: string) => boolean,
  use: (admin: Client) => Promise<A>,
): Promise<A> {
  const schema = `hns_cutover_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`SET search_path TO ${quote(schema)}`);
    for (const migration of await loadPostgresMigrations()) {
      if (migrationFilter(migration.version)) await admin.query(migration.sql);
    }
    return await use(admin);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

const beforeCutover = (version: string): boolean => !version.startsWith("0168");
const afterCutover = (): boolean => true;

async function applyCutover(admin: Client): Promise<void> {
  const cutover = (await loadPostgresMigrations()).find((migration) =>
    migration.version.startsWith("0168"),
  );
  if (cutover === undefined) throw new Error("cutover migration missing");
  await admin.query(cutover.sql);
}

async function seedOwners(admin: Client): Promise<void> {
  await admin.query("INSERT INTO users (user_id,status,account) VALUES ($1,'active','{}')", [
    actorId,
  ]);
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  await admin.query(
    `INSERT INTO communities (community_id,display_name,status,created_by_user_id,
       canonical_route_binding_id,route_authority_version,created_at,updated_at)
     VALUES ($1,'Cutover','active',$2,NULL,'optional_route_v2',clock_timestamp(),clock_timestamp())`,
    [communityId, actorId],
  );
  await admin.query("COMMIT");
}

async function seedSession(admin: Client, options: SeedSessionOptions): Promise<void> {
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  await admin.query(
    `INSERT INTO hns_root_import_sessions (
       root_import_session_id, actor_id,
       namespace_session_id, ownership_generation, ownership_expected_revision,
       root_label, challenge_txt_value, status, revision,
       start_idempotency_key, start_request_sha256, provision_job_id,
       provision_authorization_kind, provision_authorization_sha256,
       provision_idempotency_key, provision_poll_request_sha256,
       publish_plan_bytes, publish_plan_sha256, ownership_result_sha256,
       observation_job_id, observation_idempotency_key, observation_request_sha256,
       community_id, attachment_intent_id, origin_kind, created_at, expires_at
     ) VALUES (
       $1,$2,
       'namespace-' || $1,1,1,$3,$4,'observing',3,
       'start-' || $1,$5,'provision-' || $1,
       'namespace_ownership',$5,'idem-' || $1,$5,
       $6,$5,$5,
       'observation-' || $1,'obs-idem-' || $1,$5,
       $7,'attachment-' || $1,'community_attachment',
       clock_timestamp(), clock_timestamp() + interval '30 days'
     )`,
    [
      options.session,
      actorId,
      options.label,
      `pirate-verification=${options.label}`,
      planSha,
      planBytes,
      communityId,
    ],
  );
  if (options.withLifecycle) {
    const phase = options.phase ?? "checking_authority";
    await admin.query(
      `INSERT INTO hns_root_import_lifecycle (
         root_import_session_id, root_label, phase, revision, generation,
         plan_exposed_at, publication_deadline_at,
         first_current_observation_at, finality_deadline_at, readiness_observed_at,
         policy_name, policy_digest, plan_encoded_resource_sha256
       ) VALUES ($1,$2,$3,1,1,
         clock_timestamp() - interval '1 day', clock_timestamp() + interval '13 days',
         CASE WHEN $3 = 'checking_authority' THEN clock_timestamp() - interval '2 hours' END,
         CASE WHEN $3 = 'checking_authority' THEN clock_timestamp() + interval '22 hours' END,
         $4,
         'hns_root_import_lifecycle_v1','readiness',$5)`,
      [options.session, options.label, phase, options.readinessObservedAt ?? null, planSha],
    );
  }
  await admin.query("COMMIT");
}

async function seedLegacyObservation(
  admin: Client,
  input: Readonly<{
    readonly job: string;
    readonly session: string;
    readonly state: "queued" | "leased";
    readonly leaseExpiresAt?: string;
  }>,
): Promise<void> {
  await admin.query(
    `INSERT INTO hns_root_import_observation_jobs (
       observation_job_id, root_import_session_id, operation_kind,
       request_bytes, request_sha256, state, attempt_count, lease_fence,
       leased_by, lease_expires_at
     ) VALUES ($1,$2,'observe_root_v1',$3,$4,$5,0,0,
       CASE WHEN $5::text = 'leased' THEN 'legacy-executor' END,
       ${input.leaseExpiresAt ?? "NULL"})`,
    [input.job, input.session, requestBytes, requestSha, input.state],
  );
}

async function seedLifecycleReadinessJob(
  admin: Client,
  input: Readonly<{
    readonly session: string;
    readonly state: "queued" | "leased";
    readonly generation?: number;
  }>,
): Promise<string> {
  const row = await admin.query<{ lifecycle_job_id: string }>(
    `INSERT INTO hns_root_import_lifecycle_jobs (
       root_import_session_id, job_kind, due_at, state, attempt_count, lease_fence,
       leased_by, lease_expires_at, generation
     ) VALUES ($1,'observe_readiness',clock_timestamp() - interval '1 second',
       $2,0,0,
       CASE WHEN $2::text = 'leased' THEN 'lifecycle-executor' END,
       CASE WHEN $2 = 'leased' THEN clock_timestamp() + interval '60 seconds' END,
       $3)
     RETURNING lifecycle_job_id`,
    [input.session, input.state, input.generation ?? 1],
  );
  const id = row.rows[0]?.lifecycle_job_id;
  if (id === undefined) throw new Error("lifecycle job seed failed");
  return id;
}

async function legacyReadinessJobCount(admin: Client, session: string): Promise<number> {
  const row = await admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM hns_root_import_lifecycle_jobs
      WHERE root_import_session_id=$1 AND job_kind='observe_readiness'
        AND state IN ('queued','leased')`,
    [session],
  );
  return Number(row.rows[0]?.count ?? "-1");
}

suite("HNS single-owner readiness cutover on PostgreSQL 17", () => {
  test("the target schema exposes one readiness path and no ownership controls", async () => {
    await withSchema(afterCutover, async (admin) => {
      const marker = await admin.query<{ present: boolean }>(
        "SELECT to_regclass('hns_root_import_execution_ownership') IS NOT NULL AS present",
      );
      expect(marker.rows[0]?.present).toBe(false);

      const functions = await admin.query<{ name: string; count: string }>(
        `SELECT proname AS name, count(*)::text AS count
             FROM pg_proc AS procedure
             JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = current_schema()
              AND proname IN (
                'begin_hns_root_import_readiness_ownership_v1',
                'withdraw_hns_root_import_readiness_ownership_v1',
                'finalize_hns_root_import_observation_job_legacy_v1',
                'commit_hns_root_import_readiness_v1',
                'finalize_hns_root_import_observation_job_v1',
                'claim_hns_root_import_lifecycle_job_v1',
                'claim_hns_root_import_observation_job_v1'
              )
            GROUP BY proname ORDER BY proname`,
      );
      const counts = new Map(functions.rows.map((row) => [row.name, Number(row.count)]));
      expect(counts.get("begin_hns_root_import_readiness_ownership_v1")).toBeUndefined();
      expect(counts.get("withdraw_hns_root_import_readiness_ownership_v1")).toBeUndefined();
      expect(counts.get("finalize_hns_root_import_observation_job_legacy_v1")).toBeUndefined();
      expect(counts.get("commit_hns_root_import_readiness_v1")).toBe(1);
      expect(counts.get("finalize_hns_root_import_observation_job_v1")).toBe(1);
      expect(counts.get("claim_hns_root_import_lifecycle_job_v1")).toBe(1);
      expect(counts.get("claim_hns_root_import_observation_job_v1")).toBe(1);
    });
  }, 180_000);

  test("a session without a lifecycle row blocks the cutover with unchanged state", async () => {
    await withSchema(beforeCutover, async (admin) => {
      await seedOwners(admin);
      await seedSession(admin, {
        session: "cutover-unresolved",
        label: "unresolve",
        withLifecycle: false,
      });
      await seedLegacyObservation(admin, {
        job: "legacy-unresolved",
        session: "cutover-unresolved",
        state: "queued",
      });
      await expect(applyCutover(admin)).rejects.toThrow(
        /readiness_single_owner_cutover_blocked.*cutover-unresolved/s,
      );
      const marker = await admin.query<{ present: boolean }>(
        "SELECT to_regclass('hns_root_import_execution_ownership') IS NOT NULL AS present",
      );
      expect(marker.rows[0]?.present).toBe(true);
    });
  }, 180_000);

  test("a live legacy readiness lease blocks the cutover with unchanged state", async () => {
    await withSchema(beforeCutover, async (admin) => {
      await seedOwners(admin);
      await seedSession(admin, {
        session: "cutover-live-lease",
        label: "livelease",
        withLifecycle: true,
      });
      await seedLegacyObservation(admin, {
        job: "legacy-live-lease",
        session: "cutover-live-lease",
        state: "leased",
        leaseExpiresAt: "clock_timestamp() + interval '10 minutes'",
      });
      await expect(applyCutover(admin)).rejects.toThrow(
        /readiness_single_owner_cutover_blocked.*live legacy readiness lease/s,
      );
      const marker = await admin.query<{ present: boolean }>(
        "SELECT to_regclass('hns_root_import_execution_ownership') IS NOT NULL AS present",
      );
      expect(marker.rows[0]?.present).toBe(true);
    });
  }, 180_000);

  test("valid queued and leased current-generation lifecycle readiness work survives the cutover", async () => {
    await withSchema(beforeCutover, async (admin) => {
      await seedOwners(admin);
      await seedSession(admin, {
        session: "cutover-queued",
        label: "queuedwork",
        withLifecycle: true,
      });
      await seedSession(admin, {
        session: "cutover-leased",
        label: "leasedwork",
        withLifecycle: true,
      });
      await seedLifecycleReadinessJob(admin, { session: "cutover-queued", state: "queued" });
      await seedLifecycleReadinessJob(admin, { session: "cutover-leased", state: "leased" });
      await applyCutover(admin);
      expect(await legacyReadinessJobCount(admin, "cutover-queued")).toBe(1);
      expect(await legacyReadinessJobCount(admin, "cutover-leased")).toBe(1);
      const states = await admin.query<{ state: string }>(
        `SELECT state FROM hns_root_import_lifecycle_jobs
            WHERE root_import_session_id IN ('cutover-queued','cutover-leased')
              AND job_kind='observe_readiness' ORDER BY root_import_session_id`,
      );
      expect(states.rows.map((row) => row.state).sort()).toEqual(["leased", "queued"]);
    });
  }, 180_000);

  test("queued legacy readiness work is dispositioned and exactly one successor is queued", async () => {
    await withSchema(beforeCutover, async (admin) => {
      await seedOwners(admin);
      await seedSession(admin, {
        session: "cutover-successor",
        label: "successor",
        withLifecycle: true,
      });
      await seedLegacyObservation(admin, {
        job: "legacy-successor",
        session: "cutover-successor",
        state: "queued",
      });
      await applyCutover(admin);
      const legacy = await admin.query<{ state: string; failure_code: string }>(
        `SELECT state, failure_code FROM hns_root_import_observation_jobs
            WHERE observation_job_id='legacy-successor'`,
      );
      expect(legacy.rows[0]?.state).toBe("failed");
      expect(legacy.rows[0]?.failure_code).toBe("readiness_single_owner_cutover");
      expect(await legacyReadinessJobCount(admin, "cutover-successor")).toBe(1);
    });
  }, 180_000);

  test("concurrent lifecycle claims return distinct readiness jobs and never duplicate", async () => {
    await withSchema(afterCutover, async (admin) => {
      const schemaRow = await admin.query<{ schema: string }>("SELECT current_schema() AS schema");
      const currentSchema = schemaRow.rows[0]?.schema;
      if (currentSchema === undefined) throw new Error("test schema missing");
      await seedOwners(admin);
      await seedSession(admin, {
        session: "cutover-race-a",
        label: "raceone",
        withLifecycle: true,
      });
      await seedSession(admin, {
        session: "cutover-race-b",
        label: "racetwo",
        withLifecycle: true,
      });
      await seedLifecycleReadinessJob(admin, { session: "cutover-race-a", state: "queued" });
      await seedLifecycleReadinessJob(admin, { session: "cutover-race-b", state: "queued" });
      const claim = async (executor: string) => {
        const client = new Client({ connectionString });
        await client.connect();
        try {
          await client.query(`SET search_path TO ${quote(currentSchema)}`);
          const result = await client.query<{ lifecycle_job_id: string; job_kind: string }>(
            "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
            [executor, 60],
          );
          return result.rows[0];
        } finally {
          await client.end().catch(() => undefined);
        }
      };
      const [first, second] = await Promise.all([claim("cutover-one"), claim("cutover-two")]);
      expect(first?.job_kind).toBe("observe_readiness");
      expect(second?.job_kind).toBe("observe_readiness");
      expect(first?.lifecycle_job_id).not.toBe(second?.lifecycle_job_id);
      const outstanding = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM hns_root_import_lifecycle_jobs
            WHERE state='queued' AND job_kind='observe_readiness'
              AND root_import_session_id IN ('cutover-race-a','cutover-race-b')`,
      );
      expect(Number(outstanding.rows[0]?.count)).toBe(0);
    });
  }, 180_000);

  test("teardown and renewal claims survive while the legacy readiness route no longer returns work", async () => {
    await withSchema(afterCutover, async (admin) => {
      const functions = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_proc AS procedure
             JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = current_schema()
              AND proname IN ('claim_hns_root_import_observation_job_v1',
                              'claim_hns_root_health_renewal_job_v1',
                              'finalize_hns_root_import_observation_job_v1')`,
      );
      expect(Number(functions.rows[0]?.count)).toBe(3);
      await seedOwners(admin);
      await seedSession(admin, {
        session: "cutover-teardown",
        label: "teardown",
        withLifecycle: true,
      });
      await seedLegacyObservation(admin, {
        job: "legacy-disposed",
        session: "cutover-teardown",
        state: "queued",
      });
      const claim = await admin.query(
        "SELECT * FROM claim_hns_root_import_observation_job_v1('legacy-executor',60)",
      );
      expect(claim.rows.length).toBe(0);
    });
  }, 180_000);
});
