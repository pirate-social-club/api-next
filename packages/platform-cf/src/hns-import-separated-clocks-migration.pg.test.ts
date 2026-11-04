import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

/** Applying every migration into a fresh schema is well past bun's default. */
const SCHEMA_BUDGET_MS = 240_000;
const SEPARATED_CLOCKS = "0208_hns_import_separated_clocks.sql";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const shaA = "a".repeat(64);
const actor = "separated-clocks-actor";
const community = "community_123e4567-e89b-42d3-a456-426614174206";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

type Shape = Readonly<{
  readonly session: string;
  readonly label: string;
  readonly status: string;
  /** Minutes from now; negative is in the past. */
  readonly challengeExpiresInMinutes: number;
  /** Null seeds no lifecycle row. */
  readonly phase: string | null;
  readonly exposed: boolean;
  readonly provisionPlanMatches?: boolean;
  readonly origin?: "community_attachment" | "creation_intent";
}>;

// One session per inventoried class, and the edges between them.
const shapes: readonly Shape[] = [
  {
    session: "clocks-failed",
    label: "failedroot",
    status: "failed",
    challengeExpiresInMinutes: -120,
    phase: "checking_publication",
    exposed: true,
  },
  {
    session: "clocks-expired",
    label: "expiredroot",
    status: "expired",
    challengeExpiresInMinutes: -120,
    phase: "awaiting_publication",
    exposed: true,
  },
  {
    session: "clocks-activated",
    label: "activeroot",
    status: "activated",
    challengeExpiresInMinutes: -600,
    phase: "activated",
    exposed: true,
  },
  {
    session: "clocks-provisioning",
    label: "provisionroot",
    status: "provisioning",
    challengeExpiresInMinutes: 30,
    phase: "preparing",
    exposed: false,
  },
  {
    session: "clocks-no-lifecycle",
    label: "legacyroot",
    status: "awaiting_ownership",
    challengeExpiresInMinutes: -30,
    phase: null,
    exposed: false,
  },
  {
    session: "clocks-live",
    label: "liveroot",
    status: "awaiting_owner_update",
    challengeExpiresInMinutes: 40,
    phase: "awaiting_publication",
    exposed: true,
  },
  {
    session: "clocks-challenge-expired",
    label: "staleroot",
    status: "awaiting_owner_update",
    challengeExpiresInMinutes: -90,
    phase: "checking_publication",
    exposed: true,
  },
  {
    session: "clocks-already-held",
    label: "heldroot",
    status: "awaiting_owner_update",
    challengeExpiresInMinutes: 40,
    phase: "recovery_required",
    exposed: true,
  },
  {
    session: "clocks-inconsistent",
    label: "mismatchroot",
    status: "awaiting_owner_update",
    challengeExpiresInMinutes: 40,
    phase: "awaiting_publication",
    exposed: true,
    provisionPlanMatches: false,
  },
  {
    session: "clocks-lifecycle-failed",
    label: "retiredroot",
    status: "awaiting_owner_update",
    challengeExpiresInMinutes: -90,
    phase: "failed",
    exposed: true,
  },
  {
    session: "clocks-creation-intent",
    label: "creationroot",
    status: "awaiting_owner_update",
    challengeExpiresInMinutes: -90,
    phase: "checking_publication",
    exposed: true,
    origin: "creation_intent",
  },
];

async function seed(admin: Client, shape: Shape): Promise<void> {
  const origin = shape.origin ?? "community_attachment";
  const upstream = `nvs_${shape.session}`;
  const challenge = `pirate-verification=${upstream}`;
  const plan = Buffer.from(`{"plan":"${shape.session}"}`);
  const planSha256 = sha(plan.toString());
  // A provision job whose own plan differs from the session's exposed plan.
  const otherPlan = Buffer.from(`{"plan":"other-${shape.session}"}`);
  const expires = `clock_timestamp() + (${shape.challengeExpiresInMinutes} * interval '1 minute')`;
  const terminal = shape.status === "failed" || shape.status === "expired";
  const withPlan = shape.exposed && shape.status !== "provisioning";
  const observed = shape.status === "activated";
  await admin.query(
    `INSERT INTO hns_root_import_sessions (
       root_import_session_id, actor_id, origin_kind, creation_intent_id, ceremony_intent_id,
       community_id, attachment_intent_id, namespace_session_id, ownership_generation,
       ownership_expected_revision, root_label, challenge_txt_value, status, revision,
       start_idempotency_key, start_request_sha256, provision_job_id,
       provision_authorization_kind, provision_authorization_sha256,
       provision_idempotency_key, provision_poll_request_sha256,
       publish_plan_bytes, publish_plan_sha256, ownership_result_sha256,
       observation_job_id, observation_idempotency_key, observation_request_sha256,
       readiness_result_bytes, readiness_result_sha256, activated_community_id,
       created_at, expires_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,1,1,$9,$10,$11,1,$12,$13,$14,
       $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
       clock_timestamp() - interval '12 hours', ${expires}
     )`,
    [
      shape.session,
      actor,
      origin,
      origin === "creation_intent" ? `intent-${shape.session}` : null,
      origin === "creation_intent" ? `ceremony-${shape.session}` : null,
      origin === "community_attachment" ? community : null,
      origin === "community_attachment" ? `attachment-${shape.session}` : null,
      `namespace-${shape.session}`,
      shape.label,
      challenge,
      shape.status,
      `start-${shape.session}`,
      shaA,
      `provision-${shape.session}`,
      terminal || shape.status === "awaiting_ownership" ? null : "community_provisional",
      terminal || shape.status === "awaiting_ownership" ? null : shaA,
      terminal || shape.status === "awaiting_ownership" ? null : `idem-${shape.session}`,
      terminal || shape.status === "awaiting_ownership" ? null : shaA,
      withPlan && !terminal ? plan : null,
      withPlan && !terminal ? planSha256 : null,
      observed ? shaA : null,
      observed ? `observation-${shape.session}` : null,
      observed ? `obs-idem-${shape.session}` : null,
      observed ? shaA : null,
      observed ? Buffer.from("{}") : null,
      observed ? sha("{}") : null,
      observed ? community : null,
    ],
  );
  if (origin === "community_attachment") {
    await admin.query(
      `INSERT INTO community_route_attachment_namespace_sessions (
         namespace_session_id, actor_id, community_id, attachment_intent_id, ceremony_intent_id,
         start_reservation_id, start_fence_token, expected_revision, generation,
         requirement_hash, request_hash, provider_id, provider_binding_hash,
         provider_configuration_kind, provider_configuration_ref,
         provider_configuration_version, protocol_version, environment, route_root_label,
         upstream_session_ref, presentation_kind, presentation_payload, status,
         started_at, expires_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,1,1,1,$7,$7,'hns.owner.v1',$7,'managed','hns-owner-test','1',
         'hns-txt-v1','test',$8,$9,'embedded_sdk','{}'::jsonb,'pending',
         clock_timestamp() - interval '12 hours', ${expires}
       )`,
      [
        `namespace-${shape.session}`,
        actor,
        community,
        `attachment-${shape.session}`,
        `ceremony-${shape.session}`,
        `reservation-${shape.session}`,
        shaA,
        shape.label,
        upstream,
      ],
    );
  }
  await admin.query(
    `INSERT INTO hns_authority_provision_jobs (
       provision_job_id, root_import_session_id, operation_kind, request_bytes,
       request_sha256, state, attempt_count, publish_plan_bytes, publish_plan_sha256,
       result_bytes, result_sha256, created_at, completed_at
     ) VALUES (
       $1,$2,'provision_root_v1',$3,$4,$5,1,$6,$7,$8,$9,
       clock_timestamp() - interval '11 hours',
       CASE WHEN $5 = 'completed' THEN clock_timestamp() - interval '10 hours' END
     )`,
    [
      `provision-${shape.session}`,
      shape.session,
      Buffer.from(shape.session),
      sha(shape.session),
      withPlan ? "completed" : "queued",
      withPlan ? (shape.provisionPlanMatches === false ? otherPlan : plan) : null,
      withPlan
        ? shape.provisionPlanMatches === false
          ? sha(otherPlan.toString())
          : planSha256
        : null,
      withPlan ? Buffer.from(shape.session) : null,
      withPlan ? sha(shape.session) : null,
    ],
  );
  if (shape.phase === null) return;
  const exposedAt = "clock_timestamp() - interval '10 hours'";
  const deadline = "clock_timestamp() + interval '13 days'";
  const current = ["waiting_safe_commitment", "checking_authority", "ready", "activated"].includes(
    shape.phase,
  );
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle (
       root_import_session_id, root_label, phase, revision, generation, plan_exposed_at,
       publication_deadline_at, first_current_observation_at, finality_deadline_at,
       readiness_observed_at, pending_reason, next_check_at, policy_name, policy_digest,
       last_useful_error, terminal_decided_at
     ) VALUES (
       $1,$2,$3,4,1,
       ${shape.exposed ? exposedAt : "NULL"},
       ${shape.exposed ? deadline : "NULL"},
       ${current ? "clock_timestamp() - interval '2 hours'" : "NULL"},
       ${current ? "clock_timestamp() + interval '22 hours'" : "NULL"},
       ${shape.phase === "activated" ? "clock_timestamp() - interval '1 hour'" : "NULL"},
       $4, clock_timestamp() + interval '15 minutes', 'hns_root_import_policy_v1', $5,
       $6, ${shape.phase === "failed" ? "clock_timestamp() - interval '1 hour'" : "NULL"}
     )`,
    [
      shape.session,
      shape.label,
      shape.phase,
      shape.phase === "recovery_required" ? "publication_deadline_reached" : null,
      shaA,
      shape.session === "clocks-challenge-expired" ? "provider_unavailable" : null,
    ],
  );
}

suite("HNS separated-clocks migration (0208)", () => {
  test(
    "inventories every community session and applies each class's rule",
    async () => {
      const schema = `hns_separated_clocks_${randomUUID().replaceAll("-", "")}`;
      const admin = new Client({ connectionString });
      await admin.connect();
      try {
        await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
        await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
        const migrations = await loadPostgresMigrations();
        const separated = migrations.find((migration) =>
          migration.version.startsWith(SEPARATED_CLOCKS.slice(0, 4)),
        );
        if (separated === undefined) throw new Error("migration 0208 was not found");
        for (const migration of migrations) {
          if (migration.version < separated.version) await admin.query(migration.sql);
        }
        await admin.query("BEGIN");
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor]);
        await admin.query(
          `INSERT INTO communities (community_id,display_name,status,created_by_user_id,
             canonical_route_binding_id,route_authority_version,route_slug,created_at,updated_at)
           VALUES ($1,'Separated clocks','active',$2,NULL,'optional_route_v2',NULL,
             clock_timestamp(),clock_timestamp())`,
          [community, actor],
        );
        for (const shape of shapes) await seed(admin, shape);
        await admin.query("COMMIT");

        const heldBefore = (
          await admin.query(
            "SELECT revision, last_useful_error FROM hns_root_import_lifecycle WHERE root_import_session_id='clocks-challenge-expired'",
          )
        ).rows[0] as { revision: string; last_useful_error: string };

        await admin.query(separated.sql);

        const inventory = (
          await admin.query(
            `SELECT root_import_session_id, classification, reason
               FROM hns_root_import_separated_clocks_inventory
              ORDER BY root_import_session_id`,
          )
        ).rows;
        expect(inventory).toEqual([
          {
            root_import_session_id: "clocks-activated",
            classification: "activated",
            reason: "session_activated",
          },
          {
            root_import_session_id: "clocks-already-held",
            classification: "recovery_required",
            reason: "already_recovery_required",
          },
          {
            root_import_session_id: "clocks-challenge-expired",
            classification: "recovery_required",
            reason: "pre_separated_clocks_challenge_expiry",
          },
          {
            root_import_session_id: "clocks-expired",
            classification: "terminal",
            reason: "session_terminal",
          },
          {
            root_import_session_id: "clocks-failed",
            classification: "terminal",
            reason: "session_terminal",
          },
          {
            root_import_session_id: "clocks-inconsistent",
            classification: "recovery_required",
            reason: "sources_inconsistent",
          },
          {
            root_import_session_id: "clocks-lifecycle-failed",
            classification: "terminal",
            reason: "lifecycle_terminal",
          },
          {
            root_import_session_id: "clocks-live",
            classification: "authorization_backfill",
            reason: "challenge_clock_live_sources_consistent",
          },
          {
            root_import_session_id: "clocks-no-lifecycle",
            classification: "not_exposed",
            reason: "lifecycle_absent",
          },
          {
            root_import_session_id: "clocks-provisioning",
            classification: "not_exposed",
            reason: "plan_not_exposed",
          },
        ]);

        // Only the live, consistent pre-repair plan gets an authorization,
        // and it is built from stored state only.
        const authorizations = (
          await admin.query(
            `SELECT root_import_session_id, authority_generation, upstream_session_ref,
                    challenge_value_sha256, source,
                    valid_until = (SELECT publication_deadline_at FROM hns_root_import_lifecycle
                                    WHERE root_import_session_id='clocks-live') AS snapshot
               FROM hns_root_import_publication_authorizations`,
          )
        ).rows;
        expect(authorizations).toEqual([
          {
            root_import_session_id: "clocks-live",
            authority_generation: "1",
            upstream_session_ref: "nvs_clocks-live",
            challenge_value_sha256: sha("pirate-verification=nvs_clocks-live"),
            source: "migration_backfill",
            snapshot: true,
          },
        ]);

        const lifecycles = Object.fromEntries(
          (
            await admin.query(
              "SELECT root_import_session_id, phase, pending_reason FROM hns_root_import_lifecycle",
            )
          ).rows.map((row) => [row.root_import_session_id, [row.phase, row.pending_reason]]),
        );
        // The expired pre-repair plan is held for recovery with its evidence
        // retained; nothing else changes phase. The already-held plan keeps
        // its original reason; terminal and activated sessions stay as they were.
        expect(lifecycles).toEqual({
          "clocks-failed": ["checking_publication", null],
          "clocks-expired": ["awaiting_publication", null],
          "clocks-activated": ["activated", null],
          "clocks-provisioning": ["preparing", null],
          "clocks-live": ["awaiting_publication", null],
          "clocks-challenge-expired": [
            "recovery_required",
            "pre_separated_clocks_challenge_expiry",
          ],
          "clocks-already-held": ["recovery_required", "publication_deadline_reached"],
          "clocks-inconsistent": ["recovery_required", "sources_inconsistent"],
          "clocks-lifecycle-failed": ["failed", null],
          "clocks-creation-intent": ["checking_publication", null],
        });
        const heldAfter = (
          await admin.query(
            "SELECT revision, last_useful_error FROM hns_root_import_lifecycle WHERE root_import_session_id='clocks-challenge-expired'",
          )
        ).rows[0] as { revision: string; last_useful_error: string };
        expect(Number(heldAfter.revision)).toBe(Number(heldBefore.revision) + 1);
        expect(heldAfter.last_useful_error).toBe("provider_unavailable");

        const findings = (
          await admin.query(
            `SELECT root_import_session_id, classification, reason
               FROM hns_root_import_recovery_findings ORDER BY root_import_session_id`,
          )
        ).rows;
        // Each finding carries its inventoried reason; a plan already held
        // keeps its own finding and gets no second one.
        expect(findings).toEqual([
          {
            root_import_session_id: "clocks-challenge-expired",
            classification: "insufficient_evidence",
            reason: "pre_separated_clocks_challenge_expiry",
          },
          {
            root_import_session_id: "clocks-inconsistent",
            classification: "insufficient_evidence",
            reason: "sources_inconsistent",
          },
        ]);
        const history = (
          await admin.query(
            `SELECT root_import_session_id, event_name, prior_phase, new_phase
               FROM hns_root_import_lifecycle_history ORDER BY root_import_session_id`,
          )
        ).rows;
        expect(history).toEqual([
          {
            root_import_session_id: "clocks-challenge-expired",
            event_name: "recovery_hold",
            prior_phase: "checking_publication",
            new_phase: "recovery_required",
          },
          {
            root_import_session_id: "clocks-inconsistent",
            event_name: "recovery_hold",
            prior_phase: "awaiting_publication",
            new_phase: "recovery_required",
          },
        ]);

        // Session rows are never revived or rewritten by the migration.
        const sessions = (
          await admin.query(
            "SELECT root_import_session_id, status FROM hns_root_import_sessions ORDER BY root_import_session_id",
          )
        ).rows;
        expect(sessions).toEqual(
          [...shapes]
            .sort((left, right) => (left.session < right.session ? -1 : 1))
            .map((shape) => ({ root_import_session_id: shape.session, status: shape.status })),
        );

        // The live plan is now governed by the publication window, well past
        // its one-hour challenge; the held plan is not.
        const windows = (
          await admin.query(
            `SELECT session.root_import_session_id, decision.window_open, decision.reason
               FROM hns_root_import_sessions AS session
               CROSS JOIN LATERAL hns_root_import_publication_window_decision_v1(
                 session.root_import_session_id) AS decision
              WHERE session.root_import_session_id IN
                ('clocks-live','clocks-challenge-expired','clocks-creation-intent')
              ORDER BY 1`,
          )
        ).rows;
        expect(windows).toEqual([
          {
            root_import_session_id: "clocks-challenge-expired",
            window_open: false,
            reason: "recovery_required",
          },
          {
            root_import_session_id: "clocks-creation-intent",
            window_open: false,
            reason: "not_exposed",
          },
          { root_import_session_id: "clocks-live", window_open: true, reason: "open" },
        ]);

        await expect(
          admin.query("UPDATE hns_root_import_separated_clocks_inventory SET reason='x'"),
        ).rejects.toThrow("append-only");
        await expect(
          admin.query("DELETE FROM hns_root_import_publication_authorizations"),
        ).rejects.toThrow("immutable");
      } finally {
        await admin.query("ROLLBACK").catch(() => undefined);
        await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
        await admin.end();
      }
    },
    SCHEMA_BUDGET_MS,
  );
});
