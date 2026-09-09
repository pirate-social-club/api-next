import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type {
  HnsChainObservationResultV1,
  HnsChainObservationViewV1,
  HnsRootResourceRecordV1,
} from "@pirate/application/namespace-ownership";
import { Client } from "pg";
import { runHnsAuthorityProvisionExecutorOnce } from "../../../apps/hns-authority-provisioner/src/executor.ts";
import { makePostgresHnsRetentionReviewerPorts } from "../../../apps/hns-authority-provisioner/src/lifecycle-queue.ts";
import { makePostgresHnsRootObservationQueue } from "../../../apps/hns-authority-provisioner/src/observation-queue.ts";
import { makePowerDnsRootTeardown } from "../../../apps/hns-authority-provisioner/src/powerdns.ts";
import type { HnsZoneMutationLease } from "../../../apps/hns-authority-provisioner/src/provision-root.ts";
import { runHnsRetentionReviewOnce } from "../../../apps/hns-authority-provisioner/src/retention-reviewer.ts";
import { withHnsRootZoneMutation } from "../../../apps/hns-authority-provisioner/src/zone-mutation.ts";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * The retention reviewer and the teardown it gates, end to end.
 *
 * Nothing could write a retention review before this, so retirement was
 * unreachable and every retained zone, keyset and reservation charged against
 * the admission quota indefinitely. These exercise the composition that makes
 * it reachable and, more importantly, the many ways it must refuse.
 *
 * The DNS authority here is isolated: an in-process server holding zones in a
 * map, so a deletion is a real provider call with a real read-back and no live
 * infrastructure is anywhere near the test. The chain observations are injected
 * because the decision under test is what the reviewer does with evidence, not
 * how the evidence is read — the observer against a live chain is proven by the
 * composed-path and entrypoint suites.
 */

const baseConnectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (
  process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" &&
  baseConnectionString === undefined
) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = baseConnectionString ? describe : describe.skip;

/** One case builds a database and applies every migration; five seconds is not enough. */
const BUDGET_MS = 180_000;

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const shaA = "a".repeat(64);
const FRESHNESS_SECONDS = 1_800;

const authorityRecords: readonly HnsRootResourceRecordV1[] = [
  { type: "NS", ns: "ns1.pirate." },
  { type: "NS", ns: "ns2.pirate." },
] as never;

function observed(
  view: HnsChainObservationViewV1,
  records: readonly HnsRootResourceRecordV1[],
): HnsChainObservationResultV1 {
  return {
    kind: "observed",
    observation: {
      view,
      network: "regtest",
      genesis_block_hash: `${"0".repeat(63)}1`,
      anchor: {
        network: "regtest",
        genesis_block_hash: `${"0".repeat(63)}1`,
        height: 4_242,
        best_block_hash: "bb".repeat(32),
        median_time_past_epoch_seconds: 1_770_000_000,
        header_time_epoch_seconds: 1_770_000_030,
        confirmations: 1,
      },
      tip_height: 4_242,
      update_inclusion_height: 4_200,
      commitment: null,
      observed_at_epoch_ms: Date.now(),
      records,
      resource_sha256: `${"0".repeat(63)}${view === "current" ? "1" : "2"}`,
    },
  };
}

type Fixture = Readonly<{
  readonly session: string;
  readonly label: string;
  readonly challenge: string;
  readonly planBytes: Buffer | null;
}>;

function planDocument(challenge: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: "pirate-hns-root-import-publish-plan-v1",
      encoded_resource_sha256: "1".repeat(64),
      replacement_records: [
        { type: "NS", ns: "ns1.pirate." },
        { type: "NS", ns: "ns2.pirate." },
        { type: "TXT", txt: [challenge] },
      ],
    }),
  );
}

function provisionRequest(fixture: Fixture): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: "pirate-hns-authority-provision-request-v1",
      root_import_session_id: fixture.session,
      namespace_session_id: `namespace-${fixture.session}`,
      root_label: fixture.label,
      challenge_txt_value: fixture.challenge,
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    }),
  );
}

const digestOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

suite("the retention reviewer and the teardown it gates on PostgreSQL 17", () => {
  const state: {
    database: string;
    connectionString: string;
    client: Client;
    zones: Map<string, { account: string }>;
    server: ReturnType<typeof Bun.serve> | null;
    apiUrl: string;
    surviveDelete: Set<string>;
  } = {
    database: "",
    connectionString: "",
    client: null as unknown as Client,
    zones: new Map(),
    server: null,
    apiUrl: "",
    surviveDelete: new Set(),
  };

  beforeAll(async () => {
    if (baseConnectionString === undefined) return;
    state.database = `hns_reviewer_${randomUUID().replaceAll("-", "")}`.slice(0, 60);
    const admin = new Client({ connectionString: baseConnectionString });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quote(state.database)}`);
    await admin.end().catch(() => undefined);
    const url = new URL(baseConnectionString);
    url.pathname = `/${state.database}`;
    state.connectionString = url.toString();
    state.client = new Client({ connectionString: state.connectionString });
    await state.client.connect();
    for (const migration of await loadPostgresMigrations()) await state.client.query(migration.sql);
    await state.client.query("INSERT INTO users (user_id) VALUES ('reviewer-actor')");

    // The isolated DNS authority: zones live in a map, deletion is a real
    // request with a real read-back.
    state.server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        const match = path.match(/\/api\/v1\/servers\/localhost\/zones\/([^/]+)$/u);
        const name = match?.[1] === undefined ? null : decodeURIComponent(match[1]);
        if (name === null) return new Response("not found", { status: 404 });
        if (request.method === "DELETE") {
          if (!state.surviveDelete.has(name)) state.zones.delete(name);
          return new Response(null, { status: 204 });
        }
        const zone = state.zones.get(name);
        if (zone === undefined) {
          return Response.json({ error: "Not Found" }, { status: 404 });
        }
        return Response.json({
          name,
          kind: "Native",
          serial: 1,
          dnssec: true,
          account: zone.account,
          rrsets: [],
        });
      },
    });
    state.apiUrl = `http://127.0.0.1:${state.server.port}`;
  }, BUDGET_MS);

  afterAll(async () => {
    state.server?.stop(true);
    await state.client?.end().catch(() => undefined);
    if (baseConnectionString === undefined || state.database === "") return;
    const cleanup = new Client({ connectionString: baseConnectionString });
    await cleanup.connect().catch(() => undefined);
    await cleanup
      .query(`DROP DATABASE IF EXISTS ${quote(state.database)} WITH (FORCE)`)
      .catch(() => undefined);
    await cleanup.end().catch(() => undefined);
  });

  async function seed(fixture: Fixture): Promise<void> {
    const client = state.client;
    const request = provisionRequest(fixture);
    const requestSha = digestOf(request);
    const planSha = fixture.planBytes === null ? null : digestOf(fixture.planBytes);
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO hns_root_import_sessions (
         root_import_session_id, actor_id, creation_intent_id, ceremony_intent_id,
         namespace_session_id, ownership_generation, ownership_expected_revision,
         root_label, challenge_txt_value, status, revision,
         start_idempotency_key, start_request_sha256, provision_job_id,
         provision_authorization_kind, provision_authorization_sha256,
         provision_idempotency_key, provision_poll_request_sha256,
         publish_plan_bytes, publish_plan_sha256,
         expires_at, created_at
       ) VALUES (
         $1,'reviewer-actor','intent-' || $1,'ceremony-' || $1,
         $2,1,1,$3,$4,'expired',1,
         'start-' || $1,$5,'provision-' || $1,
         'community_provisional',$5,'idem-' || $1,$5,
         $6,$7,
         clock_timestamp() - interval '1 hour', clock_timestamp() - interval '2 hours'
       )`,
      [
        fixture.session,
        `namespace-${fixture.session}`,
        fixture.label,
        fixture.challenge,
        shaA,
        fixture.planBytes,
        planSha,
      ],
    );
    await client.query(
      `INSERT INTO hns_authority_provision_jobs (
         provision_job_id, root_import_session_id, operation_kind,
         request_bytes, request_sha256, state, attempt_count,
         publish_plan_bytes, publish_plan_sha256, result_bytes, result_sha256,
         created_at, updated_at, completed_at
       ) VALUES (
         'provision-' || $1,$1,'provision_root_v1',$2,$3,'completed',1,
         $4,$5,$2,$3,
         clock_timestamp() - interval '3 hours',
         clock_timestamp() - interval '2 hours',
         clock_timestamp() - interval '2 hours'
       )`,
      [fixture.session, request, requestSha, fixture.planBytes, planSha],
    );
    await client.query(
      `INSERT INTO hns_community_root_import_preparations (
         attachment_intent_id, actor_id, community_id, ceremony_intent_id, root_label,
         root_import_session_id, provision_job_id, start_idempotency_key,
         start_request_sha256, admission_kind, expires_at, created_at
       ) VALUES (
         'attach-' || $1,'reviewer-actor','community-' || $1,'ceremony-' || $1,$2,
         $1,'provision-' || $1,'start-' || $1,
         $3,'community_provisional',
         clock_timestamp() - interval '1 hour', clock_timestamp() - interval '2 hours'
       )`,
      [fixture.session, fixture.label, shaA],
    );
    await client.query(
      `INSERT INTO hns_root_import_lifecycle (
         root_import_session_id, root_label, phase, revision, generation,
         pending_reason, policy_name, policy_digest, terminal_decided_at
       ) VALUES ($1,$2,'failed',1,1,NULL,'hns_root_import_lifecycle_v1','reviewer',
         clock_timestamp() - interval '8 days')`,
      [fixture.session, fixture.label],
    );
    await client.query("COMMIT");
    state.zones.set(`${fixture.label}.`, {
      account: createHash("sha256").update(fixture.challenge).digest("hex").slice(0, 40),
    });
  }

  function makeFixture(name: string, withPlan = true): Fixture {
    const challenge = `pirate-verification=${name}`;
    return {
      session: `session-${name}`,
      label: name,
      challenge,
      planBytes: withPlan ? planDocument(challenge) : null,
    };
  }

  async function queueReview(session: string): Promise<void> {
    await state.client.query(
      `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
         VALUES ($1,'retention_review', clock_timestamp() - interval '1 second')`,
      [session],
    );
  }

  /**
   * Teardown claims are global across operations, so exactly one is queued at
   * a time and the runner asserts it claimed the intended one. A test that
   * silently tore down another fixture's authority would prove nothing.
   */
  async function queueTeardown(session: string): Promise<void> {
    await state.client.query(
      `INSERT INTO hns_root_import_teardown_jobs (teardown_job_id, root_import_session_id, state)
         VALUES ('teardown-' || $1, $1, 'waiting')`,
      [session],
    );
  }

  /** Claims the due lifecycle job and runs the reviewer against it. */
  async function review(
    executorId: string,
    chain: (
      rootLabel: string,
      view: HnsChainObservationViewV1,
    ) => Promise<HnsChainObservationResultV1>,
    fenceOffset = 0,
  ): Promise<Readonly<{ outcome: string; reason: string }>> {
    const claimed = await state.client.query<Record<string, unknown>>(
      "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
      [executorId, 60],
    );
    const row = claimed.rows[0];
    if (row === undefined) throw new Error("no due lifecycle job to review");
    const ports = makePostgresHnsRetentionReviewerPorts(
      state.connectionString,
      chain,
      async () => ({
        outcome: "conflict",
      }),
    );
    return runHnsRetentionReviewOnce(
      {
        lifecycle_job_id: String(row.lifecycle_job_id),
        root_import_session_id: String(row.root_import_session_id),
        job_kind: "retention_review",
        lease_fence: Number(row.lease_fence) + fenceOffset,
      },
      executorId,
      ports,
    );
  }

  /** Runs the observation class once, which is where teardown is claimed. */
  async function runTeardown(
    session: string,
    chainRecords: readonly HnsRootResourceRecordV1[] = authorityRecords,
    freshnessSeconds: number = FRESHNESS_SECONDS,
  ): Promise<Readonly<{ outcome: string }>> {
    // A retained teardown returns to `waiting` and stays claimable, so earlier
    // fixtures are parked before this one is queued. Without it a later case
    // would silently claim an earlier operation's job.
    await state.client.query(
      `UPDATE hns_root_import_teardown_jobs
          SET state = 'cancelled', leased_by = NULL, lease_expires_at = NULL,
              failure_code = NULL, completed_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE root_import_session_id <> $1 AND state = 'waiting'`,
      [session],
    );
    await queueTeardown(session);
    const config = {
      api_url: state.apiUrl,
      api_key: "isolated-authority",
      server_id: "localhost",
    } as const;
    const result = (await runHnsAuthorityProvisionExecutorOnce({
      executor_id: "teardown-executor",
      only: "observation",
      queue: {
        claim: () => Promise.resolve(null),
        finalize: () => Promise.reject(new Error("provisioning is not exercised here")),
      },
      provision: {
        observe_current_resource: () => Promise.reject(new Error("unused")),
        ensure_zone: () => Promise.reject(new Error("unused")),
      },
      observation: {
        queue: makePostgresHnsRootObservationQueue(state.connectionString),
        observe: {
          observe_current_resource: () => Promise.reject(new Error("unused")),
          reconcile_zone: () => Promise.reject(new Error("unused")),
          inspect_zone: () => Promise.reject(new Error("unused")),
          observe_live: () => Promise.reject(new Error("unused")),
        },
        teardown_zone: (
          input: Readonly<{
            readonly root_label: string;
            readonly challenge_txt_value?: string;
            readonly mutation_lease?: HnsZoneMutationLease;
          }>,
        ) => {
          const run = makePowerDnsRootTeardown(config);
          if (input.challenge_txt_value === undefined) return run(input);
          return withHnsRootZoneMutation(
            state.connectionString,
            { ...input, challenge_txt_value: input.challenge_txt_value },
            true,
            () => run(input),
          );
        },
        retention: {
          observe_chain: (_rootLabel: string, view: HnsChainObservationViewV1) =>
            Promise.resolve(observed(view, chainRecords)),
          retirement_authorization: async (sessionId: string) => {
            const result = await state.client.query<Record<string, unknown>>(
              "SELECT * FROM authorize_hns_root_import_retirement_v1($1,$2)",
              [sessionId, freshnessSeconds],
            );
            const row = result.rows[0];
            if (row === undefined) return null;
            return {
              kind: row.kind === "supersession" ? "supersession" : "retention_review",
              recorded_at_epoch_ms: (row.recorded_at as Date).getTime(),
              evidence_ref: String(row.evidence_ref),
            };
          },
        },
        config: { environment: "regtest", valid_for_seconds: 3_600 },
      },
    } as never)) as Readonly<{ outcome: string; root_import_session_id?: string }>;
    expect(result.root_import_session_id).toBe(session);
    return result;
  }

  const reservationHeld = async (session: string): Promise<boolean> =>
    (
      await state.client.query<{ readonly held: boolean }>(
        "SELECT hns_community_root_import_reservation_held_v1($1) AS held",
        [session],
      )
    ).rows[0]?.held === true;

  const reviews = async (session: string): Promise<Record<string, unknown>[]> =>
    (
      await state.client.query<Record<string, unknown>>(
        `SELECT decision, reason, authority_generation, evidence_ref,
                current_observed_at, safe_observed_at
           FROM hns_root_import_retention_reviews
          WHERE root_import_session_id = $1 ORDER BY retention_review_id`,
        [session],
      )
    ).rows;

  test(
    "a referenced authority is reviewed, retained, and rescheduled at the recurring cadence",
    async () => {
      const fixture = makeFixture("reviewref");
      await seed(fixture);
      await queueReview(fixture.session);

      const outcome = await review("reviewer-1", async (_label, view) =>
        observed(view, authorityRecords),
      );
      expect(outcome.outcome).toBe("completed");
      expect(outcome.reason).toBe("chain_reference_retained:recorded");

      const recorded = await reviews(fixture.session);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        decision: "retain",
        reason: "chain_reference_retained",
        authority_generation: "1",
      });
      // The successor review is persisted at the frozen thirty-day cadence,
      // and the claimed job completed in the same transaction.
      const scheduled = await state.client.query<Record<string, unknown>>(
        `SELECT state, job_kind,
                extract(epoch FROM (due_at - clock_timestamp()))::bigint AS in_seconds
           FROM hns_root_import_lifecycle_jobs
          WHERE root_import_session_id = $1 ORDER BY lifecycle_job_id`,
        [fixture.session],
      );
      expect(scheduled.rows).toHaveLength(2);
      expect(scheduled.rows[0]?.state).toBe("completed");
      expect(scheduled.rows[1]).toMatchObject({ state: "queued", job_kind: "retention_review" });
      expect(Number(scheduled.rows[1]?.in_seconds)).toBeGreaterThan(2_591_000);
      expect(Number(scheduled.rows[1]?.in_seconds)).toBeLessThanOrEqual(2_592_000);

      // No authorization exists, so teardown retains and deletes nothing.
      const teardown = await runTeardown(fixture.session);
      expect(teardown.outcome).toBe("failed");
      expect(state.zones.has(`${fixture.label}.`)).toBe(true);
      expect(await reservationHeld(fixture.session)).toBe(true);
    },
    BUDGET_MS,
  );

  test(
    "an unreadable plan is unknown provenance, and a redelivered inspection is a replay",
    async () => {
      const fixture = makeFixture("reviewprov", false);
      await seed(fixture);
      await queueReview(fixture.session);
      const first = await review("reviewer-1", async (_label, view) => observed(view, []));
      expect(first.reason).toBe("unknown_provenance_retained:recorded");

      // The same inspection again: one review row, one successor job, and the
      // second claim still completes rather than being reclaimed forever.
      await queueReview(fixture.session);
      await state.client.query(
        `UPDATE hns_root_import_lifecycle_jobs SET due_at = clock_timestamp() - interval '1 second'
          WHERE root_import_session_id = $1 AND state = 'queued'`,
        [fixture.session],
      );
      const replayed = await review("reviewer-2", async (_label, view) => observed(view, []));
      expect(replayed.outcome).toBe("completed");
      expect(replayed.reason).toBe("unknown_provenance_retained:replayed");
      expect(await reviews(fixture.session)).toHaveLength(1);
      const leftQueued = await state.client.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count FROM hns_root_import_lifecycle_jobs
          WHERE root_import_session_id = $1 AND state <> 'completed'`,
        [fixture.session],
      );
      expect(leftQueued.rows[0]?.count).toBe("1");
    },
    BUDGET_MS,
  );

  test(
    "a lost lease records nothing, and a superseded generation records nothing",
    async () => {
      const fixture = makeFixture("reviewlease");
      await seed(fixture);
      await queueReview(fixture.session);
      const lost = await review(
        "reviewer-1",
        async (_label, view) => observed(view, []),
        // One fence behind what the claim actually granted.
        -1,
      );
      expect(lost.outcome).toBe("failed");
      expect(lost.reason).toBe("lease_conflict");
      expect(await reviews(fixture.session)).toHaveLength(0);

      // The generation moves while the inspection is in flight. The evidence
      // describes infrastructure the operation no longer holds.
      await state.client.query(
        `UPDATE hns_root_import_lifecycle_jobs
            SET state='queued', leased_by=NULL, lease_expires_at=NULL,
                due_at = clock_timestamp() - interval '1 second'
          WHERE root_import_session_id = $1`,
        [fixture.session],
      );
      const claimed = await state.client.query<Record<string, unknown>>(
        "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
        ["reviewer-2", 60],
      );
      const job = claimed.rows[0];
      expect(job).toBeDefined();
      await state.client.query(
        "UPDATE hns_root_import_lifecycle SET generation = 2 WHERE root_import_session_id = $1",
        [fixture.session],
      );
      const superseded = await state.client.query<Record<string, unknown>>(
        `SELECT * FROM record_hns_root_import_retention_review_v1(
           $1,$2,$3,$4,$5,'chain_reference_retained','stale-generation',
           NULL,NULL,NULL,NULL, clock_timestamp() + interval '30 days')`,
        [fixture.session, job?.lifecycle_job_id, "reviewer-2", Number(job?.lease_fence), 1],
      );
      expect(superseded.rows[0]?.outcome).toBe("generation_conflict");
      expect(await reviews(fixture.session)).toHaveLength(0);
    },
    BUDGET_MS,
  );

  test(
    "an operator supersession authorizes deletion; the reviewer's own writer cannot",
    async () => {
      const fixture = makeFixture("reviewsuper");
      await seed(fixture);

      // Nothing the reviewer can say is accepted as an authorization: its
      // writer takes no decision at all, and refuses a retiring reason.
      await queueReview(fixture.session);
      const claimed = await state.client.query<Record<string, unknown>>(
        "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
        ["reviewer-1", 60],
      );
      await expect(
        state.client.query(
          `SELECT * FROM record_hns_root_import_retention_review_v1(
             $1,$2,$3,$4,$5,'retirement_positive_evidence','forged',
             clock_timestamp(),clock_timestamp(),NULL,NULL, clock_timestamp() + interval '30 days')`,
          [
            fixture.session,
            claimed.rows[0]?.lifecycle_job_id,
            "reviewer-1",
            Number(claimed.rows[0]?.lease_fence),
            1,
          ],
        ),
      ).rejects.toThrow(/invalid HNS retention review reason/u);

      // The operator's explicit supersession is the authorization.
      const recorded = await state.client.query<Record<string, unknown>>(
        "SELECT * FROM record_hns_root_import_authority_supersession_v1($1,$2,$3,$4)",
        [fixture.session, 1, "operator-decision-1", "authority replaced by operator"],
      );
      expect(recorded.rows[0]?.outcome).toBe("recorded");
      const replay = await state.client.query<Record<string, unknown>>(
        "SELECT * FROM record_hns_root_import_authority_supersession_v1($1,$2,$3,$4)",
        [fixture.session, 1, "operator-decision-1", "authority replaced by operator"],
      );
      expect(replay.rows[0]?.outcome).toBe("replayed");
      const wrongGeneration = await state.client.query<Record<string, unknown>>(
        "SELECT * FROM record_hns_root_import_authority_supersession_v1($1,$2,$3,$4)",
        [fixture.session, 7, "operator-decision-2", "wrong generation"],
      );
      expect(wrongGeneration.rows[0]?.outcome).toBe("generation_conflict");

      // With the authorization present and fresh, the fenced teardown deletes
      // the zone, confirms it is gone, and only then is the quota released.
      expect(await reservationHeld(fixture.session)).toBe(true);
      // The chain no longer references the authority: this is the case the
      // authorization is about. A referenced authority is retained even with
      // one recorded, which the retention suite covers separately.
      const teardown = await runTeardown(fixture.session, [
        { type: "TXT", txt: ["unrelated"] },
      ] as never);
      expect(teardown.outcome).toBe("failed");
      expect(state.zones.has(`${fixture.label}.`)).toBe(false);
      const job = await state.client.query<Record<string, unknown>>(
        "SELECT state FROM hns_root_import_teardown_jobs WHERE root_import_session_id = $1",
        [fixture.session],
      );
      expect(job.rows[0]?.state).toBe("completed");
      expect(await reservationHeld(fixture.session)).toBe(false);
    },
    BUDGET_MS,
  );

  test(
    "stale authorization evidence and a superseded generation both refuse deletion",
    async () => {
      const stale = makeFixture("reviewstale");
      await seed(stale);
      await state.client.query(
        "SELECT * FROM record_hns_root_import_authority_supersession_v1($1,$2,$3,$4)",
        [stale.session, 1, "operator-stale", "recorded long ago"],
      );
      // Reviews are append-only, so the authorization cannot be backdated: the
      // freshness bound is tightened to one second and the evidence is allowed
      // to age past it instead. Attempting to rewrite the row also proves the
      // guard, which refuses it.
      await expect(
        state.client.query(
          `UPDATE hns_root_import_retention_reviews
              SET reviewed_at = clock_timestamp() - interval '2 hours'
            WHERE root_import_session_id = $1`,
          [stale.session],
        ),
      ).rejects.toThrow(/append-only/u);
      await Bun.sleep(1_200);
      expect(
        (
          await state.client.query("SELECT * FROM authorize_hns_root_import_retirement_v1($1,$2)", [
            stale.session,
            1,
          ])
        ).rows,
      ).toHaveLength(0);
      await runTeardown(stale.session, [{ type: "TXT", txt: ["unrelated"] }] as never, 1);
      expect(state.zones.has(`${stale.label}.`)).toBe(true);
      expect(await reservationHeld(stale.session)).toBe(true);

      // A fresh authorization for a generation the operation has moved past is
      // equally refused: nobody inspected the infrastructure it now holds.
      const moved = makeFixture("reviewgen");
      await seed(moved);
      await state.client.query(
        "SELECT * FROM record_hns_root_import_authority_supersession_v1($1,$2,$3,$4)",
        [moved.session, 1, "operator-generation", "recorded for generation one"],
      );
      await state.client.query(
        "UPDATE hns_root_import_lifecycle SET generation = 2 WHERE root_import_session_id = $1",
        [moved.session],
      );
      expect(
        (
          await state.client.query("SELECT * FROM authorize_hns_root_import_retirement_v1($1,$2)", [
            moved.session,
            FRESHNESS_SECONDS,
          ])
        ).rows,
      ).toHaveLength(0);
      await runTeardown(moved.session, [{ type: "TXT", txt: ["unrelated"] }] as never);
      expect(state.zones.has(`${moved.label}.`)).toBe(true);
      expect(await reservationHeld(moved.session)).toBe(true);
    },
    BUDGET_MS,
  );

  test(
    "an authorized deletion whose zone survives is ambiguous: quota stays held",
    async () => {
      const fixture = makeFixture("reviewambig");
      await seed(fixture);
      await state.client.query(
        "SELECT * FROM record_hns_root_import_authority_supersession_v1($1,$2,$3,$4)",
        [fixture.session, 1, "operator-ambiguous", "authorized, provider unreliable"],
      );
      // The provider answers the delete with a success it did not perform.
      state.surviveDelete.add(`${fixture.label}.`);
      try {
        const teardown = await runTeardown(fixture.session, [
          { type: "TXT", txt: ["unrelated"] },
        ] as never);
        expect(teardown.outcome).toBe("retry");
      } finally {
        state.surviveDelete.delete(`${fixture.label}.`);
      }
      expect(state.zones.has(`${fixture.label}.`)).toBe(true);
      const job = await state.client.query<Record<string, unknown>>(
        "SELECT state, failure_code FROM hns_root_import_teardown_jobs WHERE root_import_session_id = $1",
        [fixture.session],
      );
      expect(job.rows[0]?.state).toBe("waiting");
      expect(await reservationHeld(fixture.session)).toBe(true);
    },
    BUDGET_MS,
  );

  test(
    "the retention functions run as the schema owner on a pinned search path, and not for PUBLIC",
    async () => {
      const signatures = [
        ["authorize_hns_root_import_retirement_v1", "text, integer"],
        ["reject_hns_retention_review_change_v1", ""],
        [
          "record_hns_root_import_retention_review_v1",
          "text, bigint, text, bigint, bigint, text, text, timestamp with time zone, timestamp with time zone, text, text, timestamp with time zone",
        ],
        ["record_hns_root_import_authority_supersession_v1", "text, bigint, text, text"],
      ] as const;
      const rows = await state.client.query<Record<string, unknown>>(
        `SELECT p.proname, oidvectortypes(p.proargtypes) AS args,
                p.prosecdef, p.proconfig,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
        [signatures.map(([name]) => name)],
      );
      expect(rows.rows).toHaveLength(4);
      for (const row of rows.rows) {
        const expected = signatures.find(([name]) => name === row.proname);
        expect(row.args).toBe(expected?.[1]);
        // The trigger guard stays SECURITY INVOKER: it must run as whoever is
        // writing, and it only ever raises. The three callable functions
        // execute as the schema owner on a pinned path.
        expect(row.prosecdef).toBe(row.proname !== "reject_hns_retention_review_change_v1");
        expect(row.proconfig).toEqual(["search_path=public, pg_temp"]);
        // EXECUTE was revoked from PUBLIC, so schema usage alone does not let
        // an unprivileged role write reviews or authorizations.
        expect(row.public_execute).toBe(false);
      }
    },
    BUDGET_MS,
  );

  test(
    "an actual runtime role can review but cannot authorize retirement",
    async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const executor = `hns_reviewer_exec_${suffix}`;
      const operator = `hns_reviewer_oper_${suffix}`;
      await state.client.query(`CREATE ROLE ${executor} NOLOGIN`);
      await state.client.query(`CREATE ROLE ${operator} NOLOGIN`);
      try {
        await state.client.query(`GRANT USAGE ON SCHEMA public TO ${executor}, ${operator}`);
        await state.client.query(
          `GRANT EXECUTE ON FUNCTION record_hns_root_import_retention_review_v1(
             TEXT,BIGINT,TEXT,BIGINT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TIMESTAMPTZ
           ) TO ${executor}`,
        );
        await state.client.query(
          `GRANT EXECUTE ON FUNCTION claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER) TO ${executor}`,
        );
        await state.client.query(
          `GRANT EXECUTE ON FUNCTION record_hns_root_import_authority_supersession_v1(
             TEXT,BIGINT,TEXT,TEXT) TO ${operator}`,
        );

        const fixture = makeFixture("reviewrole");
        await seed(fixture);
        await queueReview(fixture.session);

        await state.client.query(`SET LOCAL ROLE ${executor}`).catch(() => undefined);
        await state.client.query("BEGIN");
        await state.client.query(`SET LOCAL ROLE ${executor}`);
        const claimed = await state.client.query<Record<string, unknown>>(
          "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
          ["role-executor", 60],
        );
        const job = claimed.rows[0];
        expect(job).toBeDefined();
        const recorded = await state.client.query<Record<string, unknown>>(
          `SELECT * FROM record_hns_root_import_retention_review_v1(
             $1,$2,$3,$4,$5,'chain_reference_retained','role-evidence',
             NULL,NULL,NULL,NULL, clock_timestamp() + interval '30 days')`,
          [fixture.session, job?.lifecycle_job_id, "role-executor", Number(job?.lease_fence), 1],
        );
        expect(recorded.rows[0]?.outcome).toBe("recorded");
        // The same role cannot record an authorization.
        await expect(
          state.client.query(
            "SELECT * FROM record_hns_root_import_authority_supersession_v1($1,$2,$3,$4)",
            [fixture.session, 1, "executor-attempt", "should be refused"],
          ),
        ).rejects.toThrow(/permission denied/u);
        await state.client.query("ROLLBACK");

        // The operator role holds the authorization grant and not the reviewer's.
        await state.client.query("BEGIN");
        await state.client.query(`SET LOCAL ROLE ${operator}`);
        await expect(
          state.client.query(
            `SELECT * FROM record_hns_root_import_retention_review_v1(
               $1,$2,$3,$4,$5,'chain_reference_retained','operator-attempt',
               NULL,NULL,NULL,NULL, clock_timestamp() + interval '30 days')`,
            [fixture.session, job?.lifecycle_job_id, "role-executor", Number(job?.lease_fence), 1],
          ),
        ).rejects.toThrow(/permission denied/u);
        await state.client.query("ROLLBACK");
      } finally {
        await state.client.query("ROLLBACK").catch(() => undefined);
        await state.client.query(`DROP OWNED BY ${executor}, ${operator}`).catch(() => undefined);
        await state.client.query(`DROP ROLE IF EXISTS ${executor}`).catch(() => undefined);
        await state.client.query(`DROP ROLE IF EXISTS ${operator}`).catch(() => undefined);
      }
    },
    BUDGET_MS,
  );
});
