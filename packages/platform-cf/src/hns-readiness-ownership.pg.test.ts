import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * Readiness ownership handover and the atomic readiness acceptance.
 *
 * Spec 012, "Execution ownership and readiness handover" (ratified
 * 2026-09-10). The marker is disabled by default; the lifecycle claim leaves
 * readiness queued until it is enabled; the legacy claim yields
 * lifecycle-managed readiness only after handover and only for operations the
 * lifecycle now owns; the atomic writer accepts a result only under the
 * enabled marker, the claimed job's fence, the current generation, the
 * checking-authority phase and a fresh, plan-bound result; and the handover
 * transaction disposes obsolete rows, queues missing work exactly once and
 * refuses while a conflicting lease is live. Every refusal leaves accepted
 * evidence, deadlines and generation unchanged.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

const BUDGET_MS = 180_000;
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const actorId = "readiness-actor";
const communityId = "community_123e4567-e89b-42d3-a456-4266141740bb";
const planEncodedSha = "b".repeat(64);
const planBytes = Buffer.from(
  JSON.stringify({
    version: "pirate-hns-root-import-publish-plan-v1",
    replacement_semantics: "complete_resource",
    current_records: [],
    preserved_records: [],
    removed_conflicts: [],
    added_records: [],
    replacement_records: [],
    preserved_unknown_record_types: [],
    encoded_resource_sha256: planEncodedSha,
    acknowledgement_required: true,
  }),
);
const planSha = createHash("sha256").update(planBytes).digest("hex");

async function withSchema<A>(use: (admin: Client) => Promise<A>): Promise<A> {
  const schema = `hns_readiness_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`SET search_path TO ${quote(schema)}`);
    for (const migration of await loadPostgresMigrations()) await admin.query(migration.sql);
    return await use(admin);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

type SeedOptions = Readonly<{
  readonly session: string;
  readonly rootLabel: string;
  readonly withLifecycle: boolean;
  readonly lifecyclePhase?: "checking_authority" | "checking_publication";
}>;

async function seedOwners(admin: Client): Promise<void> {
  await admin.query("INSERT INTO users (user_id,status,account) VALUES ($1,'active','{}')", [
    actorId,
  ]);
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  await admin.query(
    `INSERT INTO communities (community_id,display_name,status,created_by_user_id,
       canonical_route_binding_id,route_authority_version,created_at,updated_at)
     VALUES ($1,'Readiness','active',$2,NULL,'optional_route_v2',clock_timestamp(),clock_timestamp())`,
    [communityId, actorId],
  );
  await admin.query(
    `INSERT INTO community_route_authority_grants
       (grant_id,community_id,principal_user_id,authority,source_kind,status,granted_at,granted_by_user_id)
     VALUES ('readiness-grant',$1,$2,'manage_routes','creator_owner','active',clock_timestamp(),$2)`,
    [communityId, actorId],
  );
  await admin.query("COMMIT");
}

async function seedOperation(admin: Client, options: SeedOptions): Promise<void> {
  // The session insert guard validates attachment ownership authority; this
  // fixture seeds the row directly, as the projection suite does, so the
  // trigger is bypassed for the seed transaction only.
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
       community_id, attachment_intent_id, origin_kind, expires_at
     ) VALUES (
       $1,$2,
       'namespace-' || $1,1,1,$3,$4,'observing',3,
       'start-' || $1,$5,'provision-' || $1,
       'namespace_ownership',$5,'idem-' || $1,$5,
       $6,$7,$5,
       'observation-' || $1,'obs-idem-' || $1,$5,
       $8,'attachment-' || $1,'community_attachment',
       clock_timestamp() + interval '30 days'
     )`,
    [
      options.session,
      actorId,
      options.rootLabel,
      `pirate-verification=${options.rootLabel}`,
      planSha,
      planBytes,
      planSha,
      communityId,
    ],
  );
  if (options.withLifecycle) {
    const checkingAuthority = options.lifecyclePhase === "checking_authority";
    await admin.query(
      `INSERT INTO hns_root_import_lifecycle (
         root_import_session_id, root_label, phase, revision, generation,
         plan_exposed_at, publication_deadline_at,
         first_current_observation_at, finality_deadline_at,
         policy_name, policy_digest, plan_encoded_resource_sha256
       ) VALUES ($1,$2,$3,1,1,
         clock_timestamp() - interval '1 day', clock_timestamp() + interval '13 days',
         CASE WHEN $4 THEN clock_timestamp() - interval '1 hour' END,
         CASE WHEN $4 THEN clock_timestamp() + interval '23 hours' END,
         'hns_root_import_lifecycle_v1','readiness',$5)`,
      [
        options.session,
        options.rootLabel,
        checkingAuthority ? "checking_authority" : "checking_publication",
        checkingAuthority,
        planEncodedSha,
      ],
    );
  }
  await admin.query("COMMIT");
}

async function enableMarker(admin: Client, evidenceRef = "handover-receipt"): Promise<void> {
  await admin.query(
    `UPDATE hns_root_import_execution_ownership
        SET enabled = TRUE, enabled_at = clock_timestamp(), evidence_ref = $1,
            updated_at = clock_timestamp()
      WHERE responsibility = 'readiness'`,
    [evidenceRef],
  );
}

async function queueJob(
  admin: Client,
  session: string,
  kind: "observe_readiness" | "observe_current" | "schedule_activation_window",
): Promise<void> {
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
       VALUES ($1,$2,clock_timestamp() - interval '1 second')`,
    [session, kind],
  );
}

async function claimLifecycle(admin: Client, executorId = "lifecycle-executor") {
  const claimed = await admin.query<Record<string, unknown>>(
    "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
    [executorId, 60],
  );
  return claimed.rows[0];
}

async function claimLegacy(admin: Client, executorId = "legacy-executor") {
  const claimed = await admin.query<Record<string, unknown>>(
    "SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)",
    [executorId, 60],
  );
  return claimed.rows[0];
}

async function requireClaimLifecycle(admin: Client, executorId = "lifecycle-executor") {
  const job = await claimLifecycle(admin, executorId);
  if (job === undefined) throw new Error("no lifecycle job was claimable");
  return job;
}

async function requireClaimLegacy(admin: Client, executorId = "legacy-executor") {
  const job = await claimLegacy(admin, executorId);
  if (job === undefined) throw new Error("no legacy job was claimable");
  return job;
}

function readinessResult(session: string, overrides: Record<string, unknown> = {}) {
  const bytes = Buffer.from(
    JSON.stringify({
      version: "pirate-hns-root-import-readiness-result-v1",
      root_import_session_id: session,
      publish_plan_sha256: planSha,
      observed_at: new Date(Date.now() - 5_000).toISOString(),
      valid_until: new Date(Date.now() + 3_600_000).toISOString(),
      ...overrides,
    }),
  );
  return { bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

async function commitReadiness(
  admin: Client,
  input: {
    readonly session: string;
    readonly job: Record<string, unknown>;
    readonly revision?: number;
    readonly holder?: string;
    readonly fence?: number;
    readonly result?: { bytes: Buffer; sha: string };
  },
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

async function operationState(admin: Client, session: string) {
  const lifecycle = await admin.query<Record<string, unknown>>(
    `SELECT phase, revision, generation, readiness_observed_at
       FROM hns_root_import_lifecycle WHERE root_import_session_id=$1`,
    [session],
  );
  const legacy = await admin.query<Record<string, unknown>>(
    `SELECT status, revision, readiness_result_sha256
       FROM hns_root_import_sessions WHERE root_import_session_id=$1`,
    [session],
  );
  return { lifecycle: lifecycle.rows[0], session: legacy.rows[0] };
}

suite("HNS readiness ownership and handover on PostgreSQL 17", () => {
  test(
    "the marker is disabled by default and readiness is not claimed",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "readiness-session",
          rootLabel: "readinessroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        const marker = await admin.query<Record<string, unknown>>(
          "SELECT enabled, enabled_at FROM hns_root_import_execution_ownership WHERE responsibility='readiness'",
        );
        expect(marker.rows[0]).toMatchObject({ enabled: false, enabled_at: null });
        await queueJob(admin, "readiness-session", "observe_readiness");
        expect(await claimLifecycle(admin)).toBeUndefined();
        const queued = await admin.query<Record<string, unknown>>(
          "SELECT state FROM hns_root_import_lifecycle_jobs WHERE root_import_session_id=$1",
          ["readiness-session"],
        );
        expect(queued.rows[0]).toMatchObject({ state: "queued" });
      });
    },
    BUDGET_MS,
  );

  test(
    "the atomic writer accepts a fresh, plan-bound result and rejects each boundary",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "accept-session",
          rootLabel: "acceptroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        await enableMarker(admin);
        await queueJob(admin, "accept-session", "observe_readiness");
        const job = await requireClaimLifecycle(admin);

        // Wrong holder and wrong fence change nothing.
        expect(
          (await commitReadiness(admin, { session: "accept-session", job, holder: "another" })).row
            ?.outcome,
        ).toBe("lease_conflict");
        expect(
          (
            await commitReadiness(admin, {
              session: "accept-session",
              job,
              fence: Number(job.lease_fence) + 1,
            })
          ).row?.outcome,
        ).toBe("lease_conflict");
        // Wrong revision and an expired/future result are refused.
        expect(
          (await commitReadiness(admin, { session: "accept-session", job, revision: 9 })).row
            ?.outcome,
        ).toBe("revision_conflict");
        expect(
          (
            await commitReadiness(admin, {
              session: "accept-session",
              job,
              result: readinessResult("accept-session", {
                valid_until: new Date(Date.now() - 1_000).toISOString(),
              }),
            })
          ).row?.outcome,
        ).toBe("invalid_result");
        expect(
          (
            await commitReadiness(admin, {
              session: "accept-session",
              job,
              result: readinessResult("accept-session", {
                observed_at: new Date(Date.now() + 60_000).toISOString(),
              }),
            })
          ).row?.outcome,
        ).toBe("invalid_result");
        expect(
          (
            await commitReadiness(admin, {
              session: "accept-session",
              job,
              result: readinessResult("accept-session", { publish_plan_sha256: "c".repeat(64) }),
            })
          ).row?.outcome,
        ).toBe("invalid_result");
        const before = await operationState(admin, "accept-session");
        expect(before.lifecycle).toMatchObject({ phase: "checking_authority", revision: "1" });
        expect(before.session).toMatchObject({ status: "observing", revision: "3" });

        // The accepted result persists the session readiness, the lifecycle
        // transition and the job completion together.
        const accepted = await commitReadiness(admin, { session: "accept-session", job });
        expect(accepted.row?.outcome).toBe("ready");
        const after = await operationState(admin, "accept-session");
        expect(after.lifecycle).toMatchObject({ phase: "ready", revision: "2" });
        expect(after.session).toMatchObject({ status: "ready", revision: "4" });
        expect(after.lifecycle?.readiness_observed_at).not.toBeNull();
        expect(after.session?.readiness_result_sha256).toBe(accepted.sha);
        const finished = await admin.query<Record<string, unknown>>(
          "SELECT state, failure_code FROM hns_root_import_lifecycle_jobs WHERE lifecycle_job_id=$1",
          [job.lifecycle_job_id],
        );
        expect(finished.rows[0]).toMatchObject({ state: "completed", failure_code: null });
        const history = await admin.query<Record<string, unknown>>(
          `SELECT event_name, outcome, lifecycle_job_id, lease_fence, generation
             FROM hns_root_import_lifecycle_history
            WHERE root_import_session_id=$1 AND event_name='readiness_observed'`,
          ["accept-session"],
        );
        expect(history.rows).toHaveLength(1);
        expect(history.rows[0]).toMatchObject({
          outcome: "transition",
          lifecycle_job_id: String(job.lifecycle_job_id),
          lease_fence: String(job.lease_fence),
          generation: "1",
        });
      });
    },
    BUDGET_MS,
  );

  test(
    "the ownership marker gates the atomic writer",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "gated-session",
          rootLabel: "gatedroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        await enableMarker(admin);
        await queueJob(admin, "gated-session", "observe_readiness");
        const job = await requireClaimLifecycle(admin);
        await admin.query(
          "UPDATE hns_root_import_execution_ownership SET enabled=FALSE, enabled_at=NULL WHERE responsibility='readiness'",
        );
        expect((await commitReadiness(admin, { session: "gated-session", job })).row?.outcome).toBe(
          "ownership_not_enabled",
        );
        const state = await operationState(admin, "gated-session");
        expect(state.lifecycle).toMatchObject({ phase: "checking_authority", revision: "1" });
        expect(state.session).toMatchObject({ status: "observing", readiness_result_sha256: null });
      });
    },
    BUDGET_MS,
  );

  test(
    "the legacy claim yields lifecycle-managed readiness only after handover",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "owned-session",
          rootLabel: "ownedroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        await admin.query(
          `INSERT INTO hns_root_import_observation_jobs
             (observation_job_id, root_import_session_id, operation_kind, request_bytes,
              request_sha256, state)
           VALUES ('owned-legacy-job','owned-session','observe_root_v1','{}'::bytea,
             encode(sha256('{}'::bytea),'hex'),'queued')`,
        );
        const before = await requireClaimLegacy(admin);
        expect(before?.operation_kind).toBe("observe_root_v1");
        // Put the claimed legacy job back so handover disposition sees it.
        await admin.query(
          `UPDATE hns_root_import_observation_jobs SET state='queued', leased_by=NULL,
             lease_expires_at=NULL WHERE observation_job_id='owned-legacy-job'`,
        );
        await seedOperation(admin, {
          session: "free-session",
          rootLabel: "freeroot",
          withLifecycle: false,
        });
        await admin.query(
          `INSERT INTO hns_root_import_observation_jobs
             (observation_job_id, root_import_session_id, operation_kind, request_bytes,
              request_sha256, state)
           VALUES ('free-legacy-job','free-session','observe_root_v1','{}'::bytea,
             encode(sha256('{}'::bytea),'hex'),'queued')`,
        );
        await enableMarker(admin);
        const claimed = await claimLegacy(admin, "legacy-executor-2");
        expect(claimed?.observation_job_id).toBe("free-legacy-job");
      });
    },
    BUDGET_MS,
  );

  test(
    "the legacy finalizer refuses readiness after handover",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "finalize-session",
          rootLabel: "finalizeroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        await admin.query(
          `INSERT INTO hns_root_import_observation_jobs
             (observation_job_id, root_import_session_id, operation_kind, request_bytes,
              request_sha256, state)
           VALUES ('finalize-legacy-job','finalize-session','observe_root_v1','{}'::bytea,
             encode(sha256('{}'::bytea),'hex'),'queued')`,
        );
        const job = await requireClaimLegacy(admin);
        expect(job?.observation_job_id).toBe("finalize-legacy-job");
        await enableMarker(admin);
        const result = readinessResult("finalize-session");
        const finalized = await admin.query<Record<string, unknown>>(
          "SELECT * FROM finalize_hns_root_import_observation_job_v1($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            "finalize-legacy-job",
            "legacy-executor",
            Number(job?.lease_fence),
            planSha,
            "ready",
            result.bytes,
            result.sha,
            null,
          ],
        );
        expect(finalized.rows[0]?.outcome).toBe("ownership_conflict");
        const state = await operationState(admin, "finalize-session");
        expect(state.session).toMatchObject({ status: "observing", readiness_result_sha256: null });
      });
    },
    BUDGET_MS,
  );

  test(
    "handover disposes obsolete rows, queues missing work once, and repeats without change",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "handover-session",
          rootLabel: "handoverroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        await admin.query(
          `INSERT INTO hns_root_import_observation_jobs
             (observation_job_id, root_import_session_id, operation_kind, request_bytes,
              request_sha256, state)
           VALUES ('handover-legacy-job','handover-session','observe_root_v1','{}'::bytea,
             encode(sha256('{}'::bytea),'hex'),'queued')`,
        );
        const first = await admin.query<Record<string, unknown>>(
          "SELECT * FROM begin_hns_root_import_readiness_ownership_v1($1)",
          ["handover-receipt-1"],
        );
        expect(first.rows[0]).toMatchObject({
          outcome: "enabled",
          dispositioned_jobs: "1",
          queued_jobs: "1",
        });
        const disposed = await admin.query<Record<string, unknown>>(
          "SELECT state, failure_code FROM hns_root_import_observation_jobs WHERE observation_job_id='handover-legacy-job'",
        );
        expect(disposed.rows[0]).toMatchObject({
          state: "failed",
          failure_code: "readiness_ownership_transferred",
        });
        const queued = await admin.query<Record<string, unknown>>(
          `SELECT state, generation FROM hns_root_import_lifecycle_jobs
            WHERE root_import_session_id='handover-session' AND job_kind='observe_readiness'`,
        );
        expect(queued.rows).toHaveLength(1);
        expect(queued.rows[0]).toMatchObject({ state: "queued", generation: "1" });

        const second = await admin.query<Record<string, unknown>>(
          "SELECT * FROM begin_hns_root_import_readiness_ownership_v1($1)",
          ["handover-receipt-2"],
        );
        expect(second.rows[0]).toMatchObject({
          outcome: "already_enabled",
          dispositioned_jobs: "0",
          queued_jobs: "0",
        });
        const stillOne = await admin.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count FROM hns_root_import_lifecycle_jobs
            WHERE root_import_session_id='handover-session' AND job_kind='observe_readiness'`,
        );
        expect(stillOne.rows[0]?.count).toBe("1");
      });
    },
    BUDGET_MS,
  );

  test(
    "handover refuses while a conflicting lease is live",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "lease-session",
          rootLabel: "leaseroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        await admin.query(
          `INSERT INTO hns_root_import_observation_jobs
             (observation_job_id, root_import_session_id, operation_kind, request_bytes,
              request_sha256, state)
           VALUES ('live-legacy-job','lease-session','observe_root_v1','{}'::bytea,
             encode(sha256('{}'::bytea),'hex'),'queued')`,
        );
        const job = await requireClaimLegacy(admin);
        expect(job?.observation_job_id).toBe("live-legacy-job");
        const refused = await admin.query<Record<string, unknown>>(
          "SELECT * FROM begin_hns_root_import_readiness_ownership_v1($1)",
          ["handover-receipt"],
        );
        expect(refused.rows[0]?.outcome).toBe("live_lease_present");
        const marker = await admin.query<Record<string, unknown>>(
          "SELECT enabled FROM hns_root_import_execution_ownership WHERE responsibility='readiness'",
        );
        expect(marker.rows[0]).toMatchObject({ enabled: false });
      });
    },
    BUDGET_MS,
  );

  test(
    "schedule_activation_window is retired from the job vocabulary",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "retired-session",
          rootLabel: "retiredroot",
          withLifecycle: true,
          lifecyclePhase: "checking_publication",
        });
        await expect(
          queueJob(admin, "retired-session", "schedule_activation_window"),
        ).rejects.toThrow(/job_kind/u);
      });
    },
    BUDGET_MS,
  );
});
