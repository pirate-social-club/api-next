import { afterAll, describe, expect, test } from "bun:test";
import type { CommunityStore } from "@pirate/application";
import {
  COMMUNITY_GATE_COMPILER_VERSION,
  CURATED_AGE_18_POLICY,
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";

import { runPostgresMigrations } from "../../../scripts/postgres-migrations";
import { seedCuratedAge18Policy } from "../../../scripts/seed-gates-v2-age18";
import { makeCommunityJoinIntentResolver } from "./community-join-intent-resolver.ts";
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

function connectionForRole(raw: string, role: string): string {
  const connection = new URL(raw);
  const options = connection.searchParams.get("options") ?? "";
  connection.searchParams.set("options", `${options} -c role=${role}`.trim());
  return connection.toString();
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

const HUMAN_COMPILED_PLAN = {
  compiler_version: COMMUNITY_GATE_COMPILER_VERSION,
  evaluator: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
  provider_binding: {
    provider_id: VERY_WEB_PROVIDER_ID,
    provider_configuration: {
      kind: "dynamic",
      reference: VERY_WEB_CONFIGURATION_REFERENCE,
      version: VERY_WEB_CONFIGURATION_VERSION,
    },
    method: VERY_WEB_METHOD,
    protocol_version: VERY_WEB_PROTOCOL_VERSION,
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: VERY_WEB_ISSUER,
      rp_scope: VERY_WEB_RP_SCOPE,
    },
  },
} as const;

async function prepareHumanCommunity(
  admin: Client,
  communityId: string,
  options: Readonly<{ readonly providerId?: string }> = {},
): Promise<void> {
  await admin.query({
    text: `INSERT INTO communities (
             community_id, display_name, status, membership_mode, human_verification_lane,
             created_by_user_id, created_at, updated_at
           ) VALUES ($1, 'Very gated', 'active', 'gated', 'very', 'user-a', now(), now())`,
    values: [communityId],
  });
  await admin.query({
    text: `INSERT INTO policy_versions (
             policy_version_id, community_id, policy_key, revision, policy_hash,
             policy, compiled_plan, compiler_version, uniqueness_model,
             created_by_user_id, published_at, policy_purpose
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8,
                     '{"kind":"none"}'::jsonb, 'user-a', clock_timestamp(), 'access')`,
    values: [
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
      communityId,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_revision,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
      JSON.stringify(CURATED_HUMAN_MEMBERSHIP_POLICY),
      JSON.stringify(HUMAN_COMPILED_PLAN),
      COMMUNITY_GATE_COMPILER_VERSION,
    ],
  });
  await admin.query({
    text: `INSERT INTO community_policy_provider_bindings (
             policy_version_id, community_id, policy_key, verification_requirement_hash,
             provider_id, provider_configuration_kind, provider_configuration_ref,
             provider_configuration_version, method, protocol_version, issuer, scope_kind,
             issuer_rp_scope, issuer_rp_action_scope, request_mode, evaluator_id
           ) VALUES ($1, $2, $3, $4, $5, 'dynamic', $6, $7, $8, $9, $10,
                     'issuer_rp_scope', $11, NULL, 'dynamic', $1)`,
    values: [
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
      communityId,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
      HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
      options.providerId ?? VERY_WEB_PROVIDER_ID,
      VERY_WEB_CONFIGURATION_REFERENCE,
      VERY_WEB_CONFIGURATION_VERSION,
      VERY_WEB_METHOD,
      VERY_WEB_PROTOCOL_VERSION,
      VERY_WEB_ISSUER,
      VERY_WEB_RP_SCOPE,
    ],
  });
  await admin.query({
    text: `INSERT INTO community_policy_current (
             community_id, policy_key, policy_version_id, activated_at, updated_at
           ) VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp())`,
    values: [
      communityId,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
    ],
  });
}

async function insertPendingVerySession(
  admin: Client,
  input: Readonly<{ readonly intentId: string; readonly proofSessionId: string }>,
): Promise<void> {
  await admin.query({
    text: `INSERT INTO proof_sessions (
             proof_session_id, actor_id, intent_id, request_hash, provider_id,
             provider_configuration_kind, provider_configuration_ref,
             provider_configuration_version, method, issuer, scope_kind, issuer_rp_scope,
             issuer_rp_action_scope, request_mode, protocol_version, environment, status,
             requested_requirements, requested_claim_ids, subject_binding_intent,
             started_at, expires_at, upstream_session_ref
           ) VALUES ($1, 'user-a', $2, repeat('a', 64), $3, 'dynamic', $4, $5, $6, $7,
                     'issuer_rp_scope', $8, NULL, 'dynamic', $9, 'test', 'pending',
                     $10::jsonb, $11::jsonb, 'establish', clock_timestamp(),
                     clock_timestamp() + interval '5 minutes', $12)`,
    values: [
      input.proofSessionId,
      input.intentId,
      VERY_WEB_PROVIDER_ID,
      VERY_WEB_CONFIGURATION_REFERENCE,
      VERY_WEB_CONFIGURATION_VERSION,
      VERY_WEB_METHOD,
      VERY_WEB_ISSUER,
      VERY_WEB_RP_SCOPE,
      VERY_WEB_PROTOCOL_VERSION,
      JSON.stringify([{ claim_id: "credential.subject_unique" }, { claim_id: "human.personhood" }]),
      JSON.stringify(["credential.subject_unique", "human.personhood"]),
      `upstream-${input.proofSessionId}`,
    ],
  });
}

async function completeVeryEvidence(
  admin: Client,
  input: Readonly<{ readonly proofSessionId: string; readonly suffix: string }>,
): Promise<void> {
  const subjectId = `subject-${input.suffix}`;
  const bindingEventId = `binding-event-${input.suffix}`;
  const receiptId = `receipt-${input.suffix}`;
  const bindingId = `binding-${input.suffix}`;
  await admin.query("BEGIN");
  try {
    await admin.query({
      text: `INSERT INTO subject_keys (
               subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
               issuer_rp_action_scope, subject_digest
             ) VALUES ($1, $2, $3, 'issuer_rp_scope', $4, NULL, repeat('1', 64))`,
      values: [subjectId, VERY_WEB_ISSUER, VERY_WEB_METHOD, VERY_WEB_RP_SCOPE],
    });
    await admin.query({
      text: `INSERT INTO subject_key_binding_events (
               binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
               binding_kind, idempotency_key, bound_at
             ) VALUES ($1, $2, 1, 'user-a', $3, 'initial', $4, clock_timestamp())`,
      values: [bindingEventId, subjectId, input.proofSessionId, `bind-${input.suffix}`],
    });
    await admin.query({
      text: `INSERT INTO evidence_receipts (
               evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
               scope_kind, issuer_rp_scope, issuer_rp_action_scope, protocol_version, environment,
               evidence_kind, evidence_hash, receipt_metadata, observed_at, expires_at,
               provenance_kind, subject_key_id, subject_binding_event_id, subject_binding_epoch,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version
             ) VALUES ($1, $2, 'user-a', $3, $4, $5, 'issuer_rp_scope', $6, NULL, $7,
                       'test', 'very.web.server-verified.v1', repeat('c', 64), '{}'::jsonb,
                       clock_timestamp(), clock_timestamp() + interval '1 day', 'proof_session',
                       $8, $9, 1, 'dynamic', $10, $11)`,
      values: [
        receiptId,
        input.proofSessionId,
        VERY_WEB_PROVIDER_ID,
        VERY_WEB_ISSUER,
        VERY_WEB_METHOD,
        VERY_WEB_RP_SCOPE,
        VERY_WEB_PROTOCOL_VERSION,
        subjectId,
        bindingEventId,
        VERY_WEB_CONFIGURATION_REFERENCE,
        VERY_WEB_CONFIGURATION_VERSION,
      ],
    });
    await admin.query({
      text: `INSERT INTO assertion_bindings (
               binding_group_id, user_id, binding_mode, subject_key_id,
               subject_binding_event_id, subject_binding_epoch
             ) VALUES ($1, 'user-a', 'same_subject', $2, $3, 1)`,
      values: [bindingId, subjectId, bindingEventId],
    });
    await admin.query({
      text: `INSERT INTO assertions (
               assertion_id, binding_group_id, evidence_receipt_id, subject_key_id, user_id,
               claim_id, assertion_value, assurance, observed_at, expires_at
             ) VALUES
               ($1, $2, $3, $4, 'user-a', 'human.personhood',
                '{"personhood":true}'::jsonb, 'provider_attested', clock_timestamp(),
                clock_timestamp() + interval '1 day'),
               ($5, $2, $3, $4, 'user-a', 'credential.subject_unique',
                '{"subject_unique":true}'::jsonb, 'provider_attested', clock_timestamp(),
                clock_timestamp() + interval '1 day')`,
      values: [
        `assertion-person-${input.suffix}`,
        bindingId,
        receiptId,
        subjectId,
        `assertion-unique-${input.suffix}`,
      ],
    });
    await admin.query({
      text: `WITH terminal(value) AS (SELECT clock_timestamp())
             UPDATE proof_sessions
                SET status = 'completed',
                    completed_at = terminal.value,
                    completion_idempotency_key = $2,
                    completion_result_hash = repeat('b', 64),
                    terminal_at = terminal.value
               FROM terminal
              WHERE proof_session_id = $1`,
      values: [input.proofSessionId, `complete-${input.suffix}`],
    });
    await admin.query({
      text: `INSERT INTO proof_session_completion_events (
               completion_event_id, proof_session_id, actor_id, idempotency_key,
               terminal_status, result_hash, terminal_at
             ) SELECT $2, proof_session_id, actor_id, completion_idempotency_key,
                      status, completion_result_hash, terminal_at
                 FROM proof_sessions
                WHERE proof_session_id = $1`,
      values: [input.proofSessionId, `completion-${input.suffix}`],
    });
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function recoverSubjectToAnotherUser(admin: Client, suffix: string): Promise<void> {
  await admin.query("INSERT INTO users (user_id) VALUES ('user-b') ON CONFLICT DO NOTHING");
  await admin.query({
    text: `INSERT INTO proof_sessions (
             proof_session_id, actor_id, intent_id, request_hash, provider_id,
             provider_configuration_kind, provider_configuration_ref,
             provider_configuration_version, method, issuer, scope_kind, issuer_rp_scope,
             issuer_rp_action_scope, request_mode, protocol_version, environment, status,
             requested_requirements, requested_claim_ids, subject_binding_intent,
             started_at, expires_at, upstream_session_ref
           ) VALUES ($1, 'user-b', $2, repeat('d', 64), $3, 'dynamic', $4, $5, $6, $7,
                     'issuer_rp_scope', $8, NULL, 'dynamic', $9, 'test', 'pending',
                     $10::jsonb, $11::jsonb, 'recover', clock_timestamp(),
                     clock_timestamp() + interval '5 minutes', $12)`,
    values: [
      `proof-recovery-${suffix}`,
      `recovery-intent-${suffix}`,
      VERY_WEB_PROVIDER_ID,
      VERY_WEB_CONFIGURATION_REFERENCE,
      VERY_WEB_CONFIGURATION_VERSION,
      VERY_WEB_METHOD,
      VERY_WEB_ISSUER,
      VERY_WEB_RP_SCOPE,
      VERY_WEB_PROTOCOL_VERSION,
      JSON.stringify([{ claim_id: "credential.subject_unique" }, { claim_id: "human.personhood" }]),
      JSON.stringify(["credential.subject_unique", "human.personhood"]),
      `upstream-recovery-${suffix}`,
    ],
  });
  await admin.query({
    text: `INSERT INTO subject_key_binding_events (
             binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
             binding_kind, previous_binding_event_id, idempotency_key, bound_at
           ) VALUES ($1, $2, 2, 'user-b', $3, 'recovery', $4, $5, clock_timestamp())`,
    values: [
      `binding-event-recovery-${suffix}`,
      `subject-${suffix}`,
      `proof-recovery-${suffix}`,
      `binding-event-${suffix}`,
      `bind-recovery-${suffix}`,
    ],
  });
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

  test("issues, replays, waits, and joins through exact persisted Very evidence", async () => {
    await withSchema(async (connection, admin) => {
      await prepareHumanCommunity(admin, "community-human");

      const first = await runStore(connection, (store) =>
        store.getJoinEligibility({ communityId: "community-human", userId: "user-a" }),
      );
      expect(first).toMatchObject({
        status: "verification_required",
        missing_capabilities: ["human_verification"],
        next_action: { kind: "start_verification", provider_id: "very.web" },
      });
      const intentId =
        first?.next_action.kind === "start_verification" ? first.next_action.intent_id : null;
      expect(intentId).toStartWith("community-join_");
      if (intentId === null) throw new Error("expected a Very join intent");

      const resolver = makeCommunityJoinIntentResolver(
        <Row>(statement: { readonly text: string; readonly values: readonly unknown[] }) =>
          Effect.promise(async () => {
            const result = await admin.query({
              text: statement.text,
              values: [...statement.values],
            });
            return { rows: result.rows as readonly Row[], rowCount: result.rowCount ?? 0 };
          }),
        "test",
      );
      await expect(
        Effect.runPromise(
          resolver.resolve({
            actor_id: "user-a",
            intent_id: intentId,
            provider_id: "very.web",
          }),
        ),
      ).resolves.toMatchObject({ method: "palm_web", environment: "test" });
      await expect(
        Effect.runPromise(
          resolver.resolve({
            actor_id: "user-b",
            intent_id: intentId,
            provider_id: "very.web",
          }),
        ),
      ).resolves.toBeNull();

      const replay = await runStore(connection, (store) =>
        store.getJoinEligibility({ communityId: "community-human", userId: "user-a" }),
      );
      expect(replay?.next_action).toEqual({
        kind: "start_verification",
        provider_id: "very.web",
        intent_id: intentId,
      });

      await insertPendingVerySession(admin, {
        intentId,
        proofSessionId: "proof-human",
      });
      const waiting = await runStore(connection, (store) =>
        store.getJoinEligibility({ communityId: "community-human", userId: "user-a" }),
      );
      expect(waiting?.next_action).toEqual({
        kind: "wait",
        reason_code: "verification_pending",
      });

      await completeVeryEvidence(admin, { proofSessionId: "proof-human", suffix: "human" });
      await admin.query({
        text: `UPDATE action_intents
                  SET expires_at = clock_timestamp() - interval '1 minute'
                WHERE action_intent_id = $1`,
        values: [intentId],
      });
      await expect(
        Effect.runPromise(
          resolver.resolve({
            actor_id: "user-a",
            intent_id: intentId,
            provider_id: "very.web",
          }),
        ),
      ).resolves.toMatchObject({ method: "palm_web", environment: "test" });
      const eligible = await runStore(connection, (store) =>
        store.getJoinEligibility({ communityId: "community-human", userId: "user-a" }),
      );
      expect(eligible).toMatchObject({
        status: "joinable",
        joinable_now: true,
        gate_evaluation: { outcome: "pass" },
        next_action: { kind: "join" },
      });

      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-human",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).resolves.toEqual({ community: "community-human", status: "joined" });

      const state = await admin.query({
        text: `SELECT
                 (SELECT COUNT(*)::int FROM action_intents
                   WHERE community_id = $1 AND user_id = 'user-a') AS intents,
                 (SELECT COUNT(*)::int FROM decision_records
                   WHERE community_id = $1 AND user_id = 'user-a' AND outcome = 'pass') AS decisions,
                 (SELECT COUNT(*)::int FROM community_memberships
                   WHERE community_id = $1 AND user_id = 'user-a' AND status = 'member') AS memberships,
                 (SELECT COUNT(*)::int FROM community_follows
                   WHERE community_id = $1 AND user_id = 'user-a' AND status = 'active') AS follows`,
        values: ["community-human"],
      });
      expect(state.rows[0]).toEqual({ intents: 1, decisions: 1, memberships: 1, follows: 1 });
    });
    completedTestCount += 1;
  }, 30_000);

  test("issues a Very intent when the runtime role cannot update policy metadata", async () => {
    await withSchema(async (connection, admin) => {
      await prepareHumanCommunity(admin, "community-runtime-policy-reader");
      const schemaResult = await admin.query<{ current_schema: string }>(
        "SELECT current_schema() AS current_schema",
      );
      const schema = schemaResult.rows[0]?.current_schema;
      if (schema === undefined) throw new Error("expected a test schema");
      const role = `api_next_gates_runtime_${Math.random().toString(36).slice(2)}`;
      await admin.query(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN`);
      try {
        await admin.query(
          `GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(role)}`,
        );
        await admin.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(role)}`,
        );
        await admin.query(
          `REVOKE UPDATE ON policy_versions, community_policy_current, community_policy_provider_bindings FROM ${quoteIdentifier(role)}`,
        );

        const eligibility = await runStore(connectionForRole(connection, role), (store) =>
          store.getJoinEligibility({
            communityId: "community-runtime-policy-reader",
            userId: "user-a",
          }),
        );
        expect(eligibility).toMatchObject({
          status: "verification_required",
          next_action: { kind: "start_verification", provider_id: "very.web" },
        });
      } finally {
        await admin.query(`DROP OWNED BY ${quoteIdentifier(role)}`);
        await admin.query(`DROP ROLE ${quoteIdentifier(role)}`);
      }
    });
    completedTestCount += 1;
  }, 30_000);

  test("does not treat a Very creation ceremony as join evidence", async () => {
    await withSchema(async (connection, admin) => {
      await prepareHumanCommunity(admin, "community-creation-evidence");
      await insertPendingVerySession(admin, {
        intentId: "community-creation-intent",
        proofSessionId: "proof-creation-only",
      });
      await completeVeryEvidence(admin, {
        proofSessionId: "proof-creation-only",
        suffix: "creation-only",
      });

      const eligibility = await runStore(connection, (store) =>
        store.getJoinEligibility({
          communityId: "community-creation-evidence",
          userId: "user-a",
        }),
      );
      expect(eligibility).toMatchObject({
        status: "verification_required",
        gate_evaluation: { outcome: "needs_evidence" },
        next_action: { kind: "start_verification", provider_id: "very.web" },
      });
      expect(
        eligibility?.next_action.kind === "start_verification"
          ? eligibility.next_action.intent_id
          : null,
      ).not.toBe("community-creation-intent");

      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-creation-evidence",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "membership-required" });
    });
    completedTestCount += 1;
  }, 30_000);

  test("fails closed before issuing an intent when the persisted provider binding drifts", async () => {
    await withSchema(async (connection, admin) => {
      await prepareHumanCommunity(admin, "community-binding-drift", {
        providerId: "very.web.wrong",
      });
      await expect(
        runStore(connection, (store) =>
          store.getJoinEligibility({
            communityId: "community-binding-drift",
            userId: "user-a",
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "invalid-row" });
      const intents = await admin.query({
        text: "SELECT COUNT(*)::int AS count FROM action_intents WHERE community_id = $1",
        values: ["community-binding-drift"],
      });
      expect(intents.rows[0]?.count).toBe(0);
    });
    completedTestCount += 1;
  }, 30_000);

  test("serializes concurrent eligibility reads onto one opaque join intent", async () => {
    await withSchema(async (connection, admin) => {
      await prepareHumanCommunity(admin, "community-intent-race");
      const [left, right] = await Promise.all([
        runStore(connection, (store) =>
          store.getJoinEligibility({ communityId: "community-intent-race", userId: "user-a" }),
        ),
        runStore(connection, (store) =>
          store.getJoinEligibility({ communityId: "community-intent-race", userId: "user-a" }),
        ),
      ]);
      expect(left?.next_action).toEqual(right?.next_action);
      expect(left?.next_action.kind).toBe("start_verification");
      const intents = await admin.query({
        text: `SELECT COUNT(*)::int AS count
                 FROM action_intents
                WHERE community_id = $1 AND user_id = 'user-a'`,
        values: ["community-intent-race"],
      });
      expect(intents.rows[0]?.count).toBe(1);
    });
    completedTestCount += 1;
  }, 30_000);

  test("locks passing Very evidence in completion order before committing membership", async () => {
    await withSchema(async (connection, admin) => {
      await prepareHumanCommunity(admin, "community-join-lock-order");
      const eligibility = await runStore(connection, (store) =>
        store.getJoinEligibility({
          communityId: "community-join-lock-order",
          userId: "user-a",
        }),
      );
      const intentId =
        eligibility?.next_action.kind === "start_verification"
          ? eligibility.next_action.intent_id
          : null;
      if (intentId === null) throw new Error("expected a Very join intent");
      await insertPendingVerySession(admin, {
        intentId,
        proofSessionId: "proof-join-lock-order",
      });
      await completeVeryEvidence(admin, {
        proofSessionId: "proof-join-lock-order",
        suffix: "join-lock-order",
      });

      const blocker = new Client({ connectionString: connection });
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query({
        text: `SELECT proof_session_id
                 FROM proof_sessions
                WHERE proof_session_id = $1
                FOR UPDATE`,
        values: ["proof-join-lock-order"],
      });

      let settled = false;
      const joining = runStore(connection, (store) =>
        store.join({
          communityId: "community-join-lock-order",
          actor: { userId: "user-a", kind: "user" },
          body: {},
        }),
      ).finally(() => {
        settled = true;
      });
      try {
        await Bun.sleep(50);
        expect(settled).toBe(false);
        const state = await admin.query({
          text: `SELECT COUNT(*)::int AS count
                   FROM community_memberships
                  WHERE community_id = $1 AND user_id = 'user-a'`,
          values: ["community-join-lock-order"],
        });
        expect(state.rows[0]?.count).toBe(0);
      } finally {
        await blocker.query("COMMIT");
        await blocker.end();
      }

      await expect(joining).resolves.toEqual({
        community: "community-join-lock-order",
        status: "joined",
      });
    });
    completedTestCount += 1;
  }, 30_000);

  test("invalidates completed join evidence after active subject ownership recovery", async () => {
    await withSchema(async (connection, admin) => {
      await prepareHumanCommunity(admin, "community-subject-recovery");
      const first = await runStore(connection, (store) =>
        store.getJoinEligibility({
          communityId: "community-subject-recovery",
          userId: "user-a",
        }),
      );
      const intentId =
        first?.next_action.kind === "start_verification" ? first.next_action.intent_id : null;
      if (intentId === null) throw new Error("expected a Very join intent");
      await insertPendingVerySession(admin, {
        intentId,
        proofSessionId: "proof-subject-recovery",
      });
      await completeVeryEvidence(admin, {
        proofSessionId: "proof-subject-recovery",
        suffix: "subject-recovery",
      });
      const before = await runStore(connection, (store) =>
        store.getJoinEligibility({
          communityId: "community-subject-recovery",
          userId: "user-a",
        }),
      );
      expect(before?.next_action).toEqual({ kind: "join" });

      await recoverSubjectToAnotherUser(admin, "subject-recovery");
      const after = await runStore(connection, (store) =>
        store.getJoinEligibility({
          communityId: "community-subject-recovery",
          userId: "user-a",
        }),
      );
      expect(after).toMatchObject({
        status: "verification_required",
        gate_evaluation: { outcome: "needs_evidence" },
        next_action: { kind: "start_verification", provider_id: "very.web" },
      });
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-subject-recovery",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "membership-required" });
    });
    completedTestCount += 1;
  }, 30_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 14) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
