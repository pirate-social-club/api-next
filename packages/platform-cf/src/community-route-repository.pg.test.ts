import { afterAll, describe, expect, test } from "bun:test";
import {
  activateOperatorManagedRoute,
  expireCommunityRouteEvidence,
  revokeOperatorManagedRoute,
} from "@pirate/application";
import type { Sha256Hex } from "@pirate/domain/verification";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneCommunityRouteExpiryStore } from "./community-route-expiry-repository.ts";
import { makeControlPlaneCanonicalCommunityRouteStore } from "./community-route-repository.ts";
import { makeControlPlaneOperatorManagedRouteStore } from "./operator-managed-route-repository.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_CANONICAL_ROUTE_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-canonical-route-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-canonical-route-suite-complete\n";
let completedTestCount = 0;

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
    schemaName: "packages_platform_cf_src_community_route_repository_pg_test_ts",
    use: async ({ admin, schema }) => {
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      return await use(connectionForSchema(connectionString, schema), admin);
    },
  });
}

type RouteSeed = Readonly<{
  readonly suffix: string;
  readonly family: "hns";
  readonly rootLabel: string;
  readonly rootLabelDisplay: string;
  readonly pathSegment: string;
  readonly communityId: string;
  readonly bindingId: string;
  readonly evidenceExpiresAt?: Date | null;
}>;

async function seedRoute(admin: Client, route: RouteSeed): Promise<void> {
  const hash = "a".repeat(64);
  const bindingHash = "b".repeat(64);
  const ceremonyId = `ceremony-${route.suffix}`;
  const intentId = `intent-${route.suffix}`;
  const evidenceRef = `evidence-${route.suffix}`;
  const terminalAt = new Date(Date.now() - 1_000);
  const evidenceExpiresAt =
    route.evidenceExpiresAt === undefined
      ? new Date(terminalAt.getTime() + 60 * 60 * 1_000)
      : route.evidenceExpiresAt;

  await admin.query(
    `INSERT INTO community_creation_intents (
       intent_id, actor_id, create_idempotency_key, create_request_hash,
       revision, status, draft, canonical_policy_revision,
       canonical_policy_hash, verification_requirement_hash,
       verification_provider_id, provider_configuration_kind,
       provider_configuration_ref, provider_configuration_version, expires_at
     ) VALUES ($1, 'route-actor', $2, $3, 1, 'verification_required',
       '{}'::jsonb, 1, $4, $5, 'route.provider', 'dynamic', 'route-config', '1',
       clock_timestamp() + interval '1 day')`,
    [intentId, `create-${route.suffix}`, hash, hash, hash],
  );
  await admin.query(
    `INSERT INTO community_creation_requirement_states (
       intent_id, actor_id, requirement_kind, status, requirement_hash,
       provider_id, provider_binding_hash, provider_configuration_kind,
       provider_configuration_ref, provider_configuration_version,
       route_family, route_root_label, route_root_label_display, route_path_segment
     ) VALUES ($1, 'route-actor', 'namespace_ownership', 'unmet', $2,
       'route.provider', $3, 'dynamic', 'route-config', '1', $4, $5, $6, $7)`,
    [
      intentId,
      hash,
      bindingHash,
      route.family,
      route.rootLabel,
      route.rootLabelDisplay,
      route.pathSegment,
    ],
  );
  await admin.query(
    `INSERT INTO community_creation_ceremony_attempts (
       ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
       requirement_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, route_family, route_root_label,
       route_root_label_display, route_path_segment, reservation_request_hash,
       reservation_request, reserved_at, expires_at
     ) VALUES ($1, 'route-actor', $2, 'namespace_ownership', 1, $3,
       'route.provider', $4, 'dynamic', 'route-config', '1', $5, $6, $7, $8,
       $3, '{}'::jsonb, clock_timestamp() - interval '1 minute',
       clock_timestamp() + interval '1 hour')`,
    [
      ceremonyId,
      intentId,
      hash,
      bindingHash,
      route.family,
      route.rootLabel,
      route.rootLabelDisplay,
      route.pathSegment,
    ],
  );
  await admin.query(
    `UPDATE community_creation_requirement_states
        SET status = 'pending', generation = 1,
            current_ceremony_intent_id = $1, updated_at = clock_timestamp()
      WHERE intent_id = $2 AND requirement_kind = 'namespace_ownership'`,
    [ceremonyId, intentId],
  );
  const namespaceSessionId = `namespace-session-${route.suffix}`;
  const startReservationId = `namespace-start-${route.suffix}`;
  const completionAttemptId = `namespace-completion-${route.suffix}`;
  await admin.query("BEGIN");
  await admin.query(
    `INSERT INTO namespace_ownership_start_reservations (
       reservation_id, namespace_session_id, actor_id, creation_intent_id,
       ceremony_intent_id, generation, requirement_hash, expected_revision,
       client_idempotency_key, request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
       protocol_version, environment, route_family, route_root_label, route_root_label_display,
       route_path_segment, route_href, state, fence_token, lease_expires_at
     ) VALUES ($1, $2, 'route-actor', $3, $4, 1, $5, 1, $6, $5,
       'route.provider', $7, 'dynamic', 'route-config', '1', 'hns-txt-v1', 'test',
       'hns', $8, $9, $10, $11, 'acquired', 1,
       clock_timestamp() + interval '30 minutes')`,
    [
      startReservationId,
      namespaceSessionId,
      intentId,
      ceremonyId,
      hash,
      `start-${route.suffix}`,
      bindingHash,
      route.rootLabel,
      route.rootLabelDisplay,
      route.pathSegment,
      `/c/${route.pathSegment}`,
    ],
  );
  await admin.query(
    `INSERT INTO namespace_ownership_sessions (
       namespace_session_id, actor_id, creation_intent_id, ceremony_intent_id,
       start_reservation_id, start_fence_token, expected_revision, generation,
       requirement_hash, request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
       protocol_version, environment, route_family, route_root_label, route_root_label_display,
       route_path_segment, route_href, upstream_session_ref, presentation_kind,
       presentation_payload, status, started_at, expires_at
     ) VALUES ($1, 'route-actor', $2, $3, $4, 1, 1, 1, $5, $5,
       'route.provider', $6, 'dynamic', 'route-config', '1', 'hns-txt-v1', 'test',
       'hns', $7, $8, $9, $10, $11, 'poll', '{"session_id":"route"}'::jsonb,
       'pending', clock_timestamp() - interval '1 minute',
       clock_timestamp() + interval '1 hour')`,
    [
      namespaceSessionId,
      intentId,
      ceremonyId,
      startReservationId,
      hash,
      bindingHash,
      route.rootLabel,
      route.rootLabelDisplay,
      route.pathSegment,
      `/c/${route.pathSegment}`,
      `upstream-${route.suffix}`,
    ],
  );
  await admin.query(
    `UPDATE namespace_ownership_start_reservations
        SET state = 'finalized', updated_at = clock_timestamp()
      WHERE reservation_id = $1`,
    [startReservationId],
  );
  await admin.query(
    `INSERT INTO namespace_ownership_completion_attempts (
       completion_attempt_id, namespace_session_id, actor_id, idempotency_key,
       completion_request_hash, evidence_ref, submission_channel, state,
       fence_token, lease_expires_at
     ) VALUES ($1, $2, 'route-actor', $3, $4, $5, 'poll_result', 'leased', 1,
       clock_timestamp() + interval '30 minutes')`,
    [completionAttemptId, namespaceSessionId, `callback-${route.suffix}`, hash, evidenceRef],
  );
  await admin.query(
    `UPDATE namespace_ownership_completion_attempts
        SET state = 'consumed', consumption_kind = 'verified',
            updated_at = clock_timestamp()
      WHERE completion_attempt_id = $1`,
    [completionAttemptId],
  );
  await admin.query(
    `INSERT INTO namespace_ownership_evidence_snapshots (
       evidence_ref, completion_attempt_id, namespace_session_id, actor_id,
       creation_intent_id, ceremony_intent_id, generation, requirement_hash,
       request_hash, provider_id, provider_binding_hash, provider_configuration_kind,
       provider_configuration_ref, provider_configuration_version, protocol_version,
       environment, family, root_label, root_label_display, path_segment, href,
       upstream_session_ref, fence_token, ownership_source, challenge_name,
       challenge_value_sha256, root_exists, root_control_verified,
       expiry_horizon_sufficient, chain_network, chain_anchor_height,
       chain_anchor_block_hash, chain_anchor_median_time, expiry_height,
       observed_at, expires_at, provider_evidence_ref, observation_sha256,
       provider_identity_digest, evidence_digest, observation, raw_response_bytes
     ) VALUES ($1, $2, $3, 'route-actor', $4, $5, 1, $6, $6,
       'route.provider', $7, 'dynamic', 'route-config', '1', 'hns-txt-v1', 'test',
       'hns', $8, $9, $10, $11, $12, 1, 'owner_authoritative_dns_txt', $13,
       $6, TRUE, TRUE, TRUE, 'hns-testnet', 10, $6, 100, 20,
       $14, COALESCE($15::timestamptz, clock_timestamp() + interval '1 hour'),
       $16, $6, $6, $6,
       '{"status":"verified"}'::jsonb, decode('01', 'hex'))`,
    [
      evidenceRef,
      completionAttemptId,
      namespaceSessionId,
      intentId,
      ceremonyId,
      hash,
      bindingHash,
      route.rootLabel,
      route.rootLabelDisplay,
      route.pathSegment,
      `/c/${route.pathSegment}`,
      `upstream-${route.suffix}`,
      `_pirate.${route.rootLabel}`,
      terminalAt,
      evidenceExpiresAt,
      `provider-evidence-${route.suffix}`,
    ],
  );
  await admin.query(
    `INSERT INTO community_creation_ceremony_results (
       ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
       requirement_hash, provider_id, provider_binding_hash,
       provider_configuration_version, callback_idempotency_key,
       callback_request_hash, outcome_status, result_hash, evidence_ref,
       evidence_digest, provider_identity_digest, terminal_at, satisfied_at,
       namespace_session_id, completion_attempt_id, submission_channel
     ) VALUES ($1, 'route-actor', $2, 'namespace_ownership', 1, $3,
       'route.provider', $4, '1', $5, $6, 'satisfied', $7, $8, $9, $10, $11, $11,
       $12, $13, 'poll_result')`,
    [
      ceremonyId,
      intentId,
      hash,
      bindingHash,
      `callback-${route.suffix}`,
      hash,
      hash,
      evidenceRef,
      hash,
      hash,
      terminalAt,
      namespaceSessionId,
      completionAttemptId,
    ],
  );
  await admin.query(
    `UPDATE community_creation_requirement_states
        SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
      WHERE intent_id = $2 AND requirement_kind = 'namespace_ownership'`,
    [terminalAt, intentId],
  );
  await admin.query(
    `UPDATE namespace_ownership_sessions
        SET status = 'completed', terminal_at = $1, completed_at = $1,
            updated_at = clock_timestamp()
      WHERE namespace_session_id = $2`,
    [terminalAt, namespaceSessionId],
  );
  await admin.query(
    `INSERT INTO community_route_ownership_evidence (
       evidence_ref, creation_ceremony_intent_id, verified_by_actor_id,
       family, root_label, root_label_display, path_segment,
       requirement_hash, provider_id, provider_binding_hash,
       provider_configuration_version, provider_identity_digest,
       evidence_digest, binding_generation, verified_at, expires_at
     ) VALUES ($1, $2, 'route-actor', $3, $4, $5, $6, $7,
       'route.provider', $8, '1', $9, $10, 1, $11, $12)`,
    [
      evidenceRef,
      ceremonyId,
      route.family,
      route.rootLabel,
      route.rootLabelDisplay,
      route.pathSegment,
      hash,
      bindingHash,
      hash,
      hash,
      terminalAt,
      evidenceExpiresAt,
    ],
  );
  await admin.query("COMMIT");
  await admin.query("BEGIN");
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id,
       created_at, updated_at, route_slug
     ) VALUES ($1, $2, 'active', 'route-actor', clock_timestamp(), clock_timestamp(), NULL)`,
    [route.communityId, `Route ${route.suffix}`],
  );
  await admin.query(
    `INSERT INTO community_canonical_route_bindings (
       route_binding_id, community_id, family, root_label, root_label_display,
       ownership_status, route_lifecycle_status, binding_generation,
       verified_evidence_ref
     ) VALUES ($1, $2, $3, $4, $5, 'verified', 'active', 1, $6)`,
    [
      route.bindingId,
      route.communityId,
      route.family,
      route.rootLabel,
      route.rootLabelDisplay,
      evidenceRef,
    ],
  );
  await admin.query(
    `UPDATE communities SET canonical_route_binding_id = $1 WHERE community_id = $2`,
    [route.bindingId, route.communityId],
  );
  await admin.query(
    `INSERT INTO community_route_app_host_health (
       route_binding_id, family, health_status, health_generation, observed_at
     ) VALUES ($1, 'hns', 'healthy', 1, clock_timestamp())`,
    [route.bindingId],
  );
  await admin.query("COMMIT");
}

function expireHnsRoutes(connection: string, limit = 25) {
  const store = makeControlPlaneCommunityRouteExpiryStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
  return Effect.runPromise(
    expireCommunityRouteEvidence(
      {
        family: "hns",
        limit,
        principal_id: "route-expiry-scheduler",
      },
      { store },
    ),
  );
}

suite("canonical community route Postgres repository", () => {
  test("resolves an active optional-route community by permanent id without a binding", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      const communityId = "community_123e4567-e89b-42d3-a456-426614174000";
      await admin.query("INSERT INTO users (user_id) VALUES ('route-actor')");
      await activatePendingPersonaFixtures(admin);
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, route_slug, canonical_route_binding_id,
           route_authority_version
         ) VALUES ($1, 'Namespaceless route', 'active', 'route-actor',
           clock_timestamp(), clock_timestamp(), NULL, NULL, 'optional_route_v2')`,
        [communityId],
      );
      const persona = await admin.query<{ persona_id: string }>(
        "SELECT persona_id FROM personas WHERE account_id = 'route-actor' AND is_first_persona",
      );
      const personaId = persona.rows[0]?.persona_id;
      if (personaId === undefined) throw new Error("missing route actor persona");
      await admin.query(
        `INSERT INTO community_memberships (
           community_id, membership_id, user_id, status, joined_at, created_at, updated_at
         ) VALUES ($1, 'route-membership', 'route-actor', 'member', now(), now(), now())`,
        [communityId],
      );
      await admin.query(
        `INSERT INTO persona_role_presentations (community_id, account_id, persona_id)
         VALUES ($1, 'route-actor', $2)`,
        [communityId, personaId],
      );
      const store = makeControlPlaneCanonicalCommunityRouteStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: communityId })),
        ),
      ).resolves.toEqual({
        authority_version: "optional_route_v2",
        community_id: communityId,
        href: `/c/${communityId}`,
        canonical_route: null,
        persona_role_presentation: {
          role: "owner",
          persona: {
            persona_id: personaId,
            object: "persona",
            display_name: null,
            avatar_ref: null,
            primary_public_handle: null,
          },
        },
      });
      await admin.query("UPDATE communities SET status = 'archived' WHERE community_id = $1", [
        communityId,
      ]);
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: communityId })),
        ),
      ).resolves.toBeNull();
      completedTestCount += 1;
    });
  }, 30_000);

  test("projects a suspended Spaces binding under the disjoint at-sign path", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      const communityId = "community_123e4567-e89b-42d3-a456-426614174050";
      await admin.query("INSERT INTO users (user_id) VALUES ('spaces-route-owner')");
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, route_slug, route_authority_version
         ) VALUES ($1, 'Spaces route', 'active', 'spaces-route-owner',
           clock_timestamp(), clock_timestamp(), NULL, 'optional_route_v2')`,
        [communityId],
      );
      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_canonical_route_bindings (
           route_binding_id, community_id, family, root_label, root_label_display,
           ownership_status, route_lifecycle_status, binding_generation,
           verified_evidence_ref
         ) VALUES ('spaces-route-binding', $1, 'spaces', 'xn--4v8h', '🔥',
           'pending', 'suspended', 1, NULL)`,
        [communityId],
      );
      await admin.query(
        `UPDATE communities
            SET canonical_route_binding_id = 'spaces-route-binding'
          WHERE community_id = $1`,
        [communityId],
      );
      await admin.query("COMMIT");

      await expect(
        admin.query(
          `SELECT path_segment, href, public_path_segment_v2, public_href_v2
             FROM community_canonical_route_bindings
            WHERE route_binding_id = 'spaces-route-binding'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            path_segment: "@xn--4v8h",
            href: "/c/@xn--4v8h",
            public_path_segment_v2: "@xn--4v8h",
            public_href_v2: "/c/@xn--4v8h",
          },
        ],
      });
      const store = makeControlPlaneCanonicalCommunityRouteStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "@xn--4v8h" })),
        ),
      ).resolves.toBeNull();
      completedTestCount += 1;
    });
  }, 30_000);

  test("resolves a live verified HNS IDN binding with no legacy fallback", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query(
        `INSERT INTO users (user_id, status, account) VALUES ('route-actor', 'active', '{}'::jsonb)`,
      );
      await seedRoute(admin, {
        suffix: "hns",
        family: "hns",
        rootLabel: "xn--mnchen-3ya",
        rootLabelDisplay: "münchen",
        pathSegment: "app.xn--mnchen-3ya",
        communityId: "community-route-hns",
        bindingId: "binding-route-hns",
      });
      await seedRoute(admin, {
        suffix: "hns-underscore",
        family: "hns",
        rootLabel: "community_music",
        rootLabelDisplay: "community_music",
        pathSegment: "app.community_music",
        communityId: "community-route-hns-underscore",
        bindingId: "binding-route-hns-underscore",
      });
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, route_slug
         ) VALUES ('legacy-only', 'Legacy', 'active', 'route-actor',
           clock_timestamp(), clock_timestamp(), 'legacy-route')`,
      );

      const store = makeControlPlaneCanonicalCommunityRouteStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "xn--mnchen-3ya" })),
        ),
      ).resolves.toMatchObject({
        community_id: "community-route-hns",
        canonical_route: {
          family: "hns",
          root_label: "xn--mnchen-3ya",
          root_label_display: "münchen",
          path_segment: "xn--mnchen-3ya",
          href: "/c/xn--mnchen-3ya",
          app_host: "app.xn--mnchen-3ya",
        },
      });
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "community_music" })),
        ),
      ).resolves.toMatchObject({
        community_id: "community-route-hns-underscore",
        canonical_route: {
          path_segment: "community_music",
          href: "/c/community_music",
          app_host: "app.community_music",
        },
      });
      const effective = await admin.query(
        `SELECT community_id, route_binding_id, path_segment, binding_generation
           FROM effective_active_route('community-route-hns', clock_timestamp())`,
      );
      expect(effective.rows).toEqual([
        {
          community_id: "community-route-hns",
          route_binding_id: "binding-route-hns",
          path_segment: "app.xn--mnchen-3ya",
          binding_generation: "1",
        },
      ]);
      await expect(expireHnsRoutes(connection)).resolves.toEqual({
        selected: 0,
        transitioned: 0,
        stale: 0,
      });
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "legacy-route" })),
        ),
      ).resolves.toBeNull();

      await admin.query(
        `UPDATE community_canonical_route_bindings
            SET ownership_status = 'expired', route_lifecycle_status = 'suspended',
                binding_generation = 2, updated_at = clock_timestamp()
          WHERE route_binding_id = 'binding-route-hns'`,
      );
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "xn--mnchen-3ya" })),
        ),
      ).resolves.toBeNull();
      const suspended = await admin.query(
        `SELECT community_id
           FROM effective_active_route('community-route-hns', clock_timestamp())`,
      );
      expect(suspended.rows).toEqual([]);
      completedTestCount += 1;
    });
  }, 30_000);

  test("fails expired evidence closed, then records one database-time lifecycle transition", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query(
        `INSERT INTO users (user_id, status, account) VALUES ('route-actor', 'active', '{}'::jsonb)`,
      );
      await seedRoute(admin, {
        suffix: "expiry",
        family: "hns",
        rootLabel: "expiry-route",
        rootLabelDisplay: "expiry-route",
        pathSegment: "app.expiry-route",
        communityId: "community-route-expiry",
        bindingId: "binding-route-expiry",
        evidenceExpiresAt: new Date(Date.now() + 5_000),
      });
      const store = makeControlPlaneCanonicalCommunityRouteStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "expiry-route" })),
        ),
      ).resolves.toMatchObject({ community_id: "community-route-expiry" });

      await new Promise((resolve) => setTimeout(resolve, 5_100));
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "expiry-route" })),
        ),
      ).resolves.toBeNull();
      const stored = await admin.query(
        `SELECT ownership_status, route_lifecycle_status, binding_generation
           FROM community_canonical_route_bindings
          WHERE route_binding_id = 'binding-route-expiry'`,
      );
      expect(stored.rows).toEqual([
        {
          ownership_status: "verified",
          route_lifecycle_status: "active",
          binding_generation: "1",
        },
      ]);

      const futureTransitionAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      await admin.query("BEGIN");
      try {
        await admin.query(
          `UPDATE community_canonical_route_bindings
              SET verified_evidence_ref = NULL,
                  ownership_status = 'expired',
                  route_lifecycle_status = 'suspended',
                  binding_generation = 2,
                  updated_at = $1
            WHERE route_binding_id = 'binding-route-expiry'`,
          [futureTransitionAt],
        );
        await expect(
          admin.query(
            `INSERT INTO community_route_lifecycle_transitions (
               route_lifecycle_transition_id, version, transition_kind,
               community_id, route_binding_id, principal_kind, principal_id,
               family, root_label, root_label_display, path_segment,
               expected_binding_generation, resulting_binding_generation,
               expected_verified_evidence_ref, observed_evidence_expires_at,
               ownership_status, route_lifecycle_status, transitioned_at
             )
             SELECT 'future-transition', 'pirate-community-route-lifecycle-transition-v1',
                    'database_time_expired', 'community-route-expiry',
                    'binding-route-expiry', 'system', 'route-expiry-scheduler',
                    'hns', 'expiry-route', 'expiry-route', 'app.expiry-route',
                    1, 2, evidence_ref, expires_at, 'expired', 'suspended', $1
               FROM community_route_ownership_evidence
              WHERE evidence_ref = 'evidence-expiry'`,
            [futureTransitionAt],
          ),
        ).rejects.toMatchObject({ code: "P0001" });
      } finally {
        await admin.query("ROLLBACK");
      }

      await expect(expireHnsRoutes(connection)).resolves.toEqual({
        selected: 1,
        transitioned: 1,
        stale: 0,
      });
      const transitioned = await admin.query(
        `SELECT version, transition_kind, community_id, route_binding_id,
                principal_kind, principal_id, family, root_label,
                expected_binding_generation, resulting_binding_generation,
                expected_verified_evidence_ref, ownership_status,
                route_lifecycle_status,
                observed_evidence_expires_at <= transitioned_at AS expired_at_transition
           FROM community_route_lifecycle_transitions`,
      );
      expect(transitioned.rows).toEqual([
        {
          version: "pirate-community-route-lifecycle-transition-v1",
          transition_kind: "database_time_expired",
          community_id: "community-route-expiry",
          route_binding_id: "binding-route-expiry",
          principal_kind: "system",
          principal_id: "route-expiry-scheduler",
          family: "hns",
          root_label: "expiry-route",
          expected_binding_generation: "1",
          resulting_binding_generation: "2",
          expected_verified_evidence_ref: "evidence-expiry",
          ownership_status: "expired",
          route_lifecycle_status: "suspended",
          expired_at_transition: true,
        },
      ]);
      const durableBinding = await admin.query(
        `SELECT ownership_status, route_lifecycle_status, binding_generation,
                verified_evidence_ref
           FROM community_canonical_route_bindings
          WHERE route_binding_id = 'binding-route-expiry'`,
      );
      expect(durableBinding.rows).toEqual([
        {
          ownership_status: "expired",
          route_lifecycle_status: "suspended",
          binding_generation: "2",
          verified_evidence_ref: null,
        },
      ]);
      await expect(expireHnsRoutes(connection)).resolves.toEqual({
        selected: 0,
        transitioned: 0,
        stale: 0,
      });
      const providerArtifacts = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM community_route_revalidation_completion_attempts)
             AS attempts,
           (SELECT count(*)::integer FROM community_route_revalidation_evidence_snapshots)
             AS snapshots`,
      );
      expect(providerArtifacts.rows).toEqual([{ attempts: 0, snapshots: 0 }]);
      await expect(
        admin.query(
          `UPDATE community_route_lifecycle_transitions
              SET principal_id = 'changed'`,
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      await expect(
        admin.query("DELETE FROM community_route_lifecycle_transitions"),
      ).rejects.toMatchObject({ code: "P0001" });
      completedTestCount += 1;
    });
  }, 30_000);

  test("fails incomplete route evidence with no expiry closed", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query(
        `INSERT INTO users (user_id, status, account) VALUES ('route-actor', 'active', '{}'::jsonb)`,
      );
      await seedRoute(admin, {
        suffix: "null-expiry",
        family: "hns",
        rootLabel: "null-expiry-route",
        rootLabelDisplay: "null-expiry-route",
        pathSegment: "app.null-expiry-route",
        communityId: "community-route-null-expiry",
        bindingId: "binding-route-null-expiry",
        evidenceExpiresAt: null,
      });
      const store = makeControlPlaneCanonicalCommunityRouteStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "null-expiry-route" })),
        ),
      ).resolves.toBeNull();
      await expect(expireHnsRoutes(connection)).resolves.toEqual({
        selected: 0,
        transitioned: 0,
        stale: 0,
      });
      completedTestCount += 1;
    });
  }, 30_000);

  test("orders a bounded expiry batch by evidence expiry before binding id", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query(
        `INSERT INTO users (user_id, status, account) VALUES ('route-actor', 'active', '{}'::jsonb)`,
      );
      const expiryBase = Date.now();
      await seedRoute(admin, {
        suffix: "later-expiry",
        family: "hns",
        rootLabel: "later-expiry",
        rootLabelDisplay: "later-expiry",
        pathSegment: "app.later-expiry",
        communityId: "community-later-expiry",
        bindingId: "binding-a-later-expiry",
        evidenceExpiresAt: new Date(expiryBase + 3_500),
      });
      await seedRoute(admin, {
        suffix: "earlier-expiry",
        family: "hns",
        rootLabel: "earlier-expiry",
        rootLabelDisplay: "earlier-expiry",
        pathSegment: "app.earlier-expiry",
        communityId: "community-earlier-expiry",
        bindingId: "binding-z-earlier-expiry",
        evidenceExpiresAt: new Date(expiryBase + 2_500),
      });
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expiryBase + 3_600 - Date.now())),
      );

      await expect(expireHnsRoutes(connection, 1)).resolves.toEqual({
        selected: 1,
        transitioned: 1,
        stale: 0,
      });
      const bindings = await admin.query(
        `SELECT route_binding_id, binding_generation, route_lifecycle_status
           FROM community_canonical_route_bindings
          ORDER BY route_binding_id`,
      );
      expect(bindings.rows).toEqual([
        {
          route_binding_id: "binding-a-later-expiry",
          binding_generation: "1",
          route_lifecycle_status: "active",
        },
        {
          route_binding_id: "binding-z-earlier-expiry",
          binding_generation: "2",
          route_lifecycle_status: "suspended",
        },
      ]);
      completedTestCount += 1;
    });
  }, 30_000);

  test("fences concurrent expiry writers to one generation advance and audit row", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query(
        `INSERT INTO users (user_id, status, account) VALUES ('route-actor', 'active', '{}'::jsonb)`,
      );
      const expiresAt = Date.now() + 2_000;
      await seedRoute(admin, {
        suffix: "concurrent-expiry",
        family: "hns",
        rootLabel: "concurrent-expiry",
        rootLabelDisplay: "concurrent-expiry",
        pathSegment: "app.concurrent-expiry",
        communityId: "community-concurrent-expiry",
        bindingId: "binding-concurrent-expiry",
        evidenceExpiresAt: new Date(expiresAt),
      });
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expiresAt + 100 - Date.now())),
      );

      const summaries = await Promise.all([
        expireHnsRoutes(connection, 1),
        expireHnsRoutes(connection, 1),
      ]);
      expect(summaries.reduce((total, summary) => total + summary.transitioned, 0)).toBe(1);
      const durable = await admin.query(
        `SELECT binding_generation, ownership_status, route_lifecycle_status,
                verified_evidence_ref,
                (SELECT count(*)::integer
                   FROM community_route_lifecycle_transitions) AS transition_count
           FROM community_canonical_route_bindings
          WHERE route_binding_id = 'binding-concurrent-expiry'`,
      );
      expect(durable.rows).toEqual([
        {
          binding_generation: "2",
          ownership_status: "expired",
          route_lifecycle_status: "suspended",
          verified_evidence_ref: null,
          transition_count: 1,
        },
      ]);
      completedTestCount += 1;
    });
  }, 30_000);

  test("activates, resolves, replays, and revokes one operator-managed first-party root", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      const communityId = "community_123e4567-e89b-42d3-a456-426614174001";
      const registryBytes = new TextEncoder().encode(
        '["pirate-operator-managed-root-registry-v1","operator-managed-roots-2026-08",1,[["hns","jazleeuw","active"]]]',
      );
      const registryDigest =
        "6e94ee9dfb2681ad1a21f0ac21bad302fbd139f8364721879a553b7ad6e44c9e" as Sha256Hex;
      await admin.query("INSERT INTO users (user_id) VALUES ('operator-route-owner')");
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, route_slug, route_authority_version
         ) VALUES ($1, 'Operator route', 'active', 'operator-route-owner',
           clock_timestamp(), clock_timestamp(), NULL, 'optional_route_v2')`,
        [communityId],
      );
      await admin.query(
        `INSERT INTO platform_operator_route_authority_grants (
           grant_id, operator_principal_id, authority, status,
           granted_at, granted_by_operator_principal_id
         ) VALUES (
           'operator-route-grant-1', 'platform-operator-1',
           'manage_operator_routes', 'active', clock_timestamp(), 'bootstrap-operator'
         )`,
      );
      await admin.query(
        `INSERT INTO operator_managed_root_registry_versions (
           registry_reference, registry_version, registry_digest, registry_bytes,
           published_at, published_by_operator_principal_id
         ) VALUES ($1, 1, $2, $3, clock_timestamp(), 'platform-operator-1')`,
        ["operator-managed-roots-2026-08", registryDigest, registryBytes],
      );
      await admin.query(
        `INSERT INTO operator_managed_root_registry_current (
           registry_kind, registry_reference, registry_version, registry_digest,
           activated_at, activated_by_operator_principal_id
         ) VALUES (
           'pirate-operator-managed-root-registry-v1', $1, 1, $2,
           clock_timestamp(), 'platform-operator-1'
         )`,
        ["operator-managed-roots-2026-08", registryDigest],
      );

      const operatorStore = makeControlPlaneOperatorManagedRouteStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      for (const [routeBindingId, rootLabel] of [
        ["reserved-platform-binding", "pirate"],
        ["reserved-opaque-binding", "community_123e4567-e89b-42d3-a456-426614174000"],
      ] as const) {
        await expect(
          admin.query(
            `INSERT INTO community_canonical_route_bindings (
               route_binding_id, community_id, family, root_label, root_label_display,
               ownership_status, route_lifecycle_status, binding_generation,
               verified_evidence_ref
             ) VALUES ($1, $2, 'hns', $3, $3, 'pending', 'suspended', 1, NULL)`,
            [routeBindingId, communityId, rootLabel],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }
      const activationInput = {
        operation_id: "operator-route-operation-1",
        operator_principal_id: "platform-operator-1",
        operator_authority_grant_id: "operator-route-grant-1",
        idempotency_key: "operator-route-activation-key-1",
        community_id: communityId,
        canonical_root: "jazleeuw",
        registry_reference: "operator-managed-roots-2026-08",
        registry_version: 1,
        registry_digest: registryDigest,
        operator_route_activation_id: "operator-route-activation-1",
        route_binding_id: "operator-route-binding-1",
        reason_code: "first-party-root",
      } as const;
      await expect(
        Effect.runPromise(
          activateOperatorManagedRoute(
            {
              ...activationInput,
              operation_id: "operator-route-operation-reserved",
              idempotency_key: "operator-route-activation-key-reserved",
              canonical_root: "pirate",
            },
            { store: operatorStore },
          ),
        ),
      ).rejects.toBeDefined();
      await expect(
        Effect.runPromise(activateOperatorManagedRoute(activationInput, { store: operatorStore })),
      ).resolves.toEqual({
        outcome: "activated",
        operator_route_activation_id: "operator-route-activation-1",
        route_binding_id: "operator-route-binding-1",
        activation_generation: 1,
      });
      await expect(
        Effect.runPromise(activateOperatorManagedRoute(activationInput, { store: operatorStore })),
      ).resolves.toMatchObject({ outcome: "replayed", activation_generation: 1 });
      await expect(
        Effect.runPromise(
          activateOperatorManagedRoute(
            { ...activationInput, reason_code: "changed-replay" },
            { store: operatorStore },
          ),
        ),
      ).rejects.toBeDefined();

      const routeStore = makeControlPlaneCanonicalCommunityRouteStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      await expect(
        Effect.runPromise(
          Effect.scoped(routeStore.resolveCanonicalRoute({ path_segment: "jazleeuw" })),
        ),
      ).resolves.toMatchObject({
        community_id: communityId,
        canonical_route: { path_segment: "jazleeuw", app_host: null },
      });
      await admin.query(
        `INSERT INTO community_route_app_host_health (
           route_binding_id, family, health_status, health_generation, observed_at
         ) VALUES ('operator-route-binding-1', 'hns', 'healthy', 1, clock_timestamp())`,
      );
      await expect(
        Effect.runPromise(
          Effect.scoped(routeStore.resolveCanonicalRoute({ path_segment: "jazleeuw" })),
        ),
      ).resolves.toMatchObject({
        canonical_route: { app_host: "app.jazleeuw" },
      });

      const authority = await admin.query(
        `SELECT binding.route_authority_kind,
                binding.ownership_status,
                binding.verified_evidence_ref,
                (SELECT count(*)::integer
                   FROM effective_active_route($1, clock_timestamp())) AS sale_authority_count,
                (SELECT count(*)::integer
                   FROM effective_route_authority_v2($1, clock_timestamp())) AS route_authority_count
           FROM community_canonical_route_bindings AS binding
          WHERE binding.route_binding_id = 'operator-route-binding-1'`,
        [communityId],
      );
      expect(authority.rows).toEqual([
        {
          route_authority_kind: "operator_managed_route_v1",
          ownership_status: "pending",
          verified_evidence_ref: null,
          sale_authority_count: 0,
          route_authority_count: 1,
        },
      ]);

      const revocationInput = {
        operation_id: "operator-route-revocation-1",
        operator_principal_id: "platform-operator-1",
        operator_authority_grant_id: "operator-route-grant-1",
        idempotency_key: "operator-route-revocation-key-1",
        community_id: communityId,
        canonical_root: "jazleeuw",
        operator_route_activation_id: "operator-route-activation-1",
        route_binding_id: "operator-route-binding-1",
        expected_activation_generation: 1,
        reason_code: "first-party-root-retired",
      } as const;
      await expect(
        Effect.runPromise(revokeOperatorManagedRoute(revocationInput, { store: operatorStore })),
      ).resolves.toMatchObject({ outcome: "revoked", activation_generation: 2 });
      await expect(
        Effect.runPromise(revokeOperatorManagedRoute(revocationInput, { store: operatorStore })),
      ).resolves.toMatchObject({ outcome: "replayed", activation_generation: 2 });
      await expect(
        Effect.runPromise(
          revokeOperatorManagedRoute(
            {
              ...revocationInput,
              operation_id: "operator-route-revocation-stale",
              idempotency_key: "operator-route-revocation-key-stale",
            },
            { store: operatorStore },
          ),
        ),
      ).rejects.toBeDefined();
      await expect(
        Effect.runPromise(
          Effect.scoped(routeStore.resolveCanonicalRoute({ path_segment: "jazleeuw" })),
        ),
      ).resolves.toBeNull();

      const retained = await admin.query(
        `SELECT activation.status,
                activation.operator_route_activation_generation,
                binding.route_lifecycle_status,
                binding.binding_generation,
                binding.authority_generation,
                (SELECT count(*)::integer
                   FROM community_route_operator_override_audit) AS audit_count,
                (SELECT count(*)::integer
                   FROM community_route_ownership_evidence) AS evidence_count
           FROM operator_managed_route_activations AS activation
           JOIN community_canonical_route_bindings AS binding
             ON binding.route_binding_id = activation.route_binding_id
          WHERE activation.operator_route_activation_id = 'operator-route-activation-1'`,
      );
      expect(retained.rows).toEqual([
        {
          status: "revoked",
          operator_route_activation_generation: "2",
          route_lifecycle_status: "suspended",
          binding_generation: "2",
          authority_generation: "2",
          audit_count: 2,
          evidence_count: 0,
        },
      ]);
      completedTestCount += 1;
    });
  }, 30_000);

  test("rechecks operator privilege and prevents current registry removal of an active root", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      const registryReference = "operator-managed-roots-2026-08";
      const activeBytes = new TextEncoder().encode(
        '["pirate-operator-managed-root-registry-v1","operator-managed-roots-2026-08",1,[["hns","jazleeuw","active"]]]',
      );
      const activeDigest = "6e94ee9dfb2681ad1a21f0ac21bad302fbd139f8364721879a553b7ad6e44c9e";
      const noncanonicalBytes = new TextEncoder().encode(
        '["pirate-operator-managed-root-registry-v1", "operator-managed-roots-2026-08", 3, [["hns", "jazleeuw", "active"]]]',
      );
      const noncanonicalDigestBuffer = await crypto.subtle.digest("SHA-256", noncanonicalBytes);
      const noncanonicalDigest = [...new Uint8Array(noncanonicalDigestBuffer)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const emptyBytes = new TextEncoder().encode(
        '["pirate-operator-managed-root-registry-v1","operator-managed-roots-2026-08",2,[]]',
      );
      const emptyDigestBuffer = await crypto.subtle.digest("SHA-256", emptyBytes);
      const emptyDigest = [...new Uint8Array(emptyDigestBuffer)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const communityId = "community_123e4567-e89b-42d3-a456-426614174002";
      await admin.query("INSERT INTO users (user_id) VALUES ('operator-route-owner-2')");
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, route_slug, route_authority_version
         ) VALUES ($1, 'Operator route 2', 'active', 'operator-route-owner-2',
           clock_timestamp(), clock_timestamp(), NULL, 'optional_route_v2')`,
        [communityId],
      );
      await admin.query(
        `INSERT INTO platform_operator_route_authority_grants (
           grant_id, operator_principal_id, authority, status,
           granted_at, granted_by_operator_principal_id
         ) VALUES ('operator-route-grant-2', 'platform-operator-2',
           'manage_operator_routes', 'active', clock_timestamp(), 'bootstrap-operator')`,
      );
      await expect(
        admin.query(
          `INSERT INTO operator_managed_root_registry_versions (
             registry_reference, registry_version, registry_digest, registry_bytes,
             published_at, published_by_operator_principal_id
           ) VALUES ($1, 3, $2, $3, clock_timestamp(), 'platform-operator-2')`,
          [registryReference, noncanonicalDigest, noncanonicalBytes],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await admin.query(
        `INSERT INTO operator_managed_root_registry_versions (
           registry_reference, registry_version, registry_digest, registry_bytes,
           published_at, published_by_operator_principal_id
         ) VALUES ($1, 1, $2, $3, clock_timestamp(), 'platform-operator-2'),
                  ($1, 2, $4, $5, clock_timestamp(), 'platform-operator-2')`,
        [registryReference, activeDigest, activeBytes, emptyDigest, emptyBytes],
      );
      await admin.query(
        `INSERT INTO operator_managed_root_registry_current (
           registry_kind, registry_reference, registry_version, registry_digest,
           activated_at, activated_by_operator_principal_id
         ) VALUES ('pirate-operator-managed-root-registry-v1', $1, 1, $2,
           clock_timestamp(), 'platform-operator-2')`,
        [registryReference, activeDigest],
      );
      const operatorStore = makeControlPlaneOperatorManagedRouteStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const input = {
        operation_id: "operator-route-operation-2",
        operator_principal_id: "platform-operator-2",
        operator_authority_grant_id: "operator-route-grant-2",
        idempotency_key: "operator-route-activation-key-2",
        community_id: communityId,
        canonical_root: "jazleeuw",
        registry_reference: registryReference,
        registry_version: 1,
        registry_digest: activeDigest as Sha256Hex,
        operator_route_activation_id: "operator-route-activation-2",
        route_binding_id: "operator-route-binding-2",
        reason_code: "first-party-root",
      } as const;
      await expect(
        Effect.runPromise(
          activateOperatorManagedRoute(
            {
              ...input,
              operation_id: "operator-route-operation-registry-mismatch",
              idempotency_key: "operator-route-activation-key-registry-mismatch",
              registry_digest: "0".repeat(64) as Sha256Hex,
            },
            { store: operatorStore },
          ),
        ),
      ).rejects.toBeDefined();
      await expect(
        Effect.runPromise(activateOperatorManagedRoute(input, { store: operatorStore })),
      ).resolves.toMatchObject({ outcome: "activated" });
      await expect(
        admin.query(
          `UPDATE operator_managed_root_registry_current
              SET registry_version = 2, registry_digest = $1,
                  activated_at = clock_timestamp()
            WHERE registry_kind = 'pirate-operator-managed-root-registry-v1'`,
          [emptyDigest],
        ),
      ).rejects.toMatchObject({ code: "P0001" });

      await admin.query(
        `UPDATE platform_operator_route_authority_grants
            SET status = 'revoked', revoked_at = clock_timestamp(),
                revoked_by_operator_principal_id = 'bootstrap-operator'
          WHERE grant_id = 'operator-route-grant-2'`,
      );
      await expect(
        Effect.runPromise(
          revokeOperatorManagedRoute(
            {
              operation_id: "operator-route-revocation-2",
              operator_principal_id: "platform-operator-2",
              operator_authority_grant_id: "operator-route-grant-2",
              idempotency_key: "operator-route-revocation-key-2",
              community_id: communityId,
              canonical_root: "jazleeuw",
              operator_route_activation_id: "operator-route-activation-2",
              route_binding_id: "operator-route-binding-2",
              expected_activation_generation: 1,
              reason_code: "privilege-recheck",
            },
            { store: operatorStore },
          ),
        ),
      ).rejects.toBeDefined();
      const stillActive = await admin.query(
        `SELECT status, operator_route_activation_generation
           FROM operator_managed_route_activations
          WHERE operator_route_activation_id = 'operator-route-activation-2'`,
      );
      expect(stillActive.rows).toEqual([
        { status: "active", operator_route_activation_generation: "1" },
      ]);
      completedTestCount += 1;
    });
  }, 30_000);

  test("serializes two communities racing for one operator-managed root", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      const registryReference = "operator-managed-roots-race";
      const registryBytes = new TextEncoder().encode(
        '["pirate-operator-managed-root-registry-v1","operator-managed-roots-race",1,[["hns","race","active"]]]',
      );
      const registryDigestBuffer = await crypto.subtle.digest("SHA-256", registryBytes);
      const registryDigest = [...new Uint8Array(registryDigestBuffer)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("") as Sha256Hex;
      const firstCommunity = "community_123e4567-e89b-42d3-a456-426614174003";
      const secondCommunity = "community_123e4567-e89b-42d3-a456-426614174004";
      await admin.query("INSERT INTO users (user_id) VALUES ('operator-route-race-owner')");
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, route_slug, route_authority_version
         ) VALUES
           ($1, 'Operator route race 1', 'active', 'operator-route-race-owner',
            clock_timestamp(), clock_timestamp(), NULL, 'optional_route_v2'),
           ($2, 'Operator route race 2', 'active', 'operator-route-race-owner',
            clock_timestamp(), clock_timestamp(), NULL, 'optional_route_v2')`,
        [firstCommunity, secondCommunity],
      );
      await admin.query(
        `INSERT INTO platform_operator_route_authority_grants (
           grant_id, operator_principal_id, authority, status,
           granted_at, granted_by_operator_principal_id
         ) VALUES ('operator-route-race-grant', 'platform-operator-race',
           'manage_operator_routes', 'active', clock_timestamp(), 'bootstrap-operator')`,
      );
      await admin.query(
        `INSERT INTO operator_managed_root_registry_versions (
           registry_reference, registry_version, registry_digest, registry_bytes,
           published_at, published_by_operator_principal_id
         ) VALUES ($1, 1, $2, $3, clock_timestamp(), 'platform-operator-race')`,
        [registryReference, registryDigest, registryBytes],
      );
      await admin.query(
        `INSERT INTO operator_managed_root_registry_current (
           registry_kind, registry_reference, registry_version, registry_digest,
           activated_at, activated_by_operator_principal_id
         ) VALUES ('pirate-operator-managed-root-registry-v1', $1, 1, $2,
           clock_timestamp(), 'platform-operator-race')`,
        [registryReference, registryDigest],
      );

      const operatorStore = makeControlPlaneOperatorManagedRouteStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const common = {
        operator_principal_id: "platform-operator-race",
        operator_authority_grant_id: "operator-route-race-grant",
        canonical_root: "race",
        registry_reference: registryReference,
        registry_version: 1,
        registry_digest: registryDigest,
        reason_code: "root-race",
      } as const;
      const outcomes = await Promise.allSettled([
        Effect.runPromise(
          activateOperatorManagedRoute(
            {
              ...common,
              operation_id: "operator-route-race-operation-1",
              idempotency_key: "operator-route-race-key-1",
              community_id: firstCommunity,
              operator_route_activation_id: "operator-route-race-activation-1",
              route_binding_id: "operator-route-race-binding-1",
            },
            { store: operatorStore },
          ),
        ),
        Effect.runPromise(
          activateOperatorManagedRoute(
            {
              ...common,
              operation_id: "operator-route-race-operation-2",
              idempotency_key: "operator-route-race-key-2",
              community_id: secondCommunity,
              operator_route_activation_id: "operator-route-race-activation-2",
              route_binding_id: "operator-route-race-binding-2",
            },
            { store: operatorStore },
          ),
        ),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

      const durable = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM community_canonical_route_bindings
             WHERE family = 'hns' AND root_label = 'race') AS binding_count,
           (SELECT count(*)::integer FROM operator_managed_route_activations
             WHERE family = 'hns' AND canonical_root = 'race') AS activation_count,
           (SELECT count(*)::integer FROM operator_managed_route_operations
             WHERE family = 'hns' AND canonical_root = 'race') AS operation_count,
           (SELECT count(*)::integer FROM community_route_operator_override_audit
             WHERE community_id IN ($1, $2)
               AND action_kind = 'operator_route_activated') AS audit_count`,
        [firstCommunity, secondCommunity],
      );
      expect(durable.rows).toEqual([
        { binding_count: 1, activation_count: 1, operation_count: 1, audit_count: 1 },
      ]);
      completedTestCount += 1;
    });
  }, 30_000);
});

afterAll(async () => {
  if (connectionString === undefined || completedTestCount !== 10) return;
  await Bun.write(sentinelPath, sentinelContents);
});
