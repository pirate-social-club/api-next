import { afterAll, describe, expect, test } from "bun:test";
import type { CommunityCreationStore } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneCommunityCreationStore } from "./community-creation-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_COMMUNITY_CREATION_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-community-creation-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-community-creation-suite-complete\n";
let completedTestCount = 0;

const humanPolicy = {
  version: 1 as const,
  accessPaths: [
    {
      id: "verified-people",
      operator: "and" as const,
      requirements: [{ requirement: "human-verification" as const }],
    },
  ] as const,
};

function schemaIdentifier(): string {
  return `api_next_creation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function storeFor(
  connection: string,
  ttlSeconds = 86_400,
  idPrefix = "intent",
): CommunityCreationStore["Service"] {
  let sequence = 0;
  return makeControlPlaneCommunityCreationStore(makeDirectPostgresControlPlaneLayer(connection), {
    intent_ttl_seconds: ttlSeconds,
    next_intent_id: () => `${idPrefix}-${++sequence}`,
  });
}

const actor = { userId: "creator-1", kind: "user" as const };

suite("Postgres 17 community creation repository", () => {
  test("persists create/update revisions and replays exact historical outcomes", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      await admin.query({
        text: "INSERT INTO users (user_id, status, account) VALUES ($1, 'active', '{}'::jsonb)",
        values: [actor.userId],
      });
      const store = storeFor(connection);
      const createBody = {
        idempotency_key: "create-1",
        draft: {
          name: "Jazleeuw",
          slug: "jazleeuw",
          description: "First draft",
          policy: humanPolicy,
        },
      };
      const create = () =>
        Effect.runPromise(store.create({ actor, body: createBody, requestHash: "a".repeat(64) }));
      const createdResult = await create();
      expect(createdResult.outcome).toBe("fresh");
      const created = createdResult.document;
      expect(created).toMatchObject({
        intent_id: "intent-1",
        revision: 1,
        status: "verification_required",
        next_action: {
          kind: "start_verification",
          provider_id: "very.oauth",
          intent_id: "intent-1",
        },
      });
      await expect(create()).resolves.toEqual({ document: created, outcome: "replayed" });
      await expect(
        Effect.runPromise(store.create({ actor, body: createBody, requestHash: "b".repeat(64) })),
      ).rejects.toMatchObject({
        _tag: "CommunityCreationRepositoryError",
        reason: "idempotency-conflict",
      });

      const firstUpdateBody = {
        idempotency_key: "update-1",
        expected_revision: 1,
        draft: { ...createBody.draft, description: "Reviewed" },
      };
      const firstUpdate = await Effect.runPromise(
        store.update({
          actor,
          intentId: created.intent_id,
          body: firstUpdateBody,
          requestHash: "c".repeat(64),
        }),
      );
      expect(firstUpdate).toMatchObject({
        revision: 2,
        status: "verification_required",
        draft: { description: "Reviewed" },
      });
      const secondUpdate = await Effect.runPromise(
        store.update({
          actor,
          intentId: created.intent_id,
          body: {
            idempotency_key: "update-2",
            expected_revision: 2,
            draft: { ...firstUpdateBody.draft, name: "Jazleeuw Community" },
          },
          requestHash: "d".repeat(64),
        }),
      );
      expect(secondUpdate.revision).toBe(3);
      await expect(
        Effect.runPromise(
          store.update({
            actor,
            intentId: created.intent_id,
            body: firstUpdateBody,
            requestHash: "c".repeat(64),
          }),
        ),
      ).resolves.toEqual(firstUpdate);
      await expect(
        Effect.runPromise(
          store.update({
            actor,
            intentId: created.intent_id,
            body: {
              ...firstUpdateBody,
              idempotency_key: "stale-update",
            },
            requestHash: "e".repeat(64),
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "CommunityCreationRepositoryError",
        reason: "revision-conflict",
      });

      const counts = await admin.query(`SELECT
        (SELECT COUNT(*)::integer FROM community_creation_intents) AS intents,
        (SELECT COUNT(*)::integer FROM community_creation_intent_revisions) AS revisions`);
      expect(counts.rows).toEqual([{ intents: 1, revisions: 3 }]);
    });
    completedTestCount += 1;
  }, 30_000);

  test("makes unsupported gates durable and expires active intents on read", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      await admin.query({
        text: "INSERT INTO users (user_id, status, account) VALUES ($1, 'active', '{}'::jsonb)",
        values: [actor.userId],
      });
      const unsupportedStore = storeFor(connection, 86_400, "unsupported-intent");
      const unsupportedResult = await Effect.runPromise(
        unsupportedStore.create({
          actor,
          requestHash: "f".repeat(64),
          body: {
            idempotency_key: "unsupported-1",
            draft: {
              name: "Unsupported",
              slug: "unsupported",
              description: null,
              policy: {
                version: 1,
                accessPaths: [
                  {
                    id: "age",
                    operator: "and",
                    requirements: [{ requirement: "age-minimum", minimumAge: 18 }],
                  },
                ],
              },
            },
          },
        }),
      );
      expect(unsupportedResult).toMatchObject({
        outcome: "fresh",
        document: {
          status: "gate_unsupported",
          next_action: { kind: "blocked", reason: "gate_unsupported" },
        },
      });

      const expiringStore = storeFor(connection, 1, "expiring-intent");
      const expiringResult = await Effect.runPromise(
        expiringStore.create({
          actor,
          requestHash: "0".repeat(64),
          body: {
            idempotency_key: "expiring-1",
            draft: {
              name: "Expiring",
              slug: "expiring",
              description: null,
              policy: humanPolicy,
            },
          },
        }),
      );
      const expiring = expiringResult.document;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const expired = await Effect.runPromise(
        expiringStore.get({ actor, intentId: expiring.intent_id }),
      );
      expect(expired).toMatchObject({
        revision: 2,
        status: "expired",
        next_action: { kind: "none", reason: "expired" },
      });
      const revisions = await admin.query({
        text: `SELECT operation_kind, status
                 FROM community_creation_intent_revisions
                WHERE intent_id = $1 ORDER BY revision`,
        values: [expiring.intent_id],
      });
      expect(revisions.rows).toEqual([
        { operation_kind: "create", status: "verification_required" },
        { operation_kind: "expire", status: "expired" },
      ]);
    });
    completedTestCount += 1;
  }, 30_000);

  test("serializes concurrent create replays and stale draft writers", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      await admin.query({
        text: "INSERT INTO users (user_id, status, account) VALUES ($1, 'active', '{}'::jsonb)",
        values: [actor.userId],
      });
      const firstStore = storeFor(connection, 86_400, "race-first");
      const secondStore = storeFor(connection, 86_400, "race-second");
      const body = {
        idempotency_key: "race-create",
        draft: {
          name: "Race",
          slug: "race",
          description: null,
          policy: humanPolicy,
        },
      };
      const [firstCreate, secondCreate] = await Promise.all([
        Effect.runPromise(firstStore.create({ actor, body, requestHash: "1".repeat(64) })),
        Effect.runPromise(secondStore.create({ actor, body, requestHash: "1".repeat(64) })),
      ]);
      expect([firstCreate.outcome, secondCreate.outcome].sort()).toEqual(["fresh", "replayed"]);
      expect(secondCreate.document).toEqual(firstCreate.document);
      const created = firstCreate.document;

      const outcomes = await Promise.allSettled([
        Effect.runPromise(
          firstStore.update({
            actor,
            intentId: created.intent_id,
            requestHash: "2".repeat(64),
            body: {
              idempotency_key: "race-update-a",
              expected_revision: 1,
              draft: { ...body.draft, description: "A" },
            },
          }),
        ),
        Effect.runPromise(
          secondStore.update({
            actor,
            intentId: created.intent_id,
            requestHash: "3".repeat(64),
            body: {
              idempotency_key: "race-update-b",
              expected_revision: 1,
              draft: { ...body.draft, description: "B" },
            },
          }),
        ),
      ]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        reason: {
          _tag: "CommunityCreationRepositoryError",
          reason: "revision-conflict",
        },
      });
      const counts = await admin.query(`SELECT
        (SELECT COUNT(*)::integer FROM community_creation_intents) AS intents,
        (SELECT COUNT(*)::integer FROM community_creation_intent_revisions) AS revisions`);
      expect(counts.rows).toEqual([{ intents: 1, revisions: 2 }]);
    });
    completedTestCount += 1;
  }, 30_000);
});

afterAll(async () => {
  if (connectionString !== undefined && completedTestCount === 3) {
    await Bun.write(sentinelPath, sentinelContents);
  }
});
