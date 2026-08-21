import { afterAll, describe, expect, test } from "bun:test";
import type { CommunityCreationStore } from "@pirate/application";
import type { ProviderSessionStart } from "@pirate/application/verification";
import { communityCreationProviderBindingHash } from "@pirate/domain";
import type { EvidenceBundle, ProofSession } from "@pirate/domain/verification";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneCommunityCreationStore } from "./community-creation-repository.ts";
import { makeControlPlaneNamespaceOwnershipCompletionStore } from "./namespace-ownership-completion-repository.ts";
import { makeControlPlaneNamespaceOwnershipStartStore } from "./namespace-ownership-start-repository.ts";
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
    next_community_id: () => `${idPrefix}-community`,
    next_route_binding_id: () => `${idPrefix}-route`,
    next_subject_claim_id: () => `${idPrefix}-subject-claim`,
    namespace_provider_bindings: [
      {
        requirement: "namespace_ownership",
        family: "hns",
        provider_id: "hns.owner.v1",
        provider_configuration: {
          kind: "managed",
          reference: "hns-owner-test",
          version: "1",
        },
        protocol_version: "hns-txt-v1",
      },
      {
        requirement: "namespace_ownership",
        family: "spaces",
        provider_id: "spaces.owner.disabled",
        provider_configuration: {
          kind: "managed",
          reference: "spaces-owner-disabled",
          version: "1",
        },
        protocol_version: "spaces-disabled-v1",
      },
    ],
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
        evidence_kind: "very.oauth.id-token-userinfo.v1",
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
  test("activates one canonical route after exact Very and namespace ceremonies", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      await admin.query({
        text: "INSERT INTO users (user_id, status, account) VALUES ($1, 'active', '{}'::jsonb)",
        values: [actor.userId],
      });
      const creationStore = storeFor(connection, 86_400, "bound-start");
      const created = await Effect.runPromise(
        creationStore.create({
          actor,
          requestHash: "9".repeat(64),
          body: {
            idempotency_key: "bound-start-create",
            draft: {
              name: "Bound start",
              description: null,
              route_request: { family: "hns", root_label: "bound-start" },
              policy: humanPolicy,
            },
          },
        }),
      );
      const document = created.document;
      if (document.next_action.kind !== "start_verification") {
        throw new Error("expected the human creation ceremony");
      }
      const providerInput = {
        actor_id: actor.userId,
        intent_id: document.next_action.ceremony_intent_id,
        request_hash: "8".repeat(64),
        method: "palm_oauth",
        scope: {
          kind: "named" as const,
          scope_semantics: "issuer_rp_scope" as const,
          issuer: "https://connect.very.org",
          rp_scope: "pirate-social",
        },
        request_mode: "dynamic" as const,
        provider_configuration: { kind: "dynamic" as const, reference: "very-oauth", version: "1" },
        requested_requirements: [
          { claim_id: "credential.subject_unique" as const },
          { claim_id: "human.personhood" as const },
        ],
        requested_claim_ids: ["credential.subject_unique" as const, "human.personhood" as const],
        subject_binding_intent: "establish" as const,
        protocol_version: "oauth2-oidc-v1",
        environment: "test",
      } as const;
      const reservationInput = {
        start: providerInput,
        ttl_ms: 60_000,
        creation: {
          creation_intent_id: document.intent_id,
          requirement: "human_identity" as const,
          generation: document.next_action.generation,
          expected_revision: document.revision,
          idempotency_key: "bound-start-launch",
          provider_id: "very.oauth",
        },
      };
      const startStore = makeControlPlaneVerificationSessionStartStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const stale = await Effect.runPromise(
        Effect.scoped(
          startStore.reserve({
            ...reservationInput,
            creation: { ...reservationInput.creation, expected_revision: document.revision + 1 },
          }),
        ),
      );
      expect(stale).toEqual({ kind: "conflict" });

      const reserved = await Effect.runPromise(Effect.scoped(startStore.reserve(reservationInput)));
      if (reserved.kind !== "acquired") throw new Error("expected an acquired reservation");
      expect(reserved.reservation.creation).toEqual({
        creation_intent_id: document.intent_id,
        ceremony_intent_id: document.next_action.ceremony_intent_id,
        requirement: "human_identity",
        generation: document.next_action.generation,
        idempotency_key: "bound-start-launch",
      });
      const providerStart: ProviderSessionStart = {
        session: {
          id: "bound-start-proof",
          ...providerInput,
          provider_id: "very.oauth",
          upstream_session_ref: "very-upstream-bound-start",
          status: "pending",
          started_at: "2026-08-21T00:00:00.000Z",
          expires_at: "2099-08-21T00:00:00.000Z",
        },
        presentation: {
          kind: "redirect",
          session_id: "bound-start-proof",
          url: "https://very.example/verify/bound-start",
        },
      };
      await expect(
        Effect.runPromise(Effect.scoped(startStore.finalize(reserved.reservation, providerStart))),
      ).resolves.toMatchObject({ kind: "created", start: providerStart });
      await expect(
        Effect.runPromise(Effect.scoped(startStore.reserve(reservationInput))),
      ).resolves.toEqual({ kind: "replay", start: providerStart });
      const rows = await admin.query(
        `SELECT reservation.creation_intent_id,
                reservation.creation_requirement_kind,
                reservation.creation_generation,
                reservation.client_idempotency_key,
                session.creation_ceremony_intent_id
           FROM verification_start_reservations AS reservation
           JOIN proof_sessions AS session
             ON session.intent_id = reservation.intent_id
          WHERE reservation.actor_id = $1`,
        [actor.userId],
      );
      expect(rows.rows).toEqual([
        {
          creation_intent_id: document.intent_id,
          creation_requirement_kind: "human_identity",
          creation_generation: "1",
          client_idempotency_key: "bound-start-launch",
          creation_ceremony_intent_id: document.next_action.ceremony_intent_id,
        },
      ]);

      const completionStore = makeControlPlaneVerificationCompletionStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const humanReservation = await Effect.runPromise(
        Effect.scoped(
          completionStore.reserveAttempt({
            proof_session_id: providerStart.session.id,
            idempotency_key: "bound-start-complete",
            lease_ms: 60_000,
            max_consumed_attempts: 3,
          }),
        ),
      );
      if (humanReservation.kind !== "acquired") {
        throw new Error("expected a human completion reservation");
      }
      const humanCompletion = await Effect.runPromiseExit(
        Effect.scoped(
          completionStore.commit({
            actor_id: actor.userId,
            idempotency_key: "bound-start-complete",
            attempt: humanReservation.reservation,
            expected_session: providerStart.session,
            result_hash: "6".repeat(64),
            bundle: veryEvidenceBundle(providerStart.session),
          }),
        ),
      );
      expect(humanCompletion).toMatchObject({
        _tag: "Success",
        value: { kind: "committed", result_hash: "6".repeat(64) },
      });
      if (humanCompletion._tag === "Failure") {
        throw new Error(String(humanCompletion.cause));
      }

      const namespacePending = await Effect.runPromise(
        creationStore.get({ actor, intentId: document.intent_id }),
      );
      if (namespacePending?.next_action.kind !== "start_verification") {
        throw new Error("expected the namespace ownership ceremony");
      }
      expect(namespacePending).toMatchObject({
        revision: 2,
        status: "verification_required",
        requirements: {
          human_identity: { status: "satisfied" },
          namespace_ownership: { status: "pending" },
        },
        next_action: { requirement: "namespace_ownership" },
      });

      const namespaceBindingHash = communityCreationProviderBindingHash({
        requirement: "namespace_ownership",
        family: "hns",
        provider_id: "hns.owner.v1",
        provider_configuration: {
          kind: "managed",
          reference: "hns-owner-test",
          version: "1",
        },
        protocol_version: "hns-txt-v1",
      });
      const namespaceStartInput = {
        provider_id: "hns.owner.v1",
        start: {
          actor_id: actor.userId,
          creation_intent_id: document.intent_id,
          ceremony_intent_id: namespacePending.next_action.ceremony_intent_id,
          requirement_hash: namespacePending.requirements.namespace_ownership.requirement_hash,
          generation: namespacePending.next_action.generation,
          request_hash: "7".repeat(64),
          provider_binding_hash: namespaceBindingHash,
          provider_configuration: {
            kind: "managed" as const,
            reference: "hns-owner-test",
            version: "1",
          },
          protocol_version: "hns-txt-v1",
          environment: "test",
          route: {
            family: "hns" as const,
            root_label: "bound-start",
            root_label_display: "bound-start",
            path_segment: "app.bound-start",
            href: "/c/app.bound-start",
            app_host: null,
          },
        },
        expected_revision: namespacePending.revision,
        client_idempotency_key: "bound-namespace-start",
        reservation_id: "bound-namespace-reservation",
        namespace_session_id: "bound-namespace-session",
        ttl_ms: 60_000,
      } as const;
      const namespaceStartStore = makeControlPlaneNamespaceOwnershipStartStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const namespaceReservation = await Effect.runPromise(
        Effect.scoped(namespaceStartStore.reserve(namespaceStartInput)),
      );
      if (namespaceReservation.kind !== "acquired") {
        throw new Error("expected a namespace start reservation");
      }
      const namespaceStarted = await Effect.runPromise(
        Effect.scoped(
          namespaceStartStore.finalize(namespaceReservation.reservation, {
            session: {
              ...namespaceStartInput.start,
              provider_id: namespaceStartInput.provider_id,
              upstream_session_ref: "bound-namespace-upstream",
              expires_at: "2099-08-21T00:00:00.000Z",
            },
            presentation: {
              kind: "poll",
              session_id: "bound-namespace-upstream",
              poll_url: "/provider/poll",
            },
          }),
        ),
      );
      expect(namespaceStarted).toMatchObject({ kind: "created" });

      const namespaceCompletionStore = makeControlPlaneNamespaceOwnershipCompletionStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const namespaceStored = await Effect.runPromise(
        Effect.scoped(
          namespaceCompletionStore.load({
            actor_id: actor.userId,
            creation_intent_id: document.intent_id,
            ceremony_intent_id: namespacePending.next_action.ceremony_intent_id,
            session_id: namespaceStartInput.namespace_session_id,
          }),
        ),
      );
      if (namespaceStored === null) throw new Error("expected the namespace completion authority");
      const namespaceCompletionInput = {
        actor_id: actor.userId,
        creation_intent_id: document.intent_id,
        ceremony_intent_id: namespacePending.next_action.ceremony_intent_id,
        session_id: namespaceStartInput.namespace_session_id,
        expected_revision: namespacePending.revision,
        idempotency_key: "bound-namespace-complete",
        completion_request_hash: "8".repeat(64),
        expired_result_hash: "9".repeat(64),
        completion_attempt_id: "bound-namespace-completion-attempt",
        evidence_ref: "bound-namespace-evidence",
        lease_ms: 60_000,
        max_consumed_attempts: 3,
      } as const;
      const namespaceCompletionReservation = await Effect.runPromise(
        Effect.scoped(namespaceCompletionStore.reserve(namespaceCompletionInput)),
      );
      if (namespaceCompletionReservation.kind !== "acquired") {
        throw new Error("expected a namespace completion reservation");
      }
      const rawResponse = Buffer.from('{"status":"verified"}', "utf8");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            namespaceCompletionStore.verify({
              actor_id: actor.userId,
              expected: namespaceStored,
              idempotency_key: namespaceCompletionInput.idempotency_key,
              completion_request_hash: namespaceCompletionInput.completion_request_hash,
              result_hash: "a".repeat(64),
              expired_result_hash: namespaceCompletionInput.expired_result_hash,
              attempt: namespaceCompletionReservation.reservation,
              verified: {
                envelope: {
                  version: "pirate-hns-ownership-evidence-v1",
                  actor_id: actor.userId,
                  creation_intent_id: document.intent_id,
                  requirement: "namespace_ownership",
                  requirement_hash: namespaceStored.session.requirement_hash,
                  ceremony_intent_id: namespaceStored.session.ceremony_intent_id,
                  generation: namespaceStored.session.generation,
                  request_hash: namespaceStored.session.request_hash,
                  provider_id: namespaceStored.session.provider_id,
                  provider_binding_hash: namespaceStored.session.provider_binding_hash,
                  provider_configuration_kind: namespaceStored.session.provider_configuration.kind,
                  provider_configuration_reference:
                    namespaceStored.session.provider_configuration.reference,
                  provider_configuration_version:
                    namespaceStored.session.provider_configuration.version,
                  protocol_version: namespaceStored.session.protocol_version,
                  environment: namespaceStored.session.environment,
                  family: "hns",
                  root_label: namespaceStored.session.route.root_label,
                  root_label_display: namespaceStored.session.route.root_label_display,
                  path_segment: namespaceStored.session.route.path_segment,
                  upstream_session_ref: namespaceStored.session.upstream_session_ref,
                  ownership_source: "owner_authoritative_dns_txt",
                  challenge_name: `_pirate.${namespaceStored.session.route.root_label}`,
                  challenge_value_sha256: "b".repeat(64),
                  root_exists: true,
                  root_control_verified: true,
                  expiry_horizon_sufficient: true,
                  chain_network: "regtest",
                  chain_anchor_height: 123,
                  chain_anchor_block_hash: "c".repeat(64),
                  chain_anchor_median_time: 456,
                  expiry_height: 789,
                  observed_at: "2026-08-21T00:01:00.000Z",
                  expires_at: "2099-08-21T00:00:00.000Z",
                  evidence_ref: namespaceCompletionReservation.reservation.evidence_ref,
                  provider_evidence_ref: "bound-provider-evidence",
                  observation_sha256: "d".repeat(64),
                  provider_identity_digest: "e".repeat(64),
                  evidence_digest: "f".repeat(64),
                },
                observation: {
                  status: "verified",
                  provider_evidence_ref: "bound-provider-evidence",
                },
                raw_response_bytes: rawResponse,
              },
            }),
          ),
        ),
      ).toEqual({ kind: "committed", result_hash: "a".repeat(64) });

      const ready = await Effect.runPromise(
        creationStore.get({ actor, intentId: document.intent_id }),
      );
      expect(ready).toMatchObject({
        revision: 3,
        status: "commit_ready",
        next_action: { kind: "commit" },
      });
      if (ready === null) throw new Error("expected a commit-ready creation intent");
      const committed = await Effect.runPromise(
        creationStore.commit({
          actor,
          intentId: document.intent_id,
          requestHash: "1".repeat(64),
          body: {
            idempotency_key: "bound-create-commit",
            expected_revision: ready.revision,
          },
        }),
      );
      expect(committed).toMatchObject({
        outcome: "fresh_created",
        document: {
          revision: 4,
          status: "committed",
          committed_resource: {
            community_id: "bound-start-community",
            href: "/c/app.bound-start",
            canonical_route: {
              family: "hns",
              root_label: "bound-start",
              path_segment: "app.bound-start",
              app_host: null,
            },
          },
        },
      });
      const activation = await admin.query(
        `SELECT community.route_slug, community.canonical_route_binding_id,
                binding.community_id, binding.path_segment, binding.href,
                binding.ownership_status, binding.route_lifecycle_status,
                intent.committed_resource_href
           FROM communities AS community
           JOIN community_canonical_route_bindings AS binding
             ON binding.route_binding_id = community.canonical_route_binding_id
            AND binding.community_id = community.community_id
           JOIN community_creation_intents AS intent
             ON intent.committed_community_id = community.community_id
          WHERE community.community_id = 'bound-start-community'`,
      );
      expect(activation.rows).toEqual([
        {
          route_slug: null,
          canonical_route_binding_id: "bound-start-route",
          community_id: "bound-start-community",
          path_segment: "app.bound-start",
          href: "/c/app.bound-start",
          ownership_status: "verified",
          route_lifecycle_status: "active",
          committed_resource_href: "/c/app.bound-start",
        },
      ]);
    });
    completedTestCount += 1;
  }, 30_000);

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
          description: "First draft",
          route_request: { family: "hns" as const, root_label: "jazleeuw" },
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
          provider_id: "very.oauth",
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
              description: null,
              route_request: { family: "hns", root_label: "unsupported" },
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
              name: "Spaces deferred",
              description: null,
              route_request: { family: "spaces", root_label: "music" },
              policy: humanPolicy,
            },
          },
        }),
      );
      expect(spacesResult).toMatchObject({
        outcome: "fresh",
        document: {
          status: "gate_unsupported",
          next_action: { kind: "blocked", reason: "gate_unsupported" },
          draft: { route_request: { family: "spaces", root_label: "music" } },
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
              description: null,
              route_request: { family: "hns", root_label: "expiring" },
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
          description: null,
          route_request: { family: "hns" as const, root_label: "race" },
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
  if (connectionString !== undefined && completedTestCount === 4) {
    await Bun.write(sentinelPath, sentinelContents);
  }
});
