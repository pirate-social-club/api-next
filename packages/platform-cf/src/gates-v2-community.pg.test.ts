import { afterAll, describe, expect, test } from "bun:test";
import type { CommunityStore } from "@pirate/application";
import { CURATED_AGE_18_POLICY } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";

import { runPostgresMigrations } from "../../../scripts/postgres-migrations";
import { seedCuratedAge18Policy } from "../../../scripts/seed-gates-v2-age18";
import { makeControlPlaneCommunityStore } from "./community-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_GATES_V2_COMMUNITY_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-gates-v2-community-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-gates-v2-community-suite-complete\n";
let completedTestCount = 0;

function schemaIdentifier(): string {
  return `api_next_gates_v2_community_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    await runPostgresMigrations({
      connectionString: connectionForSchema(connectionString, schema),
    });
    await admin.query("INSERT INTO users (user_id) VALUES ('user-a')");
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function runStore<A, E>(
  connection: string,
  use: (store: CommunityStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeControlPlaneCommunityStore(layer);
  return Effect.runPromise(Effect.scoped(use(store)));
}

async function prepareCommunity(connection: string, communityId: string): Promise<void> {
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  try {
    await admin.query({
      text: `INSERT INTO communities
        (community_id, display_name, status, membership_mode, created_by_user_id, created_at, updated_at)
        VALUES ($1, 'Age gated', 'active', 'gated', 'user-a', now(), now())`,
      values: [communityId],
    });
  } finally {
    await admin.end();
  }
  await seedCuratedAge18Policy({
    connectionString: connection,
    communityId,
  });
}

async function insertCompletedEvidence(
  admin: Client,
  input: Readonly<{ readonly age: string; readonly expired?: boolean }>,
): Promise<void> {
  const expiry = input.expired
    ? "clock_timestamp() - interval '1 minute'"
    : "clock_timestamp() + interval '1 day'";
  await admin.query("BEGIN");
  try {
    await admin.query({
      text: `INSERT INTO proof_sessions (
        proof_session_id, actor_id, intent_id, request_hash, provider_id,
        provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
        method, issuer, scope_kind, issuer_rp_scope, issuer_rp_action_scope,
        request_mode, protocol_version, environment, status, requested_requirements,
        requested_claim_ids, subject_binding_intent, started_at, expires_at,
        upstream_session_ref
      ) VALUES (
        'proof-age', 'user-a', 'intent-age', repeat('a', 64), 'zkpassport',
        'managed', 'community-age', '1', 'document', 'zkpassport',
        'issuer_rp_scope', 'pirate-social', NULL, 'curated', 'gates-v2', 'test', 'pending',
        $1::jsonb, $2::jsonb, 'establish', clock_timestamp(),
        clock_timestamp() + interval '1 day', 'upstream-age'
      )`,
      values: [
        JSON.stringify([
          { claim_id: "age.minimum", minimum_age: "18" },
          { claim_id: "credential.subject_unique" },
          { claim_id: "document.valid" },
        ]),
        JSON.stringify(["age.minimum", "credential.subject_unique", "document.valid"]),
      ],
    });
    await admin.query({
      text: `INSERT INTO subject_keys (
        subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
        issuer_rp_action_scope, subject_digest
      ) VALUES ('subject-age', 'zkpassport', 'document', 'issuer_rp_scope', 'pirate-social', NULL, repeat('1', 64))`,
    });
    await admin.query({
      text: `INSERT INTO subject_key_binding_events (
        binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
        binding_kind, idempotency_key, bound_at
      ) VALUES ('binding-event-age', 'subject-age', 1, 'user-a', 'proof-age',
                'initial', 'bind-age', clock_timestamp())`,
    });
    await admin.query({
      text: `INSERT INTO evidence_receipts (
        evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
        scope_kind, issuer_rp_scope, issuer_rp_action_scope, protocol_version, environment,
        evidence_kind, evidence_hash, receipt_metadata, observed_at, expires_at,
        provenance_kind, subject_key_id, subject_binding_event_id, subject_binding_epoch,
        provider_configuration_kind, provider_configuration_ref, provider_configuration_version
      ) VALUES (
        'receipt-age', 'proof-age', 'user-a', 'zkpassport', 'zkpassport', 'document',
        'issuer_rp_scope', 'pirate-social', NULL, 'gates-v2', 'test', 'document', repeat('c', 64),
        '{}'::jsonb, clock_timestamp(), ${expiry}, 'proof_session', 'subject-age',
        'binding-event-age', 1, 'managed', 'community-age', '1'
      )`,
    });
    await admin.query({
      text: `INSERT INTO assertion_bindings (
        binding_group_id, user_id, binding_mode, subject_key_id,
        subject_binding_event_id, subject_binding_epoch
      ) VALUES ('binding-age', 'user-a', 'same_subject', 'subject-age', 'binding-event-age', 1)`,
    });
    await admin.query({
      text: `INSERT INTO assertions (
        assertion_id, binding_group_id, evidence_receipt_id, subject_key_id, user_id,
        claim_id, assertion_value, assurance, observed_at, expires_at
      ) VALUES
        ('assertion-age', 'binding-age', 'receipt-age', 'subject-age', 'user-a',
         'age.minimum', jsonb_build_object('minimum_age', $1::text), 'document_zk', clock_timestamp(), ${expiry}),
        ('assertion-unique', 'binding-age', 'receipt-age', 'subject-age', 'user-a',
         'credential.subject_unique', '{"subject_unique": true}'::jsonb, 'document_zk', clock_timestamp(), ${expiry}),
        ('assertion-document', 'binding-age', 'receipt-age', 'subject-age', 'user-a',
         'document.valid', '{"valid": true}'::jsonb, 'document_zk', clock_timestamp(), ${expiry})`,
      values: [input.age],
    });
    await admin.query({
      text: `UPDATE proof_sessions
                SET status = 'completed',
                    completed_at = CURRENT_TIMESTAMP,
                    completion_idempotency_key = 'complete-age',
                    completion_result_hash = repeat('b', 64),
                    terminal_at = CURRENT_TIMESTAMP
              WHERE proof_session_id = 'proof-age'`,
    });
    await admin.query({
      text: `INSERT INTO proof_session_completion_events (
        completion_event_id, proof_session_id, actor_id, idempotency_key,
        terminal_status, result_hash, terminal_at
      ) SELECT 'completion-age', proof_session_id, actor_id, completion_idempotency_key,
               status, completion_result_hash, terminal_at
          FROM proof_sessions
         WHERE proof_session_id = 'proof-age'`,
    });
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

suite("Gates v2 curated age community vertical", () => {
  test("records needs_evidence before denying a user without evidence", async () => {
    await withSchema(async (connection, admin) => {
      await prepareCommunity(connection, "community-needs");
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-needs",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "membership-required" });

      const rows = await admin.query({
        text: `SELECT evaluation_mode, outcome, winning_witness, trace
                 FROM decision_records
                WHERE community_id = $1 AND user_id = $2`,
        values: ["community-needs", "user-a"],
      });
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ evaluation_mode: "enforce", outcome: "needs_evidence" });
      expect(rows.rows[0]?.winning_witness).toEqual([]);
      expect(rows.rows[0]?.trace).toContain("required_claim_missing");

      const memberships = await admin.query({
        text: "SELECT COUNT(*)::int AS count FROM community_memberships WHERE community_id = $1",
        values: ["community-needs"],
      });
      expect(memberships.rows[0]?.count).toBe(0);
    });
    completedTestCount += 1;
  }, 30_000);

  test("rejects a current policy pointer that does not match the pinned policy", async () => {
    await withSchema(async (connection, admin) => {
      await prepareCommunity(connection, "community-policy-mismatch");
      await admin.query({
        text: `INSERT INTO policy_versions (
                 policy_version_id, community_id, policy_key, revision, policy_hash,
                 policy, compiled_plan, compiler_version, uniqueness_model,
                 created_by_user_id, published_at, policy_purpose
               ) VALUES (
                 'curated-age-v2', $1, 'curated-age', 2, repeat('d', 64),
                 '{"policy_version_id":"curated-age-v2"}'::jsonb,
                 '{"kind":"curated_age"}'::jsonb, 'gates-v2-curated-age-v1',
                 '{"kind":"none"}'::jsonb, NULL, clock_timestamp(), 'access'
               )`,
        values: ["community-policy-mismatch"],
      });
      await admin.query({
        text: `UPDATE community_policy_current
                  SET policy_version_id = 'curated-age-v2'
                WHERE community_id = $1 AND policy_key = 'curated-age'`,
        values: ["community-policy-mismatch"],
      });

      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-policy-mismatch",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "invalid-row" });

      const state = await admin.query({
        text: `SELECT
                 (SELECT COUNT(*)::int FROM decision_records WHERE community_id = $1) AS decisions,
                 (SELECT COUNT(*)::int FROM community_memberships WHERE community_id = $1) AS memberships`,
        values: ["community-policy-mismatch"],
      });
      expect(state.rows[0]).toEqual({ decisions: 0, memberships: 0 });
    });
    completedTestCount += 1;
  }, 30_000);

  test("loads evidence, persists an array witness, joins atomically, and replays by membership predicate", async () => {
    await withSchema(async (connection, admin) => {
      await prepareCommunity(connection, "community-pass");
      await insertCompletedEvidence(admin, { age: "18" });

      await expect(
        runStore(connection, (store) =>
          store.getJoinEligibility({ communityId: "community-pass", userId: "user-a" }),
        ),
      ).resolves.toMatchObject({
        status: "joinable",
        joinable_now: true,
        gate_evaluation: { outcome: "pass" },
      });
      const previewDecisions = await admin.query({
        text: "SELECT COUNT(*)::int AS count FROM decision_records WHERE community_id = $1 AND user_id = $2",
        values: ["community-pass", "user-a"],
      });
      expect(previewDecisions.rows[0]?.count).toBe(0);
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-pass",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).resolves.toEqual({ community: "community-pass", status: "joined" });

      const rows = await admin.query({
        text: `SELECT policy_version_id, policy_hash, evaluation_mode, outcome,
                      jsonb_typeof(winning_witness) AS witness_type,
                      jsonb_array_length(winning_witness) AS witness_count,
                      winning_witness
                 FROM decision_records
                WHERE community_id = $1 AND user_id = $2`,
        values: ["community-pass", "user-a"],
      });
      expect(rows.rows).toEqual([
        expect.objectContaining({
          policy_version_id: CURATED_AGE_18_POLICY.policy_version_id,
          policy_hash: CURATED_AGE_18_POLICY.policy_hash,
          evaluation_mode: "enforce",
          outcome: "pass",
          witness_type: "array",
          witness_count: 1,
          winning_witness: [
            {
              assertion_ids: ["assertion-age", "assertion-document", "assertion-unique"],
              evidence_receipt_ids: ["receipt-age"],
              subject_key_id: "subject-age",
              binding_group_id: "binding-age",
            },
          ],
        }),
      ]);

      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-pass",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).resolves.toEqual({ community: "community-pass", status: "joined" });
      const membership = await admin.query({
        text: "SELECT COUNT(*)::int AS count FROM community_memberships WHERE community_id = $1 AND user_id = $2",
        values: ["community-pass", "user-a"],
      });
      expect(membership.rows[0]?.count).toBe(1);
      const decisionCount = await admin.query({
        text: "SELECT COUNT(*)::int AS count FROM decision_records WHERE community_id = $1 AND user_id = $2",
        values: ["community-pass", "user-a"],
      });
      expect(decisionCount.rows[0]?.count).toBe(1);
    });
    completedTestCount += 1;
  }, 30_000);

  test("keeps underage evidence terminal and never creates membership without enforce/pass", async () => {
    await withSchema(async (connection, admin) => {
      await prepareCommunity(connection, "community-underage");
      await insertCompletedEvidence(admin, { age: "17" });
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-underage",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "membership-required" });

      const decision = await admin.query({
        text: "SELECT outcome, trace FROM decision_records WHERE community_id = $1 AND user_id = $2",
        values: ["community-underage", "user-a"],
      });
      expect(decision.rows[0]).toMatchObject({ outcome: "fail" });
      expect(decision.rows[0]?.trace).toContain("age_below_threshold");
      const membership = await admin.query({
        text: "SELECT COUNT(*)::int AS count FROM community_memberships WHERE community_id = $1",
        values: ["community-underage"],
      });
      expect(membership.rows[0]?.count).toBe(0);
      const invariant = await admin.query({
        text: `SELECT COUNT(*)::int AS count
                 FROM community_memberships AS membership
                 LEFT JOIN decision_records AS decision
                   ON decision.community_id = membership.community_id
                  AND decision.user_id = membership.user_id
                  AND decision.evaluation_mode = 'enforce'
                  AND decision.outcome = 'pass'
                WHERE membership.community_id = $1
                  AND decision.decision_record_id IS NULL`,
        values: ["community-underage"],
      });
      expect(invariant.rows[0]?.count).toBe(0);
    });
    completedTestCount += 1;
  }, 30_000);

  test("rolls back membership when decision persistence fails", async () => {
    await withSchema(async (connection, admin) => {
      await prepareCommunity(connection, "community-decision-rollback");
      await insertCompletedEvidence(admin, { age: "18" });
      await admin.query(`CREATE FUNCTION reject_gates_decision_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'test decision insert failure'; END; $$`);
      await admin.query(`CREATE TRIGGER reject_gates_decision_insert
        BEFORE INSERT ON decision_records
        FOR EACH ROW EXECUTE FUNCTION reject_gates_decision_insert()`);

      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-decision-rollback",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toBeDefined();

      const state = await admin.query({
        text: `SELECT
                 (SELECT COUNT(*)::int FROM decision_records WHERE community_id = $1) AS decisions,
                 (SELECT COUNT(*)::int FROM community_memberships WHERE community_id = $1) AS memberships`,
        values: ["community-decision-rollback"],
      });
      expect(state.rows[0]).toEqual({ decisions: 0, memberships: 0 });
    });
    completedTestCount += 1;
  }, 30_000);

  test("rolls back the decision when membership persistence fails", async () => {
    await withSchema(async (connection, admin) => {
      await prepareCommunity(connection, "community-rollback");
      await insertCompletedEvidence(admin, { age: "18" });
      await admin.query(`CREATE FUNCTION reject_gates_membership_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'test membership insert failure'; END; $$`);
      await admin.query(`CREATE TRIGGER reject_gates_membership_insert
        BEFORE INSERT ON community_memberships
        FOR EACH ROW EXECUTE FUNCTION reject_gates_membership_insert()`);

      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-rollback",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toBeDefined();

      const state = await admin.query({
        text: `SELECT
                 (SELECT COUNT(*)::int FROM decision_records WHERE community_id = $1 AND user_id = $2) AS decisions,
                 (SELECT COUNT(*)::int FROM community_memberships WHERE community_id = $1 AND user_id = $2) AS memberships`,
        values: ["community-rollback", "user-a"],
      });
      expect(state.rows[0]).toEqual({ decisions: 0, memberships: 0 });
    });
    completedTestCount += 1;
  }, 30_000);

  test("treats expired evidence as actionable needs_evidence", async () => {
    await withSchema(async (connection, admin) => {
      await prepareCommunity(connection, "community-expired");
      await insertCompletedEvidence(admin, { age: "18", expired: true });
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-expired",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "membership-required" });

      const decision = await admin.query({
        text: "SELECT outcome, trace FROM decision_records WHERE community_id = $1 AND user_id = $2",
        values: ["community-expired", "user-a"],
      });
      expect(decision.rows[0]).toMatchObject({ outcome: "needs_evidence" });
      expect(decision.rows[0]?.trace).toContain("evidence_expired");
    });
    completedTestCount += 1;
  }, 30_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 5) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
