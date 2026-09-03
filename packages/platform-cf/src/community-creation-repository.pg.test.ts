import { afterAll, describe, expect, test } from "bun:test";
import type { CommunityCreationStore } from "@pirate/application";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
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

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_community_creation_repository_pg_test_ts",
    use: async ({ admin, schema }) => {
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      return await use(connectionForSchema(connectionString, schema), admin);
    },
  });
}

async function firstPersonaId(admin: Client, accountId: string): Promise<string> {
  await activatePendingPersonaFixtures(admin);
  const result = await admin.query<{ persona_id: string }>(
    "SELECT persona_id FROM personas WHERE account_id = $1 AND is_first_persona",
    [accountId],
  );
  const personaId = result.rows[0]?.persona_id;
  if (personaId === undefined) throw new Error(`missing first persona for ${accountId}`);
  return personaId;
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
    next_ceremony_intent_id: () => `${idPrefix}-ceremony-${sequence}`,
    next_community_id: () => `community_${crypto.randomUUID()}`,
    next_subject_claim_id: () => `${idPrefix}-subject-claim`,
  });
}

const actor = { userId: "creator-1", kind: "user" as const };

suite("Postgres 17 community creation repository", () => {
  test("creates requirement-free V2 intents that are commit-ready without any ceremony", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query({
        text: "INSERT INTO users (user_id, status, account) VALUES ($1, 'active', '{}'::jsonb)",
        values: [actor.userId],
      });
      const personaId = await firstPersonaId(admin, actor.userId);
      const creationStore = storeFor(connection, 86_400, "optional-v2");
      const created = await Effect.runPromise(
        creationStore.create({
          actor,
          requestHash: "9".repeat(64),
          body: {
            idempotency_key: "optional-v2-create",
            draft: {
              persona_id: personaId,
              name: "Optional route",
              description: null,
              policy: humanPolicy,
            },
          },
        }),
      );
      const document = created.document;
      expect(document).toMatchObject({
        creation_contract_version: "optional_route_v2",
        revision: 1,
        status: "commit_ready",
        requirements: {},
        next_action: { kind: "commit" },
      });
      expect(Object.keys(document.requirements)).toEqual([]);

      const stored = await admin.query(
        `SELECT intent.verification_requirement_hash, intent.verification_provider_id,
                intent.provider_configuration_kind, intent.provider_configuration_ref,
                intent.provider_configuration_version,
                (SELECT COUNT(*)::integer FROM community_creation_requirement_states
                  WHERE intent_id = intent.intent_id) AS requirement_rows,
                (SELECT COUNT(*)::integer FROM community_creation_ceremony_attempts
                  WHERE intent_id = intent.intent_id) AS ceremony_rows
           FROM community_creation_intents AS intent
          WHERE intent.intent_id = $1`,
        [document.intent_id],
      );
      expect(stored.rows).toEqual([
        {
          verification_requirement_hash: null,
          verification_provider_id: null,
          provider_configuration_kind: null,
          provider_configuration_ref: null,
          provider_configuration_version: null,
          requirement_rows: 0,
          ceremony_rows: 0,
        },
      ]);

      // Storage keys the cardinality on the absent creator authority: a
      // requirement-free intent can never gain a human requirement row.
      await expect(
        admin.query({
          text: `INSERT INTO community_creation_requirement_states (
                   intent_id, actor_id, requirement_kind, status,
                   requirement_hash, provider_id, provider_binding_hash,
                   provider_configuration_kind, provider_configuration_ref,
                   provider_configuration_version, route_family, route_root_label,
                   route_root_label_display, route_path_segment, generation
                 ) VALUES ($1, $2, 'human_identity', 'unmet', $3, 'very.web', $4,
                           'dynamic', 'very-web', '1', NULL, NULL, NULL, NULL, 0)`,
          values: [document.intent_id, actor.userId, "a".repeat(64), "b".repeat(64)],
        }),
      ).rejects.toThrow(/must carry no human requirement row/u);

      const updated = await Effect.runPromise(
        creationStore.update({
          actor,
          intentId: document.intent_id,
          requestHash: "7".repeat(64),
          body: {
            idempotency_key: "optional-v2-update",
            expected_revision: 1,
            draft: {
              persona_id: personaId,
              name: "Optional route, revised",
              description: "Still requirement-free",
              policy: humanPolicy,
            },
          },
        }),
      );
      expect(updated).toMatchObject({
        revision: 2,
        status: "commit_ready",
        requirements: {},
        next_action: { kind: "commit" },
        draft: { name: "Optional route, revised" },
      });
      const afterUpdate = await admin.query(
        `SELECT verification_requirement_hash, verification_provider_id
           FROM community_creation_intents WHERE intent_id = $1`,
        [document.intent_id],
      );
      expect(afterUpdate.rows).toEqual([
        { verification_requirement_hash: null, verification_provider_id: null },
      ]);

      // Commit rechecks the member policy, persona ownership, and the
      // account-scoped cap; no ceremony, evidence, or subject claim exists.
      const commitInput = {
        actor,
        intentId: document.intent_id,
        requestHash: "1".repeat(64),
        body: { idempotency_key: "optional-v2-commit", expected_revision: updated.revision },
      } as const;
      const committed = await Effect.runPromise(creationStore.commit(commitInput));
      const resource = committed.document.committed_resource;
      expect(committed).toMatchObject({
        outcome: "fresh_created",
        document: {
          creation_contract_version: "optional_route_v2",
          revision: 3,
          status: "committed",
          requirements: {},
          next_action: { kind: "none", reason: "committed" },
          committed_resource: { authority_version: "optional_route_v2", canonical_route: null },
        },
      });
      if (resource === null || !("authority_version" in resource)) {
        throw new Error("expected an optional-route resource");
      }
      expect(resource.href).toBe(`/c/${resource.community_id}`);
      await expect(Effect.runPromise(creationStore.commit(commitInput))).resolves.toEqual({
        document: committed.document,
        outcome: "replayed",
      });
      const activated = await admin.query(
        `SELECT community.status, community.route_authority_version,
                (SELECT COUNT(*)::integer FROM community_memberships
                  WHERE community_id = community.community_id
                    AND user_id = $1 AND status = 'member') AS memberships,
                (SELECT COUNT(*)::integer FROM community_route_authority_grants
                  WHERE community_id = community.community_id
                    AND principal_user_id = $1 AND authority = 'manage_routes'
                    AND status = 'active') AS route_grants,
                (SELECT COUNT(*)::integer FROM community_policy_current
                  WHERE community_id = community.community_id) AS current_policies,
                (SELECT COUNT(*)::integer FROM community_creation_subject_claims
                  WHERE community_id = community.community_id) AS subject_claims
           FROM communities AS community
          WHERE community.community_id = $2`,
        [actor.userId, resource.community_id],
      );
      expect(activated.rows).toEqual([
        {
          status: "active",
          route_authority_version: "optional_route_v2",
          memberships: 1,
          route_grants: 1,
          current_policies: 1,
          subject_claims: 0,
        },
      ]);
    });
    completedTestCount += 1;
  }, 30_000);

  test("settles a requirement-free commit as quota_exceeded at the account cap", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query({
        text: "INSERT INTO users (user_id, status, account) VALUES ($1, 'active', '{}'::jsonb)",
        values: [actor.userId],
      });
      const personaId = await firstPersonaId(admin, actor.userId);
      let sequence = 0;
      const store = makeControlPlaneCommunityCreationStore(
        makeDirectPostgresControlPlaneLayer(connection),
        {
          intent_ttl_seconds: 86_400,
          optional_route_account_community_cap: 1,
          next_intent_id: () => `capped-${++sequence}`,
          next_ceremony_intent_id: () => `capped-ceremony-${sequence}`,
          next_community_id: () => `community_${crypto.randomUUID()}`,
          next_subject_claim_id: () => `capped-subject-claim-${sequence}`,
        },
      );
      const createAndCommit = async (name: string, key: string, hash: string) => {
        const created = await Effect.runPromise(
          store.create({
            actor,
            requestHash: hash,
            body: {
              idempotency_key: `${key}-create`,
              draft: { persona_id: personaId, name, description: null, policy: humanPolicy },
            },
          }),
        );
        return Effect.runPromise(
          store.commit({
            actor,
            intentId: created.document.intent_id,
            requestHash: hash,
            body: {
              idempotency_key: `${key}-commit`,
              expected_revision: created.document.revision,
            },
          }),
        );
      };
      const first = await createAndCommit("First", "capped-one", "a".repeat(64));
      expect(first.outcome).toBe("fresh_created");
      const second = await createAndCommit("Second", "capped-two", "b".repeat(64));
      expect(second).toMatchObject({
        outcome: "fresh_not_created",
        document: {
          status: "quota_exceeded",
          next_action: { kind: "blocked", reason: "quota_exceeded" },
        },
      });
      const communities = await admin.query(
        "SELECT COUNT(*)::integer AS created FROM communities WHERE created_by_user_id = $1",
        [actor.userId],
      );
      expect(communities.rows).toEqual([{ created: 1 }]);
    });
    completedTestCount += 1;
  }, 30_000);

  test("persists create/update revisions and replays exact historical outcomes", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query({
        text: "INSERT INTO users (user_id, status, account) VALUES ($1, 'active', '{}'::jsonb)",
        values: [actor.userId],
      });
      const personaId = await firstPersonaId(admin, actor.userId);
      const store = storeFor(connection);
      const createBody = {
        idempotency_key: "create-1",
        draft: {
          persona_id: personaId,
          name: "Jazleeuw",
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
        status: "commit_ready",
        next_action: { kind: "commit" },
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
        status: "commit_ready",
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
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query({
        text: "INSERT INTO users (user_id, status, account) VALUES ($1, 'active', '{}'::jsonb)",
        values: [actor.userId],
      });
      const personaId = await firstPersonaId(admin, actor.userId);
      const unsupportedStore = storeFor(connection, 86_400, "unsupported-intent");
      const unsupportedResult = await Effect.runPromise(
        unsupportedStore.create({
          actor,
          requestHash: "f".repeat(64),
          body: {
            idempotency_key: "unsupported-1",
            draft: {
              persona_id: personaId,
              name: "Unsupported",
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

      const spacesStore = storeFor(connection, 86_400, "spaces-intent");
      const spacesResult = await Effect.runPromise(
        spacesStore.create({
          actor,
          requestHash: "d".repeat(64),
          body: {
            idempotency_key: "spaces-unsupported-1",
            draft: {
              persona_id: personaId,
              name: "Second optional route",
              description: null,
              policy: humanPolicy,
            },
          },
        }),
      );
      expect(spacesResult).toMatchObject({
        outcome: "fresh",
        document: {
          creation_contract_version: "optional_route_v2",
          status: "commit_ready",
          next_action: { kind: "commit" },
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
              persona_id: personaId,
              name: "Expiring",
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
        { operation_kind: "create", status: "commit_ready" },
        { operation_kind: "expire", status: "expired" },
      ]);
    });
    completedTestCount += 1;
  }, 30_000);

  test("serializes concurrent create replays and stale draft writers", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query({
        text: "INSERT INTO users (user_id, status, account) VALUES ($1, 'active', '{}'::jsonb)",
        values: [actor.userId],
      });
      const personaId = await firstPersonaId(admin, actor.userId);
      const firstStore = storeFor(connection, 86_400, "race-first");
      const secondStore = storeFor(connection, 86_400, "race-second");
      const body = {
        idempotency_key: "race-create",
        draft: {
          persona_id: personaId,
          name: "Race",
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

  test("rejects fresh route-v1 commits but replays an exact committed snapshot", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query({
        text: "INSERT INTO users (user_id, status, account) VALUES ($1, 'active', '{}'::jsonb)",
        values: [actor.userId],
      });
      const store = storeFor(connection, 86_400, "route-v1-replay");
      const intentId = "route-v1-replay-intent";
      const rootLabel = "legacy-replay";
      const draft = {
        name: "Legacy replay",
        description: null,
        route_request: { family: "hns", root_label: rootLabel },
        policy: humanPolicy,
      };
      await expect(
        Effect.runPromise(
          store.create({
            actor,
            requestHash: "0".repeat(64),
            body: { idempotency_key: "legacy-create-rejected", draft } as never,
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "CommunityCreationRepositoryError",
        operation: "create",
        reason: "constraint",
      });
      expect(
        (
          await admin.query(`SELECT
            (SELECT COUNT(*)::integer FROM community_creation_intents) AS intents,
            (SELECT COUNT(*)::integer FROM community_creation_intent_revisions) AS revisions`)
        ).rows,
      ).toEqual([{ intents: 0, revisions: 0 }]);

      await admin.query("BEGIN");
      try {
        // Current APIs cannot create route-v1 rows. Seed a structurally
        // consistent historical snapshot without replaying the retired
        // ceremony workflow; the repository decoder validates its shape below.
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query(
          `INSERT INTO community_creation_intents (
           intent_id, actor_id, create_idempotency_key, create_request_hash,
           revision, status, draft, canonical_policy_revision,
           canonical_policy_hash, verification_requirement_hash,
           verification_provider_id, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version,
           expires_at, creation_contract_version
         ) VALUES ($1, $2, 'legacy-create', $3, 1, 'commit_ready', $4::jsonb, 1,
                   $5, $6, 'very.web', 'dynamic', 'very-web', '1',
                   '2099-01-01T00:00:00.000Z', 'route_v1')`,
          [
            intentId,
            actor.userId,
            "f".repeat(64),
            JSON.stringify(draft),
            "a".repeat(64),
            "b".repeat(64),
          ],
        );
        await admin.query(
          `INSERT INTO community_creation_requirement_states (
           intent_id, actor_id, requirement_kind, status,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, route_family, route_root_label,
           route_root_label_display, route_path_segment, generation,
           current_ceremony_intent_id, satisfied_at
         ) VALUES
           ($1, $2, 'human_identity', 'satisfied', $3, 'very.web', $4,
                   'dynamic', 'very-web', '1', NULL, NULL, NULL, NULL, 1,
                   'legacy-human-ceremony', '2026-08-21T00:00:00.000Z'),
           ($1, $2, 'namespace_ownership', 'satisfied', $5, 'hns.owner.v1', $6,
                   'managed', 'hns-owner-test', '1', 'hns', $7, $7, $8, 1,
                   'legacy-namespace-ceremony', '2026-08-21T00:00:00.000Z')`,
          [
            intentId,
            actor.userId,
            "b".repeat(64),
            "c".repeat(64),
            "d".repeat(64),
            "e".repeat(64),
            rootLabel,
            `app.${rootLabel}`,
          ],
        );
        await admin.query(
          `INSERT INTO community_creation_ceremony_attempts (
           ceremony_intent_id, actor_id, intent_id, requirement_kind,
           generation, requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, route_family, route_root_label,
           route_root_label_display, route_path_segment,
           reservation_request_hash, reservation_request, expires_at
         ) VALUES
           ('legacy-human-ceremony', $1, $2, 'human_identity', 1, $3,
                   'very.web', $4, 'dynamic', 'very-web', '1',
                   NULL, NULL, NULL, NULL, $5, '{}'::jsonb, '2099-01-01T00:00:00.000Z'),
           ('legacy-namespace-ceremony', $1, $2, 'namespace_ownership', 1, $6,
                   'hns.owner.v1', $7, 'managed', 'hns-owner-test', '1',
                   'hns', $8, $8, $9, $10, '{}'::jsonb, '2099-01-01T00:00:00.000Z')`,
          [
            actor.userId,
            intentId,
            "b".repeat(64),
            "c".repeat(64),
            "1".repeat(64),
            "d".repeat(64),
            "e".repeat(64),
            rootLabel,
            `app.${rootLabel}`,
            "2".repeat(64),
          ],
        );
        await admin.query("SET LOCAL session_replication_role = origin");
        await admin.query("COMMIT");
      } catch (cause) {
        await admin.query("ROLLBACK").catch(() => undefined);
        throw cause;
      }
      const commitInput = {
        actor,
        intentId,
        requestHash: "1".repeat(64),
        body: { idempotency_key: "legacy-commit", expected_revision: 1 },
      } as const;
      const state = async () =>
        (
          await admin.query(
            `SELECT revision, status, committed_community_id, committed_resource_href,
                  (SELECT COUNT(*)::integer FROM community_creation_intent_revisions
                    WHERE intent_id = $1 AND operation_kind = 'commit') AS commit_revisions,
                  (SELECT COUNT(*)::integer FROM community_creation_requirement_states
                    WHERE intent_id = $1) AS requirement_states,
                  (SELECT COUNT(*)::integer FROM community_creation_ceremony_attempts
                    WHERE intent_id = $1) AS ceremony_attempts,
                  (SELECT COUNT(*)::integer FROM community_creation_ceremony_results
                    WHERE intent_id = $1) AS ceremony_results,
                  (SELECT COUNT(*)::integer FROM communities) AS communities,
                  (SELECT COUNT(*)::integer FROM community_canonical_route_bindings) AS bindings,
                  (SELECT COUNT(*)::integer FROM community_creation_subject_claims) AS claims,
                  (SELECT COUNT(*)::integer FROM policy_versions) AS policies,
                  (SELECT COUNT(*)::integer FROM community_policy_provider_bindings) AS provider_bindings,
                  (SELECT COUNT(*)::integer FROM community_policy_current) AS current_policies
             FROM community_creation_intents
            WHERE intent_id = $1`,
            [intentId],
          )
        ).rows;
      const before = await state();
      const ready = await Effect.runPromise(store.get({ actor, intentId }));
      if (ready === null || ready.status !== "commit_ready") {
        throw new Error("expected a valid commit-ready route-v1 intent");
      }
      if ("creation_contract_version" in ready) {
        throw new Error("expected the historical route-v1 document shape");
      }
      await expect(Effect.runPromise(store.commit(commitInput))).rejects.toMatchObject({
        _tag: "CommunityCreationRepositoryError",
        operation: "commit",
        reason: "constraint",
      });
      expect(await state()).toEqual(before);

      const committedSnapshot = {
        ...ready,
        revision: ready.revision + 1,
        status: "committed" as const,
        next_action: { kind: "none" as const, reason: "committed" as const },
        committed_resource: {
          community_id: "legacy-replay-community",
          href: `/c/app.${rootLabel}`,
          canonical_route: {
            family: "hns" as const,
            root_label: rootLabel,
            root_label_display: rootLabel,
            path_segment: `app.${rootLabel}`,
            href: `/c/app.${rootLabel}`,
            app_host: null,
          },
        },
      };
      await admin.query(
        `INSERT INTO community_creation_intent_revisions (
           intent_id, revision, actor_id, operation_kind, idempotency_key,
           request_hash, status, state_snapshot
         ) VALUES ($1, 2, $2, 'commit', $3, $4, 'committed', $5::jsonb)`,
        [
          intentId,
          actor.userId,
          commitInput.body.idempotency_key,
          commitInput.requestHash,
          JSON.stringify(committedSnapshot),
        ],
      );
      await expect(Effect.runPromise(store.commit(commitInput))).resolves.toEqual({
        document: committedSnapshot,
        outcome: "replayed",
      });
      expect(await state()).toEqual([
        {
          revision: 1,
          status: "commit_ready",
          committed_community_id: null,
          committed_resource_href: null,
          commit_revisions: 1,
          requirement_states: 2,
          ceremony_attempts: 2,
          ceremony_results: 0,
          communities: 0,
          bindings: 0,
          claims: 0,
          policies: 0,
          provider_bindings: 0,
          current_policies: 0,
        },
      ]);
    });
    completedTestCount += 1;
  }, 30_000);
});

afterAll(async () => {
  if (connectionString !== undefined && completedTestCount === 6) {
    await Bun.write(sentinelPath, sentinelContents);
  }
});
