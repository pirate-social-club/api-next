import { afterAll, describe, expect, test } from "bun:test";
import type { CommunityCreationDraftV2 } from "@pirate/contracts";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneCommunityCreationStore } from "./community-creation-repository.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

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

function draft(personaId: string, policy = composedPolicy(["US"])): CommunityCreationDraftV2 {
  return {
    persona: { kind: "existing", persona_id: personaId },
    name: "Member policy community",
    description: null,
    policy,
  };
}

suite("Postgres 17 community creation nationality authoring without creator proof", () => {
  test("commits member nationality policy with no creator proof or ceremony", async () => {
    await withSeededSchema(async ({ connection, admin, personaId }) => {
      const store = storeFor(connection);
      const created = await Effect.runPromise(
        store.create({
          actor,
          requestHash: "8".repeat(64),
          body: { idempotency_key: "create", draft: draft(personaId) },
        }),
      );
      expect(created.document.status).toBe("commit_ready");
      expect(created.document.requirements).toEqual({});
      const committed = await Effect.runPromise(
        store.commit({
          actor,
          intentId: created.document.intent_id,
          requestHash: "7".repeat(64),
          body: { idempotency_key: "commit", expected_revision: 1 },
        }),
      );
      expect(committed.outcome).toBe("fresh_created");
      const communityId = committed.document.committed_resource?.community_id;
      expect(communityId).toBeDefined();
      expect(
        (
          await admin.query(
            "SELECT status FROM community_memberships WHERE community_id=$1 AND user_id=$2",
            [communityId, actor.userId],
          )
        ).rows,
      ).toEqual([{ status: "member" }]);
      expect(
        (
          await admin.query(
            "SELECT policy_key FROM community_policy_current WHERE community_id=$1 ORDER BY policy_key",
            [communityId],
          )
        ).rows,
      ).toHaveLength(2);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM nationality_requirement_states WHERE action_kind='community_creation'",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM nationality_ceremony_attempts WHERE action_kind='community_creation'",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        (
          await admin.query("SELECT count(*)::int AS count FROM proof_sessions WHERE actor_id=$1", [
            actor.userId,
          ])
        ).rows,
      ).toEqual([{ count: 0 }]);
      const replay = await Effect.runPromise(
        store.commit({
          actor,
          intentId: created.document.intent_id,
          requestHash: "7".repeat(64),
          body: { idempotency_key: "commit", expected_revision: 1 },
        }),
      );
      expect(replay.outcome).toBe("replayed");
      expect(replay.document).toEqual(committed.document);
    });
    completedTestCount += 1;
  }, 45_000);

  test("changing the allowlist remains commit-ready without reserving a ceremony", async () => {
    await withSeededSchema(async ({ connection, admin, personaId }) => {
      const store = storeFor(connection);
      const created = await Effect.runPromise(
        store.create({
          actor,
          requestHash: "8".repeat(64),
          body: { idempotency_key: "create", draft: draft(personaId) },
        }),
      );
      const updated = await Effect.runPromise(
        store.update({
          actor,
          intentId: created.document.intent_id,
          requestHash: "9".repeat(64),
          body: {
            idempotency_key: "update",
            expected_revision: 1,
            draft: draft(personaId, composedPolicy(["GB"])),
          },
        }),
      );
      expect(updated.status).toBe("commit_ready");
      expect(updated.requirements).toEqual({});
      expect(updated.canonical_policy_hash).not.toBe(created.document.canonical_policy_hash);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM nationality_ceremony_attempts"))
          .rows,
      ).toEqual([{ count: 0 }]);
    });
    completedTestCount += 1;
  }, 45_000);

  test("Palm-only creation remains requirement-free", async () => {
    await withSeededSchema(async ({ connection, personaId }) => {
      const store = storeFor(connection);
      const created = await Effect.runPromise(
        store.create({
          actor,
          requestHash: "8".repeat(64),
          body: { idempotency_key: "create", draft: draft(personaId, humanPolicy) },
        }),
      );
      expect(created.document.status).toBe("commit_ready");
      expect(created.document.requirements).toEqual({});
    });
    completedTestCount += 1;
  }, 45_000);

  test("authoring disabled rejects nationality without starting creator verification", async () => {
    await withSeededSchema(async ({ connection, personaId }) => {
      const store = makeControlPlaneCommunityCreationStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const created = await Effect.runPromise(
        store.create({
          actor,
          requestHash: "8".repeat(64),
          body: { idempotency_key: "create", draft: draft(personaId) },
        }),
      );
      expect(created.document.status).toBe("gate_unsupported");
      expect(created.document.requirements).toEqual({});
      expect(created.document.next_action).toEqual({ kind: "blocked", reason: "gate_unsupported" });
    });
    completedTestCount += 1;
  }, 45_000);

  test("new owners activate their profile before the terminal creation commit", async () => {
    await withSeededSchema(async ({ connection, admin }) => {
      const store = storeFor(connection);
      const created = await Effect.runPromise(
        store.create({
          actor,
          requestHash: "8".repeat(64),
          body: {
            idempotency_key: "create",
            draft: {
              ...draft("unused"),
              persona: { kind: "create_new" },
              public_name: "Community owner",
            },
          },
        }),
      );
      const pending = await Effect.runPromise(
        store.commit({
          actor,
          intentId: created.document.intent_id,
          requestHash: "7".repeat(64),
          body: { idempotency_key: "reserve", expected_revision: 1 },
        }),
      );
      expect(pending.outcome).toBe("fresh_not_created");
      await activatePendingPersonaFixtures(admin);
      const committed = await Effect.runPromise(
        store.commit({
          actor,
          intentId: created.document.intent_id,
          requestHash: "6".repeat(64),
          body: { idempotency_key: "commit", expected_revision: pending.document.revision },
        }),
      );
      expect(committed.outcome).toBe("fresh_created");
      expect(committed.document.requirements).toEqual({});
    });
    completedTestCount += 1;
  }, 45_000);

  test("cutover replay returns expiry instead of an obsolete nationality action", async () => {
    await withSeededSchema(async ({ connection, admin, personaId }) => {
      const store = storeFor(connection);
      const input = {
        actor,
        requestHash: "8".repeat(64),
        body: { idempotency_key: "historical-create", draft: draft(personaId) },
      };
      const created = await Effect.runPromise(store.create(input));
      // Reconstruct a pre-cutover snapshot inside this disposable schema.
      // Production revision history stays append-only throughout the migration.
      await admin.query(`
        ALTER TABLE community_creation_intents DISABLE TRIGGER community_creation_intent_update_guard;
        ALTER TABLE community_creation_intent_revisions DISABLE TRIGGER community_creation_intent_revision_append_only;
        UPDATE community_creation_intents SET status='verification_required';
        UPDATE community_creation_intent_revisions
          SET state_snapshot=jsonb_set(jsonb_set(state_snapshot, '{status}', '"verification_required"'),
            '{next_action}', '{"kind":"start_verification","requirement":"nationality","provider_id":"self.pass","intent_id":"obsolete-ceremony"}');
        SET CONSTRAINTS ALL IMMEDIATE;
        ALTER TABLE community_creation_intents ENABLE TRIGGER community_creation_intent_update_guard;
        ALTER TABLE community_creation_intent_revisions ENABLE TRIGGER community_creation_intent_revision_append_only;
        DROP TRIGGER nationality_creation_state_retired ON nationality_requirement_states;
        DROP TRIGGER nationality_creation_attempt_retired ON nationality_ceremony_attempts;
        DROP FUNCTION reject_retired_creation_nationality_write();
      `);
      const migration = await Bun.file(
        new URL(
          "../../../db/postgres/migrations/0193_creation_nationality_retirement.sql",
          import.meta.url,
        ),
      ).text();
      await admin.query("BEGIN");
      try {
        await admin.query(migration);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      const replay = await Effect.runPromise(store.create(input));
      expect(replay.outcome).toBe("replayed");
      expect(replay.document.intent_id).toBe(created.document.intent_id);
      expect(replay.document.status).toBe("expired");
      expect(replay.document.revision).toBe(2);
      expect(replay.document.requirements).toEqual({});
      expect(replay.document.next_action).toEqual({ kind: "none", reason: "expired" });
      // A pre-nationality create snapshot must not resurrect an earlier ready state either.
      await admin.query(
        "ALTER TABLE community_creation_intent_revisions DISABLE TRIGGER community_creation_intent_revision_append_only",
      );
      await admin.query("UPDATE community_creation_intent_revisions SET state_snapshot=$1::jsonb", [
        JSON.stringify({ ...created.document, draft: draft(personaId, humanPolicy) }),
      ]);
      await admin.query(
        "ALTER TABLE community_creation_intent_revisions ENABLE TRIGGER community_creation_intent_revision_append_only",
      );
      const earlierReplay = await Effect.runPromise(store.create(input));
      expect(earlierReplay.document).toEqual(replay.document);

      expect(
        (
          await admin.query(
            "SELECT state_snapshot->>'status' AS status FROM community_creation_intent_revisions",
          )
        ).rows,
      ).toEqual([{ status: "commit_ready" }]);
    });
    completedTestCount += 1;
  }, 45_000);

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 6)
      await Bun.write(sentinelPath, sentinelContents);
  });
});
