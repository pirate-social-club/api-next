import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneCanonicalCommunityRouteStore } from "./community-route-repository.ts";
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

function schemaIdentifier(): string {
  return `api_next_canonical_route_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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

suite("canonical community route Postgres repository", () => {
  test("resolves a live verified HNS IDN binding with no legacy fallback", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
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
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "app.xn--mnchen-3ya" })),
        ),
      ).resolves.toMatchObject({
        community_id: "community-route-hns",
        canonical_route: {
          family: "hns",
          root_label: "xn--mnchen-3ya",
          root_label_display: "münchen",
          path_segment: "app.xn--mnchen-3ya",
          href: "/c/app.xn--mnchen-3ya",
          app_host: "app.xn--mnchen-3ya",
        },
      });
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "app.legacy-route" })),
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
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "app.xn--mnchen-3ya" })),
        ),
      ).resolves.toBeNull();
      completedTestCount += 1;
    });
  }, 30_000);

  test("fails an expired route closed before a lifecycle writer suspends it", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
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
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "app.expiry-route" })),
        ),
      ).resolves.toMatchObject({ community_id: "community-route-expiry" });

      await new Promise((resolve) => setTimeout(resolve, 5_100));
      await expect(
        Effect.runPromise(
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "app.expiry-route" })),
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
      completedTestCount += 1;
    });
  }, 30_000);

  test("fails incomplete route evidence with no expiry closed", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
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
          Effect.scoped(store.resolveCanonicalRoute({ path_segment: "app.null-expiry-route" })),
        ),
      ).resolves.toBeNull();
      completedTestCount += 1;
    });
  }, 30_000);
});

afterAll(async () => {
  if (connectionString === undefined || completedTestCount !== 3) return;
  await Bun.write(sentinelPath, sentinelContents);
});
