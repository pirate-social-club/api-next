import { afterAll, describe, expect, test } from "bun:test";
import { compileNationalityPolicy, type NationalityPolicy } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";

import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { loadCuratedNationalityEvaluation } from "./gates-v2-community.ts";
import { ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_GATES_V2_NATIONALITY_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-gates-v2-nationality-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-gates-v2-nationality-suite-complete\n";
let completedTestCount = 0;

function schemaIdentifier(): string {
  return `api_next_gates_v2_nationality_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
    await applyPostgresTestBaselineConnection({
      connectionString: connectionForSchema(connectionString, schema),
    });
    await admin.query("INSERT INTO users (user_id) VALUES ('user-a')");
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

const providerFixtures = ["self.pass", "zkpassport"].map((provider_id) => ({
  provider_id,
  provider_configuration: { kind: "dynamic", reference: `test:${provider_id}`, version: "1" },
  method: "document",
  protocol_version: provider_id === "self.pass" ? "self-pass-v1" : "zkpassport-v2",
  scope: {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: provider_id,
    rp_scope: "test",
  },
  environment: "test",
}));

function nationalityPolicy(allowedCountries: readonly string[]): NationalityPolicy {
  const compilation = compileNationalityPolicy({
    policy_revision: 1,
    allowed_countries: allowedCountries,
    evidence_lifetime: { kind: "max_age_seconds", seconds: 3600 },
    provider_bindings: providerFixtures,
  });
  if (compilation.kind !== "compiled")
    throw new Error(`fixture did not compile: ${compilation.reason}`);
  return compilation.policy;
}

async function insertCompletedNationalityEvidence(
  admin: Client,
  input: Readonly<{
    readonly suffix: string;
    readonly provider: "self.pass" | "zkpassport";
    readonly requirement: Readonly<{
      claim_id: "nationality.allowed";
      allowed_countries: readonly string[];
    }>;
    readonly expired?: boolean;
  }>,
): Promise<void> {
  const provider = input.provider === "self.pass" ? providerFixtures[0] : providerFixtures[1];
  if (provider === undefined) throw new Error("provider fixture missing");
  const sessionId = `proof-nationality-${input.suffix}`;
  const subjectId = `subject-nationality-${input.suffix}`;
  const bindingEventId = `binding-event-nationality-${input.suffix}`;
  const receiptId = `receipt-nationality-${input.suffix}`;
  const bindingId = `binding-nationality-${input.suffix}`;
  const assertionId = `assertion-nationality-${input.suffix}`;
  const receiptObservedAt = input.expired
    ? "clock_timestamp() - interval '2 hours'"
    : "clock_timestamp()";
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
           ) VALUES ($1, 'user-a', $2, repeat('a', 64), $3, 'dynamic', $4, '1',
                     'document', $3, 'issuer_rp_scope', 'test', NULL, 'dynamic', $5, 'test',
                     'pending', $6::jsonb, $7::jsonb, 'establish', clock_timestamp() - interval '2 hours',
                     clock_timestamp() + interval '1 day', $8)`,
      values: [
        sessionId,
        `nationality-intent-${input.suffix}`,
        provider.provider_id,
        provider.provider_configuration.reference,
        provider.protocol_version,
        JSON.stringify([input.requirement]),
        JSON.stringify(["nationality.allowed"]),
        `upstream-${input.suffix}`,
      ],
    });
    await admin.query({
      text: `INSERT INTO subject_keys (
             subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
             issuer_rp_action_scope, subject_digest
           ) VALUES ($1, $2, 'document', 'issuer_rp_scope', 'test', NULL, repeat('1', 64))`,
      values: [subjectId, provider.provider_id],
    });
    await admin.query({
      text: `INSERT INTO subject_key_binding_events (
             binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
             binding_kind, idempotency_key, bound_at
           ) VALUES ($1, $2, 1, 'user-a', $3, 'initial', $4, clock_timestamp())`,
      values: [bindingEventId, subjectId, sessionId, `bind-${input.suffix}`],
    });
    await admin.query({
      text: `INSERT INTO evidence_receipts (
             evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
             scope_kind, issuer_rp_scope, issuer_rp_action_scope, protocol_version, environment,
             evidence_kind, evidence_hash, receipt_metadata, observed_at, expires_at,
             provenance_kind, subject_key_id, subject_binding_event_id, subject_binding_epoch,
             provider_configuration_kind, provider_configuration_ref, provider_configuration_version
           ) VALUES ($1, $2, 'user-a', $3, $3, 'document', 'issuer_rp_scope', 'test', NULL, $4,
                     'test', 'document', repeat('c', 64), '{}'::jsonb, ${receiptObservedAt}, ${expiry},
                     'proof_session', $5, $6, 1, 'dynamic', $7, '1')`,
      values: [
        receiptId,
        sessionId,
        provider.provider_id,
        provider.protocol_version,
        subjectId,
        bindingEventId,
        provider.provider_configuration.reference,
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
           ) VALUES ($1, $2, $3, $4, 'user-a', 'nationality.allowed',
                     '{"allowed": true}'::jsonb, 'document_zk', clock_timestamp(), NULL)`,
      values: [assertionId, bindingId, receiptId, subjectId],
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
      values: [sessionId, `complete-${input.suffix}`],
    });
    await admin.query({
      text: `INSERT INTO proof_session_completion_events (
             completion_event_id, proof_session_id, actor_id, idempotency_key,
             terminal_status, result_hash, terminal_at
           ) SELECT $2, proof_session_id, actor_id, completion_idempotency_key,
                    status, completion_result_hash, terminal_at
               FROM proof_sessions
              WHERE proof_session_id = $1`,
      values: [sessionId, `completion-${input.suffix}`],
    });
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

function runEvaluation(
  connection: string,
  policy: NationalityPolicy,
): Promise<Record<string, unknown>> {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        loadCuratedNationalityEvaluation(transaction, { userId: "user-a", policy }),
      );
    }),
  );
  return Effect.runPromise(
    program.pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
  ) as Promise<Record<string, unknown>>;
}

const bindingRow = (communityId: string, policy: NationalityPolicy, providerId: string) => ({
  text: `INSERT INTO community_policy_provider_bindings (
           policy_version_id, community_id, policy_key, verification_requirement_hash,
           provider_id, provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, method, protocol_version, issuer, scope_kind,
           issuer_rp_scope, issuer_rp_action_scope, request_mode, evaluator_id
         ) VALUES ('curated-nationality-v1', $1, 'curated-nationality', $2, $3, 'dynamic', $4, '1',
                   'document', $5, $3, 'issuer_rp_scope', 'test', NULL, 'dynamic',
                   'curated-nationality-v1')`,
  values: [
    communityId,
    policy.requirement_hash,
    providerId,
    `test:${providerId}`,
    providerId === "self.pass" ? "self-pass-v1" : "zkpassport-v2",
  ],
});

suite("Gates v2 nationality provider alternatives and evidence loader", () => {
  test("widened provider key stores both alternatives and rejects a duplicate provider row", async () => {
    await withSchema(async (_connection, admin) => {
      const policy = nationalityPolicy(["US"]);
      await admin.query({
        text: `INSERT INTO communities (
                 community_id, display_name, status, membership_mode, created_by_user_id,
                 created_at, updated_at
               ) VALUES ('community-nationality', 'Nationality gated', 'active', 'gated',
                         'user-a', now(), now())`,
      });
      await admin.query({
        text: `INSERT INTO policy_versions (
                 policy_version_id, community_id, policy_key, revision, policy_hash,
                 policy, compiled_plan, compiler_version, uniqueness_model,
                 created_by_user_id, published_at, policy_purpose
               ) VALUES ('curated-nationality-v1', 'community-nationality', 'curated-nationality',
                         1, $1, $2::jsonb, '{"kind":"composed"}'::jsonb,
                         'community-gate-compiler-v2', '{"kind":"none"}'::jsonb, 'user-a',
                         clock_timestamp(), 'access')`,
        values: [policy.policy_hash, JSON.stringify(policy)],
      });
      await admin.query(bindingRow("community-nationality", policy, "self.pass"));
      await admin.query(bindingRow("community-nationality", policy, "zkpassport"));
      const rows = await admin.query({
        text: `SELECT provider_id
                 FROM community_policy_provider_bindings
                WHERE community_id = 'community-nationality'
                ORDER BY provider_id`,
      });
      expect(rows.rows.map((row) => row.provider_id)).toEqual(["self.pass", "zkpassport"]);
      await expect(
        admin.query(bindingRow("community-nationality", policy, "self.pass")),
      ).rejects.toMatchObject({ code: "23505" });
    });
    completedTestCount += 1;
  }, 30_000);

  test("loads account-bound evidence for either provider and passes with a witness", async () => {
    await withSchema(async (connection, admin) => {
      const policy = nationalityPolicy(["US"]);
      await insertCompletedNationalityEvidence(admin, {
        suffix: "self-pass",
        provider: "self.pass",
        requirement: policy.requirement,
      });
      const evaluation = await runEvaluation(connection, policy);
      expect(evaluation).toMatchObject({
        outcome: "pass",
        policy_hash: policy.policy_hash,
        requirement_hash: policy.requirement_hash,
        winning_witness: [
          {
            assertion_ids: ["assertion-nationality-self-pass"],
            evidence_receipt_ids: ["receipt-nationality-self-pass"],
            subject_key_id: "subject-nationality-self-pass",
            binding_group_id: "binding-nationality-self-pass",
          },
        ],
      });
    });
    completedTestCount += 1;
  }, 30_000);

  test("treats an unchanged-requirement mismatch as missing evidence, not reuse", async () => {
    await withSchema(async (connection, admin) => {
      const seeded = nationalityPolicy(["US"]);
      await insertCompletedNationalityEvidence(admin, {
        suffix: "requirement",
        provider: "self.pass",
        requirement: seeded.requirement,
      });
      const evaluation = await runEvaluation(connection, nationalityPolicy(["CA"]));
      expect(evaluation).toMatchObject({
        outcome: "needs_evidence",
        reason: "missing",
        requirement_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    });
    completedTestCount += 1;
  }, 30_000);

  test("expired evidence is actionable needs_evidence", async () => {
    await withSchema(async (connection, admin) => {
      const policy = nationalityPolicy(["US"]);
      await insertCompletedNationalityEvidence(admin, {
        suffix: "expired",
        provider: "self.pass",
        requirement: policy.requirement,
        expired: true,
      });
      const evaluation = await runEvaluation(connection, policy);
      expect(evaluation).toMatchObject({ outcome: "needs_evidence", reason: "expired" });
    });
    completedTestCount += 1;
  }, 30_000);

  test("latest revalidation outcome gates reuse without disclosing a country", async () => {
    await withSchema(async (connection, admin) => {
      const policy = nationalityPolicy(["US"]);
      await insertCompletedNationalityEvidence(admin, {
        suffix: "revalidation",
        provider: "self.pass",
        requirement: policy.requirement,
      });
      await admin.query({
        text: `INSERT INTO assertion_revalidation_events (
                 assertion_revalidation_event_id, assertion_id, user_id, evidence_receipt_id,
                 outcome, observed_at
               ) VALUES ('reval-revoked', 'assertion-nationality-revalidation', 'user-a',
                         'receipt-nationality-revalidation', 'revoked', clock_timestamp())`,
      });
      const revoked = await runEvaluation(connection, policy);
      expect(revoked).toMatchObject({ outcome: "needs_evidence", reason: "revoked" });
      expect(JSON.stringify(revoked)).not.toContain("US");

      await admin.query({
        text: `INSERT INTO assertion_revalidation_events (
                 assertion_revalidation_event_id, assertion_id, user_id, evidence_receipt_id,
                 outcome, observed_at
               ) VALUES ('reval-indeterminate', 'assertion-nationality-revalidation', 'user-a',
                         'receipt-nationality-revalidation', 'indeterminate', clock_timestamp())`,
      });
      const indeterminate = await runEvaluation(connection, policy);
      expect(indeterminate).toMatchObject({
        outcome: "indeterminate",
        reason: "evidence_store_unavailable",
      });
    });
    completedTestCount += 1;
  }, 30_000);

  test("ownership recovery to another account removes the evidence rather than failing it", async () => {
    await withSchema(async (connection, admin) => {
      const policy = nationalityPolicy(["US"]);
      await insertCompletedNationalityEvidence(admin, {
        suffix: "drift",
        provider: "zkpassport",
        requirement: policy.requirement,
      });
      const before = await runEvaluation(connection, policy);
      expect(before).toMatchObject({ outcome: "pass" });

      await admin.query("INSERT INTO users (user_id) VALUES ('user-b') ON CONFLICT DO NOTHING");
      await admin.query({
        text: `INSERT INTO proof_sessions (
                 proof_session_id, actor_id, intent_id, request_hash, provider_id,
                 provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
                 method, issuer, scope_kind, issuer_rp_scope, issuer_rp_action_scope, request_mode,
                 protocol_version, environment, status, requested_requirements, requested_claim_ids,
                 subject_binding_intent, started_at, expires_at, upstream_session_ref
               ) VALUES ('proof-nationality-drift-recovery', 'user-b', 'recovery-intent-drift',
                         repeat('d', 64), 'self.pass', 'dynamic', 'test:self.pass', '1', 'document',
                         'self.pass', 'issuer_rp_scope', 'test', NULL, 'dynamic', 'self-pass-v1',
                         'test', 'pending', $1::jsonb, $2::jsonb, 'recover', clock_timestamp(),
                         clock_timestamp() + interval '5 minutes', 'upstream-drift-recovery')`,
        values: [JSON.stringify([policy.requirement]), JSON.stringify(["nationality.allowed"])],
      });
      await admin.query({
        text: `INSERT INTO subject_key_binding_events (
                 binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
                 binding_kind, previous_binding_event_id, idempotency_key, bound_at
               ) VALUES ('binding-event-nationality-drift-2', 'subject-nationality-drift', 2,
                         'user-b', 'proof-nationality-drift-recovery', 'recovery',
                         'binding-event-nationality-drift', 'bind-drift-2', clock_timestamp())`,
      });
      const after = await runEvaluation(connection, policy);
      expect(after).toMatchObject({ outcome: "needs_evidence", reason: "missing" });
    });
    completedTestCount += 1;
  }, 30_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 6) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
