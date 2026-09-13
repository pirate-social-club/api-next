import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";

import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { advanceCommunityCreationVerificationInTransaction } from "./community-creation-repository.ts";
import { ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_CREATION_NATIONALITY_COMPLETION_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-creation-nationality-completion-suite-complete";
let completedTestCount = 0;

const HASH = "a".repeat(64);

function schemaIdentifier(): string {
  return `api_next_creation_nationality_completion_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
    await admin.query("INSERT INTO users (user_id) VALUES ('user-a'), ('user-b')");
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function seedIntent(
  admin: Client,
  input: Readonly<{
    readonly intentId: string;
    readonly actorId: string;
    readonly status?: string;
  }>,
): Promise<void> {
  await admin.query({
    text: `INSERT INTO community_creation_intents (
             intent_id, actor_id, create_idempotency_key, create_request_hash,
             revision, status, draft, canonical_policy_revision, canonical_policy_hash,
             expires_at, creation_contract_version
           ) VALUES ($1, $2, $1, $3, 1, $4,
                     jsonb_build_object(
                       'persona', jsonb_build_object('kind', 'create_new'),
                       'name', $1::text,
                       'description', NULL::text,
                       'policy', jsonb_build_object('version', 1, 'accessPaths', '[]'::jsonb)
                     ),
                     1, $3,
                     clock_timestamp() + interval '1 day', 'optional_route_v2')`,
    values: [input.intentId, input.actorId, HASH, input.status ?? "verification_required"],
  });
}

async function seedUnmetNationalityState(
  admin: Client,
  input: Readonly<{
    readonly intentId: string;
    readonly actorId: string;
    readonly actionKind?: string;
  }>,
): Promise<void> {
  await admin.query({
    text: `INSERT INTO nationality_requirement_states (
             action_kind, intent_id, requirement_kind, actor_id, status,
             requirement_hash, accepted_provider_ids
           ) VALUES ($1, $2, 'nationality', $3, 'unmet', $4,
                     '["self.pass","zkpassport"]'::jsonb)`,
    values: [input.actionKind ?? "community_creation", input.intentId, input.actorId, HASH],
  });
}

async function seedPendingNationalityState(
  admin: Client,
  input: Readonly<{
    readonly intentId: string;
    readonly actorId: string;
    readonly ceremonyIntentId: string;
    readonly generation: number;
    readonly providerId: string;
    readonly actionKind?: string;
  }>,
): Promise<void> {
  await admin.query({
    text: `UPDATE nationality_requirement_states
              SET status = 'pending', generation = $4,
                  current_ceremony_intent_id = $5, current_provider_id = $6,
                  current_provider_binding_hash = $3, current_provider_configuration_kind = 'dynamic',
                  current_provider_configuration_ref = 'test:' || $6,
                  current_provider_configuration_version = '1',
                  updated_at = clock_timestamp()
            WHERE action_kind = $1 AND intent_id = $2 AND requirement_kind = 'nationality'
              AND actor_id = $7`,
    values: [
      input.actionKind ?? "community_creation",
      input.intentId,
      HASH,
      input.generation,
      input.ceremonyIntentId,
      input.providerId,
      input.actorId,
    ],
  });
}

async function seedAttempt(
  admin: Client,
  input: Readonly<{
    readonly ceremonyIntentId: string;
    readonly intentId: string;
    readonly actorId: string;
    readonly generation: number;
    readonly providerId: string;
    readonly actionKind?: string;
  }>,
): Promise<void> {
  await admin.query({
    text: `INSERT INTO nationality_ceremony_attempts (
             ceremony_intent_id, actor_id, action_kind, intent_id, requirement_kind,
             generation, requirement_hash, provider_id, provider_binding_hash,
             provider_configuration_kind, provider_configuration_ref,
             provider_configuration_version, reservation_request_hash,
             reservation_request, expires_at
           ) VALUES ($1, $2, $3, $4, 'nationality', $5, $6, $7, $6, 'dynamic',
                     'test:' || $7, '1', $6, '{}'::jsonb,
                     clock_timestamp() + interval '1 hour')`,
    values: [
      input.ceremonyIntentId,
      input.actorId,
      input.actionKind ?? "community_creation",
      input.intentId,
      input.generation,
      HASH,
      input.providerId,
    ],
  });
}

async function seedCompletedSession(
  admin: Client,
  input: Readonly<{
    readonly sessionId: string;
    readonly actorId: string;
    readonly intentId: string;
  }>,
): Promise<void> {
  await admin.query("BEGIN");
  try {
    await admin.query({
      text: `INSERT INTO proof_sessions (
               proof_session_id, actor_id, intent_id, request_hash, provider_id,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, method, issuer, scope_kind,
               issuer_rp_scope, issuer_rp_action_scope, request_mode, requested_requirements,
               requested_claim_ids, subject_binding_intent, protocol_version, environment,
               status, started_at, expires_at
             ) VALUES ($1, $2, $3, repeat('a', 64), 'self.pass', 'dynamic', 'test:self.pass', '1',
                       'document', 'self.pass', 'issuer_rp_scope', 'test', NULL, 'dynamic',
                       '[{"claim_id":"nationality.allowed","allowed_countries":["US"]}]'::jsonb,
                       '["nationality.allowed"]'::jsonb, 'establish', 'self-pass-v1', 'test',
                       'pending', clock_timestamp() - interval '10 minutes',
                       clock_timestamp() + interval '1 hour')`,
      values: [input.sessionId, input.actorId, input.intentId],
    });
    await admin.query({
      text: `WITH terminal(value) AS (SELECT clock_timestamp())
             UPDATE proof_sessions
                SET status = 'completed', completed_at = terminal.value,
                    completion_idempotency_key = $2, completion_result_hash = $3,
                    terminal_at = terminal.value
               FROM terminal WHERE proof_session_id = $1`,
      values: [input.sessionId, `complete-${input.sessionId}`, HASH],
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

function advance(
  connection: string,
  input: Readonly<{ readonly actorId: string; readonly sessionId: string }>,
): Promise<unknown> {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        advanceCommunityCreationVerificationInTransaction(transaction, {
          actor_id: input.actorId,
          proof_session_id: input.sessionId,
          result_hash: HASH,
        }),
      );
    }),
  );
  return Effect.runPromise(
    program.pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
  );
}

async function stateRow(
  admin: Client,
  intentId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await admin.query({
    text: `SELECT status, generation::int AS generation, satisfied_at FROM nationality_requirement_states
            WHERE action_kind = 'community_creation' AND intent_id = $1`,
    values: [intentId],
  });
  return result.rows[0] as Record<string, unknown> | undefined;
}

suite("community creation nationality completion", () => {
  test("matching completion satisfies the requirement and advances the intent", async () => {
    await withSchema(async (connection, admin) => {
      await seedIntent(admin, { intentId: "intent-match", actorId: "user-a" });
      await seedUnmetNationalityState(admin, { intentId: "intent-match", actorId: "user-a" });
      await seedAttempt(admin, {
        ceremonyIntentId: "ceremony-a",
        intentId: "intent-match",
        actorId: "user-a",
        generation: 1,
        providerId: "self.pass",
      });
      await seedPendingNationalityState(admin, {
        intentId: "intent-match",
        actorId: "user-a",
        ceremonyIntentId: "ceremony-a",
        generation: 1,
        providerId: "self.pass",
      });
      await seedCompletedSession(admin, {
        sessionId: "session-match",
        actorId: "user-a",
        intentId: "ceremony-a",
      });
      await expect(
        advance(connection, { actorId: "user-a", sessionId: "session-match" }),
      ).resolves.toMatchObject({ kind: "advanced", intent_id: "intent-match", revision: 2 });
      expect(await stateRow(admin, "intent-match")).toMatchObject({ status: "satisfied" });
      const intent = await admin.query({
        text: `SELECT status, revision FROM community_creation_intents WHERE intent_id = 'intent-match'`,
      });
      expect(intent.rows[0]).toEqual({ status: "commit_ready", revision: 2 });
    });
    completedTestCount += 1;
  }, 30_000);

  test("a superseded generation after a provider switch grants nothing", async () => {
    await withSchema(async (connection, admin) => {
      await seedIntent(admin, { intentId: "intent-switch", actorId: "user-a" });
      await seedUnmetNationalityState(admin, { intentId: "intent-switch", actorId: "user-a" });
      await seedAttempt(admin, {
        ceremonyIntentId: "ceremony-old",
        intentId: "intent-switch",
        actorId: "user-a",
        generation: 1,
        providerId: "self.pass",
      });
      await seedPendingNationalityState(admin, {
        intentId: "intent-switch",
        actorId: "user-a",
        ceremonyIntentId: "ceremony-old",
        generation: 1,
        providerId: "self.pass",
      });
      await seedAttempt(admin, {
        ceremonyIntentId: "ceremony-zk",
        intentId: "intent-switch",
        actorId: "user-a",
        generation: 2,
        providerId: "zkpassport",
      });
      await seedPendingNationalityState(admin, {
        intentId: "intent-switch",
        actorId: "user-a",
        ceremonyIntentId: "ceremony-zk",
        generation: 2,
        providerId: "zkpassport",
      });
      await seedCompletedSession(admin, {
        sessionId: "session-old",
        actorId: "user-a",
        intentId: "ceremony-old",
      });
      await expect(
        advance(connection, { actorId: "user-a", sessionId: "session-old" }),
      ).resolves.toMatchObject({ kind: "stale" });
      expect(await stateRow(admin, "intent-switch")).toMatchObject({
        status: "pending",
        generation: 2,
      });
      const intent = await admin.query({
        text: `SELECT status FROM community_creation_intents WHERE intent_id = 'intent-switch'`,
      });
      expect(intent.rows[0]).toEqual({ status: "verification_required" });
    });
    completedTestCount += 1;
  }, 30_000);

  test("a foreign actor cannot satisfy another actor's requirement", async () => {
    await withSchema(async (connection, admin) => {
      await seedIntent(admin, { intentId: "intent-foreign", actorId: "user-b" });
      await seedUnmetNationalityState(admin, { intentId: "intent-foreign", actorId: "user-b" });
      await seedAttempt(admin, {
        ceremonyIntentId: "ceremony-b",
        intentId: "intent-foreign",
        actorId: "user-b",
        generation: 1,
        providerId: "self.pass",
      });
      await seedPendingNationalityState(admin, {
        intentId: "intent-foreign",
        actorId: "user-b",
        ceremonyIntentId: "ceremony-b",
        generation: 1,
        providerId: "self.pass",
      });
      await seedCompletedSession(admin, {
        sessionId: "session-b",
        actorId: "user-b",
        intentId: "ceremony-b",
      });
      await expect(
        advance(connection, { actorId: "user-a", sessionId: "session-b" }),
      ).resolves.toMatchObject({ kind: "not_applicable" });
      expect(await stateRow(admin, "intent-foreign")).toMatchObject({ status: "pending" });
    });
    completedTestCount += 1;
  }, 30_000);

  test("a non-creation ceremony never satisfies a creation requirement", async () => {
    await withSchema(async (connection, admin) => {
      await seedIntent(admin, { intentId: "intent-join", actorId: "user-a" });
      await seedUnmetNationalityState(admin, { intentId: "intent-join", actorId: "user-a" });
      await seedPendingNationalityState(admin, {
        intentId: "intent-join",
        actorId: "user-a",
        ceremonyIntentId: "ceremony-creation",
        generation: 1,
        providerId: "self.pass",
      });
      await seedUnmetNationalityState(admin, {
        intentId: "intent-join",
        actorId: "user-a",
        actionKind: "community_join",
      });
      await seedAttempt(admin, {
        ceremonyIntentId: "ceremony-join",
        intentId: "intent-join",
        actorId: "user-a",
        generation: 1,
        providerId: "self.pass",
        actionKind: "community_join",
      });
      await seedPendingNationalityState(admin, {
        intentId: "intent-join",
        actorId: "user-a",
        ceremonyIntentId: "ceremony-join",
        generation: 1,
        providerId: "self.pass",
        actionKind: "community_join",
      });
      await seedCompletedSession(admin, {
        sessionId: "session-join",
        actorId: "user-a",
        intentId: "ceremony-join",
      });
      await expect(
        advance(connection, { actorId: "user-a", sessionId: "session-join" }),
      ).resolves.toMatchObject({ kind: "stale" });
      expect(await stateRow(admin, "intent-join")).toMatchObject({ status: "pending" });
      const intent = await admin.query({
        text: `SELECT status FROM community_creation_intents WHERE intent_id = 'intent-join'`,
      });
      expect(intent.rows[0]).toEqual({ status: "verification_required" });
    });
    completedTestCount += 1;
  }, 30_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 4) {
      await Bun.write(
        sentinelPath,
        "api-next-control-plane-postgres-creation-nationality-completion-suite-complete\n",
      );
    }
  });
});
