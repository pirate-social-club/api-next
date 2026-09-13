import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;
const BUDGET_MS = 180_000;

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const actorId = "cutover-actor";
const communityId = "community_123e4567-e89b-42d3-a456-426614174077";
const planBytes = Buffer.from("single-owner-cutover-plan");
const planSha = createHash("sha256").update(planBytes).digest("hex");
const requestBytes = Buffer.from("single-owner-cutover-request");
const requestSha = createHash("sha256").update(requestBytes).digest("hex");
const provisionResultBytes = Buffer.from("single-owner-cutover-provision-result");
const provisionResultSha = createHash("sha256").update(provisionResultBytes).digest("hex");

type SeedSessionOptions = Readonly<{
  readonly session: string;
  readonly label: string;
  readonly withLifecycle: boolean;
  readonly phase?: "checking_authority" | "ready" | "preparing" | "failed";
  readonly sessionStatus?: string;
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

const beforePreflight = (version: string): boolean =>
  !version.startsWith("0168") && !version.startsWith("0169");

async function applyMigration(admin: Client, prefix: string): Promise<void> {
  const migration = (await loadPostgresMigrations()).find((entry) =>
    entry.version.startsWith(prefix),
  );
  if (migration === undefined) throw new Error(`migration ${prefix} missing`);
  await admin.query(migration.sql);
}

async function applyPreflight(admin: Client): Promise<void> {
  await applyMigration(admin, "0168");
}

async function applyRemoval(admin: Client): Promise<void> {
  await applyMigration(admin, "0169");
}

async function applyCutover(admin: Client): Promise<void> {
  await applyPreflight(admin);
  await applyRemoval(admin);
}

async function currentSchema(admin: Client): Promise<string> {
  const row = await admin.query<{ schema: string }>("SELECT current_schema() AS schema");
  const schema = row.rows[0]?.schema;
  if (schema === undefined) throw new Error("test schema missing");
  return schema;
}

async function connectToSchema(schema: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query(`SET search_path TO ${quote(schema)}`);
  return client;
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
       'namespace-' || $1,1,1,$3,$4,$7,3,
       'start-' || $1,$5,'provision-' || $1,
       'namespace_ownership',$5,'idem-' || $1,$5,
       $6,$5,$5,
       'observation-' || $1,'obs-idem-' || $1,$5,
       $8,'attachment-' || $1,'community_attachment',
       clock_timestamp(), clock_timestamp() + interval '30 days'
     )`,
    [
      options.session,
      actorId,
      options.label,
      `pirate-verification=${options.label}`,
      planSha,
      planBytes,
      options.sessionStatus ?? "observing",
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
         CASE WHEN $3 IN ('checking_authority', 'ready') THEN clock_timestamp() - interval '2 hours' END,
         CASE WHEN $3 IN ('checking_authority', 'ready') THEN clock_timestamp() + interval '22 hours' END,
         $4,
         'hns_root_import_lifecycle_v1','readiness',$5)`,
      [options.session, options.label, phase, options.readinessObservedAt ?? null, planSha],
    );
  }
  await admin.query("COMMIT");
}

async function seedCompletedProvision(admin: Client, session: string): Promise<void> {
  await admin.query(
    `INSERT INTO hns_authority_provision_jobs (
       provision_job_id, root_import_session_id, operation_kind,
       request_bytes, request_sha256, state, attempt_count, lease_fence,
       publish_plan_bytes, publish_plan_sha256, result_bytes, result_sha256, completed_at
     ) VALUES ($1,$2,'provision_root_v1',$3,$4,'completed',0,0,$5,$6,$7,$8,clock_timestamp())`,
    [
      `provision-${session}`,
      session,
      requestBytes,
      requestSha,
      planBytes,
      planSha,
      provisionResultBytes,
      provisionResultSha,
    ],
  );
}

async function seedLegacyObservation(
  admin: Client,
  input: Readonly<{
    readonly job: string;
    readonly session: string;
    readonly state: "queued" | "leased" | "completed";
    readonly leaseExpiresAt?: Date;
  }>,
): Promise<void> {
  const leased = input.state === "leased";
  const completed = input.state === "completed";
  await admin.query(
    `INSERT INTO hns_root_import_observation_jobs (
       observation_job_id, root_import_session_id, operation_kind,
       request_bytes, request_sha256, state, attempt_count, lease_fence,
       leased_by, lease_expires_at
     ) VALUES ($1,$2,'observe_root_v1',$3,$4,$5,0,0,$6,$7)`,
    [
      input.job,
      input.session,
      requestBytes,
      requestSha,
      completed ? "queued" : input.state,
      leased ? "legacy-executor" : null,
      leased ? (input.leaseExpiresAt ?? null) : null,
    ],
  );
  if (completed) {
    await admin.query(
      `UPDATE hns_root_import_observation_jobs
          SET state='completed', result_bytes=$2, result_sha256=$3,
              completed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE observation_job_id=$1`,
      [input.job, requestBytes, requestSha],
    );
  }
}

async function seedLifecycleReadinessJob(
  admin: Client,
  input: Readonly<{
    readonly session: string;
    readonly state: "queued" | "leased";
    readonly generation?: number;
    readonly dueAt?: Date;
    readonly executor?: string;
  }>,
): Promise<string> {
  const leased = input.state === "leased";
  const row = await admin.query<{ lifecycle_job_id: string }>(
    `INSERT INTO hns_root_import_lifecycle_jobs (
       root_import_session_id, job_kind, due_at, state, attempt_count, lease_fence,
       leased_by, lease_expires_at, generation
     ) VALUES ($1,'observe_readiness',$2,$3,0,0,$4,$5,$6)
     RETURNING lifecycle_job_id`,
    [
      input.session,
      input.dueAt ?? new Date(Date.now() - 1_000),
      input.state,
      leased ? (input.executor ?? "lifecycle-executor") : null,
      leased ? new Date(Date.now() + 60_000) : null,
      input.generation ?? 1,
    ],
  );
  const id = row.rows[0]?.lifecycle_job_id;
  if (id === undefined) throw new Error("lifecycle job seed failed");
  return id;
}

async function latestReceipt(
  admin: Client,
): Promise<Readonly<{ successor_jobs: number; duplicate_jobs: number }> | null> {
  const receipt = await admin.query<{ successor_jobs: string; duplicate_jobs: string }>(
    `SELECT successor_jobs, duplicate_jobs FROM hns_readiness_single_owner_cutover_receipt
      ORDER BY cutover_receipt_id DESC LIMIT 1`,
  );
  const row = receipt.rows[0];
  if (row === undefined) return null;
  return {
    successor_jobs: Number(row.successor_jobs),
    duplicate_jobs: Number(row.duplicate_jobs),
  };
}

async function readinessJobCount(admin: Client, session: string): Promise<number> {
  const row = await admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM hns_root_import_lifecycle_jobs
      WHERE root_import_session_id=$1 AND job_kind='observe_readiness'
        AND state IN ('queued','leased')`,
    [session],
  );
  return Number(row.rows[0]?.count ?? "-1");
}

function readinessResult(session: string, overrides: Record<string, unknown> = {}) {
  const observedAt = new Date(Date.now() - 5_000);
  const bytes = Buffer.from(
    JSON.stringify({
      version: "pirate-hns-root-import-readiness-result-v1",
      root_import_session_id: session,
      publish_plan_sha256: planSha,
      observed_at: observedAt.toISOString(),
      valid_until: new Date(observedAt.getTime() + 3_600_000).toISOString(),
      ...overrides,
    }),
  );
  return { bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

async function commitReadiness(
  admin: Client,
  input: Readonly<{
    readonly session: string;
    readonly job: Record<string, unknown>;
    readonly revision?: number;
    readonly holder?: string;
    readonly fence?: number;
    readonly result?: Readonly<{ bytes: Buffer; sha: string }>;
  }>,
) {
  const result = input.result ?? readinessResult(input.session);
  const committed = await admin.query<Record<string, unknown>>(
    `SELECT * FROM commit_hns_root_import_readiness_v1($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.session,
      input.job.lifecycle_job_id,
      input.holder ?? "lifecycle-executor",
      input.fence === undefined ? Number(input.job.lease_fence) : input.fence,
      input.revision ?? 1,
      result.bytes,
      result.sha,
    ],
  );
  return { row: committed.rows[0], sha: result.sha };
}

async function claimLifecycle(admin: Client, executor = "lifecycle-executor") {
  const claimed = await admin.query<Record<string, unknown>>(
    "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
    [executor, 60],
  );
  return claimed.rows[0];
}

async function enableReadinessOwnership(admin: Client): Promise<void> {
  await admin.query(
    `UPDATE hns_root_import_execution_ownership
        SET enabled=TRUE, enabled_at=clock_timestamp(), evidence_ref='cutover-test',
            updated_at=clock_timestamp()
      WHERE responsibility='readiness'`,
  );
}

suite("HNS single-owner readiness cutover on PostgreSQL 17", () => {
  test(
    "the target schema exposes one readiness path and no ownership controls",
    async () => {
      await withSchema(
        () => true,
        async (admin) => {
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
                'claim_hns_root_import_observation_job_v1',
                'hns_lifecycle_schema_compatibility_v1'
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
          expect(counts.get("hns_lifecycle_schema_compatibility_v1")).toBe(1);

          const acceptance = await admin.query<{ present: boolean }>(
            `SELECT EXISTS (
           SELECT 1 FROM pg_attribute
            WHERE attrelid = 'hns_root_import_lifecycle'::regclass
              AND attname = 'readiness_accepted_at' AND NOT attisdropped
         ) AS present`,
          );
          expect(acceptance.rows[0]?.present).toBe(true);

          const cutover = await admin.query<{ cutover_version: string }>(
            "SELECT cutover_version FROM hns_lifecycle_schema_cutover",
          );
          expect(cutover.rows.map((row) => row.cutover_version)).toEqual(["0169"]);
        },
      );
    },
    BUDGET_MS,
  );

  test(
    "unresolved sessions are persisted before removal refuses by identity",
    async () => {
      await withSchema(beforePreflight, async (admin) => {
        await seedOwners(admin);
        await seedSession(admin, {
          session: "cutover-unresolved-none",
          label: "unresnone",
          withLifecycle: false,
        });
        await seedSession(admin, {
          session: "cutover-unresolved-done",
          label: "unresdone",
          withLifecycle: false,
        });
        await seedLegacyObservation(admin, {
          job: "legacy-unresolved-done",
          session: "cutover-unresolved-done",
          state: "completed",
        });

        await applyPreflight(admin);
        const dispositions = await admin.query<{
          root_import_session_id: string;
          blocker: string;
          required_evidence: readonly { readonly kind: string }[];
          recovery_owner: string;
          resolved_at: Date | null;
        }>(
          `SELECT root_import_session_id, blocker, required_evidence, recovery_owner, resolved_at
           FROM hns_readiness_single_owner_cutover_unresolved
          ORDER BY root_import_session_id`,
        );
        expect(dispositions.rows.map((row) => row.root_import_session_id)).toEqual([
          "cutover-unresolved-done",
          "cutover-unresolved-none",
        ]);
        for (const row of dispositions.rows) {
          expect(row.blocker).toBe("missing_lifecycle_row");
          expect(row.recovery_owner).toBe("operator_authorized_recovery_adoption");
          expect(row.resolved_at).toBeNull();
          expect(row.required_evidence.map((entry) => entry.kind)).toEqual([
            "current_view_read",
            "safe_view_read",
            "session_plan_binding",
          ]);
        }

        // The removal refuses by identity, and the independently committed
        // dispositions survive the failed removal transaction.
        await expect(applyRemoval(admin)).rejects.toThrow(
          /readiness_single_owner_cutover_unresolved.*cutover-unresolved-done/s,
        );
        const persisted = await admin.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM hns_readiness_single_owner_cutover_unresolved
          WHERE resolved_at IS NULL`,
        );
        expect(Number(persisted.rows[0]?.count)).toBe(2);
        const marker = await admin.query<{ present: boolean }>(
          "SELECT to_regclass('hns_root_import_execution_ownership') IS NOT NULL AS present",
        );
        expect(marker.rows[0]?.present).toBe(true);
        // The removal transaction is atomic: no object created by 0169 or a
        // later reviewed migration is visible after the refusal.
        const cutoverTable = await admin.query<{ present: boolean }>(
          "SELECT to_regclass('hns_lifecycle_schema_cutover') IS NOT NULL AS present",
        );
        expect(cutoverTable.rows[0]?.present).toBe(false);
        const sessions = await admin.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM hns_root_import_sessions
          WHERE root_import_session_id IN
            ('cutover-unresolved-none','cutover-unresolved-done')`,
        );
        expect(Number(sessions.rows[0]?.count)).toBe(2);
      });
    },
    BUDGET_MS,
  );

  test(
    "a live legacy readiness lease blocks the cutover with unchanged state",
    async () => {
      await withSchema(beforePreflight, async (admin) => {
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
          leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
        });
        await applyPreflight(admin);
        await expect(applyRemoval(admin)).rejects.toThrow(
          /readiness_single_owner_cutover_blocked.*live legacy readiness lease/s,
        );
        const marker = await admin.query<{ present: boolean }>(
          "SELECT to_regclass('hns_root_import_execution_ownership') IS NOT NULL AS present",
        );
        expect(marker.rows[0]?.present).toBe(true);
      });
    },
    BUDGET_MS,
  );

  test(
    "valid queued and leased current-generation lifecycle readiness work survives the cutover",
    async () => {
      await withSchema(beforePreflight, async (admin) => {
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
        expect(await readinessJobCount(admin, "cutover-queued")).toBe(1);
        expect(await readinessJobCount(admin, "cutover-leased")).toBe(1);
        const states = await admin.query<{ state: string }>(
          `SELECT state FROM hns_root_import_lifecycle_jobs
            WHERE root_import_session_id IN ('cutover-queued','cutover-leased')
              AND job_kind='observe_readiness' ORDER BY root_import_session_id`,
        );
        expect(states.rows.map((row) => row.state).sort()).toEqual(["leased", "queued"]);
        expect((await latestReceipt(admin))?.successor_jobs ?? 0).toBe(0);
      });
    },
    BUDGET_MS,
  );

  test(
    "queued legacy readiness work is dispositioned and exactly one successor is queued",
    async () => {
      await withSchema(beforePreflight, async (admin) => {
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
        expect(await readinessJobCount(admin, "cutover-successor")).toBe(1);
        expect((await latestReceipt(admin))?.successor_jobs ?? 0).toBe(1);
      });
    },
    BUDGET_MS,
  );

  test(
    "pre-existing duplicate readiness work receives one deterministic survivor",
    async () => {
      await withSchema(beforePreflight, async (admin) => {
        await seedOwners(admin);
        await seedSession(admin, {
          session: "cutover-duplicates",
          label: "duplicates",
          withLifecycle: true,
        });
        const survivor = await seedLifecycleReadinessJob(admin, {
          session: "cutover-duplicates",
          state: "queued",
          dueAt: new Date(Date.now() - 120_000),
        });
        await seedLifecycleReadinessJob(admin, {
          session: "cutover-duplicates",
          state: "queued",
          dueAt: new Date(Date.now() - 60_000),
        });
        await applyCutover(admin);
        const jobs = await admin.query<{
          lifecycle_job_id: string;
          state: string;
          failure_code: string | null;
        }>(
          `SELECT lifecycle_job_id, state, failure_code FROM hns_root_import_lifecycle_jobs
          WHERE root_import_session_id='cutover-duplicates' AND job_kind='observe_readiness'
          ORDER BY lifecycle_job_id`,
        );
        expect(jobs.rows.map((row) => row.state)).toEqual(["queued", "failed"]);
        expect(jobs.rows[0]?.lifecycle_job_id).toBe(survivor);
        expect(jobs.rows[1]?.failure_code).toBe("readiness_single_owner_cutover_duplicate");
        const receipt = await latestReceipt(admin);
        expect(receipt?.successor_jobs ?? 0).toBe(0);
        expect(receipt?.duplicate_jobs ?? 0).toBe(1);
      });
    },
    BUDGET_MS,
  );

  test(
    "readiness work in an unsupported phase receives a named disposition",
    async () => {
      await withSchema(beforePreflight, async (admin) => {
        await seedOwners(admin);
        await seedSession(admin, {
          session: "cutover-inconsistent",
          label: "inconsistent",
          withLifecycle: true,
          phase: "preparing",
        });
        await seedLifecycleReadinessJob(admin, {
          session: "cutover-inconsistent",
          state: "queued",
        });
        await applyCutover(admin);
        const jobs = await admin.query<{ state: string; failure_code: string | null }>(
          `SELECT state, failure_code FROM hns_root_import_lifecycle_jobs
          WHERE root_import_session_id='cutover-inconsistent' AND job_kind='observe_readiness'`,
        );
        expect(jobs.rows[0]?.state).toBe("failed");
        expect(jobs.rows[0]?.failure_code).toBe("readiness_single_owner_cutover_inconsistent");
        expect(await readinessJobCount(admin, "cutover-inconsistent")).toBe(0);
      });
    },
    BUDGET_MS,
  );

  test(
    "a concurrent claim cannot duplicate readiness work across the removal",
    async () => {
      await withSchema(beforePreflight, async (admin) => {
        await seedOwners(admin);
        await seedSession(admin, {
          session: "cutover-claim-race",
          label: "claimrace",
          withLifecycle: true,
        });
        await seedLifecycleReadinessJob(admin, { session: "cutover-claim-race", state: "queued" });
        await applyPreflight(admin);
        await enableReadinessOwnership(admin);
        const schema = await currentSchema(admin);
        const holder = await connectToSchema(schema);
        try {
          await holder.query("BEGIN");
          await holder.query(
            `SELECT 1 FROM hns_root_import_execution_ownership
            WHERE responsibility='readiness' FOR SHARE`,
          );
          const claimed = await holder.query<Record<string, unknown>>(
            "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
            ["claim-race-executor", 60],
          );
          expect(claimed.rows[0]?.job_kind).toBe("observe_readiness");
          const removal = applyRemoval(admin);
          await new Promise((resolve) => setTimeout(resolve, 250));
          await holder.query("COMMIT");
          await removal;
        } finally {
          await holder.end().catch(() => undefined);
        }
        const jobs = await admin.query<{ state: string; leased_by: string }>(
          `SELECT state, leased_by FROM hns_root_import_lifecycle_jobs
          WHERE root_import_session_id='cutover-claim-race' AND job_kind='observe_readiness'
          ORDER BY lifecycle_job_id`,
        );
        expect(jobs.rows).toHaveLength(1);
        expect(jobs.rows[0]).toMatchObject({
          state: "leased",
          leased_by: "claim-race-executor",
        });
        expect((await latestReceipt(admin))?.successor_jobs ?? 0).toBe(0);
      });
    },
    BUDGET_MS,
  );

  test(
    "a readiness acceptance in flight across the removal is preserved as the successor",
    async () => {
      await withSchema(beforePreflight, async (admin) => {
        await seedOwners(admin);
        await seedSession(admin, {
          session: "cutover-refresh-race",
          label: "refreshrace",
          withLifecycle: true,
        });
        await seedLifecycleReadinessJob(admin, {
          session: "cutover-refresh-race",
          state: "queued",
        });
        await applyPreflight(admin);
        await enableReadinessOwnership(admin);
        const schema = await currentSchema(admin);
        const holder = await connectToSchema(schema);
        try {
          await holder.query("BEGIN");
          const claimed = await holder.query<Record<string, unknown>>(
            "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
            ["refresh-race-executor", 60],
          );
          const job = claimed.rows[0];
          if (job === undefined) throw new Error("no readiness job was claimable");
          const result = readinessResult("cutover-refresh-race");
          const written = await holder.query<{ outcome: string }>(
            "SELECT * FROM commit_hns_root_import_readiness_v1($1,$2,$3,$4,$5,$6,$7)",
            [
              "cutover-refresh-race",
              job.lifecycle_job_id,
              "refresh-race-executor",
              Number(job.lease_fence),
              1,
              result.bytes,
              result.sha,
            ],
          );
          expect(written.rows[0]?.outcome).toBe("ready");
          const removal = applyRemoval(admin);
          await new Promise((resolve) => setTimeout(resolve, 250));
          await holder.query("COMMIT");
          await removal;
        } finally {
          await holder.end().catch(() => undefined);
        }
        expect(await readinessJobCount(admin, "cutover-refresh-race")).toBe(0);
        const lifecycle = await admin.query<{
          phase: string;
          readiness_observed_at: Date;
          readiness_accepted_at: Date;
        }>(
          `SELECT phase, readiness_observed_at, readiness_accepted_at
           FROM hns_root_import_lifecycle WHERE root_import_session_id='cutover-refresh-race'`,
        );
        expect(lifecycle.rows[0]?.phase).toBe("ready");
        expect(lifecycle.rows[0]?.readiness_observed_at).not.toBeNull();
        expect(lifecycle.rows[0]?.readiness_accepted_at).not.toBeNull();
        expect((await latestReceipt(admin))?.successor_jobs ?? 0).toBe(0);
      });
    },
    BUDGET_MS,
  );

  test(
    "an in-flight lifecycle decision is re-read before successor scheduling",
    async () => {
      await withSchema(beforePreflight, async (admin) => {
        await seedOwners(admin);
        await seedSession(admin, {
          session: "cutover-decision-race",
          label: "decisionrace",
          withLifecycle: true,
        });
        await applyPreflight(admin);
        const schema = await currentSchema(admin);
        const holder = await connectToSchema(schema);
        try {
          await holder.query("BEGIN");
          await holder.query(
            `SELECT 1 FROM hns_root_import_lifecycle
            WHERE root_import_session_id='cutover-decision-race' FOR UPDATE`,
          );
          const removal = applyRemoval(admin);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const decided = await holder.query<{ outcome: string }>(
            `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1(
             $1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              "cutover-decision-race",
              1,
              "cutover-decision-race-event",
              "recovery_decided",
              "transition",
              "recovery decision racing the removal",
              "recovery_required",
              "{}",
              "[]",
            ],
          );
          expect(decided.rows[0]?.outcome).toBe("transition");
          await holder.query("COMMIT");
          await removal;
        } finally {
          await holder.end().catch(() => undefined);
        }
        expect(await readinessJobCount(admin, "cutover-decision-race")).toBe(0);
        const lifecycle = await admin.query<{ phase: string }>(
          `SELECT phase FROM hns_root_import_lifecycle
          WHERE root_import_session_id='cutover-decision-race'`,
        );
        expect(lifecycle.rows[0]?.phase).toBe("recovery_required");
      });
    },
    BUDGET_MS,
  );

  test(
    "the readiness writer rejects invalid evidence without changing state",
    async () => {
      await withSchema(
        () => true,
        async (admin) => {
          await seedOwners(admin);
          await seedSession(admin, {
            session: "cutover-evidence",
            label: "evidence",
            withLifecycle: true,
          });
          await seedLifecycleReadinessJob(admin, { session: "cutover-evidence", state: "queued" });
          const job = await claimLifecycle(admin);
          if (job === undefined) throw new Error("no readiness job was claimable");

          const invalidResults: readonly (readonly [string, Record<string, unknown>])[] = [
            ["omitted observed_at", { observed_at: undefined }],
            ["null observed_at", { observed_at: null }],
            ["omitted valid_until", { valid_until: undefined }],
            ["null valid_until", { valid_until: null }],
            ["numeric observed_at", { observed_at: 1_700_000_000 }],
            ["malformed observed_at", { observed_at: "not-a-timestamp" }],
            ["infinite observed_at", { observed_at: "infinity" }],
            ["infinite valid_until", { valid_until: "infinity" }],
            [
              "stale observation with future expiry",
              {
                observed_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
                valid_until: new Date(Date.now() + 3_600_000).toISOString(),
              },
            ],
            [
              "future observation",
              {
                observed_at: new Date(Date.now() + 60_000).toISOString(),
                valid_until: new Date(Date.now() + 3_600_000).toISOString(),
              },
            ],
            [
              "beyond the freshness boundary",
              {
                observed_at: new Date(Date.now() - 1_900_000).toISOString(),
                valid_until: new Date(Date.now() + 3_600_000).toISOString(),
              },
            ],
          ];
          for (const [label, overrides] of invalidResults) {
            const attempted = await commitReadiness(admin, {
              session: "cutover-evidence",
              job,
              result: readinessResult("cutover-evidence", overrides),
            });
            expect(attempted.row?.outcome, label).toBe("invalid_result");
          }

          const unchanged = await admin.query<{
            phase: string;
            revision: string;
            readiness_observed_at: Date | null;
            readiness_accepted_at: Date | null;
          }>(
            `SELECT phase, revision, readiness_observed_at, readiness_accepted_at
           FROM hns_root_import_lifecycle WHERE root_import_session_id='cutover-evidence'`,
          );
          expect(unchanged.rows[0]).toMatchObject({
            phase: "checking_authority",
            revision: "1",
            readiness_observed_at: null,
            readiness_accepted_at: null,
          });
          const session = await admin.query<{ status: string; revision: string }>(
            `SELECT status, revision FROM hns_root_import_sessions
          WHERE root_import_session_id='cutover-evidence'`,
          );
          expect(session.rows[0]).toMatchObject({ status: "observing", revision: "3" });

          // Fresh evidence inside the window is accepted, and the observation
          // timestamp is preserved while acceptance is recorded separately.
          const observedAt = new Date(Date.now() - 1_790_000);
          const accepted = await commitReadiness(admin, {
            session: "cutover-evidence",
            job,
            result: readinessResult("cutover-evidence", {
              observed_at: observedAt.toISOString(),
            }),
          });
          expect(accepted.row?.outcome).toBe("ready");
          const after = await admin.query<{
            phase: string;
            revision: string;
            readiness_observed_at: Date;
            readiness_accepted_at: Date;
            next_check_at: Date;
          }>(
            `SELECT phase, revision, readiness_observed_at, readiness_accepted_at, next_check_at
           FROM hns_root_import_lifecycle WHERE root_import_session_id='cutover-evidence'`,
          );
          const row = after.rows[0];
          if (row === undefined) throw new Error("accepted lifecycle state missing");
          expect(row.phase).toBe("ready");
          expect(row.revision).toBe("2");
          expect(Math.abs(row.readiness_observed_at.getTime() - observedAt.getTime())).toBeLessThan(
            1_000,
          );
          expect(row.readiness_accepted_at.getTime()).toBeGreaterThanOrEqual(
            row.readiness_observed_at.getTime(),
          );
          expect(
            Math.abs(row.next_check_at.getTime() - (observedAt.getTime() + 1_800_000)),
          ).toBeLessThan(1_000);
          const finished = await admin.query<{ state: string }>(
            "SELECT state FROM hns_root_import_lifecycle_jobs WHERE lifecycle_job_id=$1",
            [job.lifecycle_job_id],
          );
          expect(finished.rows[0]?.state).toBe("completed");
        },
      );
    },
    BUDGET_MS,
  );

  test(
    "teardown work leased before the cutover finalizes and reclaims after it",
    async () => {
      await withSchema(beforePreflight, async (admin) => {
        await seedOwners(admin);
        await seedSession(admin, {
          session: "cutover-teardown-lease",
          label: "teardownlease",
          withLifecycle: true,
          phase: "failed",
          sessionStatus: "failed",
        });
        await seedCompletedProvision(admin, "cutover-teardown-lease");
        await admin.query(
          `INSERT INTO hns_root_import_teardown_jobs (
           teardown_job_id, root_import_session_id, state, attempt_count, lease_fence,
           leased_by, lease_expires_at
         ) VALUES ('teardown-before-cutover','cutover-teardown-lease','leased',1,3,
           'teardown-executor', clock_timestamp() + interval '10 minutes')`,
        );
        await applyCutover(admin);
        const finalized = await admin.query<{ outcome: string }>(
          `SELECT * FROM finalize_hns_root_import_observation_job_v1(
           $1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            "teardown-before-cutover",
            "teardown-executor",
            3,
            requestSha,
            "retry",
            null,
            null,
            "provider_unavailable",
          ],
        );
        expect(finalized.rows[0]?.outcome).toBe("retry");
        const reclaimed = await admin.query<Record<string, unknown>>(
          "SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)",
          ["teardown-executor", 60],
        );
        expect(reclaimed.rows[0]).toMatchObject({
          observation_job_id: "teardown-before-cutover",
          operation_kind: "teardown_root_v1",
          lease_fence: "4",
        });
      });
    },
    BUDGET_MS,
  );

  test(
    "renewal claims and stale renewal fences survive the cutover",
    async () => {
      await withSchema(
        () => true,
        async (admin) => {
          const claim = await admin.query(
            "SELECT * FROM claim_hns_root_health_renewal_job_v1('renewal-executor',60)",
          );
          expect(claim.rows).toHaveLength(0);
          const finalized = await admin.query<{ outcome: string }>(
            `SELECT * FROM finalize_hns_root_health_renewal_job_v1(
           $1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              "missing-renewal",
              "renewal-executor",
              1,
              requestSha,
              "failed",
              null,
              null,
              "no_such_job",
            ],
          );
          expect(finalized.rows[0]?.outcome).toBe("not_found");
        },
      );
    },
    BUDGET_MS,
  );

  test(
    "a stale old-worker readiness delivery is refused without acceptance",
    async () => {
      await withSchema(
        () => true,
        async (admin) => {
          await seedOwners(admin);
          await seedSession(admin, {
            session: "cutover-stale-worker",
            label: "staleworker",
            withLifecycle: true,
          });
          await seedLegacyObservation(admin, {
            job: "legacy-stale-worker",
            session: "cutover-stale-worker",
            state: "leased",
            leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
          });
          const result = readinessResult("cutover-stale-worker");
          const finalized = await admin.query<{ outcome: string }>(
            `SELECT * FROM finalize_hns_root_import_observation_job_v1(
               $1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              "legacy-stale-worker",
              "legacy-executor",
              1,
              requestSha,
              "ready",
              result.bytes,
              result.sha,
              null,
            ],
          );
          expect(finalized.rows[0]?.outcome).not.toBe("ready");
          const session = await admin.query<Record<string, unknown>>(
            `SELECT status, revision, readiness_result_sha256 FROM hns_root_import_sessions
              WHERE root_import_session_id='cutover-stale-worker'`,
          );
          expect(session.rows[0]).toMatchObject({
            status: "observing",
            revision: "3",
            readiness_result_sha256: null,
          });
          const lifecycle = await admin.query<Record<string, unknown>>(
            `SELECT phase, revision, readiness_observed_at FROM hns_root_import_lifecycle
              WHERE root_import_session_id='cutover-stale-worker'`,
          );
          expect(lifecycle.rows[0]).toMatchObject({
            phase: "checking_authority",
            revision: "1",
            readiness_observed_at: null,
          });
          const claim = await admin.query(
            "SELECT * FROM claim_hns_root_import_observation_job_v1('legacy-executor',60)",
          );
          expect(claim.rows).toHaveLength(0);
        },
      );
    },
    BUDGET_MS,
  );

  test(
    "the controlled cutover probe binds attempt, artifact and lease, and refuses a fresh attempt",
    async () => {
      await withSchema(
        () => true,
        async (admin) => {
          const seeded = await admin.query<{ outcome: string }>(
            "SELECT seed_hns_lifecycle_readiness_cutover_probe_v1() AS outcome",
          );
          expect(seeded.rows[0]?.outcome).toBe("seeded");
          const version = "pirate-hns-authority-provisioner-v2";
          const digest = "d".repeat(64);
          const first = await admin.query<{ outcome: string }>(
            "SELECT run_hns_lifecycle_readiness_cutover_probe_v1($1,$2,$3,$4,$5,clock_timestamp()) AS outcome",
            ["probe-executor", "attempt-00000001", version, digest, digest],
          );
          expect(first.rows[0]?.outcome).toBe("ready");
          const identity = await admin.query<Record<string, unknown>>(
            `SELECT attempt_id, bundle_sha256, measured_bundle_sha256, expected_bundle_sha256,
                    executor_id, probe_job_id, lease_fence, probe_outcome, probe_reason,
                    probe_completed_at IS NOT NULL AS completed
               FROM hns_lifecycle_service_identity`,
          );
          expect(identity.rows[0]).toMatchObject({
            attempt_id: "attempt-00000001",
            bundle_sha256: digest,
            measured_bundle_sha256: digest,
            expected_bundle_sha256: digest,
            executor_id: "probe-executor",
            probe_outcome: "ready",
            probe_reason: null,
            completed: true,
          });
          expect(Number(identity.rows[0]?.probe_job_id)).toBeGreaterThan(0);
          expect(Number(identity.rows[0]?.lease_fence)).toBeGreaterThan(0);
          const job = await admin.query<{ state: string; synthetic: boolean }>(
            `SELECT job.state, lifecycle.synthetic
               FROM hns_root_import_lifecycle_jobs AS job
               JOIN hns_root_import_lifecycle AS lifecycle USING(root_import_session_id)
              WHERE job.root_import_session_id='cutover-readiness-probe'
              ORDER BY job.lifecycle_job_id DESC LIMIT 1`,
          );
          expect(job.rows[0]).toMatchObject({ state: "completed" });
          expect(job.rows[0]?.synthetic).toBe(true);

          // Same attempt refreshes; a fresh attempt can never be satisfied by
          // the previous attempt's completion.
          const replay = await admin.query<{ outcome: string }>(
            "SELECT run_hns_lifecycle_readiness_cutover_probe_v1($1,$2,$3,$4,$5,clock_timestamp()) AS outcome",
            ["probe-executor", "attempt-00000001", version, digest, digest],
          );
          expect(replay.rows[0]?.outcome).toBe("replayed");
          const stale = await admin.query<{ outcome: string }>(
            "SELECT run_hns_lifecycle_readiness_cutover_probe_v1($1,$2,$3,$4,$5,clock_timestamp()) AS outcome",
            ["probe-executor", "attempt-00000002", version, digest, digest],
          );
          expect(stale.rows[0]?.outcome).toBe("failed");
          expect(
            (
              await admin.query<{ probe_reason: string }>(
                "SELECT probe_reason FROM hns_lifecycle_service_identity",
              )
            ).rows[0]?.probe_reason,
          ).toBe("attempt_mismatch");

          // The measured artifact must equal the expected deployment digest.
          const measured = await admin.query<{ outcome: string }>(
            "SELECT run_hns_lifecycle_readiness_cutover_probe_v1($1,$2,$3,$4,$5,clock_timestamp()) AS outcome",
            ["probe-executor", "attempt-00000001", version, "e".repeat(64), digest],
          );
          expect(measured.rows[0]?.outcome).toBe("failed");
          expect(
            (
              await admin.query<{ probe_reason: string }>(
                "SELECT probe_reason FROM hns_lifecycle_service_identity",
              )
            ).rows[0]?.probe_reason,
          ).toBe("artifact_mismatch");

          await admin.query(
            "DELETE FROM hns_root_import_lifecycle_jobs WHERE root_import_session_id='cutover-readiness-probe'",
          );
          const absent = await admin.query<{ outcome: string }>(
            "SELECT run_hns_lifecycle_readiness_cutover_probe_v1($1,$2,$3,$4,$5,clock_timestamp()) AS outcome",
            ["probe-executor", "attempt-00000001", version, digest, digest],
          );
          expect(absent.rows[0]?.outcome).toBe("probe_absent");
        },
      );
    },
    BUDGET_MS,
  );

  test(
    "probe work is isolated, creates no readiness or activation evidence, and survives lease conflicts",
    async () => {
      await withSchema(
        () => true,
        async (admin) => {
          await seedOwners(admin);
          await seedSession(admin, {
            session: "cutover-probe-neighbour",
            label: "neighbour",
            withLifecycle: true,
          });
          await seedLifecycleReadinessJob(admin, {
            session: "cutover-probe-neighbour",
            state: "queued",
          });
          await admin.query("SELECT seed_hns_lifecycle_readiness_cutover_probe_v1()");
          const digest = "f".repeat(64);
          const probe = await admin.query<{ outcome: string }>(
            "SELECT run_hns_lifecycle_readiness_cutover_probe_v1($1,$2,$3,$4,$5,clock_timestamp()) AS outcome",
            [
              "probe-executor",
              "attempt-00000003",
              "pirate-hns-authority-provisioner-v2",
              digest,
              digest,
            ],
          );
          expect(probe.rows[0]?.outcome).toBe("ready");
          // No session, readiness or activation evidence is created.
          const sessions = await admin.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM hns_root_import_sessions WHERE root_import_session_id='cutover-readiness-probe'",
          );
          expect(Number(sessions.rows[0]?.count)).toBe(0);
          const operations = await admin.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM hns_root_import_activation_operations",
          );
          expect(Number(operations.rows[0]?.count)).toBe(0);
          // The normal claim takes only the real operation, never the probe.
          const claimed = await admin.query<{ root_import_session_id: string }>(
            "SELECT * FROM claim_hns_root_import_lifecycle_job_v1('normal-executor',60)",
          );
          expect(claimed.rows[0]?.root_import_session_id).toBe("cutover-probe-neighbour");
          const none = await admin.query(
            "SELECT * FROM claim_hns_root_import_lifecycle_job_v1('normal-executor',60)",
          );
          expect(none.rows).toHaveLength(0);
          // A live foreign lease on the probe is a named conflict; an expired
          // lease is recovered by the next attempt.
          await admin.query("SELECT seed_hns_lifecycle_readiness_cutover_probe_v1()");
          await admin.query(
            `UPDATE hns_root_import_lifecycle_jobs
                SET state='leased', leased_by='other-executor', lease_fence=3,
                    lease_expires_at=clock_timestamp() + interval '10 minutes',
                    updated_at=clock_timestamp()
              WHERE root_import_session_id='cutover-readiness-probe' AND state='queued'`,
          );
          const conflict = await admin.query<{ outcome: string }>(
            "SELECT run_hns_lifecycle_readiness_cutover_probe_v1($1,$2,$3,$4,$5,clock_timestamp()) AS outcome",
            [
              "probe-executor",
              "attempt-00000004",
              "pirate-hns-authority-provisioner-v2",
              digest,
              digest,
            ],
          );
          expect(conflict.rows[0]?.outcome).toBe("lease_conflict");
          await admin.query(
            `UPDATE hns_root_import_lifecycle_jobs
                SET lease_expires_at=clock_timestamp() - interval '1 second'
              WHERE root_import_session_id='cutover-readiness-probe'`,
          );
          const recovered = await admin.query<{ outcome: string }>(
            "SELECT run_hns_lifecycle_readiness_cutover_probe_v1($1,$2,$3,$4,$5,clock_timestamp()) AS outcome",
            [
              "probe-executor",
              "attempt-00000004",
              "pirate-hns-authority-provisioner-v2",
              digest,
              digest,
            ],
          );
          expect(recovered.rows[0]?.outcome).toBe("ready");
        },
      );
    },
    BUDGET_MS,
  );

  test(
    "the migration revokes inherited identity writes in deployment order and the probe stays executable",
    async () => {
      await withSchema(
        (version) => version < "0171",
        async (admin) => {
          const schema = await currentSchema(admin);
          const suffix = randomUUID().replaceAll("-", "");
          const denied = `hns_probe_denied_${suffix}`;
          const digest = "9".repeat(64);
          await admin.query("BEGIN");
          try {
            // The supported deployment order: the runtime role and the broad
            // default privileges exist before 0171 creates the identity table.
            await admin.query("CREATE ROLE api_next_app NOLOGIN");
            await admin.query(`CREATE ROLE ${denied} NOLOGIN`);
            await admin.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO api_next_app, ${denied}`);
            await admin.query(
              `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quote(schema)} TO api_next_app`,
            );
            await admin.query(
              `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO api_next_app`,
            );
            await applyMigration(admin, "0171");
            const inherited = await admin.query<Record<string, boolean>>(
              `SELECT has_table_privilege('api_next_app','hns_lifecycle_service_identity','INSERT') AS i,
                      has_table_privilege('api_next_app','hns_lifecycle_service_identity','UPDATE') AS u`,
            );
            expect(inherited.rows[0]).toEqual({ i: true, u: true });

            await applyMigration(admin, "0172");
            const revoked = await admin.query<Record<string, boolean>>(
              `SELECT has_table_privilege('api_next_app','hns_lifecycle_service_identity','SELECT') AS s,
                      has_table_privilege('api_next_app','hns_lifecycle_service_identity','INSERT') AS i,
                      has_table_privilege('api_next_app','hns_lifecycle_service_identity','UPDATE') AS u,
                      has_table_privilege('api_next_app','hns_lifecycle_service_identity','DELETE') AS d`,
            );
            expect(revoked.rows[0]).toEqual({ s: false, i: false, u: false, d: false });
            const obsolete = await admin.query<{ present: boolean }>(
              "SELECT to_regprocedure('run_hns_lifecycle_readiness_cutover_probe_v1(text,text,text)') IS NOT NULL AS present",
            );
            expect(obsolete.rows[0]?.present).toBe(false);
            const current = await admin.query<{ present: boolean }>(
              "SELECT to_regprocedure('run_hns_lifecycle_readiness_cutover_probe_v1(text,text,text,text,text,timestamptz)') IS NOT NULL AS present",
            );
            expect(current.rows[0]?.present).toBe(true);

            await admin.query("SELECT seed_hns_lifecycle_readiness_cutover_probe_v1()");
            // Authorized executor: direct identity mutation is refused while
            // the granted probe function succeeds through the definer.
            await admin.query("SAVEPOINT denied_identity_write");
            await admin.query("SET LOCAL ROLE api_next_app");
            await expect(
              admin.query(
                "UPDATE hns_lifecycle_service_identity SET probe_reason='tampered' WHERE service_name='pirate-hns-authority-provisioner'",
              ),
            ).rejects.toMatchObject({ code: "42501" });
            await admin.query("ROLLBACK TO SAVEPOINT denied_identity_write");
            await admin.query("SET LOCAL ROLE api_next_app");
            const authorized = await admin.query<{ outcome: string }>(
              "SELECT run_hns_lifecycle_readiness_cutover_probe_v1($1,$2,$3,$4,$5,clock_timestamp()) AS outcome",
              [
                "probe-executor",
                "attempt-00000009",
                "pirate-hns-authority-provisioner-v2",
                digest,
                digest,
              ],
            );
            expect(authorized.rows[0]?.outcome).toBe("ready");
            await admin.query("RESET ROLE");

            // An unauthorized role without the EXECUTE grant is refused.
            await admin.query("SAVEPOINT denied_probe_execute");
            await admin.query(`SET LOCAL ROLE ${denied}`);
            await expect(
              admin.query(
                "SELECT run_hns_lifecycle_readiness_cutover_probe_v1($1,$2,$3,$4,$5,clock_timestamp()) AS outcome",
                [
                  "probe-executor",
                  "attempt-00000010",
                  "pirate-hns-authority-provisioner-v2",
                  digest,
                  digest,
                ],
              ),
            ).rejects.toMatchObject({ code: "42501" });
            await admin.query("ROLLBACK TO SAVEPOINT denied_probe_execute");
            await admin.query("RESET ROLE");
          } finally {
            await admin.query("ROLLBACK");
          }
        },
      );
    },
    BUDGET_MS,
  );

  test(
    "the role template applied after migrations produces the same identity and probe contract",
    async () => {
      await withSchema(
        () => true,
        async (admin) => {
          const schema = await currentSchema(admin);
          const existing = await admin.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_roles WHERE rolname IN ('api_next_app','api_next_operator')",
          );
          expect(existing.rows[0]?.count).toBe("0");
          const template = await Bun.file(
            new URL("../../../db/postgres/roles.sql.example", import.meta.url),
          ).text();
          await admin.query("BEGIN");
          try {
            await admin.query(`SET LOCAL search_path TO ${quote(schema)}, public`);
            await admin.query(template);
            const acl = await admin.query<Record<string, boolean>>(
              `SELECT has_table_privilege('api_next_app','hns_lifecycle_service_identity','SELECT') AS s,
                      has_table_privilege('api_next_app','hns_lifecycle_service_identity','INSERT') AS i,
                      has_table_privilege('api_next_app','hns_lifecycle_service_identity','UPDATE') AS u,
                      has_table_privilege('api_next_app','hns_lifecycle_service_identity','DELETE') AS d`,
            );
            expect(acl.rows[0]).toEqual({ s: false, i: false, u: false, d: false });
            expect(template).toContain(
              "REVOKE ALL ON hns_lifecycle_service_identity FROM api_next_app",
            );
            const execute = await admin.query<{ allowed: boolean }>(
              "SELECT has_function_privilege('api_next_app','run_hns_lifecycle_readiness_cutover_probe_v1(text,text,text,text,text,timestamptz)','EXECUTE') AS allowed",
            );
            expect(execute.rows[0]?.allowed).toBe(true);
            const obsolete = await admin.query<{ present: boolean }>(
              "SELECT to_regprocedure('run_hns_lifecycle_readiness_cutover_probe_v1(text,text,text)') IS NOT NULL AS present",
            );
            expect(obsolete.rows[0]?.present).toBe(false);
          } finally {
            await admin.query("ROLLBACK");
          }
        },
      );
    },
    BUDGET_MS,
  );

  test(
    "the schema compatibility contract refuses an old bundle and admits restart",
    async () => {
      await withSchema(
        () => true,
        async (admin) => {
          const compatible = await admin.query<{ compatibility: string }>(
            "SELECT hns_lifecycle_schema_compatibility_v1($1,$2) AS compatibility",
            ["pirate-hns-authority-provisioner-v2", "hns-lifecycle-job-envelope-v1"],
          );
          expect(compatible.rows[0]?.compatibility).toBe("compatible");
          const restarted = await admin.query<{ compatibility: string }>(
            "SELECT hns_lifecycle_schema_compatibility_v1($1,$2) AS compatibility",
            ["pirate-hns-authority-provisioner-v2", "hns-lifecycle-job-envelope-v1"],
          );
          expect(restarted.rows[0]?.compatibility).toBe("compatible");
          await expect(
            admin.query("SELECT hns_lifecycle_schema_compatibility_v1($1,$2)", [
              "pirate-hns-authority-provisioner-v1",
              "hns-lifecycle-job-envelope-v1",
            ]),
          ).rejects.toThrow(/hns_lifecycle_schema_incompatible/);
          await expect(
            admin.query("SELECT hns_lifecycle_schema_compatibility_v1($1,$2)", [
              "pirate-hns-authority-provisioner-v2",
              "hns-lifecycle-job-envelope-v0",
            ]),
          ).rejects.toThrow(/hns_lifecycle_schema_incompatible/);
        },
      );
    },
    BUDGET_MS,
  );
});
