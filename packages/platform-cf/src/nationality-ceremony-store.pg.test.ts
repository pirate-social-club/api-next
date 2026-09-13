import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import {
  type NationalityCeremonyRequirement,
  resolveOrIssueNationalityCeremony,
} from "./nationality-ceremony-store.ts";
import { ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) throw new Error("test URL required");
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_NATIONALITY_CEREMONY_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-nationality-ceremony-suite-complete";
let completedTestCount = 0;

function schemaIdentifier(): string {
  return `api_next_nationality_ceremony_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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

function requirement(overrides: Partial<NationalityCeremonyRequirement> = {}) {
  return {
    actionKind: "community_join",
    intentId: "join-intent-1",
    actorId: "user-a",
    requirementHash: "a".repeat(64),
    acceptedProviderIds: ["self.pass", "zkpassport"] as const,
    selectedProviderId: "self.pass",
    selectedBinding: {
      bindingHash: "b".repeat(64),
      configurationKind: "dynamic",
      configurationRef: "test:self.pass",
      configurationVersion: "1",
    },
    reservationRequest: { provider: "self.pass", mode: "test" },
    ttlSeconds: 600,
    ...overrides,
  } as NationalityCeremonyRequirement;
}

function issue(
  connection: string,
  input: NationalityCeremonyRequirement,
): Promise<Record<string, unknown>> {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        resolveOrIssueNationalityCeremony(transaction, input),
      );
    }),
  );
  return Effect.runPromise(
    program.pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
  ) as Promise<Record<string, unknown>>;
}

suite("nationality ceremony store", () => {
  test("issues generation one, replays the same provider as wait, and switches provider at generation two", async () => {
    await withSchema(async (connection) => {
      const first = await issue(connection, requirement());
      expect(first).toMatchObject({ kind: "start", generation: 1 });
      const replay = await issue(connection, requirement());
      expect(replay).toMatchObject({
        kind: "wait",
        generation: 1,
        ceremonyIntentId: first.ceremonyIntentId,
      });
      const switched = await issue(connection, requirement({ selectedProviderId: "zkpassport" }));
      expect(switched).toMatchObject({ kind: "start", generation: 2 });
      expect(switched.ceremonyIntentId).not.toBe(first.ceremonyIntentId);
      const replaySwitched = await issue(
        connection,
        requirement({ selectedProviderId: "zkpassport" }),
      );
      expect(replaySwitched).toMatchObject({
        kind: "wait",
        generation: 2,
        ceremonyIntentId: switched.ceremonyIntentId,
      });
    });
    completedTestCount += 1;
  }, 30_000);

  test("retires an expired attempt before issuing the next generation", async () => {
    await withSchema(async (connection, admin) => {
      await issue(connection, requirement({ ttlSeconds: 1, intentId: "join-intent-expiry" }));
      await Bun.sleep(1500);
      const next = await issue(connection, requirement({ intentId: "join-intent-expiry" }));
      expect(next).toMatchObject({ kind: "start", generation: 2 });
      const state = await admin.query(
        `SELECT status, generation::int AS generation FROM nationality_requirement_states WHERE intent_id = 'join-intent-expiry'`,
      );
      expect(state.rows[0]).toMatchObject({ status: "pending", generation: 2 });
    });
    completedTestCount += 1;
  }, 30_000);

  test("rejects a foreign actor on an owned intent and an unknown provider", async () => {
    await withSchema(async (connection) => {
      const owned = await issue(connection, requirement({ intentId: "join-intent-foreign" }));
      expect(owned).toMatchObject({ kind: "start", generation: 1 });
      await expect(
        issue(connection, requirement({ actorId: "user-b", intentId: "join-intent-foreign" })),
      ).rejects.toMatchObject({ _tag: "NationalityCeremonyDataInvalid" });
      await expect(
        issue(
          connection,
          requirement({ selectedProviderId: "very.web", intentId: "join-intent-foreign" }),
        ),
      ).rejects.toMatchObject({ _tag: "NationalityCeremonyDataInvalid" });
    });
    completedTestCount += 1;
  }, 30_000);

  test("keeps join and handle-claim ceremonies separate per action intent", async () => {
    await withSchema(async (connection) => {
      const join = await issue(connection, requirement({ intentId: "join-intent-shared" }));
      const claim = await issue(
        connection,
        requirement({ actionKind: "handle_claim", intentId: "claim-intent-shared" }),
      );
      expect(join).toMatchObject({ kind: "start", generation: 1 });
      expect(claim).toMatchObject({ kind: "start", generation: 1 });
      expect(join.ceremonyIntentId).not.toBe(claim.ceremonyIntentId);
    });
    completedTestCount += 1;
  }, 30_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 4) {
      await Bun.write(
        sentinelPath,
        "api-next-control-plane-postgres-nationality-ceremony-suite-complete\n",
      );
    }
  });
});
