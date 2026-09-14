import { afterAll, describe, expect, test } from "bun:test";
import type { CommunityStore, JoinEligibilityDocument } from "@pirate/application";
import {
  COMMUNITY_GATE_COMPILER_VERSION,
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  communityJoinActionPayloadHash,
  communityJoinIntentBindingHash,
  compileNationalityPolicy,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  type NationalityPolicy,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "@pirate/domain";
import { startNationalityFixture } from "@pirate/testing/verification";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { enforceCreatorNationalityPolicy } from "./community-creation-repository.ts";
import { advanceCommunityCreationVerificationInTransaction } from "./community-creation-verification-settlement.ts";
import { makeControlPlaneCommunityJoinIntentResolver } from "./community-join-intent-resolver.ts";
import { makeControlPlaneCommunityStore } from "./community-repository.ts";
import { loadCuratedNationalityEvaluation } from "./gates-v2-community.ts";
import { ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneVerificationSessionStartStore } from "./verification-start-repository.ts";

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

function runStore<A, E>(
  connection: string,
  use: (store: CommunityStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  const store = makeControlPlaneCommunityStore(makeDirectPostgresControlPlaneLayer(connection));
  return Effect.runPromise(Effect.scoped(use(store)));
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
    readonly reuseBindingSuffix?: string;
  }>,
): Promise<void> {
  const provider = input.provider === "self.pass" ? providerFixtures[0] : providerFixtures[1];
  if (provider === undefined) throw new Error("provider fixture missing");
  const sessionId = `proof-nationality-${input.suffix}`;
  const subjectId = `subject-nationality-${input.reuseBindingSuffix ?? input.suffix}`;
  const bindingEventId = `binding-event-nationality-${input.reuseBindingSuffix ?? input.suffix}`;
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
    if (input.reuseBindingSuffix === undefined) {
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
    }
    await admin.query({
      text: `INSERT INTO evidence_receipts (
             evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
             scope_kind, issuer_rp_scope, issuer_rp_action_scope, protocol_version, environment,
             evidence_kind, evidence_hash, receipt_metadata, observed_at, expires_at,
             provenance_kind, subject_key_id, subject_binding_event_id, subject_binding_epoch,
             provider_configuration_kind, provider_configuration_ref, provider_configuration_version
           ) VALUES ($1, $2, 'user-a', $3, $3, 'document', 'issuer_rp_scope', 'test', NULL, $4,
                     'test', 'document', repeat('c', 60) || substr(md5($1), 1, 4), '{}'::jsonb,
                     ${receiptObservedAt}, ${expiry},
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
  providerId?: "self.pass" | "zkpassport",
): Promise<Record<string, unknown>> {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        loadCuratedNationalityEvaluation(transaction, {
          userId: "user-a",
          policy,
          ...(providerId === undefined ? {} : { providerId }),
        }),
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

async function seedHumanCommunity(admin: Client, communityId: string): Promise<void> {
  await admin.query({
    text: `INSERT INTO communities (
             community_id, display_name, status, membership_mode, human_verification_lane,
             created_by_user_id, created_at, updated_at
           ) VALUES ($1, 'Composed', 'active', 'gated', 'very', 'user-a', now(), now())`,
    values: [communityId],
  });
  await admin.query({
    text: `INSERT INTO policy_versions (
             policy_version_id, community_id, policy_key, revision, policy_hash,
             policy, compiled_plan, compiler_version, uniqueness_model,
             created_by_user_id, published_at, policy_purpose
           ) VALUES ('curated-human-membership-v1', $1, 'curated-human-membership', 1,
                     $2, $3::jsonb, $4::jsonb, 'community-gate-compiler-v1',
                     '{"kind":"none"}'::jsonb, 'user-a', clock_timestamp(), 'access')`,
    values: [
      communityId,
      CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
      JSON.stringify(CURATED_HUMAN_MEMBERSHIP_POLICY),
      JSON.stringify({
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
      }),
    ],
  });
  await admin.query({
    text: `INSERT INTO community_policy_provider_bindings (
             policy_version_id, community_id, policy_key, verification_requirement_hash,
             provider_id, provider_configuration_kind, provider_configuration_ref,
             provider_configuration_version, method, protocol_version, issuer, scope_kind,
             issuer_rp_scope, issuer_rp_action_scope, request_mode, evaluator_id
           ) VALUES ('curated-human-membership-v1', $1, 'curated-human-membership',
                     '${HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH}',
                     'very.web', 'dynamic', 'very-web', '1', 'palm_web', 'very-web-v1',
                     'https://verify.very.org', 'issuer_rp_scope', 'pirate-social', NULL,
                     'dynamic', 'curated-human-membership-v1')`,
    values: [communityId],
  });
  await admin.query({
    text: `INSERT INTO community_policy_current (community_id, policy_key, policy_version_id, activated_at)
           VALUES ($1, 'curated-human-membership', 'curated-human-membership-v1', clock_timestamp())`,
    values: [communityId],
  });
}

async function seedNationalityPolicy(
  admin: Client,
  communityId: string,
  policy: NationalityPolicy,
  persistBindings = true,
): Promise<void> {
  await admin.query({
    text: `INSERT INTO policy_versions (
             policy_version_id, community_id, policy_key, revision, policy_hash,
             policy, compiled_plan, compiler_version, uniqueness_model,
             created_by_user_id, published_at, policy_purpose
           ) VALUES ('curated-nationality-v1', $1, 'curated-nationality', 1, $2, $3::jsonb,
                     '{"kind":"nationality"}'::jsonb, 'community-gate-compiler-v2',
                     '{"kind":"none"}'::jsonb, 'user-a', clock_timestamp(), 'access')`,
    values: [communityId, policy.policy_hash, JSON.stringify(policy)],
  });
  for (const provider of persistBindings ? policy.provider_bindings : []) {
    await admin.query({
      text: `INSERT INTO community_policy_provider_bindings (
               policy_version_id, community_id, policy_key, verification_requirement_hash,
               provider_id, provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, method, protocol_version, issuer, scope_kind,
               issuer_rp_scope, issuer_rp_action_scope, request_mode, evaluator_id
             ) VALUES ('curated-nationality-v1', $1, 'curated-nationality', $2, $3,
                       'dynamic', $4, '1', 'document', $5, $3, 'issuer_rp_scope', 'test', NULL,
                       'dynamic', 'curated-nationality-v1')`,
      values: [
        communityId,
        policy.requirement_hash,
        provider.provider_id,
        provider.provider_configuration.reference,
        provider.protocol_version,
      ],
    });
  }
  await admin.query({
    text: `INSERT INTO community_policy_current (community_id, policy_key, policy_version_id, activated_at)
           VALUES ($1, 'curated-nationality', 'curated-nationality-v1', clock_timestamp())`,
    values: [communityId],
  });
}

async function seedPalmEvidence(admin: Client, suffix: string, communityId: string): Promise<void> {
  const subjectId = `subject-palm-${suffix}`;
  const bindingEventId = `binding-event-palm-${suffix}`;
  const receiptId = `receipt-palm-${suffix}`;
  await admin.query("BEGIN");
  try {
    await admin.query({
      text: `INSERT INTO subject_keys (subject_key_id, issuer, method, scope_kind, issuer_rp_scope, issuer_rp_action_scope, subject_digest)
             VALUES ($1, 'https://verify.very.org', 'palm_web', 'issuer_rp_scope', 'pirate-social', NULL,
                     repeat('1', 60) || substr(md5($2), 1, 4))`,
      values: [subjectId, suffix],
    });
    await admin.query({
      text: `INSERT INTO proof_sessions (
             proof_session_id, actor_id, intent_id, request_hash, provider_id,
             provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
             method, issuer, scope_kind, issuer_rp_scope, issuer_rp_action_scope, request_mode,
             protocol_version, environment, status, requested_requirements, requested_claim_ids,
             subject_binding_intent, started_at, expires_at, upstream_session_ref
           ) VALUES ($1, 'user-a', $2, repeat('a', 64), 'very.web', 'dynamic', 'very-web', '1',
                     'palm_web', 'https://verify.very.org', 'issuer_rp_scope', 'pirate-social', NULL,
                     'dynamic', 'very-web-v1', 'test', 'pending', $3::jsonb, $4::jsonb, 'establish',
                     clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day', $5)`,
      values: [
        `proof-palm-${suffix}`,
        `intent-palm-${suffix}`,
        JSON.stringify([
          { claim_id: "credential.subject_unique" },
          { claim_id: "human.personhood" },
        ]),
        JSON.stringify(["credential.subject_unique", "human.personhood"]),
        `upstream-palm-${suffix}`,
      ],
    });
    await admin.query({
      text: `INSERT INTO subject_key_binding_events (binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id, binding_kind, idempotency_key, bound_at)
             VALUES ($1, $2, 1, 'user-a', $4, 'initial', $3, clock_timestamp())`,
      values: [bindingEventId, subjectId, `bind-palm-${suffix}`, `proof-palm-${suffix}`],
    });
    await admin.query({
      text: `INSERT INTO evidence_receipts (
             evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method, scope_kind,
             issuer_rp_scope, issuer_rp_action_scope, protocol_version, environment, evidence_kind,
             evidence_hash, receipt_metadata, observed_at, expires_at, provenance_kind, subject_key_id,
             subject_binding_event_id, subject_binding_epoch, provider_configuration_kind,
             provider_configuration_ref, provider_configuration_version
           ) VALUES ($1, $2, 'user-a', 'very.web', 'https://verify.very.org', 'palm_web',
                     'issuer_rp_scope', 'pirate-social', NULL, 'very-web-v1', 'test',
                     'very.web.server-verified.v1',
                     repeat('c', 60) || substr(md5($5), 1, 4), '{}'::jsonb, clock_timestamp(),
                     clock_timestamp() + interval '1 day', 'proof_session', $3, $4, 1, 'dynamic',
                     'very-web', '1')`,
      values: [`receipt-palm-${suffix}`, `proof-palm-${suffix}`, subjectId, bindingEventId, suffix],
    });
    await admin.query({
      text: `INSERT INTO assertion_bindings (binding_group_id, user_id, binding_mode, subject_key_id, subject_binding_event_id, subject_binding_epoch)
             VALUES ($1, 'user-a', 'same_subject', $2, $3, 1)`,
      values: [`binding-palm-${suffix}`, subjectId, bindingEventId],
    });
    await admin.query({
      text: `INSERT INTO assertions (assertion_id, binding_group_id, evidence_receipt_id, subject_key_id, user_id, claim_id, assertion_value, assurance, observed_at, expires_at)
             VALUES ($1, $2, $3, $4, 'user-a', 'human.personhood', '{"personhood":true}'::jsonb,
                     'provider_attested', clock_timestamp(), clock_timestamp() + interval '1 day'),
                    ($5, $2, $3, $4, 'user-a', 'credential.subject_unique', '{"subject_unique":true}'::jsonb,
                     'provider_attested', clock_timestamp(), clock_timestamp() + interval '1 day')`,
      values: [
        `assertion-person-${suffix}`,
        `binding-palm-${suffix}`,
        `receipt-palm-${suffix}`,
        subjectId,
        `assertion-unique-${suffix}`,
      ],
    });
    await admin.query({
      text: `WITH terminal(value) AS (SELECT clock_timestamp())
             UPDATE proof_sessions SET status = 'completed', completed_at = terminal.value,
                    completion_idempotency_key = $2, completion_result_hash = repeat('b', 64),
                    terminal_at = terminal.value
               FROM terminal WHERE proof_session_id = $1`,
      values: [`proof-palm-${suffix}`, `complete-palm-${suffix}`],
    });
    await admin.query({
      text: `INSERT INTO proof_session_completion_events (completion_event_id, proof_session_id, actor_id, idempotency_key, terminal_status, result_hash, terminal_at)
             SELECT $2, proof_session_id, actor_id, completion_idempotency_key, status, completion_result_hash, terminal_at
               FROM proof_sessions WHERE proof_session_id = $1`,
      values: [`proof-palm-${suffix}`, `completion-palm-${suffix}`],
    });
    await admin.query({
      text: `INSERT INTO action_intents (action_intent_id, user_id, community_id, action_kind, action_scope, action_payload_hash, intent_binding_hash, idempotency_key, status, expires_at)
             VALUES ($1, 'user-a', $2, 'community_join', $2, $3, $4, $1, 'open', clock_timestamp() + interval '1 hour')`,
      values: [
        `intent-palm-${suffix}`,
        communityId,
        communityJoinActionPayloadHash(communityId),
        communityJoinIntentBindingHash({ actorId: "user-a", communityId }),
      ],
    });
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

const JOIN_NATIONALITY_RESULT_HASH = "b".repeat(64);

function assertProviderChoiceEligibility(
  document: JoinEligibilityDocument | null,
): asserts document is Extract<
  JoinEligibilityDocument,
  { readonly join_eligibility_version: "provider_choice_v2" }
> {
  if (document === null || !("join_eligibility_version" in document)) {
    throw new Error("expected the provider-choice eligibility projection");
  }
}

async function seedCompletedJoinNationalitySession(
  admin: Client,
  input: Readonly<{
    readonly sessionId: string;
    readonly actorId: string;
    readonly ceremonyIntentId: string;
    readonly requirement: Readonly<{
      readonly claim_id: "nationality.allowed";
      readonly allowed_countries: readonly string[];
    }>;
  }>,
): Promise<void> {
  await admin.query("BEGIN");
  try {
    const pending = await admin.query({
      text: `SELECT proof_session_id FROM proof_sessions WHERE proof_session_id=$1 AND actor_id=$2
        AND intent_id=$3 AND status='pending' AND requested_requirements=$4::jsonb`,
      values: [
        input.sessionId,
        input.actorId,
        input.ceremonyIntentId,
        JSON.stringify([input.requirement]),
      ],
    });
    expect(pending.rowCount).toBe(1);
    await admin.query({
      text: `WITH terminal(value) AS (SELECT clock_timestamp())
             UPDATE proof_sessions
                SET status = 'completed', completed_at = terminal.value,
                    completion_idempotency_key = $2, completion_result_hash = $3,
                    terminal_at = terminal.value
               FROM terminal WHERE proof_session_id = $1`,
      values: [input.sessionId, `complete-${input.sessionId}`, JOIN_NATIONALITY_RESULT_HASH],
    });
    await admin.query({
      text: `INSERT INTO proof_session_completion_events (
               completion_event_id, proof_session_id, actor_id, idempotency_key,
               terminal_status, result_hash, terminal_at
             ) SELECT $2, proof_session_id, actor_id, completion_idempotency_key,
                      status, completion_result_hash, terminal_at
                 FROM proof_sessions WHERE proof_session_id = $1`,
      values: [input.sessionId, `completion-${input.sessionId}`],
    });
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

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

  test("a revoked alternative cannot hide valid evidence and a pinned provider cannot substitute it", async () => {
    await withSchema(async (connection, admin) => {
      const policy = nationalityPolicy(["US"]);
      await insertCompletedNationalityEvidence(admin, {
        suffix: "valid-alternative",
        provider: "self.pass",
        requirement: policy.requirement,
      });
      await insertCompletedNationalityEvidence(admin, {
        suffix: "revoked-alternative",
        provider: "zkpassport",
        requirement: policy.requirement,
      });
      await admin.query(`INSERT INTO assertion_revalidation_events
        (assertion_revalidation_event_id,assertion_id,user_id,evidence_receipt_id,outcome,observed_at)
        VALUES ('alternative-revoked','assertion-nationality-revoked-alternative','user-a',
          'receipt-nationality-revoked-alternative','revoked',clock_timestamp())`);
      expect(await runEvaluation(connection, policy)).toMatchObject({
        outcome: "pass",
        winning_witness: [{ evidence_receipt_ids: ["receipt-nationality-valid-alternative"] }],
      });
      expect(await runEvaluation(connection, policy, "zkpassport")).toMatchObject({
        outcome: "needs_evidence",
        reason: "revoked",
      });
      expect(await runEvaluation(connection, policy, "self.pass")).toMatchObject({
        outcome: "pass",
      });
    });
    completedTestCount += 1;
  }, 30_000);

  test("enforcement serializes revalidation with its decision transaction", async () => {
    await withSchema(async (connection, admin) => {
      const policy = nationalityPolicy(["US"]);
      await insertCompletedNationalityEvidence(admin, {
        suffix: "locked",
        provider: "self.pass",
        requirement: policy.requirement,
      });
      const insertRevalidation = () =>
        admin.query(`INSERT INTO assertion_revalidation_events
        (assertion_revalidation_event_id,assertion_id,user_id,evidence_receipt_id,outcome,observed_at)
        VALUES ('lock-revoked','assertion-nationality-locked','user-a','receipt-nationality-locked','revoked',clock_timestamp())`);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* db.withTransaction((transaction) =>
              Effect.gen(function* () {
                const evaluation = yield* loadCuratedNationalityEvaluation(transaction, {
                  userId: "user-a",
                  policy,
                  lockEvidence: true,
                });
                expect(evaluation).toMatchObject({ outcome: "pass" });
                yield* Effect.promise(async () => {
                  await admin.query("SET statement_timeout = '150ms'");
                  try {
                    await expect(insertRevalidation()).rejects.toMatchObject({ code: "57014" });
                  } finally {
                    await admin.query("RESET statement_timeout");
                  }
                });
              }),
            );
          }),
        ).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
      );
      await insertRevalidation();
      expect(await runEvaluation(connection, policy)).toMatchObject({
        outcome: "needs_evidence",
        reason: "revoked",
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

  test("a current nationality policy with missing provider rows never becomes an open gate", async () => {
    await withSchema(async (connection, admin) => {
      const policy = nationalityPolicy(["US"]);
      const communityId = "community-missing-nationality-bindings";
      await seedHumanCommunity(admin, communityId);
      await seedNationalityPolicy(admin, communityId, policy, false);
      await seedPalmEvidence(admin, "missing-bindings", communityId);
      const eligibility = () =>
        runStore(connection, (store) =>
          store.getJoinEligibility({ communityId, userId: "user-a" }),
        );
      await expect(eligibility()).rejects.toMatchObject({ _tag: "CommunityRepositoryError" });
      await admin.query(bindingRow(communityId, policy, "self.pass"));
      await expect(eligibility()).rejects.toMatchObject({ _tag: "CommunityRepositoryError" });
      await admin.query(bindingRow(communityId, policy, "zkpassport"));
      expect(await eligibility()).toMatchObject({
        status: "verification_required",
        joinable_now: false,
      });
    });
    completedTestCount += 1;
  }, 30_000);

  test("palm alone cannot admit to a nationality-gated community", async () => {
    await withSchema(async (connection, admin) => {
      const policy = nationalityPolicy(["US"]);
      await seedHumanCommunity(admin, "community-composed-palm-only");
      await seedNationalityPolicy(admin, "community-composed-palm-only", policy);
      await seedPalmEvidence(admin, "palm-only", "community-composed-palm-only");
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-composed-palm-only",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toMatchObject({ _tag: "CommunityRepositoryError", reason: "membership-required" });
      const state = await admin.query({
        text: `SELECT
                 (SELECT COUNT(*)::int FROM community_memberships WHERE community_id = $1) AS memberships,
                 (SELECT COUNT(*)::int FROM decision_records WHERE community_id = $1 AND outcome = 'needs_evidence') AS nationality_missing`,
        values: ["community-composed-palm-only"],
      });
      expect(state.rows[0]).toEqual({ memberships: 0, nationality_missing: 1 });
    });
    completedTestCount += 1;
  }, 30_000);

  test("either document provider satisfies nationality alongside palm", async () => {
    await withSchema(async (connection, admin) => {
      for (const provider of ["self.pass", "zkpassport"] as const) {
        const communityId = `community-composed-${provider.replaceAll(".", "-")}`;
        const policy = nationalityPolicy(["US"]);
        await seedHumanCommunity(admin, communityId);
        await seedNationalityPolicy(admin, communityId, policy);
        await seedPalmEvidence(admin, provider.replaceAll(".", "-"), communityId);
        await insertCompletedNationalityEvidence(admin, {
          suffix: `composed-${provider.replaceAll(".", "-")}`,
          provider,
          requirement: policy.requirement,
        });
        await expect(
          runStore(connection, (store) =>
            store.join({
              communityId,
              actor: { userId: "user-a", kind: "user" },
              body: { persona: { kind: "create_new" } },
            }),
          ),
        ).resolves.toMatchObject({ community: communityId, status: "joined" });
        const decisions = await admin.query({
          text: `SELECT policy_version_id, outcome FROM decision_records WHERE community_id = $1 ORDER BY policy_version_id`,
          values: [communityId],
        });
        expect(decisions.rows).toEqual([
          { policy_version_id: "curated-human-membership-v1", outcome: "pass" },
          { policy_version_id: "curated-nationality-v1", outcome: "pass" },
        ]);
      }
    });
    completedTestCount += 1;
  }, 45_000);

  test("creator activation rejects without nationality evidence and passes with it", async () => {
    await withSchema(async (connection, admin) => {
      const policy = nationalityPolicy(["US"]);
      await seedHumanCommunity(admin, "community-creator-guard");
      await seedNationalityPolicy(admin, "community-creator-guard", policy);

      const rejected = Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            enforceCreatorNationalityPolicy(transaction, {
              communityId: "community-creator-guard",
              userId: "user-a",
            }),
          );
        }),
      );
      await expect(
        Effect.runPromise(
          rejected.pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
        ),
      ).rejects.toMatchObject({ _tag: "VerificationCompletionStorageFailed" });
      const rejection = await admin.query({
        text: `SELECT outcome FROM decision_records
                WHERE community_id = 'community-creator-guard' AND policy_version_id = 'curated-nationality-v1'`,
      });
      expect(rejection.rows).toEqual([]);

      await insertCompletedNationalityEvidence(admin, {
        suffix: "creator-guard",
        provider: "zkpassport",
        requirement: policy.requirement,
      });
      const admitted = Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            enforceCreatorNationalityPolicy(transaction, {
              communityId: "community-creator-guard",
              userId: "user-a",
            }),
          );
        }),
      );
      await expect(
        Effect.runPromise(
          admitted.pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
        ),
      ).resolves.toBe(true);
      const decisions = await admin.query({
        text: `SELECT outcome FROM decision_records
                WHERE community_id = 'community-creator-guard' AND policy_version_id = 'curated-nationality-v1'
                ORDER BY created_at`,
      });
      expect(decisions.rows).toEqual([{ outcome: "pass" }]);
    });
    completedTestCount += 1;
  }, 30_000);

  test("creator activation is a no-op without a current nationality policy", async () => {
    await withSchema(async (connection, admin) => {
      await seedHumanCommunity(admin, "community-creator-palm-only");
      const program = Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            enforceCreatorNationalityPolicy(transaction, {
              communityId: "community-creator-palm-only",
              userId: "user-a",
            }),
          );
        }),
      );
      await expect(
        Effect.runPromise(
          program.pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
        ),
      ).resolves.toBe(true);
      const decisions = await admin.query({
        text: `SELECT COUNT(*)::int AS count FROM decision_records
                WHERE community_id = 'community-creator-palm-only' AND policy_version_id = 'curated-nationality-v1'`,
      });
      expect(decisions.rows[0]).toEqual({ count: 0 });
    });
    completedTestCount += 1;
  }, 30_000);

  test("issues, fences, completes, and joins through the joiner nationality ceremony", async () => {
    await withSchema(async (connection, admin) => {
      const policy = nationalityPolicy(["US"]);
      await seedHumanCommunity(admin, "community-join-ceremony");
      await seedNationalityPolicy(admin, "community-join-ceremony", policy);
      await seedPalmEvidence(admin, "join-ceremony", "community-join-ceremony");

      const first = await runStore(connection, (store) =>
        store.getJoinEligibility({ communityId: "community-join-ceremony", userId: "user-a" }),
      );
      const firstProjection = first;
      assertProviderChoiceEligibility(firstProjection);
      expect(firstProjection).toMatchObject({
        join_eligibility_version: "provider_choice_v2",
        status: "verification_required",
        missing_capabilities: ["nationality"],
        suggested_verification_provider: "self.pass",
        next_action: {
          kind: "start_verification",
          requirement: "nationality",
          provider_id: "self.pass",
        },
      });
      expect(firstProjection.requirements.nationality).toMatchObject({
        status: "pending",
        provider_id: "self.pass",
        accepted_provider_ids: ["self.pass", "zkpassport"],
      });
      expect(firstProjection.requirements.human_identity).toMatchObject({
        status: "satisfied",
        provider_id: "very.web",
      });
      expect(first?.membership_gate_summaries.map((summary) => summary.gate_type)).toEqual([
        "human_verification",
        "nationality",
      ]);
      const ceremonyId =
        first?.next_action.kind === "start_verification" ? first.next_action.intent_id : null;
      if (ceremonyId === null) throw new Error("expected a joiner nationality ceremony");
      expect(ceremonyId).toStartWith("nationality-community_join_");

      const resolver = makeControlPlaneCommunityJoinIntentResolver(
        makeDirectPostgresControlPlaneLayer(connection),
        "test",
      );
      const selfStart = await startNationalityFixture(
        makeControlPlaneVerificationSessionStartStore(
          makeDirectPostgresControlPlaneLayer(connection),
        ),
        resolver,
        policy,
        {
          actor_id: "user-a",
          intent_id: ceremonyId,
          provider_id: "self.pass",
        },
      );
      expect(selfStart).toMatchObject({ provider_id: "self.pass", replayed: false });
      const switchedStart = await startNationalityFixture(
        makeControlPlaneVerificationSessionStartStore(
          makeDirectPostgresControlPlaneLayer(connection),
        ),
        resolver,
        policy,
        {
          actor_id: "user-a",
          intent_id: ceremonyId,
          provider_id: "zkpassport",
        },
      );
      expect(switchedStart).toMatchObject({ provider_id: "zkpassport", replayed: false });
      expect(switchedStart.proof_session_id).not.toBe(selfStart.proof_session_id);

      const state = await admin.query({
        text: `SELECT status, generation::int AS generation, current_provider_id,
                      current_ceremony_intent_id
                 FROM nationality_requirement_states
                WHERE action_kind = 'community_join'`,
      });
      expect(state.rows).toMatchObject([
        { status: "pending", generation: 2, current_provider_id: "zkpassport" },
      ]);
      const currentCeremonyId = state.rows[0]?.current_ceremony_intent_id;
      if (typeof currentCeremonyId !== "string") throw new Error("expected a current ceremony");

      await expect(
        Effect.runPromise(
          resolver.resolve({
            actor_id: "user-a",
            intent_id: ceremonyId,
            provider_id: "zkpassport",
          }),
        ),
      ).resolves.toBeNull();
      const refreshed = await Promise.all(
        [0, 1].map(() =>
          runStore(connection, (store) =>
            store.getJoinEligibility({ communityId: "community-join-ceremony", userId: "user-a" }),
          ),
        ),
      );
      for (const projection of refreshed) {
        expect(projection).toMatchObject({
          requirements: {
            nationality: {
              provider_id: "zkpassport",
              generation: 2,
              ceremony_intent_id: currentCeremonyId,
            },
          },
          next_action: { provider_id: "zkpassport", intent_id: currentCeremonyId },
        });
      }

      await seedCompletedJoinNationalitySession(admin, {
        sessionId: switchedStart.proof_session_id,
        actorId: "user-a",
        ceremonyIntentId: currentCeremonyId,
        requirement: policy.requirement,
      });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* db.withTransaction((transaction) =>
              advanceCommunityCreationVerificationInTransaction(transaction, {
                actor_id: "user-a",
                proof_session_id: switchedStart.proof_session_id,
                result_hash: JOIN_NATIONALITY_RESULT_HASH,
              }),
            );
          }),
        ).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
      );
      const satisfied = await admin.query({
        text: `SELECT status FROM nationality_requirement_states
                WHERE action_kind = 'community_join'`,
      });
      expect(satisfied.rows).toEqual([{ status: "satisfied" }]);

      await insertCompletedNationalityEvidence(admin, {
        suffix: "join-ceremony",
        provider: "zkpassport",
        requirement: policy.requirement,
      });
      const joined = await runStore(connection, (store) =>
        store.getJoinEligibility({ communityId: "community-join-ceremony", userId: "user-a" }),
      );
      const joinedProjection = joined;
      assertProviderChoiceEligibility(joinedProjection);
      expect(joinedProjection).toMatchObject({
        join_eligibility_version: "provider_choice_v2",
        status: "joinable",
        joinable_now: true,
        next_action: { kind: "join" },
        requirements: {
          human_identity: { requirement: "human_identity", status: "satisfied" },
        },
      });
      await admin.query(`INSERT INTO assertion_revalidation_events (
        assertion_revalidation_event_id, assertion_id, user_id, evidence_receipt_id, outcome, observed_at
      ) VALUES ('join-revoked', 'assertion-nationality-join-ceremony', 'user-a',
        'receipt-nationality-join-ceremony', 'revoked', clock_timestamp())`);
      const renewed = await runStore(connection, (store) =>
        store.getJoinEligibility({ communityId: "community-join-ceremony", userId: "user-a" }),
      );
      assertProviderChoiceEligibility(renewed);
      expect(renewed).toMatchObject({
        status: "verification_required",
        requirements: { nationality: { provider_id: "zkpassport", generation: 1 } },
      });
      const renewalId =
        renewed.next_action.kind === "start_verification" ? renewed.next_action.intent_id : null;
      expect(renewalId).not.toBe(currentCeremonyId);
      const renewalReplay = await runStore(connection, (store) =>
        store.getJoinEligibility({ communityId: "community-join-ceremony", userId: "user-a" }),
      );
      expect(renewalReplay?.next_action).toEqual(renewed.next_action);
      expect(
        (
          await admin.query(
            `SELECT status FROM nationality_requirement_states
        WHERE current_ceremony_intent_id = $1`,
            [currentCeremonyId],
          )
        ).rows,
      ).toEqual([{ status: "satisfied" }]);
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-join-ceremony",
            actor: { userId: "user-a", kind: "user" },
            body: {},
          }),
        ),
      ).rejects.toMatchObject({ reason: "membership-required" });
      if (renewalId === null) throw new Error("Expected a renewal ceremony");
      await expect(
        Effect.runPromise(
          resolver.resolve({ actor_id: "user-a", intent_id: renewalId, provider_id: "zkpassport" }),
        ),
      ).resolves.toMatchObject({ protocol_version: "zkpassport-v2" });
      await insertCompletedNationalityEvidence(admin, {
        suffix: "join-renewed",
        reuseBindingSuffix: "join-ceremony",
        provider: "zkpassport",
        requirement: policy.requirement,
      });
      await expect(
        runStore(connection, (store) =>
          store.join({
            communityId: "community-join-ceremony",
            actor: { userId: "user-a", kind: "user" },
            body: { persona: { kind: "create_new" } },
          }),
        ),
      ).resolves.toMatchObject({ community: "community-join-ceremony", status: "joined" });
    });
    completedTestCount += 1;
  }, 90_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 14) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
