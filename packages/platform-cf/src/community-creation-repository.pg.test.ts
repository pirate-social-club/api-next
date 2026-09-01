import { afterAll, describe, expect, test } from "bun:test";
import type { CommunityCreationStore } from "@pirate/application";
import type { ProviderSessionStart } from "@pirate/application/verification";
import type { EvidenceBundle, ProofSession } from "@pirate/domain/verification";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneCommunityCreationStore } from "./community-creation-repository.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneVerificationCompletionStore } from "./verification-completion-repository.ts";
import { makeControlPlaneVerificationSessionStartStore } from "./verification-start-repository.ts";

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

function veryEvidenceBundle(session: ProofSession): EvidenceBundle {
  if (session.scope.kind !== "named") throw new Error("expected the Very named scope");
  return {
    id: "bound-start-bundle",
    proof_session_id: session.id,
    subject_keys: [
      {
        id: "bound-start-subject",
        issuer: session.scope.issuer,
        method: session.method,
        scope: session.scope,
        subject_digest: "d".repeat(64),
      },
    ],
    receipts: [
      {
        id: "bound-start-receipt",
        proof_session_id: session.id,
        provider_id: session.provider_id,
        issuer: session.scope.issuer,
        method: session.method,
        scope: session.scope,
        provider_configuration: session.provider_configuration,
        protocol_version: session.protocol_version,
        environment: session.environment,
        provenance_kind: "proof_session",
        evidence_kind: "very.web.server-verified.v1",
        evidence_hash: "6".repeat(64),
        metadata: { source: "test" },
        observed_at: "2026-08-21T00:00:30.000Z",
        expires_at: "2099-08-21T00:00:00.000Z",
        subject_key_id: "bound-start-subject",
      },
    ],
    binding_groups: [
      { id: "bound-start-binding", kind: "same_subject", subject_key_id: "bound-start-subject" },
    ],
    assertions: [
      {
        id: "bound-start-unique",
        subject_key_id: "bound-start-subject",
        evidence_receipt_id: "bound-start-receipt",
        claim_id: "credential.subject_unique",
        value: { subject_unique: true },
        assurance: "provider_attested",
        binding_group_id: "bound-start-binding",
        observed_at: "2026-08-21T00:00:30.000Z",
        expires_at: "2099-08-21T00:00:00.000Z",
      },
      {
        id: "bound-start-personhood",
        subject_key_id: "bound-start-subject",
        evidence_receipt_id: "bound-start-receipt",
        claim_id: "human.personhood",
        value: { personhood: true },
        assurance: "provider_attested",
        binding_group_id: "bound-start-binding",
        observed_at: "2026-08-21T00:00:30.000Z",
        expires_at: "2099-08-21T00:00:00.000Z",
      },
    ],
  };
}

const actor = { userId: "creator-1", kind: "user" as const };

suite("Postgres 17 community creation repository", () => {
  test("commits V2 after one human ceremony with a permanent namespaceless resource", async () => {
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
        status: "verification_required",
        requirements: { human_identity: { status: "pending" } },
      });
      expect(Object.keys(document.requirements)).toEqual(["human_identity"]);
      if (document.next_action.kind !== "start_verification") {
        throw new Error("expected the human creation ceremony");
      }

      const providerInput = {
        actor_id: actor.userId,
        intent_id: document.next_action.ceremony_intent_id,
        request_hash: "8".repeat(64),
        method: "palm_web",
        scope: {
          kind: "named" as const,
          scope_semantics: "issuer_rp_scope" as const,
          issuer: "https://verify.very.org",
          rp_scope: "pirate-social",
        },
        request_mode: "dynamic" as const,
        provider_configuration: {
          kind: "dynamic" as const,
          reference: "very-web",
          version: "1",
        },
        requested_requirements: [
          { claim_id: "credential.subject_unique" as const },
          { claim_id: "human.personhood" as const },
        ],
        requested_claim_ids: ["credential.subject_unique" as const, "human.personhood" as const],
        subject_binding_intent: "establish" as const,
        protocol_version: "very-web-v1",
        environment: "test",
      } as const;
      const startStore = makeControlPlaneVerificationSessionStartStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const reservation = await Effect.runPromise(
        Effect.scoped(
          startStore.reserve({
            start: providerInput,
            ttl_ms: 60_000,
            creation: {
              creation_intent_id: document.intent_id,
              requirement: "human_identity",
              generation: document.next_action.generation,
              expected_revision: document.revision,
              idempotency_key: "optional-v2-launch",
              provider_id: "very.web",
            },
          }),
        ),
      );
      if (reservation.kind !== "acquired") throw new Error("expected a start reservation");
      const providerStart: ProviderSessionStart = {
        session: {
          id: "optional-v2-proof",
          ...providerInput,
          provider_id: "very.web",
          upstream_session_ref: "very-upstream-optional-v2",
          status: "pending",
          started_at: "2026-08-21T00:00:00.000Z",
          expires_at: "2099-08-21T00:00:00.000Z",
        },
        presentation: {
          kind: "redirect",
          session_id: "optional-v2-proof",
          url: "https://very.example/verify/optional-v2",
        },
      };
      await expect(
        Effect.runPromise(
          Effect.scoped(startStore.finalize(reservation.reservation, providerStart)),
        ),
      ).resolves.toMatchObject({ kind: "created" });

      const completionStore = makeControlPlaneVerificationCompletionStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const completionReservation = await Effect.runPromise(
        Effect.scoped(
          completionStore.reserveAttempt({
            proof_session_id: providerStart.session.id,
            idempotency_key: "optional-v2-complete",
            lease_ms: 60_000,
            max_consumed_attempts: 3,
          }),
        ),
      );
      if (completionReservation.kind !== "acquired") {
        throw new Error("expected a completion reservation");
      }
      const completion = await Effect.runPromise(
        Effect.scoped(
          completionStore.commit({
            actor_id: actor.userId,
            idempotency_key: "optional-v2-complete",
            attempt: completionReservation.reservation,
            expected_session: providerStart.session,
            result_hash: "6".repeat(64),
            bundle: veryEvidenceBundle(providerStart.session),
          }),
        ),
      );
      expect(completion).toMatchObject({ kind: "committed" });

      const ready = await Effect.runPromise(
        creationStore.get({ actor, intentId: document.intent_id }),
      );
      expect(ready).toMatchObject({
        creation_contract_version: "optional_route_v2",
        revision: 2,
        status: "commit_ready",
        next_action: { kind: "commit" },
      });
      if (ready === null) throw new Error("expected a commit-ready intent");
      const commitInput = {
        actor,
        intentId: document.intent_id,
        requestHash: "1".repeat(64),
        body: { idempotency_key: "optional-v2-commit", expected_revision: ready.revision },
      } as const;
      const committed = await Effect.runPromise(creationStore.commit(commitInput));
      const resource = committed.document.committed_resource;
      expect(committed).toMatchObject({
        outcome: "fresh_created",
        document: {
          creation_contract_version: "optional_route_v2",
          revision: 3,
          status: "committed",
          committed_resource: {
            authority_version: "optional_route_v2",
            canonical_route: null,
          },
        },
      });
      if (resource === null || !("authority_version" in resource)) {
        throw new Error("expected an optional-route resource");
      }
      expect(resource.community_id).toMatch(
        /^community_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(resource.href).toBe(`/c/${resource.community_id}`);
      await expect(Effect.runPromise(creationStore.commit(commitInput))).resolves.toEqual({
        document: committed.document,
        outcome: "replayed",
      });

      const stored = await admin.query(
        `SELECT community.canonical_route_binding_id,
                community.route_authority_version,
                (SELECT COUNT(*)::integer FROM community_creation_requirement_states
                  WHERE intent_id = $1 AND requirement_kind = 'human_identity') AS human_rows,
                (SELECT COUNT(*)::integer FROM community_creation_requirement_states
                  WHERE intent_id = $1 AND requirement_kind = 'namespace_ownership') AS namespace_rows,
                (SELECT COUNT(*)::integer FROM community_memberships
                  WHERE community_id = community.community_id
                    AND user_id = $2 AND status = 'member') AS memberships,
                (SELECT COUNT(*)::integer FROM community_route_authority_grants
                  WHERE community_id = community.community_id
                    AND principal_user_id = $2 AND authority = 'manage_routes'
                    AND status = 'active') AS route_grants,
                (SELECT COUNT(*)::integer FROM community_handle_sales_authority_grants
                  WHERE community_id = community.community_id
                    AND principal_account_id = $2 AND authority = 'manage_handle_sales'
                    AND status = 'active') AS handle_sales_grants
           FROM communities AS community
          WHERE community.community_id = $3`,
        [document.intent_id, actor.userId, resource.community_id],
      );
      expect(stored.rows).toEqual([
        {
          canonical_route_binding_id: null,
          route_authority_version: "optional_route_v2",
          human_rows: 1,
          namespace_rows: 0,
          memberships: 1,
          route_grants: 1,
          handle_sales_grants: 1,
        },
      ]);
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
        status: "verification_required",
        next_action: {
          kind: "start_verification",
          requirement: "human_identity",
          provider_id: "very.web",
          creation_intent_id: "intent-1",
          ceremony_intent_id: "intent-ceremony-1",
          generation: 1,
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
          status: "verification_required",
          next_action: { kind: "start_verification", requirement: "human_identity" },
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
        { operation_kind: "create", status: "verification_required" },
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
  if (connectionString !== undefined && completedTestCount === 5) {
    await Bun.write(sentinelPath, sentinelContents);
  }
});
