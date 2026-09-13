import { afterAll, describe, expect, test } from "bun:test";
import { communityJoinActionPayloadHash, communityJoinIntentBindingHash } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneCommunityStore } from "./community-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_JOIN_FULFILLMENT_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-join-fulfillment-suite-complete";
let completedTestCount = 0;

function schemaIdentifier(): string {
  return `api_next_join_fulfillment_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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

async function openCommunity(admin: Client, communityId: string): Promise<void> {
  await admin.query({
    text: `INSERT INTO communities (
             community_id, display_name, status, membership_mode, created_by_user_id,
             created_at, updated_at
           ) VALUES ($1, 'Open', 'active', 'open', 'user-a', now(), now())`,
    values: [communityId],
  });
}

async function insertIntent(
  admin: Client,
  input: Readonly<{
    readonly intentId: string;
    readonly communityId: string;
    readonly status?: string;
    readonly payloadHash?: string;
  }>,
): Promise<void> {
  await admin.query({
    text: `INSERT INTO action_intents (
             action_intent_id, user_id, community_id, action_kind, action_scope,
             action_payload_hash, intent_binding_hash, idempotency_key, status, expires_at
           ) VALUES ($1, 'user-a', $2, 'community_join', $2, $3, $4, $1, $5,
                     clock_timestamp() + interval '1 hour')`,
    values: [
      input.intentId,
      input.communityId,
      input.payloadHash ?? communityJoinActionPayloadHash(input.communityId),
      communityJoinIntentBindingHash({ actorId: "user-a", communityId: input.communityId }),
      input.status ?? "open",
    ],
  });
}

function join(connection: string, communityId: string): Promise<Record<string, unknown>> {
  const store = makeControlPlaneCommunityStore(makeDirectPostgresControlPlaneLayer(connection));
  return Effect.runPromise(
    Effect.scoped(
      store.join({
        communityId,
        actor: { userId: "user-a", kind: "user" },
        body: { persona: { kind: "create_new" } },
      }),
    ),
  ) as Promise<Record<string, unknown>>;
}

suite("community join intent fulfillment", () => {
  test("commits the fulfilled write with membership activation and replays without duplicate effect", async () => {
    await withSchema(async (connection, admin) => {
      await openCommunity(admin, "community-fulfill");
      await insertIntent(admin, { intentId: "intent-1", communityId: "community-fulfill" });
      await expect(join(connection, "community-fulfill")).resolves.toMatchObject({
        community: "community-fulfill",
        status: "joined",
      });
      await expect(join(connection, "community-fulfill")).resolves.toMatchObject({
        status: "joined",
      });
      const state = await admin.query({
        text: `SELECT
                 (SELECT COUNT(*)::int FROM community_memberships
                   WHERE community_id = 'community-fulfill' AND user_id = 'user-a') AS memberships,
                 (SELECT COUNT(*)::int FROM action_intents
                   WHERE community_id = 'community-fulfill' AND status = 'fulfilled') AS fulfilled`,
      });
      expect(state.rows[0]).toEqual({ memberships: 1, fulfilled: 1 });
    });
    completedTestCount += 1;
  }, 30_000);

  test("refuses to fulfill mismatched lineage", async () => {
    await withSchema(async (connection, admin) => {
      await openCommunity(admin, "community-lineage");
      await insertIntent(admin, {
        intentId: "intent-wrong-payload",
        communityId: "community-lineage",
        payloadHash: "f".repeat(64),
      });
      await insertIntent(admin, {
        intentId: "intent-other-community",
        communityId: "community-lineage",
      });
      await openCommunity(admin, "community-elsewhere");
      await admin.query({
        text: `UPDATE action_intents SET community_id = 'community-elsewhere'
                WHERE action_intent_id = 'intent-other-community'`,
      });
      await expect(join(connection, "community-lineage")).resolves.toMatchObject({
        status: "joined",
      });
      const state = await admin.query({
        text: `SELECT action_intent_id, status FROM action_intents ORDER BY action_intent_id`,
      });
      expect(state.rows).toEqual([
        { action_intent_id: "intent-other-community", status: "open" },
        { action_intent_id: "intent-wrong-payload", status: "open" },
      ]);
    });
    completedTestCount += 1;
  }, 30_000);

  test("rolls back with the membership when the transaction fails", async () => {
    await withSchema(async (connection, admin) => {
      await openCommunity(admin, "community-rollback");
      await insertIntent(admin, { intentId: "intent-rollback", communityId: "community-rollback" });
      await admin.query(`CREATE FUNCTION reject_fulfillment_membership()
        RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'test membership insert failure'; END; $$`);
      await admin.query(`CREATE TRIGGER reject_fulfillment_membership
        BEFORE INSERT ON community_memberships
        FOR EACH ROW EXECUTE FUNCTION reject_fulfillment_membership()`);
      await expect(join(connection, "community-rollback")).rejects.toBeDefined();
      const state = await admin.query({
        text: `SELECT
                 (SELECT COUNT(*)::int FROM community_memberships
                   WHERE community_id = 'community-rollback') AS memberships,
                 (SELECT COUNT(*)::int FROM action_intents
                   WHERE community_id = 'community-rollback' AND status = 'open') AS open_intents`,
      });
      expect(state.rows[0]).toEqual({ memberships: 0, open_intents: 1 });
    });
    completedTestCount += 1;
  }, 30_000);

  test("leaves terminal intents on their own status", async () => {
    await withSchema(async (connection, admin) => {
      await openCommunity(admin, "community-terminal");
      await insertIntent(admin, {
        intentId: "intent-expired",
        communityId: "community-terminal",
        status: "expired",
      });
      await expect(join(connection, "community-terminal")).resolves.toMatchObject({
        status: "joined",
      });
      const state = await admin.query({
        text: `SELECT status FROM action_intents WHERE action_intent_id = 'intent-expired'`,
      });
      expect(state.rows[0]).toEqual({ status: "expired" });
    });
    completedTestCount += 1;
  }, 30_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 4) {
      await Bun.write(
        sentinelPath,
        "api-next-control-plane-postgres-join-fulfillment-suite-complete\n",
      );
    }
  });
});
