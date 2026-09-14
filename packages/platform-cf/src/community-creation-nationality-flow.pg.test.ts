import { afterAll, describe, expect, test } from "bun:test";
import type { CommunityCreationIntentDocument } from "@pirate/application";
import type { CommunityCreationDraftV2 } from "@pirate/contracts";
import { startNationalityFixture } from "@pirate/testing/verification";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneCommunityCreationIntentResolver } from "./community-creation-intent-resolver.ts";
import {
  compileOptionalRouteDraft,
  makeControlPlaneCommunityCreationStore,
} from "./community-creation-repository.ts";
import { advanceCommunityCreationVerificationInTransaction } from "./community-creation-verification-settlement.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneVerificationSessionStartStore } from "./verification-start-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_CREATION_NATIONALITY_FLOW_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-creation-nationality-flow-suite-complete";
const sentinelContents =
  "api-next-control-plane-postgres-creation-nationality-flow-suite-complete\n";
let completedTestCount = 0;

const RESULT_HASH = "b".repeat(64);
const actor = { userId: "user-a", kind: "user" as const };

const authoring = {
  policy_revision: 1,
  evidence_lifetime: { kind: "max_age_seconds", seconds: 3600 },
  provider_bindings: ["self.pass", "zkpassport"].map((provider_id) => ({
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
  })),
};

function composedPolicy(allowedCountries: readonly string[]): CommunityCreationDraftV2["policy"] {
  return {
    version: 1,
    accessPaths: [
      {
        id: "verified-people",
        operator: "and",
        requirements: [
          { requirement: "human-verification" },
          {
            requirement: "nationality-allowed",
            allowedCountries: [...allowedCountries] as [string, ...string[]],
          },
        ],
      },
    ],
  };
}

const humanPolicy: CommunityCreationDraftV2["policy"] = {
  version: 1,
  accessPaths: [
    {
      id: "verified-people",
      operator: "and",
      requirements: [{ requirement: "human-verification" }],
    },
  ],
};

function compiledComposed(policy: CommunityCreationDraftV2["policy"]) {
  const compiled = compileOptionalRouteDraft(policy, authoring);
  const nationality = compiled?.nationality;
  if (nationality === undefined) {
    throw new Error("composed fixture did not compile");
  }
  return nationality;
}

function nationalityProgress(document: CommunityCreationIntentDocument) {
  if (!("creation_contract_version" in document)) {
    throw new Error("expected an optional-route intent");
  }
  return document.requirements.nationality;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSeededSchema<A>(
  use: (context: {
    readonly connection: string;
    readonly admin: Client;
    readonly personaId: string;
  }) => Promise<A>,
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = `api_next_creation_nationality_flow_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    await applyPostgresTestBaselineConnection({
      connectionString: connectionForSchema(connectionString, schema),
    });
    await admin.query({
      text: "INSERT INTO users (user_id, status, account) VALUES ($1, 'active', '{}'::jsonb)",
      values: [actor.userId],
    });
    await activatePendingPersonaFixtures(admin);
    const persona = await admin.query<{ persona_id: string }>(
      "SELECT persona_id FROM personas WHERE account_id = $1 AND is_first_persona",
      [actor.userId],
    );
    const personaId = persona.rows[0]?.persona_id;
    if (personaId === undefined) throw new Error("missing first persona");
    await admin.query(
      "UPDATE persona_profiles SET display_name='Test Owner', revision=revision+1 WHERE persona_id=$1",
      [personaId],
    );
    return await use({
      connection: connectionForSchema(connectionString, schema),
      admin,
      personaId,
    });
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function storeFor(connection: string) {
  let sequence = 0;
  return makeControlPlaneCommunityCreationStore(makeDirectPostgresControlPlaneLayer(connection), {
    intent_ttl_seconds: 86_400,
    nationality_authoring: authoring,
    next_intent_id: () => `flow-intent-${++sequence}`,
    next_ceremony_intent_id: () => `flow-ceremony-${++sequence}`,
    next_community_id: () => `community_${crypto.randomUUID()}`,
  });
}

function resolverFor(connection: string) {
  return makeControlPlaneCommunityCreationIntentResolver(
    makeDirectPostgresControlPlaneLayer(connection),
    "test",
    { nationality_authoring: authoring },
  );
}

async function reloadNationalityState(admin: Client, intentId: string) {
  const result = await admin.query({
    text: `SELECT state.status, state.requirement_hash, state.generation::int AS generation,
                  state.current_provider_id, state.current_ceremony_intent_id,
                  attempt.provider_id AS attempt_provider_id
             FROM nationality_requirement_states AS state
             LEFT JOIN nationality_ceremony_attempts AS attempt
               ON attempt.action_kind = state.action_kind
              AND attempt.intent_id = state.intent_id
              AND attempt.requirement_kind = state.requirement_kind
              AND attempt.generation = state.generation
            WHERE state.action_kind = 'community_creation' AND state.intent_id = $1`,
    values: [intentId],
  });
  return result.rows[0] as Record<string, unknown> | undefined;
}

async function seedCompletedNationalSession(
  admin: Client,
  input: Readonly<{
    readonly sessionId: string;
    readonly alreadyStarted?: true;
    readonly actorId: string;
    readonly ceremonyIntentId: string;
    readonly provider: "self.pass" | "zkpassport";
  }>,
): Promise<void> {
  const provider =
    input.provider === "self.pass"
      ? { protocol_version: "self-pass-v1", reference: "test:self.pass" }
      : { protocol_version: "zkpassport-v2", reference: "test:zkpassport" };
  await admin.query("BEGIN");
  try {
    if (input.alreadyStarted) {
      const pending = await admin.query({
        text: `SELECT proof_session_id FROM proof_sessions WHERE proof_session_id=$1 AND actor_id=$2
          AND intent_id=$3 AND provider_id=$4 AND status='pending'`,
        values: [input.sessionId, input.actorId, input.ceremonyIntentId, input.provider],
      });
      expect(pending.rowCount).toBe(1);
    } else {
      await admin.query({
        text: `INSERT INTO proof_sessions (
               proof_session_id, actor_id, intent_id, request_hash, provider_id,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, method, issuer, scope_kind,
               issuer_rp_scope, issuer_rp_action_scope, request_mode, requested_requirements,
               requested_claim_ids, subject_binding_intent, protocol_version, environment,
               status, started_at, expires_at
             ) VALUES ($1, $2, $3, repeat('a', 64), $4, 'dynamic', $5, '1',
                       'document', $4, 'issuer_rp_scope', 'test', NULL, 'dynamic',
                       '[{"claim_id":"nationality.allowed","allowed_countries":["US"]}]'::jsonb,
                       '["nationality.allowed"]'::jsonb, 'establish', $6, 'test',
                       'pending', clock_timestamp() - interval '10 minutes',
                       clock_timestamp() + interval '1 hour')`,
        values: [
          input.sessionId,
          input.actorId,
          input.ceremonyIntentId,
          input.provider,
          provider.reference,
          provider.protocol_version,
        ],
      });
    }
    await admin.query({
      text: `WITH terminal(value) AS (SELECT clock_timestamp())
             UPDATE proof_sessions
                SET status = 'completed', completed_at = terminal.value,
                    completion_idempotency_key = $2, completion_result_hash = $3,
                    terminal_at = terminal.value
               FROM terminal WHERE proof_session_id = $1`,
      values: [input.sessionId, `complete-${input.sessionId}`, RESULT_HASH],
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

async function insertCompletedNationalityEvidence(
  admin: Client,
  input: Readonly<{
    readonly suffix: string;
    readonly provider: "self.pass" | "zkpassport";
    readonly requirement: Readonly<{
      readonly claim_id: "nationality.allowed";
      readonly allowed_countries: readonly string[];
    }>;
  }>,
): Promise<void> {
  const provider =
    input.provider === "self.pass"
      ? authoring.provider_bindings[0]
      : authoring.provider_bindings[1];
  if (provider === undefined) throw new Error("provider fixture missing");
  const sessionId = `flow-proof-${input.suffix}`;
  const subjectId = `flow-subject-${input.suffix}`;
  const bindingEventId = `flow-binding-event-${input.suffix}`;
  await admin.query("BEGIN");
  try {
    await admin.query({
      text: `INSERT INTO proof_sessions (
               proof_session_id, actor_id, intent_id, request_hash, provider_id,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, method, issuer, scope_kind,
               issuer_rp_scope, issuer_rp_action_scope, request_mode, protocol_version,
               environment, status, requested_requirements, requested_claim_ids,
               subject_binding_intent, started_at, expires_at, upstream_session_ref
             ) VALUES ($1, $2, $3, repeat('a', 64), $4, 'dynamic', $5, '1',
                       'document', $4, 'issuer_rp_scope', 'test', NULL, 'dynamic', $6, 'test',
                       'pending', $7::jsonb, $8::jsonb, 'establish',
                       clock_timestamp() - interval '2 hours',
                       clock_timestamp() + interval '1 day', $9)`,
      values: [
        sessionId,
        actor.userId,
        `flow-evidence-intent-${input.suffix}`,
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
             ) VALUES ($1, $2, 1, $3, $4, 'initial', $5, clock_timestamp())`,
      values: [bindingEventId, subjectId, actor.userId, sessionId, `bind-${input.suffix}`],
    });
    await admin.query({
      text: `INSERT INTO evidence_receipts (
               evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
               scope_kind, issuer_rp_scope, issuer_rp_action_scope, protocol_version, environment,
               evidence_kind, evidence_hash, receipt_metadata, observed_at, expires_at,
               provenance_kind, subject_key_id, subject_binding_event_id, subject_binding_epoch,
               provider_configuration_kind, provider_configuration_ref, provider_configuration_version
             ) VALUES ($1, $2, $3, $4, $4, 'document', 'issuer_rp_scope', 'test', NULL, $5, 'test',
                       'document', repeat('c', 60) || substr(md5($1), 1, 4), '{}'::jsonb,
                       clock_timestamp(), clock_timestamp() + interval '1 day',
                       'proof_session', $6, $7, 1, 'dynamic', $8, '1')`,
      values: [
        `flow-receipt-${input.suffix}`,
        sessionId,
        actor.userId,
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
             ) VALUES ($1, $2, 'same_subject', $3, $4, 1)`,
      values: [`flow-binding-${input.suffix}`, actor.userId, subjectId, bindingEventId],
    });
    await admin.query({
      text: `INSERT INTO assertions (
               assertion_id, binding_group_id, evidence_receipt_id, subject_key_id, user_id,
               claim_id, assertion_value, assurance, observed_at, expires_at
             ) VALUES ($1, $2, $3, $4, $5, 'nationality.allowed',
                       '{"allowed": true}'::jsonb, 'document_zk', clock_timestamp(), NULL)`,
      values: [
        `flow-assertion-${input.suffix}`,
        `flow-binding-${input.suffix}`,
        `flow-receipt-${input.suffix}`,
        subjectId,
        actor.userId,
      ],
    });
    await admin.query({
      text: `WITH terminal(value) AS (SELECT clock_timestamp())
             UPDATE proof_sessions
                SET status = 'completed', completed_at = terminal.value,
                    completion_idempotency_key = $2, completion_result_hash = repeat('b', 64),
                    terminal_at = terminal.value
               FROM terminal WHERE proof_session_id = $1`,
      values: [sessionId, `complete-${input.suffix}`],
    });
    await admin.query({
      text: `INSERT INTO proof_session_completion_events (
               completion_event_id, proof_session_id, actor_id, idempotency_key,
               terminal_status, result_hash, terminal_at
             ) SELECT $2, proof_session_id, actor_id, completion_idempotency_key,
                      status, completion_result_hash, terminal_at
                 FROM proof_sessions WHERE proof_session_id = $1`,
      values: [sessionId, `completion-${input.suffix}`],
    });
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

function advance(connection: string, sessionId: string) {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        advanceCommunityCreationVerificationInTransaction(transaction, {
          actor_id: actor.userId,
          proof_session_id: sessionId,
          result_hash: RESULT_HASH,
        }),
      );
    }),
  );
  return Effect.runPromise(
    program.pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
  );
}

suite("Postgres 17 community creation nationality flow", () => {
  test("reuses accepted account evidence for a composed commit", async () => {
    await withSeededSchema(async ({ connection, admin, personaId }) => {
      const policy = composedPolicy(["US"]);
      const nationality = compiledComposed(policy);
      await insertCompletedNationalityEvidence(admin, {
        suffix: "reuse",
        provider: "self.pass",
        requirement: nationality.policy.requirement,
      });
      const store = storeFor(connection);
      const created = await Effect.runPromise(
        store.create({
          actor,
          requestHash: "8".repeat(64),
          body: {
            idempotency_key: "flow-reuse-create",
            draft: {
              persona: { kind: "existing" as const, persona_id: personaId },
              name: "Reuse community",
              description: null,
              policy,
            },
          },
        }),
      );
      expect(created.document.status).toBe("commit_ready");
      expect(created.document.requirements).toEqual({});
      expect(created.document.next_action).toEqual({ kind: "commit" });
      const attempts = await admin.query(
        "SELECT COUNT(*)::int AS count FROM nationality_ceremony_attempts WHERE intent_id = $1",
        [created.document.intent_id],
      );
      expect(attempts.rows[0]).toEqual({ count: 0 });

      const committed = await Effect.runPromise(
        store.commit({
          actor,
          intentId: created.document.intent_id,
          requestHash: "7".repeat(64),
          body: { idempotency_key: "flow-reuse-commit", expected_revision: 1 },
        }),
      );
      expect(committed.outcome).toBe("fresh_created");
      const resource = committed.document.committed_resource;
      if (resource === null) throw new Error("expected a committed resource");
      const membership = await admin.query(
        "SELECT status FROM community_memberships WHERE community_id = $1 AND user_id = $2",
        [resource.community_id, actor.userId],
      );
      expect(membership.rows).toEqual([{ status: "member" }]);
      const counts = await admin.query(
        `SELECT
           (SELECT COUNT(*)::int FROM policy_versions
             WHERE community_id = $1 AND policy_key = 'curated-nationality') AS policies,
           (SELECT COUNT(*)::int FROM community_policy_provider_bindings
             WHERE community_id = $1 AND policy_key = 'curated-nationality') AS bindings,
           (SELECT COUNT(*)::int FROM community_policy_current
             WHERE community_id = $1 AND policy_key = 'curated-nationality') AS current`,
        [resource.community_id],
      );
      expect(counts.rows[0]).toEqual({ policies: 1, bindings: 2, current: 1 });
    });
    completedTestCount += 1;
  }, 60_000);

  test("issues, switches, completes, and commits the creator nationality ceremony", async () => {
    await withSeededSchema(async ({ connection, admin, personaId }) => {
      const policy = composedPolicy(["US"]);
      const nationality = compiledComposed(policy);
      const store = storeFor(connection);
      const created = await Effect.runPromise(
        store.create({
          actor,
          requestHash: "6".repeat(64),
          body: {
            idempotency_key: "flow-ceremony-create",
            draft: {
              persona: { kind: "existing" as const, persona_id: personaId },
              name: "Ceremony community",
              description: null,
              policy,
            },
          },
        }),
      );
      const intentId = created.document.intent_id;
      const first = nationalityProgress(created.document);
      if (first === undefined) throw new Error("expected a nationality requirement");
      expect(created.document.status).toBe("verification_required");
      expect(first).toMatchObject({
        status: "pending",
        requirement_hash: nationality.requirementHash,
        provider_id: "self.pass",
        generation: 1,
      });
      expect(created.document.next_action).toMatchObject({
        kind: "start_verification",
        requirement: "nationality",
        provider_id: "self.pass",
        creation_intent_id: intentId,
        ceremony_intent_id: first.ceremony_intent_id,
        generation: 1,
      });
      expect(await reloadNationalityState(admin, intentId)).toMatchObject({
        status: "pending",
        generation: 1,
        current_provider_id: "self.pass",
        attempt_provider_id: "self.pass",
      });

      const resolver = resolverFor(connection);
      const selfStart = await startNationalityFixture(
        makeControlPlaneVerificationSessionStartStore(
          makeDirectPostgresControlPlaneLayer(connection),
        ),
        resolver,
        nationality.policy,
        {
          actor_id: actor.userId,
          intent_id: first.ceremony_intent_id ?? "",
          provider_id: "self.pass",
        },
      );
      expect(selfStart).toMatchObject({ provider_id: "self.pass", replayed: false });
      const switchedStart = await startNationalityFixture(
        makeControlPlaneVerificationSessionStartStore(
          makeDirectPostgresControlPlaneLayer(connection),
        ),
        resolver,
        nationality.policy,
        {
          actor_id: actor.userId,
          intent_id: first.ceremony_intent_id ?? "",
          provider_id: "zkpassport",
        },
      );
      expect(switchedStart).toMatchObject({ provider_id: "zkpassport", replayed: false });
      expect(switchedStart.proof_session_id).not.toBe(selfStart.proof_session_id);
      const afterSwitch = await Effect.runPromise(store.get({ actor, intentId }));
      if (afterSwitch === null) throw new Error("expected the switched intent");
      const switched = nationalityProgress(afterSwitch);
      if (switched === undefined) throw new Error("expected nationality progress");
      expect(switched).toMatchObject({
        status: "pending",
        provider_id: "zkpassport",
        generation: 2,
      });
      expect(switched.ceremony_intent_id).not.toBe(first.ceremony_intent_id);
      expect(afterSwitch.next_action).toEqual({
        kind: "wait",
        requirement: "nationality",
        reason_code: "verification_pending",
      });

      await expect(
        Effect.runPromise(
          resolver.resolve({
            actor_id: actor.userId,
            intent_id: first.ceremony_intent_id ?? "",
            provider_id: "zkpassport",
          }),
        ),
      ).resolves.toBeNull();

      const early = await Effect.runPromise(
        store
          .commit({
            actor,
            intentId,
            requestHash: "5".repeat(64),
            body: {
              idempotency_key: "flow-ceremony-early",
              expected_revision: afterSwitch.revision,
            },
          })
          .pipe(Effect.exit),
      );
      expect(early._tag).toBe("Failure");

      await seedCompletedNationalSession(admin, {
        sessionId: selfStart.proof_session_id,
        alreadyStarted: true,
        actorId: actor.userId,
        ceremonyIntentId: first.ceremony_intent_id ?? "",
        provider: "self.pass",
      });
      await expect(advance(connection, selfStart.proof_session_id)).resolves.toMatchObject({
        kind: "stale",
      });
      expect(await reloadNationalityState(admin, intentId)).toMatchObject({
        status: "pending",
        generation: 2,
      });

      await seedCompletedNationalSession(admin, {
        sessionId: switchedStart.proof_session_id,
        alreadyStarted: true,
        actorId: actor.userId,
        ceremonyIntentId: switched.ceremony_intent_id ?? "",
        provider: "zkpassport",
      });
      await expect(advance(connection, switchedStart.proof_session_id)).resolves.toMatchObject({
        kind: "advanced",
        intent_id: intentId,
      });
      expect(await reloadNationalityState(admin, intentId)).toMatchObject({ status: "satisfied" });
      const ready = await Effect.runPromise(store.get({ actor, intentId }));
      if (ready === null) throw new Error("expected the completed intent");
      expect(ready.status).toBe("commit_ready");
      expect(ready.next_action).toEqual({ kind: "commit" });

      await insertCompletedNationalityEvidence(admin, {
        suffix: "ceremony",
        provider: "zkpassport",
        requirement: nationality.policy.requirement,
      });
      const committed = await Effect.runPromise(
        store.commit({
          actor,
          intentId,
          requestHash: "4".repeat(64),
          body: { idempotency_key: "flow-ceremony-commit", expected_revision: ready.revision },
        }),
      );
      expect(committed.outcome).toBe("fresh_created");
      const resource = committed.document.committed_resource;
      if (resource === null) throw new Error("expected a committed resource");
      const rows = await admin.query(
        `SELECT
           (SELECT COUNT(*)::int FROM communities WHERE community_id = $1) AS communities,
           (SELECT COUNT(*)::int FROM community_memberships
             WHERE community_id = $1 AND user_id = $2 AND status = 'member') AS memberships,
           (SELECT COUNT(*)::int FROM community_policy_provider_bindings
             WHERE community_id = $1 AND policy_key = 'curated-nationality') AS bindings`,
        [resource.community_id, actor.userId],
      );
      expect(rows.rows[0]).toEqual({ communities: 1, memberships: 1, bindings: 2 });
    });
    completedTestCount += 1;
  }, 90_000);

  test("rolls back the terminal commit when the creator lacks accepted evidence", async () => {
    await withSeededSchema(async ({ connection, admin, personaId }) => {
      const policy = composedPolicy(["US"]);
      const store = storeFor(connection);
      const created = await Effect.runPromise(
        store.create({
          actor,
          requestHash: "3".repeat(64),
          body: {
            idempotency_key: "flow-rollback-create",
            draft: {
              persona: { kind: "existing" as const, persona_id: personaId },
              name: "Rollback community",
              description: null,
              policy,
            },
          },
        }),
      );
      const intentId = created.document.intent_id;
      const requirement = nationalityProgress(created.document);
      if (requirement === undefined) throw new Error("expected nationality progress");
      await seedCompletedNationalSession(admin, {
        sessionId: "flow-session-rollback",
        actorId: actor.userId,
        ceremonyIntentId: requirement.ceremony_intent_id ?? "",
        provider: "self.pass",
      });
      await expect(advance(connection, "flow-session-rollback")).resolves.toMatchObject({
        kind: "advanced",
      });
      const ready = await Effect.runPromise(store.get({ actor, intentId }));
      if (ready === null) throw new Error("expected the completed intent");
      expect(ready.status).toBe("commit_ready");
      const failed = await Effect.runPromise(
        store
          .commit({
            actor,
            intentId,
            requestHash: "2".repeat(64),
            body: { idempotency_key: "flow-rollback-commit", expected_revision: ready.revision },
          })
          .pipe(Effect.exit),
      );
      expect(failed._tag).toBe("Failure");
      const rows = await admin.query(
        `SELECT
           (SELECT COUNT(*)::int FROM communities) AS communities,
           (SELECT COUNT(*)::int FROM community_memberships) AS memberships,
           (SELECT COUNT(*)::int FROM community_policy_provider_bindings
             WHERE policy_key = 'curated-nationality') AS bindings`,
      );
      expect(rows.rows[0]).toEqual({ communities: 0, memberships: 0, bindings: 0 });
      const intent = await admin.query(
        "SELECT status FROM community_creation_intents WHERE intent_id = $1",
        [intentId],
      );
      expect(intent.rows).toEqual([{ status: "commit_ready" }]);
    });
    completedTestCount += 1;
  }, 60_000);

  test("requires fresh proof when the allowlist changes and fences the old ceremony", async () => {
    await withSeededSchema(async ({ connection, admin, personaId }) => {
      const firstPolicy = composedPolicy(["US"]);
      const secondPolicy = composedPolicy(["CA"]);
      const secondNationality = compiledComposed(secondPolicy);
      const store = storeFor(connection);
      const created = await Effect.runPromise(
        store.create({
          actor,
          requestHash: "1".repeat(64),
          body: {
            idempotency_key: "flow-change-create",
            draft: {
              persona: { kind: "existing" as const, persona_id: personaId },
              name: "Changed community",
              description: null,
              policy: firstPolicy,
            },
          },
        }),
      );
      const intentId = created.document.intent_id;
      const first = nationalityProgress(created.document);
      if (first === undefined) throw new Error("expected nationality progress");
      await insertCompletedNationalityEvidence(admin, {
        suffix: "changed-old",
        provider: "self.pass",
        requirement: compiledComposed(firstPolicy).policy.requirement,
      });
      const updated = await Effect.runPromise(
        store.update({
          actor,
          intentId,
          requestHash: "0".repeat(64),
          body: {
            idempotency_key: "flow-change-update",
            expected_revision: 1,
            draft: {
              persona: { kind: "existing" as const, persona_id: personaId },
              name: "Changed community",
              description: null,
              policy: secondPolicy,
            },
          },
        }),
      );
      const second = nationalityProgress(updated);
      if (second === undefined) throw new Error("expected nationality progress");
      expect(updated.status).toBe("verification_required");
      expect(second).toMatchObject({
        status: "pending",
        requirement_hash: secondNationality.requirementHash,
        provider_id: "self.pass",
      });
      expect(second.requirement_hash).not.toBe(first.requirement_hash);
      expect(second.ceremony_intent_id).not.toBe(first.ceremony_intent_id);
      expect(second.generation).toBeGreaterThan(first.generation);
      expect(await reloadNationalityState(admin, intentId)).toMatchObject({
        status: "pending",
        requirement_hash: secondNationality.requirementHash,
      });
      const resolver = resolverFor(connection);
      await expect(
        Effect.runPromise(
          resolver.resolve({
            actor_id: actor.userId,
            intent_id: first.ceremony_intent_id ?? "",
            provider_id: "self.pass",
          }),
        ),
      ).resolves.toBeNull();
    });
    completedTestCount += 1;
  }, 60_000);

  test("keeps Palm-only creation commit-ready and fails closed without authoring", async () => {
    await withSeededSchema(async ({ connection, admin, personaId }) => {
      const store = storeFor(connection);
      const created = await Effect.runPromise(
        store.create({
          actor,
          requestHash: "a".repeat(64),
          body: {
            idempotency_key: "flow-human-create",
            draft: {
              persona: { kind: "existing" as const, persona_id: personaId },
              name: "Human community",
              description: null,
              policy: humanPolicy,
            },
          },
        }),
      );
      expect(created.document).toMatchObject({
        status: "commit_ready",
        requirements: {},
        next_action: { kind: "commit" },
      });
      const nationalityRows = await admin.query(
        "SELECT COUNT(*)::int AS count FROM nationality_requirement_states WHERE intent_id = $1",
        [created.document.intent_id],
      );
      expect(nationalityRows.rows[0]).toEqual({ count: 0 });

      const strictStore = makeControlPlaneCommunityCreationStore(
        makeDirectPostgresControlPlaneLayer(connection),
        { intent_ttl_seconds: 86_400 },
      );
      const unsupported = await Effect.runPromise(
        strictStore.create({
          actor,
          requestHash: "b".repeat(64),
          body: {
            idempotency_key: "flow-no-authoring-create",
            draft: {
              persona: { kind: "existing" as const, persona_id: personaId },
              name: "Unsupported community",
              description: null,
              policy: composedPolicy(["US"]),
            },
          },
        }),
      );
      expect(unsupported.document.status).toBe("gate_unsupported");
      const attempts = await admin.query(
        "SELECT COUNT(*)::int AS count FROM nationality_ceremony_attempts WHERE intent_id = $1",
        [unsupported.document.intent_id],
      );
      expect(attempts.rows[0]).toEqual({ count: 0 });
    });
    completedTestCount += 1;
  }, 60_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 5) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
