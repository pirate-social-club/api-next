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
  /** SQL interval expressions, for a passed expiry or an exhausted deadline. */
  readonly sessionExpiresAt?: string;
  readonly sessionCreatedAt?: string;
  readonly firstCurrentAt?: string;
  readonly finalityDeadlineAt?: string;
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
       community_id, attachment_intent_id, origin_kind, created_at, expires_at
     ) VALUES (
       $1,$2,
       'namespace-' || $1,1,1,$3,$4,'observing',3,
       'start-' || $1,$5,'provision-' || $1,
       'namespace_ownership',$5,'idem-' || $1,$5,
       $6,$7,$5,
       'observation-' || $1,'obs-idem-' || $1,$5,
       $8,'attachment-' || $1,'community_attachment',
       ${options.sessionCreatedAt ?? "clock_timestamp()"},
       ${options.sessionExpiresAt ?? "clock_timestamp() + interval '30 days'"}
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
         CASE WHEN $4 THEN ${options.firstCurrentAt ?? "clock_timestamp() - interval '1 hour'"} END,
         CASE WHEN $4 THEN ${options.finalityDeadlineAt ?? "clock_timestamp() + interval '23 hours'"} END,
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
        // Every new outcome is gated, not only the readiness acceptance: a
        // post-handover retry or failure would mutate the session too.
        for (const outcome of ["retry", "failed"]) {
          const refused = await admin.query<Record<string, unknown>>(
            "SELECT * FROM finalize_hns_root_import_observation_job_v1($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              "finalize-legacy-job",
              "legacy-executor",
              Number(job?.lease_fence),
              planSha,
              outcome,
              null,
              null,
              "carrier_failure",
            ],
          );
          expect(refused.rows[0]?.outcome).toBe("ownership_conflict");
        }
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
    "a claim in flight blocks the handover and is then seen as a live lease",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "race-session",
          rootLabel: "raceroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        await admin.query(
          `INSERT INTO hns_root_import_observation_jobs
             (observation_job_id, root_import_session_id, operation_kind, request_bytes,
              request_sha256, state)
           VALUES ('race-legacy-job','race-session','observe_root_v1','{}'::bytea,
             encode(sha256('{}'::bytea),'hex'),'queued')`,
        );
        const schema = (
          await admin.query<{ readonly schema: string }>("SELECT current_schema() AS schema")
        ).rows[0]?.schema;
        if (schema === undefined) throw new Error("schema was not established");

        const legacyClaimer = new Client({ connectionString });
        await legacyClaimer.connect();
        try {
          await legacyClaimer.query(`SET search_path TO ${quote(schema)}`);
          await legacyClaimer.query("BEGIN");
          const claimed = await legacyClaimer.query<Record<string, unknown>>(
            "SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)",
            ["race-executor", 60],
          );
          expect(claimed.rows).toHaveLength(1);
          const handover = admin.query<Record<string, unknown>>(
            "SELECT * FROM begin_hns_root_import_readiness_ownership_v1($1)",
            ["race-receipt"],
          );
          // The claim holds the marker share lock; the handover's FOR UPDATE
          // cannot pass it, so the lease check cannot miss an in-flight claim.
          const settled = await Promise.race([
            handover.then(() => "settled" as const),
            new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 500)),
          ]);
          expect(settled).toBe("blocked");
          await legacyClaimer.query("COMMIT");
          const refused = await handover;
          expect(refused.rows[0]?.outcome).toBe("live_lease_present");
        } finally {
          await legacyClaimer.end().catch(() => undefined);
        }
        await admin.query(
          `UPDATE hns_root_import_observation_jobs
              SET state='failed', leased_by=NULL, lease_expires_at=NULL,
                  failure_code='test_cleanup', completed_at=clock_timestamp(),
                  updated_at=clock_timestamp()
            WHERE observation_job_id='race-legacy-job'`,
        );

        // The lifecycle claim serializes on the same marker row.
        await queueJob(admin, "race-session", "observe_current");
        const lifecycleClaimer = new Client({ connectionString });
        await lifecycleClaimer.connect();
        try {
          await lifecycleClaimer.query(`SET search_path TO ${quote(schema)}`);
          await lifecycleClaimer.query("BEGIN");
          const claimed = await lifecycleClaimer.query<Record<string, unknown>>(
            "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
            ["race-lifecycle-executor", 60],
          );
          expect(claimed.rows).toHaveLength(1);
          const handover = admin.query<Record<string, unknown>>(
            "SELECT * FROM begin_hns_root_import_readiness_ownership_v1($1)",
            ["race-receipt-2"],
          );
          const settled = await Promise.race([
            handover.then(() => "settled" as const),
            new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 500)),
          ]);
          expect(settled).toBe("blocked");
          await lifecycleClaimer.query("COMMIT");
          const refused = await handover;
          expect(refused.rows[0]?.outcome).toBe("live_lease_present");
        } finally {
          await lifecycleClaimer.end().catch(() => undefined);
        }
      });
    },
    BUDGET_MS,
  );

  test(
    "a stale-ready operation refreshes readiness in place",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "refresh-session",
          rootLabel: "refreshroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        const staleBytes = Buffer.from('{"stale":true}');
        await admin.query(
          `UPDATE hns_root_import_sessions
              SET status='ready',
                  readiness_result_bytes=$1,
                  readiness_result_sha256=encode(sha256($1),'hex'),
                  revision=4
            WHERE root_import_session_id='refresh-session'`,
          [staleBytes],
        );
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET phase='ready',
                  readiness_observed_at=clock_timestamp() - interval '2 hours',
                  next_check_at=clock_timestamp() - interval '2 hours'
            WHERE root_import_session_id='refresh-session'`,
        );
        await enableMarker(admin);
        await queueJob(admin, "refresh-session", "observe_readiness");
        const job = await requireClaimLifecycle(admin);
        const before = await admin.query<Record<string, unknown>>(
          `SELECT readiness_observed_at, first_current_observation_at, finality_deadline_at
             FROM hns_root_import_lifecycle WHERE root_import_session_id='refresh-session'`,
        );
        const firstResult = readinessResult("refresh-session");
        const accepted = await commitReadiness(admin, {
          session: "refresh-session",
          job,
          revision: 1,
          result: firstResult,
        });
        expect(accepted.row?.outcome).toBe("ready");
        const after = await admin.query<Record<string, unknown>>(
          `SELECT phase, revision, readiness_observed_at, first_current_observation_at,
                  finality_deadline_at
             FROM hns_root_import_lifecycle WHERE root_import_session_id='refresh-session'`,
        );
        const afterRow = after.rows[0];
        const beforeRow = before.rows[0];
        if (afterRow === undefined || beforeRow === undefined) {
          throw new Error("readiness timestamps were not read");
        }
        expect(afterRow.phase).toBe("ready");
        expect(afterRow.revision).toBe("2");
        expect((afterRow.readiness_observed_at as Date).getTime()).toBeGreaterThan(
          (beforeRow.readiness_observed_at as Date).getTime(),
        );
        // The refresh moves readiness evidence only: the publication and
        // finality anchors are untouched.
        expect(afterRow.first_current_observation_at).toEqual(
          beforeRow.first_current_observation_at,
        );
        expect(afterRow.finality_deadline_at).toEqual(beforeRow.finality_deadline_at);
        const session = await admin.query<Record<string, unknown>>(
          `SELECT status, revision, readiness_result_sha256 FROM hns_root_import_sessions
            WHERE root_import_session_id='refresh-session'`,
        );
        expect(session.rows[0]).toMatchObject({ status: "ready", revision: "5" });
        expect(session.rows[0]?.readiness_result_sha256).toBe(accepted.sha);
        const completed = await admin.query<Record<string, unknown>>(
          "SELECT state FROM hns_root_import_lifecycle_jobs WHERE lifecycle_job_id=$1",
          [job.lifecycle_job_id],
        );
        expect(completed.rows[0]?.state).toBe("completed");

        // Re-delivering the identical job, fence and digest is a replay: the
        // completed job's event already exists, so nothing moves.
        const replayed = await commitReadiness(admin, {
          session: "refresh-session",
          job,
          revision: 1,
          result: firstResult,
        });
        expect(replayed.row?.outcome).toBe("replayed");
        expect(replayed.row?.readiness_result_sha256).toBe(accepted.sha);
        const afterReplay = await admin.query<Record<string, unknown>>(
          `SELECT revision, readiness_observed_at FROM hns_root_import_lifecycle
            WHERE root_import_session_id='refresh-session'`,
        );
        const replayRow = afterReplay.rows[0];
        if (replayRow === undefined) throw new Error("replay state was not read");
        expect(replayRow.revision).toBe("2");
        expect((replayRow.readiness_observed_at as Date).getTime()).toBe(
          (afterRow.readiness_observed_at as Date).getTime(),
        );
        const replaySession = await admin.query<Record<string, unknown>>(
          `SELECT revision FROM hns_root_import_sessions
            WHERE root_import_session_id='refresh-session'`,
        );
        expect(replaySession.rows[0]?.revision).toBe("5");

        // A second refresh with a different reading is a new accepted
        // decision, not a replay of the first.
        await queueJob(admin, "refresh-session", "observe_readiness");
        const nextJob = await requireClaimLifecycle(admin);
        const second = await commitReadiness(admin, {
          session: "refresh-session",
          job: nextJob,
          revision: 2,
          result: readinessResult("refresh-session", {
            observed_at: new Date(Date.now() - 1_000).toISOString(),
          }),
        });
        expect(second.row?.outcome).toBe("ready");
        expect(second.row?.readiness_result_sha256).not.toBe(accepted.sha);
      });
    },
    BUDGET_MS,
  );

  test(
    "handover queues a refresh for a stale-ready operation",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "stale-ready-session",
          rootLabel: "stalereadyroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        await admin.query(
          `UPDATE hns_root_import_sessions
              SET status='ready',
                  readiness_result_bytes='{"stale":true}'::bytea,
                  readiness_result_sha256=encode(sha256('{"stale":true}'::bytea),'hex'),
                  revision=4
            WHERE root_import_session_id='stale-ready-session'`,
        );
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET phase='ready',
                  readiness_observed_at=clock_timestamp() - interval '2 hours',
                  next_check_at=clock_timestamp() - interval '2 hours'
            WHERE root_import_session_id='stale-ready-session'`,
        );
        const handover = await admin.query<Record<string, unknown>>(
          "SELECT * FROM begin_hns_root_import_readiness_ownership_v1($1)",
          ["stale-ready-receipt"],
        );
        expect(handover.rows[0]).toMatchObject({ outcome: "enabled", queued_jobs: "1" });
        const queued = await admin.query<Record<string, unknown>>(
          `SELECT state, generation FROM hns_root_import_lifecycle_jobs
            WHERE root_import_session_id='stale-ready-session' AND job_kind='observe_readiness'`,
        );
        expect(queued.rows).toHaveLength(1);
        expect(queued.rows[0]).toMatchObject({ state: "queued", generation: "1" });
        // A fresh-ready operation is not queued a second time.
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET readiness_observed_at = clock_timestamp()
            WHERE root_import_session_id='stale-ready-session'`,
        );
        await seedOperation(admin, {
          session: "fresh-ready-session",
          rootLabel: "freshreadyroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        await admin.query(
          `UPDATE hns_root_import_sessions
              SET status='ready',
                  readiness_result_bytes='{}'::bytea,
                  readiness_result_sha256=encode(sha256('{}'::bytea),'hex'),
                  revision=4
            WHERE root_import_session_id='fresh-ready-session'`,
        );
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET phase='ready', readiness_observed_at=clock_timestamp()
            WHERE root_import_session_id='fresh-ready-session'`,
        );
        const again = await admin.query<Record<string, unknown>>(
          "SELECT * FROM begin_hns_root_import_readiness_ownership_v1($1)",
          ["stale-ready-receipt-2"],
        );
        expect(again.rows[0]).toMatchObject({ outcome: "already_enabled", queued_jobs: "0" });
        const freshQueued = await admin.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count FROM hns_root_import_lifecycle_jobs
            WHERE root_import_session_id='fresh-ready-session' AND job_kind='observe_readiness'`,
        );
        expect(freshQueued.rows[0]?.count).toBe("0");
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

  test(
    "the lifecycle activation gate accepts fresh readiness and current evidence",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "activate-session",
          rootLabel: "activateroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        const readinessBytes = Buffer.from('{"ready":true}');
        const readinessSha = createHash("sha256").update(readinessBytes).digest("hex");
        await admin.query(
          `UPDATE hns_root_import_sessions
              SET status='ready', readiness_result_bytes=$1,
                  readiness_result_sha256=$2, revision=4
            WHERE root_import_session_id='activate-session'`,
          [readinessBytes, readinessSha],
        );
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET phase='ready', readiness_observed_at=clock_timestamp() - interval '60 seconds'
            WHERE root_import_session_id='activate-session'`,
        );
        const baseEvidence = {
          observedAt: new Date(Date.now() - 5_000).toISOString(),
          resourceSha: planEncodedSha,
          qualifying: true,
          lifecycleRevision: 1,
          generation: 1,
        };
        const call = (
          overrides: Partial<{
            evidence: typeof baseEvidence;
            expectedSessionRevision: number;
            planSha: string;
            readinessSha: string;
            identity: string;
          }> = {},
        ) => {
          const evidence = overrides.evidence ?? baseEvidence;
          return admin.query<Record<string, unknown>>(
            `SELECT * FROM commit_hns_root_import_activation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              "activate-session",
              overrides.expectedSessionRevision ?? 4,
              evidence.lifecycleRevision,
              evidence.generation,
              overrides.planSha ?? planSha,
              overrides.readinessSha ?? readinessSha,
              overrides.identity ?? "activation-test-1",
              evidence.observedAt,
              evidence.resourceSha,
              evidence.qualifying,
            ],
          );
        };

        // Refusals change nothing.
        expect(
          (await call({ evidence: { ...baseEvidence, lifecycleRevision: 9 } })).rows[0]?.outcome,
        ).toBe("revision_conflict");
        expect(
          (await call({ evidence: { ...baseEvidence, generation: 2 } })).rows[0]?.outcome,
        ).toBe("generation_conflict");
        expect((await call({ planSha: "d".repeat(64) })).rows[0]?.outcome).toBe("plan_conflict");
        expect((await call({ readinessSha: "e".repeat(64) })).rows[0]?.outcome).toBe(
          "readiness_conflict",
        );
        await expect(call({ identity: "" })).rejects.toThrow(
          /invalid HNS lifecycle activation input/u,
        );
        expect(
          (await call({ evidence: { ...baseEvidence, qualifying: false } })).rows[0]?.outcome,
        ).toBe("current_conflict");
        expect(
          (
            await call({
              evidence: {
                ...baseEvidence,
                observedAt: new Date(Date.now() - 7_200_000).toISOString(),
              },
            })
          ).rows[0]?.outcome,
        ).toBe("current_stale");
        // The observed wire digest must be the operation's generation-bound
        // encoded-resource digest, not merely a well-formed hash.
        expect(
          (await call({ evidence: { ...baseEvidence, resourceSha: "d".repeat(64) } })).rows[0]
            ?.outcome,
        ).toBe("current_conflict");
        const before = await admin.query<Record<string, unknown>>(
          `SELECT phase, revision FROM hns_root_import_lifecycle
            WHERE root_import_session_id='activate-session'`,
        );
        expect(before.rows[0]).toMatchObject({ phase: "ready", revision: "1" });

        // Freshness of the accepted readiness evidence is the database clock's.
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET readiness_observed_at=clock_timestamp() - interval '2 hours'
            WHERE root_import_session_id='activate-session'`,
        );
        expect((await call()).rows[0]?.outcome).toBe("readiness_stale");
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET readiness_observed_at=clock_timestamp() - interval '60 seconds'
            WHERE root_import_session_id='activate-session'`,
        );

        // The accepted activation commits the lifecycle decision; the session
        // update is the repository's, in the same transaction.
        const accepted = await call();
        expect(accepted.rows[0]).toMatchObject({ outcome: "activated", revision: "2" });
        // Successful activation schedules the policy's initial retention
        // review in the same decision.
        const reviewJob = await admin.query<Record<string, unknown>>(
          `SELECT job_kind, state FROM hns_root_import_lifecycle_jobs
            WHERE root_import_session_id='activate-session' AND job_kind='retention_review'`,
        );
        expect(reviewJob.rows).toHaveLength(1);
        expect(reviewJob.rows[0]).toMatchObject({ state: "queued" });
        const after = await admin.query<Record<string, unknown>>(
          `SELECT phase, revision FROM hns_root_import_lifecycle
            WHERE root_import_session_id='activate-session'`,
        );
        expect(after.rows[0]).toMatchObject({ phase: "activated", revision: "2" });
        const session = await admin.query<Record<string, unknown>>(
          `SELECT status, revision FROM hns_root_import_sessions
            WHERE root_import_session_id='activate-session'`,
        );
        expect(session.rows[0]).toMatchObject({ status: "ready", revision: "4" });
        const history = await admin.query<Record<string, unknown>>(
          `SELECT outcome, lifecycle_job_id, lease_fence, generation
             FROM hns_root_import_lifecycle_history
            WHERE root_import_session_id='activate-session' AND event_name='activation_requested'`,
        );
        expect(history.rows).toHaveLength(1);
        expect(history.rows[0]).toMatchObject({
          outcome: "transition",
          lifecycle_job_id: null,
          lease_fence: null,
          generation: "1",
        });

        // A re-delivered activation identity replays and changes nothing.
        const replayed = await call();
        expect(replayed.rows[0]).toMatchObject({ outcome: "replayed", revision: "2" });
        const afterReplay = await admin.query<Record<string, unknown>>(
          `SELECT phase, revision FROM hns_root_import_lifecycle
            WHERE root_import_session_id='activate-session'`,
        );
        expect(afterReplay.rows[0]).toMatchObject({ phase: "activated", revision: "2" });
      });
    },
    BUDGET_MS,
  );

  test(
    "the lifecycle activation gate refuses a missing current-view binding and is absent for legacy sessions",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "old-session",
          rootLabel: "oldroot",
          withLifecycle: false,
        });
        const legacy = await admin.query<Record<string, unknown>>(
          `SELECT * FROM commit_hns_root_import_activation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            "old-session",
            3,
            null,
            null,
            planSha,
            "a".repeat(64),
            "legacy-activation",
            null,
            null,
            null,
          ],
        );
        expect(legacy.rows[0]).toMatchObject({ outcome: "lifecycle_absent", revision: null });

        await seedOperation(admin, {
          session: "unbound-session",
          rootLabel: "unboundroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        const readinessBytes = Buffer.from('{"ready":true}');
        const readinessSha = createHash("sha256").update(readinessBytes).digest("hex");
        await admin.query(
          `UPDATE hns_root_import_sessions
              SET status='ready', readiness_result_bytes=$1,
                  readiness_result_sha256=$2, revision=4
            WHERE root_import_session_id='unbound-session'`,
          [readinessBytes, readinessSha],
        );
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET phase='ready', readiness_observed_at=clock_timestamp() - interval '60 seconds'
            WHERE root_import_session_id='unbound-session'`,
        );
        const unbound = await admin.query<Record<string, unknown>>(
          `SELECT * FROM commit_hns_root_import_activation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            "unbound-session",
            4,
            null,
            null,
            planSha,
            readinessSha,
            "unbound-activation",
            null,
            null,
            null,
          ],
        );
        expect(unbound.rows[0]).toMatchObject({ outcome: "evidence_required", revision: "1" });
        const after = await admin.query<Record<string, unknown>>(
          `SELECT phase FROM hns_root_import_lifecycle WHERE root_import_session_id='unbound-session'`,
        );
        expect(after.rows[0]).toMatchObject({ phase: "ready" });
      });
    },
    BUDGET_MS,
  );

  test(
    "stale activation records one pending refresh and authorization follows the refresh",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "stale-activation-session",
          rootLabel: "staleactivationroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        const readinessBytes = Buffer.from('{"ready":true}');
        const readinessSha = createHash("sha256").update(readinessBytes).digest("hex");
        await admin.query(
          `UPDATE hns_root_import_sessions
              SET status='ready', readiness_result_bytes=$1,
                  readiness_result_sha256=$2, revision=4
            WHERE root_import_session_id='stale-activation-session'`,
          [readinessBytes, readinessSha],
        );
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET phase='ready', readiness_observed_at=clock_timestamp() - interval '2 hours'
            WHERE root_import_session_id='stale-activation-session'`,
        );
        const authorize = (identity: string, lifecycleRevision: number) =>
          admin.query<Record<string, unknown>>(
            `SELECT * FROM authorize_hns_root_import_activation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              "stale-activation-session",
              4,
              lifecycleRevision,
              1,
              planSha,
              readinessSha,
              identity,
              new Date(Date.now() - 5_000).toISOString(),
              planEncodedSha,
              true,
            ],
          );

        const first = await authorize("stale-command-1", 1);
        expect(first.rows[0]).toMatchObject({ outcome: "readiness_pending", revision: "2" });
        const lifecycle = await admin.query<Record<string, unknown>>(
          `SELECT phase, revision, pending_reason FROM hns_root_import_lifecycle
            WHERE root_import_session_id='stale-activation-session'`,
        );
        expect(lifecycle.rows[0]).toMatchObject({
          phase: "ready",
          revision: "2",
          pending_reason: "readiness_evidence_stale",
        });
        const jobs = await admin.query<Record<string, unknown>>(
          `SELECT state FROM hns_root_import_lifecycle_jobs
            WHERE root_import_session_id='stale-activation-session'
              AND job_kind='observe_readiness'`,
        );
        expect(jobs.rows).toHaveLength(1);
        expect(jobs.rows[0]).toMatchObject({ state: "queued" });

        // A second stale command records its identity but schedules no second
        // refresh and does not advance the revision again.
        const second = await authorize("stale-command-2", 2);
        expect(second.rows[0]).toMatchObject({ outcome: "readiness_pending", revision: "2" });
        const stillOne = await admin.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count FROM hns_root_import_lifecycle_jobs
            WHERE root_import_session_id='stale-activation-session'
              AND job_kind='observe_readiness'`,
        );
        expect(stillOne.rows[0]?.count).toBe("1");
        const revisionAfter = await admin.query<Record<string, unknown>>(
          `SELECT revision FROM hns_root_import_lifecycle
            WHERE root_import_session_id='stale-activation-session'`,
        );
        expect(revisionAfter.rows[0]?.revision).toBe("2");

        // After the refresh, authorization returns without writing, and the
        // committing half accepts at the new revision.
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET readiness_observed_at=clock_timestamp() - interval '30 seconds'
            WHERE root_import_session_id='stale-activation-session'`,
        );
        const authorized = await authorize("stale-command-3", 2);
        expect(authorized.rows[0]).toMatchObject({ outcome: "authorized", revision: "2" });
        const committed = await admin.query<Record<string, unknown>>(
          `SELECT * FROM commit_hns_root_import_activation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            "stale-activation-session",
            4,
            2,
            1,
            planSha,
            readinessSha,
            "stale-command-3",
            new Date(Date.now() - 5_000).toISOString(),
            planEncodedSha,
            true,
          ],
        );
        expect(committed.rows[0]).toMatchObject({ outcome: "activated", revision: "3" });
      });
    },
    BUDGET_MS,
  );

  test(
    "the retired session expiry no longer gates readiness or activation",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "expired-session",
          rootLabel: "expiredroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
          // The retired single expiry has passed; the publication and
          // finality windows remain valid.
          sessionCreatedAt: "clock_timestamp() - interval '3 hours'",
          sessionExpiresAt: "clock_timestamp() - interval '2 hours'",
        });
        await enableMarker(admin);
        await queueJob(admin, "expired-session", "observe_readiness");
        const job = await requireClaimLifecycle(admin);
        const readiness = readinessResult("expired-session");
        const accepted = await admin.query<Record<string, unknown>>(
          `SELECT * FROM commit_hns_root_import_readiness_v1($1,$2,$3,$4,$5,$6,$7)`,
          [
            "expired-session",
            job.lifecycle_job_id,
            "lifecycle-executor",
            Number(job.lease_fence),
            1,
            readiness.bytes,
            readiness.sha,
          ],
        );
        expect(accepted.rows[0]?.outcome).toBe("ready");
        const session = await admin.query<Record<string, unknown>>(
          `SELECT status, revision FROM hns_root_import_sessions
            WHERE root_import_session_id='expired-session'`,
        );
        expect(session.rows[0]).toMatchObject({ status: "ready", revision: "4" });
        const lifecycle = await admin.query<Record<string, unknown>>(
          `SELECT phase, revision FROM hns_root_import_lifecycle
            WHERE root_import_session_id='expired-session'`,
        );
        expect(lifecycle.rows[0]).toMatchObject({ phase: "ready", revision: "2" });
        // Activation follows the same clocks: fresh readiness and qualifying
        // current evidence at the current generation.
        const activation = await admin.query<Record<string, unknown>>(
          `SELECT * FROM commit_hns_root_import_activation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            "expired-session",
            4,
            2,
            1,
            planSha,
            readiness.sha,
            "expired-session-activation",
            new Date(Date.now() - 5_000).toISOString(),
            planEncodedSha,
            true,
          ],
        );
        expect(activation.rows[0]).toMatchObject({ outcome: "activated", revision: "3" });
      });
    },
    BUDGET_MS,
  );

  test(
    "a historical finality deadline does not refuse readiness after safe commitment",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        // The safe commitment landed late: the phase is already
        // checking_authority while the finality deadline it left behind is in
        // the past. The finality window is active only in
        // waiting_safe_commitment, so readiness must still be accepted.
        await seedOperation(admin, {
          session: "deadline-session",
          rootLabel: "deadlineroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
          firstCurrentAt: "clock_timestamp() - interval '2 days'",
          finalityDeadlineAt: "clock_timestamp() - interval '1 hour'",
        });
        const before = await admin.query<Record<string, unknown>>(
          `SELECT first_current_observation_at, finality_deadline_at
             FROM hns_root_import_lifecycle WHERE root_import_session_id='deadline-session'`,
        );
        await enableMarker(admin);
        await queueJob(admin, "deadline-session", "observe_readiness");
        const job = await requireClaimLifecycle(admin);
        const readiness = readinessResult("deadline-session");
        const accepted = await admin.query<Record<string, unknown>>(
          `SELECT * FROM commit_hns_root_import_readiness_v1($1,$2,$3,$4,$5,$6,$7)`,
          [
            "deadline-session",
            job.lifecycle_job_id,
            "lifecycle-executor",
            Number(job.lease_fence),
            1,
            readiness.bytes,
            readiness.sha,
          ],
        );
        expect(accepted.rows[0]).toMatchObject({ outcome: "ready", revision: "2" });
        const lifecycle = await admin.query<Record<string, unknown>>(
          `SELECT phase, revision, first_current_observation_at, finality_deadline_at
             FROM hns_root_import_lifecycle WHERE root_import_session_id='deadline-session'`,
        );
        expect(lifecycle.rows[0]).toMatchObject({ phase: "ready", revision: "2" });
        // The historical anchor and deadline are history: the refresh moves
        // readiness only.
        expect(lifecycle.rows[0]?.first_current_observation_at).toEqual(
          before.rows[0]?.first_current_observation_at,
        );
        expect(lifecycle.rows[0]?.finality_deadline_at).toEqual(
          before.rows[0]?.finality_deadline_at,
        );
      });
    },
    BUDGET_MS,
  );

  test(
    "an activation preflight and the effects transaction serialize on the lifecycle lock",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "lock-activation-session",
          rootLabel: "lockactivationroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        const readinessBytes = Buffer.from('{"ready":true}');
        const readinessSha = createHash("sha256").update(readinessBytes).digest("hex");
        await admin.query(
          `UPDATE hns_root_import_sessions
              SET status='ready', readiness_result_bytes=$1,
                  readiness_result_sha256=$2, revision=4
            WHERE root_import_session_id='lock-activation-session'`,
          [readinessBytes, readinessSha],
        );
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET phase='ready', readiness_observed_at=clock_timestamp() - interval '60 seconds'
            WHERE root_import_session_id='lock-activation-session'`,
        );
        const schema = (
          await admin.query<{ readonly schema: string }>("SELECT current_schema() AS schema")
        ).rows[0]?.schema;
        if (schema === undefined) throw new Error("schema was not established");
        const holder = new Client({ connectionString });
        await holder.connect();
        try {
          await holder.query(`SET search_path TO ${quote(schema)}`);
          await holder.query("BEGIN");
          await holder.query(
            `SELECT root_import_session_id FROM hns_root_import_lifecycle
              WHERE root_import_session_id='lock-activation-session' FOR UPDATE`,
          );
          // The preflight locks lifecycle then session; it must wait for the
          // holder's lifecycle lock rather than proceed out of order.
          const preflight = admin.query<Record<string, unknown>>(
            `SELECT * FROM authorize_hns_root_import_activation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              "lock-activation-session",
              4,
              1,
              1,
              planSha,
              readinessSha,
              "lock-identity-b",
              new Date(Date.now() - 5_000).toISOString(),
              planEncodedSha,
              true,
            ],
          );
          const settled = await Promise.race([
            preflight.then(() => "settled" as const),
            new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 500)),
          ]);
          expect(settled).toBe("blocked");
          // The holder runs the activation decision itself, then commits; the
          // preflight then sees the moved phase and changes nothing.
          await holder.query(
            `SELECT * FROM commit_hns_root_import_activation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              "lock-activation-session",
              4,
              1,
              1,
              planSha,
              readinessSha,
              "lock-identity-a",
              new Date(Date.now() - 5_000).toISOString(),
              planEncodedSha,
              true,
            ],
          );
          await holder.query("COMMIT");
          const resolved = await preflight;
          expect(resolved.rows[0]?.outcome).toBe("phase_conflict");
          const history = await admin.query<Record<string, unknown>>(
            `SELECT event_id FROM hns_root_import_lifecycle_history
              WHERE root_import_session_id='lock-activation-session'
                AND event_name='activation_requested'`,
          );
          expect(history.rows).toHaveLength(1);
          expect(history.rows[0]?.event_id).toBe("activation:lock-identity-a");
        } finally {
          await holder.end().catch(() => undefined);
        }
      });
    },
    BUDGET_MS,
  );

  test(
    "a readiness refresh and an activation serialize on the lifecycle lock",
    async () => {
      await withSchema(async (admin) => {
        await seedOwners(admin);
        await seedOperation(admin, {
          session: "lock-readiness-session",
          rootLabel: "lockreadinessroot",
          withLifecycle: true,
          lifecyclePhase: "checking_authority",
        });
        await enableMarker(admin);
        await queueJob(admin, "lock-readiness-session", "observe_readiness");
        const job = await requireClaimLifecycle(admin);
        const readiness = readinessResult("lock-readiness-session");
        const schema = (
          await admin.query<{ readonly schema: string }>("SELECT current_schema() AS schema")
        ).rows[0]?.schema;
        if (schema === undefined) throw new Error("schema was not established");
        const holder = new Client({ connectionString });
        await holder.connect();
        try {
          await holder.query(`SET search_path TO ${quote(schema)}`);
          await holder.query("BEGIN");
          await holder.query(
            `SELECT * FROM commit_hns_root_import_readiness_v1($1,$2,$3,$4,$5,$6,$7)`,
            [
              "lock-readiness-session",
              job.lifecycle_job_id,
              "lifecycle-executor",
              Number(job.lease_fence),
              1,
              readiness.bytes,
              readiness.sha,
            ],
          );
          const lock = admin.query<Record<string, unknown>>(
            `SELECT root_import_session_id FROM hns_root_import_lifecycle
              WHERE root_import_session_id='lock-readiness-session' FOR UPDATE`,
          );
          const settled = await Promise.race([
            lock.then(() => "settled" as const),
            new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 500)),
          ]);
          expect(settled).toBe("blocked");
          await holder.query("COMMIT");
          await lock;
          const lifecycle = await admin.query<Record<string, unknown>>(
            `SELECT phase, revision FROM hns_root_import_lifecycle
              WHERE root_import_session_id='lock-readiness-session'`,
          );
          expect(lifecycle.rows[0]).toMatchObject({ phase: "ready", revision: "2" });
        } finally {
          await holder.end().catch(() => undefined);
        }
      });
    },
    BUDGET_MS,
  );
});
