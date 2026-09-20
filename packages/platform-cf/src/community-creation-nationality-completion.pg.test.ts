import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";

import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { advanceCommunityCreationVerificationInTransaction } from "./community-creation-verification-settlement.ts";
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
    // Reconstruct the immediately preceding schema to exercise the cutover
    // with historical rows; all other baseline constraints remain in force.
    await admin.query(
      "DROP TRIGGER nationality_creation_state_retired ON nationality_requirement_states; DROP TRIGGER nationality_creation_attempt_retired ON nationality_ceremony_attempts; DROP FUNCTION reject_retired_creation_nationality_write()",
    );
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

async function cutover(admin: Client) {
  const sql = await Bun.file(
    new URL(
      "../../../db/postgres/migrations/0193_creation_nationality_retirement.sql",
      import.meta.url,
    ),
  ).text();
  await admin.query("BEGIN");
  try {
    await admin.query(sql);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}
async function seedHistorical(admin: Client, intentId: string) {
  await seedIntent(admin, { intentId, actorId: "user-a" });
  await seedUnmetNationalityState(admin, { intentId, actorId: "user-a" });
  await seedAttempt(admin, {
    ceremonyIntentId: `ceremony-${intentId}`,
    intentId,
    actorId: "user-a",
    generation: 1,
    providerId: "self.pass",
  });
  await seedPendingNationalityState(admin, {
    ceremonyIntentId: `ceremony-${intentId}`,
    intentId,
    actorId: "user-a",
    generation: 1,
    providerId: "self.pass",
  });
}

suite("community creation nationality retirement", () => {
  test("expires only affected intents and retains historical ceremony evidence", async () => {
    await withSchema(async (_connection, admin) => {
      await seedHistorical(admin, "waiting");
      await seedIntent(admin, {
        intentId: "unrelated",
        actorId: "user-a",
        status: "gate_unsupported",
      });
      await seedIntent(admin, {
        intentId: "unsupported-nationality",
        actorId: "user-a",
        status: "draft",
      });
      await admin.query(`UPDATE community_creation_intents SET revision=revision+1, status='gate_unsupported',
        draft=jsonb_set(draft, '{policy}', '{"version":1,"accessPaths":[{"requirements":[{"requirement":"nationality-allowed","allowedCountries":["US"]}]}]}'::jsonb)
        WHERE intent_id='unsupported-nationality'`);
      await cutover(admin);
      expect(
        (
          await admin.query(
            "SELECT intent_id,status FROM community_creation_intents ORDER BY intent_id",
          )
        ).rows,
      ).toEqual([
        { intent_id: "unrelated", status: "gate_unsupported" },
        { intent_id: "unsupported-nationality", status: "expired" },
        { intent_id: "waiting", status: "expired" },
      ]);
      expect(await stateRow(admin, "waiting")).toMatchObject({ status: "expired", generation: 1 });
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM nationality_ceremony_attempts"))
          .rows,
      ).toEqual([{ count: 1 }]);
    });
    completedTestCount += 1;
  }, 30_000);

  test("late completed creator sessions never advance a retired intent", async () => {
    await withSchema(async (connection, admin) => {
      await seedHistorical(admin, "late");
      await seedCompletedSession(admin, {
        sessionId: "session-late",
        actorId: "user-a",
        intentId: "ceremony-late",
      });
      await cutover(admin);
      await expect(
        advance(connection, { actorId: "user-a", sessionId: "session-late" }),
      ).resolves.toEqual({ kind: "stale", reason: "session_binding_drift" });
      expect(
        (
          await admin.query(
            "SELECT status,revision FROM community_creation_intents WHERE intent_id='late'",
          )
        ).rows,
      ).toEqual([{ status: "expired", revision: 2 }]);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM proof_session_completion_events"))
          .rows,
      ).toEqual([{ count: 1 }]);
    });
    completedTestCount += 1;
  }, 30_000);

  test("blocks new creator states and attempts but permits join and claim states", async () => {
    await withSchema(async (_connection, admin) => {
      await seedHistorical(admin, "blocked");
      await cutover(admin);
      await expect(
        seedUnmetNationalityState(admin, { intentId: "new", actorId: "user-a" }),
      ).rejects.toThrow("creator nationality verification is retired");
      await expect(
        seedAttempt(admin, {
          ceremonyIntentId: "next",
          intentId: "blocked",
          actorId: "user-a",
          generation: 2,
          providerId: "self.pass",
        }),
      ).rejects.toThrow();
      for (const actionKind of ["community_join", "handle_claim"]) {
        await seedUnmetNationalityState(admin, {
          intentId: actionKind,
          actorId: "user-a",
          actionKind,
        });
        await seedAttempt(admin, {
          ceremonyIntentId: actionKind,
          intentId: actionKind,
          actorId: "user-a",
          generation: 1,
          providerId: "self.pass",
          actionKind,
        });
      }
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM nationality_ceremony_attempts"))
          .rows,
      ).toEqual([{ count: 3 }]);
    });
    completedTestCount += 1;
  }, 30_000);

  test("retains satisfied and unmet historical states unchanged and prevents later mutation", async () => {
    await withSchema(async (_connection, admin) => {
      await seedHistorical(admin, "satisfied");
      await admin.query(
        "UPDATE nationality_requirement_states SET status='satisfied', satisfied_at=clock_timestamp(), updated_at=clock_timestamp() WHERE intent_id='satisfied'",
      );
      await seedIntent(admin, { intentId: "unmet", actorId: "user-a" });
      await seedUnmetNationalityState(admin, { intentId: "unmet", actorId: "user-a" });
      const unmetBefore = await stateRow(admin, "unmet");
      const before = await stateRow(admin, "satisfied");
      await cutover(admin);
      expect(await stateRow(admin, "unmet")).toEqual(unmetBefore);
      expect(await stateRow(admin, "satisfied")).toEqual(before);
      await expect(
        admin.query(
          "UPDATE nationality_requirement_states SET updated_at=clock_timestamp() WHERE intent_id='satisfied'",
        ),
      ).rejects.toThrow("creator nationality verification is retired");
    });
    completedTestCount += 1;
  }, 30_000);
  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 4)
      await Bun.write(
        sentinelPath,
        "api-next-control-plane-postgres-creation-nationality-completion-suite-complete\n",
      );
  });
});
