import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneHnsCommunityRootImportStartStore } from "./hns-community-root-import-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

/**
 * The lifecycle a client reads comes from the row the server wrote.
 *
 * This is the adapter end of the emission path: persisted phase, pending
 * reason, deadlines, next-check time and the accepted observation are read from
 * `hns_root_import_lifecycle` and projected, with the server's own clock. What
 * it is really guarding is that no part of the projection is reconstructed from
 * the session status, which is coarse and would disagree with the operation the
 * runner is actually driving.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

/** Each case builds a schema from the baseline; five seconds is not enough. */
const BUDGET_MS = 180_000;

const quoted = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const scoped = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

const binding = {
  requirement: "namespace_ownership" as const,
  family: "hns" as const,
  provider_id: "hns.owner.v1",
  provider_configuration: { kind: "managed" as const, reference: "hns-owner-test", version: "1" },
  protocol_version: "hns-txt-v1",
};

const actorId = "projection-actor";
const communityId = "community_123e4567-e89b-42d3-a456-4266141740aa";
const sessionId = "projection-session";
const rootLabel = "projected";
const challenge = "pirate-verification=projected";
const shaA = "a".repeat(64);
const serverNow = Date.UTC(2026, 8, 10, 12, 0, 0);

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = `hns_projection_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoted(schema)}`);
  await admin.query(`SET search_path TO ${quoted(schema)}`);
  try {
    const connection = scoped(connectionString, schema);
    await applyPostgresTestBaselineConnection({ connectionString: connection });
    return await use(connection, admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoted(schema)} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

const planBytes = Buffer.from(
  JSON.stringify({
    version: "pirate-hns-root-import-publish-plan-v1",
    replacement_semantics: "complete_resource",
    current_records: [],
    preserved_records: [],
    removed_conflicts: [],
    added_records: [],
    replacement_records: [{ type: "NS", ns: "ns1.pirate." }],
    preserved_unknown_record_types: [],
    encoded_resource_sha256: "1".repeat(64),
    acknowledgement_required: true,
  }),
);
const planSha = createHash("sha256").update(planBytes).digest("hex");

/** A session in `observing`, with the operation row a runner would have written. */
async function seed(admin: Client, options: { readonly lifecycle: boolean }): Promise<void> {
  await admin.query("INSERT INTO users (user_id,status,account) VALUES ($1,'active','{}')", [
    actorId,
  ]);
  await admin.query("BEGIN");
  await admin.query(
    `INSERT INTO communities (community_id,display_name,status,created_by_user_id,
       canonical_route_binding_id,route_authority_version,created_at,updated_at)
     VALUES ($1,'Projection','active',$2,NULL,'optional_route_v2',clock_timestamp(),clock_timestamp())`,
    [communityId, actorId],
  );
  await admin.query("SET LOCAL session_replication_role = replica");
  await admin.query(
    `INSERT INTO community_route_authority_grants
       (grant_id,community_id,principal_user_id,authority,source_kind,status,granted_at,granted_by_user_id)
     VALUES ('projection-grant',$1,$2,'manage_routes','creator_owner','active',clock_timestamp(),$2)`,
    [communityId, actorId],
  );
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
    [sessionId, actorId, rootLabel, challenge, shaA, planBytes, planSha, communityId],
  );
  if (options.lifecycle) {
    await admin.query(
      `INSERT INTO hns_root_import_lifecycle (
         root_import_session_id, root_label, phase, revision, generation,
         plan_exposed_at, publication_deadline_at,
         first_current_observation_at, finality_deadline_at,
         pending_reason, next_check_at, observation_count,
         policy_name, policy_digest,
         last_observation_view, last_observation_resource_sha256,
         last_observation_tip_height, last_observation_update_inclusion_height,
         last_observation_commitment_height, last_observation_at,
         last_observation_recorded_at
       ) VALUES (
         $1,$2,'waiting_safe_commitment',7,1,
         TIMESTAMPTZ '2026-09-10T11:00:00Z', TIMESTAMPTZ '2026-09-24T11:00:00Z',
         TIMESTAMPTZ '2026-09-10T11:50:00Z', TIMESTAMPTZ '2026-09-11T11:50:00Z',
         'waiting_safe_commitment', TIMESTAMPTZ '2026-09-10T12:15:00Z', 2,
         'hns_root_import_lifecycle_v1','projection',
         'current',$3,
         3260, 3248, NULL, TIMESTAMPTZ '2026-09-10T11:59:00Z',
         TIMESTAMPTZ '2026-09-10T11:59:05Z'
       )`,
      [sessionId, rootLabel, "3".repeat(64)],
    );
  }
  await admin.query("COMMIT");
}

function storeFor(connection: string) {
  return makeControlPlaneHnsCommunityRootImportStartStore(
    makeDirectPostgresControlPlaneLayer(connection),
    {
      environment: "test",
      provider_binding: binding,
      // A fixed server clock, so `server_time` and the retry hint derived from
      // the persisted next-check time are both checkable exactly.
      now_epoch_ms: () => serverNow,
    },
  );
}

const read = (connection: string) =>
  Effect.runPromise(
    Effect.scoped(
      storeFor(connection).get({
        actor_id: actorId,
        community_id: communityId,
        root_import_session_id: sessionId,
      }) as never,
    ),
  ) as Promise<Record<string, unknown> | null>;

suite("the emitted lifecycle is the persisted lifecycle on PostgreSQL 17", () => {
  test(
    "phase, pending reason, deadline, next check and observation all come from the stored row",
    async () => {
      await withSchema(async (connection, admin) => {
        await seed(admin, { lifecycle: true });
        const session = await read(connection);
        expect(session).not.toBeNull();
        const lifecycle = session?.lifecycle as Record<string, unknown>;
        expect(lifecycle).toBeDefined();
        expect(lifecycle.phase).toBe("waiting_safe_commitment");
        expect(lifecycle.pending_reason).toBe("waiting_safe_commitment");
        // Waiting for finality: the finality deadline applies, not the
        // publication one that is also stored on the row.
        expect(lifecycle.deadline).toEqual({
          kind: "finality",
          at: "2026-09-11T11:50:00.000Z",
        });
        expect(lifecycle.server_time).toBe(new Date(serverNow).toISOString());
        expect(lifecycle.next_check_at).toBe("2026-09-10T12:15:00.000Z");
        expect(lifecycle.retry_hint_seconds).toBe(900);
        expect(lifecycle.permitted_actions).toEqual(["poll"]);
        expect(lifecycle.observation).toEqual({
          view: "current",
          resource_sha256: "3".repeat(64),
          tip_height: 3_260,
          update_inclusion_height: 3_248,
          commitment_height: null,
        });
        // The session's own revision is 3 and the operation's is 7. Reading
        // one as the other would project a different operation's state.
        expect(session?.revision).toBe(3);
      });
    },
    BUDGET_MS,
  );

  test(
    "an operation with no persisted lifecycle emits no projection",
    async () => {
      await withSchema(async (connection, admin) => {
        await seed(admin, { lifecycle: false });
        const session = await read(connection);
        expect(session).not.toBeNull();
        expect(session !== null && "lifecycle" in session).toBe(false);
        expect(session?.status).toBe("observing");
      });
    },
    BUDGET_MS,
  );

  test(
    "a reload after the server records a different observation reports the difference",
    async () => {
      await withSchema(async (connection, admin) => {
        await seed(admin, { lifecycle: true });
        const before = (await read(connection))?.lifecycle as Record<string, unknown>;

        // The runner accepts a safe observation at a later tip, through the
        // function the runner itself calls — under a real claimed lease, which
        // is what that function now requires.
        await admin.query(
          `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
             VALUES ($1,'observe_safe', clock_timestamp() - interval '1 second')`,
          [sessionId],
        );
        const claimed = await admin.query<Record<string, unknown>>(
          "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
          ["projection-executor", 60],
        );
        const job = claimed.rows[0];
        expect(job).toBeDefined();
        // The observation the runner writes is bound to the accepted decision
        // that consumed it. Here that decision is a pending hold — the safe
        // view did not move the operation — which is exactly the case the
        // projection used to report with no decision behind it.
        const decisionEventId = "projection-observation-event";
        await admin.query(
          `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1(
             $1, 7, $2, 'safe_observation', 'pending', 'safe_resource_mismatch_hold',
             'waiting_safe_commitment',
             '{"pending_reason":"waiting_safe_commitment","next_check_at":"2026-09-10T12:15:00Z"}'::jsonb,
             '[]'::jsonb)`,
          [sessionId, decisionEventId],
        );
        const written = await admin.query<{ readonly outcome: string }>(
          `SELECT record_hns_root_import_lifecycle_observation_v1(
             $1,$2,$3,$4,'safe',$5,3300,3248,3295,
             clock_timestamp() - interval '30 seconds',$6,1,3600) AS outcome`,
          [
            sessionId,
            job?.lifecycle_job_id,
            "projection-executor",
            Number(job?.lease_fence),
            "4".repeat(64),
            decisionEventId,
          ],
        );
        expect(written.rows[0]?.outcome).toBe("recorded");

        // A worker that has lost its lease writes nothing, so the projection
        // can never report evidence nobody can vouch for.
        const stale = await admin.query<{ readonly outcome: string }>(
          `SELECT record_hns_root_import_lifecycle_observation_v1(
             $1,$2,$3,$4,'current',$5,9999,NULL,NULL, clock_timestamp(),
             $6,1,3600) AS outcome`,
          [
            sessionId,
            job?.lifecycle_job_id,
            "projection-executor",
            Number(job?.lease_fence) - 1,
            "9".repeat(64),
            decisionEventId,
          ],
        );
        expect(stale.rows[0]?.outcome).toBe("lease_conflict");
        const after = (await read(connection))?.lifecycle as Record<string, unknown>;

        expect(after.observation).not.toEqual(before.observation);
        expect(after.observation).toEqual({
          view: "safe",
          resource_sha256: "4".repeat(64),
          tip_height: 3_300,
          update_inclusion_height: 3_248,
          commitment_height: 3_295,
        });
        // The reload changes only what the server changed. The phase, its
        // deadline and the next-check time are untouched by an observation
        // that did not move the operation.
        expect(after.phase).toBe(before.phase);
        expect(after.deadline).toEqual(before.deadline);
        expect(after.next_check_at).toBe(before.next_check_at);
        expect(after.server_time).toBe(before.server_time);
      });
    },
    BUDGET_MS,
  );

  test(
    "a half-written observation is refused rather than projected",
    async () => {
      await withSchema(async (connection, admin) => {
        await seed(admin, { lifecycle: true });
        // A digest with no height, or a view the vocabulary does not contain,
        // would project evidence the server cannot stand behind.
        await expect(
          admin.query(
            `SELECT record_hns_root_import_lifecycle_observation_v1(
               $1,1,'projection-executor',1,'sideways',$2,3300,NULL,NULL, clock_timestamp(),
               'projection-observation-event',1,3600)`,
            [sessionId, "4".repeat(64)],
          ),
        ).rejects.toThrow(/invalid HNS lifecycle observation evidence/u);
        await expect(
          admin.query(
            `UPDATE hns_root_import_lifecycle
                SET last_observation_resource_sha256 = $2, last_observation_tip_height = NULL
              WHERE root_import_session_id = $1`,
            [sessionId, "5".repeat(64)],
          ),
        ).rejects.toThrow(/hns_root_import_lifecycle_observation_shape/u);
        const lifecycle = (await read(connection))?.lifecycle as Record<string, unknown>;
        expect((lifecycle.observation as Record<string, unknown>).resource_sha256).toBe(
          "3".repeat(64),
        );
      });
    },
    BUDGET_MS,
  );
});
