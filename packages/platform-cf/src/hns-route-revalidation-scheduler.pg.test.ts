import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

const { HNS_ROUTE_REVALIDATION_PENDING_SESSIONS_SQL, HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL } =
  await import("../../../apps/jobs-worker/src/hns-route-revalidation");

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const CONFIG_REFERENCE = "hns-owner-staging";
const CONFIG_VERSION = "hns-owner-config-v1";
const PRINCIPAL_ID = "route-revalidation-scheduler";
const ENVIRONMENT = "staging";
type ProviderAuthority = Readonly<{
  configurationReference: string;
  configurationVersion: string;
  environment: string;
}>;
const DEFAULT_AUTHORITY: ProviderAuthority = {
  configurationReference: CONFIG_REFERENCE,
  configurationVersion: CONFIG_VERSION,
  environment: ENVIRONMENT,
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedConnection(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (client: Client, connection: string) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("Postgres test configuration is unavailable");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_hns_route_revalidation_scheduler_pg_test_ts",
    use: async ({ admin, schema }) => {
      const connection = scopedConnection(connectionString, schema);
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      return await use(admin, connection);
    },
  });
}

type RouteSeed = Readonly<{
  readonly authority: ProviderAuthority;
  readonly suffix: string;
  readonly bindingId: string;
  readonly root: string;
  readonly communityId: string;
  readonly evidenceRef: string;
  readonly routeRevalidationId: string;
  readonly sessionId: string;
}>;

type PendingSeed = Readonly<{
  readonly routeRevalidationId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly evidenceRef: string | null;
}>;

function pendingIds(route: RouteSeed, generation: number): PendingSeed {
  return {
    routeRevalidationId: `hns-route-revalidation:${route.bindingId}:${generation}`,
    sessionId: `hns-route-revalidation-session:${route.bindingId}:${generation}`,
    generation,
    evidenceRef: generation === 1 ? route.evidenceRef : null,
  };
}

async function finalizeOwnershipEvidence(
  client: Client,
  value: Readonly<{
    readonly actorId: string;
    readonly authority: ProviderAuthority;
    readonly ceremonyId: string;
    readonly evidenceRef: string;
    readonly expiresAt: string;
    readonly intentId: string;
    readonly path: string;
    readonly root: string;
    readonly suffix: string;
    readonly verifiedAt: string;
  }>,
): Promise<void> {
  const reservationId = `namespace_start_${value.suffix}`;
  const namespaceSessionId = `namespace_session_${value.suffix}`;
  const completionAttemptId = `completion_${value.suffix}`;
  const upstreamSessionRef = `upstream_${value.suffix}`;
  const routeHref = `/c/${value.path}`;
  const challengeName = `_pirate.${value.root}`;

  await client.query("BEGIN");
  await client.query(
    `INSERT INTO namespace_ownership_start_reservations (
       reservation_id, namespace_session_id, actor_id, creation_intent_id,
       ceremony_intent_id, generation, requirement_hash, expected_revision,
       client_idempotency_key, request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
       protocol_version, environment, route_family, route_root_label, route_root_label_display,
       route_path_segment, route_href, route_app_host, state, fence_token, lease_expires_at
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, 1, $7, $8, 'hns.owner.v1', $9,
       'managed', $10, $11, 'hns-txt-v1', $12, 'hns', $13, $13, $14, $15, NULL,
       'acquired', 1, clock_timestamp() + interval '30 minutes')`,
    [
      reservationId,
      namespaceSessionId,
      value.actorId,
      value.intentId,
      value.ceremonyId,
      SHA,
      `start-key-${value.suffix}`,
      SHA_B,
      SHA_C,
      value.authority.configurationReference,
      value.authority.configurationVersion,
      value.authority.environment,
      value.root,
      value.path,
      routeHref,
    ],
  );
  await client.query(
    `INSERT INTO namespace_ownership_sessions (
       namespace_session_id, actor_id, creation_intent_id, ceremony_intent_id,
       start_reservation_id, start_fence_token, expected_revision, generation,
       requirement_hash, request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
       protocol_version, environment, route_family, route_root_label, route_root_label_display,
       route_path_segment, route_href, route_app_host, upstream_session_ref,
       presentation_kind, presentation_payload, status, started_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, 1, 1, 1, $6, $7, 'hns.owner.v1', $8,
       'managed', $9, $10, 'hns-txt-v1', $11, 'hns', $12, $12, $13, $14, NULL,
       $15, 'poll', $16::jsonb, 'pending', clock_timestamp() - interval '1 minute',
       clock_timestamp() + interval '1 hour')`,
    [
      namespaceSessionId,
      value.actorId,
      value.intentId,
      value.ceremonyId,
      reservationId,
      SHA,
      SHA_B,
      SHA_C,
      value.authority.configurationReference,
      value.authority.configurationVersion,
      value.authority.environment,
      value.root,
      value.path,
      routeHref,
      upstreamSessionRef,
      JSON.stringify({ session_id: upstreamSessionRef }),
    ],
  );
  await client.query(
    `UPDATE namespace_ownership_start_reservations
        SET state = 'finalized', updated_at = clock_timestamp()
      WHERE reservation_id = $1`,
    [reservationId],
  );
  await client.query("COMMIT");

  await client.query(
    `INSERT INTO namespace_ownership_completion_attempts (
       completion_attempt_id, namespace_session_id, actor_id, idempotency_key, evidence_ref,
       completion_request_hash, submission_channel, state, fence_token, lease_expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'poll_result', 'leased', 1,
       clock_timestamp() + interval '30 minutes')`,
    [
      completionAttemptId,
      namespaceSessionId,
      value.actorId,
      `callback-${value.suffix}`,
      value.evidenceRef,
      SHA_B,
    ],
  );

  await client.query("BEGIN");
  await client.query(
    `UPDATE namespace_ownership_completion_attempts
        SET state = 'consumed', consumption_kind = 'verified', updated_at = clock_timestamp()
      WHERE completion_attempt_id = $1`,
    [completionAttemptId],
  );
  await client.query(
    `INSERT INTO namespace_ownership_evidence_snapshots (
       evidence_ref, completion_attempt_id, namespace_session_id, actor_id, creation_intent_id,
       ceremony_intent_id, generation, requirement_hash, request_hash, provider_id,
       provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, protocol_version, environment, family, root_label,
       root_label_display, path_segment, href, app_host, upstream_session_ref, fence_token,
       abi_version, ownership_source, challenge_name, challenge_value_sha256, root_exists,
       root_control_verified, expiry_horizon_sufficient, chain_network, chain_anchor_height,
       chain_anchor_block_hash, chain_anchor_median_time, expiry_height, observed_at, expires_at,
       provider_evidence_ref,
       observation_sha256, provider_identity_digest, evidence_digest, observation, raw_response_bytes
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, 'hns.owner.v1', $9,
       'managed', $10, $11, 'hns-txt-v1', $12, 'hns', $13, $13, $14, $15, NULL, $16, 1,
       'pirate-hns-ownership-evidence-v1', $17, $18, $19, TRUE, TRUE, TRUE, 'hns-testnet',
       10, $20, 100, 20, $21, $22, $23, $24, $25, $26, $27::jsonb, $28)`,
    [
      value.evidenceRef,
      completionAttemptId,
      namespaceSessionId,
      value.actorId,
      value.intentId,
      value.ceremonyId,
      SHA,
      SHA_B,
      SHA_C,
      value.authority.configurationReference,
      value.authority.configurationVersion,
      value.authority.environment,
      value.root,
      value.path,
      routeHref,
      upstreamSessionRef,
      "owner_authoritative_dns_txt",
      challengeName,
      SHA,
      SHA_C,
      value.verifiedAt,
      value.expiresAt,
      `provider-observation-${value.suffix}`,
      SHA,
      SHA_C,
      SHA_B,
      JSON.stringify({ status: "verified" }),
      Buffer.from('{"status":"verified"}', "utf8"),
    ],
  );
  const terminalResult = await client.query<{ value: string }>(
    "SELECT (clock_timestamp() - interval '10 seconds')::text AS value",
  );
  const terminalAt = terminalResult.rows[0]?.value ?? value.verifiedAt;
  await client.query(
    `INSERT INTO community_creation_ceremony_results (
       ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
       requirement_hash, provider_id, provider_binding_hash, provider_configuration_version,
       callback_idempotency_key, callback_request_hash, outcome_status, result_hash,
       evidence_ref, evidence_digest, provider_identity_digest, terminal_at, satisfied_at,
       namespace_session_id, completion_attempt_id, submission_channel
     ) VALUES ($1, $2, $3, 'namespace_ownership', 1, $4, 'hns.owner.v1', $5, $6,
       $7, $8, 'satisfied', $9, $10, $11, $12, $13, $13, $14, $15, 'poll_result')`,
    [
      value.ceremonyId,
      value.actorId,
      value.intentId,
      SHA,
      SHA_C,
      value.authority.configurationVersion,
      `callback-${value.suffix}`,
      SHA_B,
      SHA_B,
      value.evidenceRef,
      SHA_B,
      SHA_C,
      terminalAt,
      namespaceSessionId,
      completionAttemptId,
    ],
  );
  await client.query(
    `UPDATE community_creation_requirement_states
        SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
      WHERE intent_id = $2 AND requirement_kind = 'namespace_ownership'`,
    [terminalAt, value.intentId],
  );
  await client.query(
    `INSERT INTO community_route_ownership_evidence (
       evidence_ref, creation_ceremony_intent_id, verified_by_actor_id,
       family, root_label, root_label_display, path_segment,
       requirement_hash, provider_id, provider_binding_hash,
       provider_configuration_version, provider_identity_digest,
       evidence_digest, binding_generation, verified_at, expires_at
     ) VALUES ($1, $2, $3, 'hns', $4, $4, $5, $6, 'hns.owner.v1', $7,
       $8, $9, $10, 1, $11,
       (SELECT expires_at FROM namespace_ownership_evidence_snapshots WHERE evidence_ref = $1))`,
    [
      value.evidenceRef,
      value.ceremonyId,
      value.actorId,
      value.root,
      value.path,
      SHA,
      SHA_C,
      value.authority.configurationVersion,
      SHA_C,
      SHA_B,
      terminalAt,
    ],
  );
  await client.query(
    `UPDATE namespace_ownership_sessions
        SET status = 'completed', terminal_at = $1, completed_at = $1,
            updated_at = clock_timestamp()
      WHERE namespace_session_id = $2`,
    [terminalAt, namespaceSessionId],
  );
  await client.query("COMMIT");
}

async function seedRoute(
  client: Client,
  suffix: string,
  bindingId: string,
  root: string,
  authority: ProviderAuthority = DEFAULT_AUTHORITY,
): Promise<RouteSeed> {
  const actorId = `actor_${suffix}`;
  const intentId = `intent_${suffix}`;
  const ceremonyId = `ceremony_${suffix}`;
  const communityId = `community_${suffix}`;
  const evidenceRef = `route_evidence_${suffix}`;
  const path = `app.${root}`;
  const verifiedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

  await client.query("INSERT INTO users (user_id) VALUES ($1)", [actorId]);
  await client.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id,
       created_at, updated_at, canonical_route_binding_id
     ) VALUES ($1, $2, 'active', $3, clock_timestamp(), clock_timestamp(), NULL)`,
    [communityId, `Community ${suffix}`, actorId],
  );
  await client.query(
    `INSERT INTO community_creation_intents (
       intent_id, actor_id, create_idempotency_key, create_request_hash, revision,
       status, draft, canonical_policy_revision, canonical_policy_hash,
       verification_requirement_hash, verification_provider_id,
       provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, expires_at
     ) VALUES ($1, $2, $3, $4, 1, 'verification_required', '{}'::jsonb, 1, $4,
       $5, 'hns.owner.v1', 'managed', $6, $7,
       clock_timestamp() + interval '1 day')`,
    [
      intentId,
      actorId,
      `create_${suffix}`,
      SHA,
      SHA_B,
      authority.configurationReference,
      authority.configurationVersion,
    ],
  );
  await client.query(
    `INSERT INTO community_creation_requirement_states (
       intent_id, actor_id, requirement_kind, status, requirement_hash, provider_id,
       provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, route_family, route_root_label,
       route_root_label_display, route_path_segment, generation,
       current_ceremony_intent_id, satisfied_at
     ) VALUES ($1, $2, 'namespace_ownership', 'unmet', $3, 'hns.owner.v1', $4,
       'managed', $5, $6, 'hns', $7, $7, $8, 0, NULL, NULL)`,
    [
      intentId,
      actorId,
      SHA,
      SHA_C,
      authority.configurationReference,
      authority.configurationVersion,
      root,
      path,
    ],
  );
  await client.query(
    `INSERT INTO community_creation_ceremony_attempts (
       ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
       requirement_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, route_family, route_root_label,
       route_root_label_display, route_path_segment, reservation_request_hash,
       reservation_request, expires_at
     ) VALUES ($1, $2, $3, 'namespace_ownership', 1, $4, 'hns.owner.v1', $5,
       'managed', $6, $7, 'hns', $8, $8, $9, $10, '{}'::jsonb,
       clock_timestamp() + interval '1 hour')`,
    [
      ceremonyId,
      actorId,
      intentId,
      SHA,
      SHA_C,
      authority.configurationReference,
      authority.configurationVersion,
      root,
      path,
      SHA_B,
    ],
  );
  await client.query(
    `UPDATE community_creation_requirement_states
        SET status = 'pending', generation = 1, current_ceremony_intent_id = $1,
            updated_at = clock_timestamp()
      WHERE intent_id = $2 AND requirement_kind = 'namespace_ownership'`,
    [ceremonyId, intentId],
  );
  await finalizeOwnershipEvidence(client, {
    actorId,
    authority,
    ceremonyId,
    evidenceRef,
    expiresAt,
    intentId,
    path,
    root,
    suffix,
    verifiedAt,
  });
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO community_canonical_route_bindings (
       route_binding_id, community_id, family, root_label, root_label_display,
       ownership_status, route_lifecycle_status, binding_generation, verified_evidence_ref
     ) VALUES ($1, $2, 'hns', $3, $3, 'verified', 'active', 1, $4)`,
    [bindingId, communityId, root, evidenceRef],
  );
  await client.query(
    `UPDATE communities SET canonical_route_binding_id = $1, updated_at = clock_timestamp()
      WHERE community_id = $2`,
    [bindingId, communityId],
  );
  await client.query("COMMIT");
  return {
    authority,
    suffix,
    bindingId,
    root,
    communityId,
    evidenceRef,
    routeRevalidationId: `hns-route-revalidation:${bindingId}:1`,
    sessionId: `hns-route-revalidation-session:${bindingId}:1`,
  };
}

async function insertPendingSession(
  client: Client,
  route: RouteSeed,
  generation: number,
  evidenceRef: string | null,
): Promise<PendingSeed> {
  const pending = pendingIds(route, generation);
  const upstream = `upstream_${route.suffix}_${generation}`;
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const presentation = {
    kind: "embedded_sdk",
    session_id: upstream,
    protocol: "hns-txt-challenge",
    version: "1",
    payload: {
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: `_pirate.${route.root}`,
      challenge_value: `pirate-verification=${upstream}`,
      expires_at: expiresAt,
    },
  };
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO community_route_revalidation_start_reservations (
       route_revalidation_id, revalidation_session_id, community_id, route_binding_id,
       principal_kind, principal_id, expected_binding_generation,
       expected_verified_evidence_ref, requirement_hash, provider_id,
       provider_binding_hash, provider_configuration_kind,
       provider_configuration_reference, provider_configuration_version,
       protocol_version, environment, family, root_label, root_label_display,
       path_segment, start_request_hash, state, fence_token, lease_expires_at
     ) VALUES ($1, $2, $3, $4, 'system', $5, $6, $7, $8, 'hns.owner.v1', $9,
       'managed', $10, $11, 'hns-txt-v1', $12, 'hns', $13, $13, $14, $15,
       'acquired', 1, clock_timestamp() + interval '15 seconds')`,
    [
      pending.routeRevalidationId,
      pending.sessionId,
      route.communityId,
      route.bindingId,
      PRINCIPAL_ID,
      generation,
      evidenceRef,
      SHA,
      SHA_C,
      route.authority.configurationReference,
      route.authority.configurationVersion,
      route.authority.environment,
      route.root,
      `app.${route.root}`,
      SHA_B,
    ],
  );
  await client.query(
    `INSERT INTO community_route_revalidation_sessions (
       revalidation_session_id, route_revalidation_id, start_fence_token,
       community_id, route_binding_id, principal_kind, principal_id,
       expected_binding_generation, expected_verified_evidence_ref, requirement_hash,
       start_request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_reference,
       provider_configuration_version, protocol_version, environment, family,
       root_label, root_label_display, path_segment, upstream_session_ref,
       start_presentation, status, started_at, expires_at
     ) VALUES ($1, $2, 1, $3, $4, 'system', $5, $6, $7, $8, $9, 'hns.owner.v1', $10,
       'managed', $11, $12, 'hns-txt-v1', $13, 'hns', $14, $14, $15, $16, $17::jsonb,
       'pending', clock_timestamp() - interval '3 days', $18)`,
    [
      pending.sessionId,
      pending.routeRevalidationId,
      route.communityId,
      route.bindingId,
      PRINCIPAL_ID,
      generation,
      evidenceRef,
      SHA,
      SHA_B,
      SHA_C,
      route.authority.configurationReference,
      route.authority.configurationVersion,
      route.authority.environment,
      route.root,
      `app.${route.root}`,
      upstream,
      JSON.stringify(presentation),
      expiresAt,
    ],
  );
  await client.query(
    `UPDATE community_route_revalidation_start_reservations
        SET state = 'finalized'
      WHERE route_revalidation_id = $1`,
    [pending.routeRevalidationId],
  );
  await client.query("COMMIT");
  return pending;
}

async function terminalizeRecoveryPrior(client: Client, route: RouteSeed): Promise<void> {
  const prior = pendingIds(route, 1);
  const attemptId = `attempt_${route.suffix}_prior`;
  const idempotencyKey = `poll_${route.suffix}_prior`;
  const terminalDocument = JSON.stringify([
    "pirate-hns-route-revalidation-result-v1",
    prior.routeRevalidationId,
    prior.sessionId,
    attemptId,
    route.bindingId,
    1,
    idempotencyKey,
    SHA_C,
    "missing_root",
    null,
    null,
    null,
    "revoked",
    "suspended",
  ]);
  const resultHash = createHash("sha256").update(terminalDocument).digest("hex");
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO community_route_revalidation_completion_attempts (
       route_revalidation_attempt_id, route_revalidation_id, revalidation_session_id,
       route_binding_id, expected_binding_generation, expected_verified_evidence_ref,
       attempt_number, idempotency_key, completion_request_hash, evidence_ref,
       state, fence_token, lease_expires_at
     ) VALUES ($1, $2, $3, $4, 1, $5, 1, $6, $7, $8, 'leased', 1,
       clock_timestamp() + interval '15 seconds')`,
    [
      attemptId,
      prior.routeRevalidationId,
      prior.sessionId,
      route.bindingId,
      route.evidenceRef,
      idempotencyKey,
      SHA_C,
      `attempt_evidence_${route.suffix}_prior`,
    ],
  );
  await client.query(
    `UPDATE community_canonical_route_bindings
        SET ownership_status = 'revoked', route_lifecycle_status = 'suspended',
            binding_generation = 2, verified_evidence_ref = NULL,
            updated_at = clock_timestamp()
      WHERE route_binding_id = $1`,
    [route.bindingId],
  );
  await client.query(
    `UPDATE community_route_revalidation_completion_attempts
        SET state = 'consumed', consumption_kind = 'missing_root',
            result_hash = $2, terminal_result_document = $3,
            terminal_at = clock_timestamp()
      WHERE route_revalidation_attempt_id = $1`,
    [attemptId, resultHash, terminalDocument],
  );
  await client.query(
    `UPDATE community_route_revalidation_sessions
        SET status = 'failed', terminal_at = clock_timestamp()
      WHERE revalidation_session_id = $1`,
    [prior.sessionId],
  );
  await client.query("COMMIT");
}

async function insertExhaustedAttempts(client: Client, pending: PendingSeed, route: RouteSeed) {
  for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
    const attemptId = `attempt_${route.suffix}_exhausted_${attemptNumber}`;
    const idempotencyKey = `poll_${route.suffix}_${attemptNumber}`;
    await client.query(
      `INSERT INTO community_route_revalidation_completion_attempts (
         route_revalidation_attempt_id, route_revalidation_id, revalidation_session_id,
         route_binding_id, expected_binding_generation, expected_verified_evidence_ref,
         attempt_number, idempotency_key, completion_request_hash, evidence_ref,
         state, fence_token, lease_expires_at
       ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, 'leased', 1,
         clock_timestamp() + interval '15 seconds')`,
      [
        attemptId,
        pending.routeRevalidationId,
        pending.sessionId,
        route.bindingId,
        pending.generation,
        attemptNumber,
        idempotencyKey,
        SHA_C,
        `attempt_evidence_${route.suffix}_${attemptNumber}`,
      ],
    );
    await client.query(
      `UPDATE community_route_revalidation_completion_attempts
          SET state = 'consumed', consumption_kind = 'challenge_mismatch',
              terminal_at = clock_timestamp()
        WHERE route_revalidation_attempt_id = $1`,
      [attemptId],
    );
  }
}

async function makeRecoveryTarget(client: Client, route: RouteSeed): Promise<void> {
  await insertPendingSession(client, route, 1, route.evidenceRef);
  await terminalizeRecoveryPrior(client, route);
}

suite("HNS scheduler SQL regressions (Postgres)", () => {
  test("never returns an active binding, including when forced", async () => {
    await withSchema(async (client) => {
      await seedRoute(client, "alpha", "binding_alpha", "alpha");

      const ordinary = await client.query({
        text: HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL,
        values: [
          86_400,
          1,
          PRINCIPAL_ID,
          null,
          null,
          ENVIRONMENT,
          CONFIG_REFERENCE,
          CONFIG_VERSION,
        ],
      });
      expect(ordinary.rows).toHaveLength(0);

      const forced = await client.query({
        text: HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL,
        values: [
          86_400,
          1,
          PRINCIPAL_ID,
          "binding_alpha",
          1,
          ENVIRONMENT,
          CONFIG_REFERENCE,
          CONFIG_VERSION,
        ],
      });
      expect(forced.rows).toHaveLength(0);
    });
  }, 30_000);

  test("filters provider authority before applying the ordered start limit", async () => {
    await withSchema(async (client) => {
      const stale = await seedRoute(
        client,
        "authority_stale",
        "binding_authority_aaa_stale",
        "authoritystale",
        {
          configurationReference: "hns-owner-other",
          configurationVersion: "hns-owner-config-v2",
          environment: "development",
        },
      );
      const eligible = await seedRoute(
        client,
        "authority_eligible",
        "binding_authority_zzz_eligible",
        "authorityeligible",
      );
      await makeRecoveryTarget(client, stale);
      await makeRecoveryTarget(client, eligible);

      const result = await client.query({
        text: HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL,
        values: [0, 1, PRINCIPAL_ID, null, null, ENVIRONMENT, CONFIG_REFERENCE, CONFIG_VERSION],
      });
      expect(result.rows.map((row) => row.route_binding_id)).toEqual([
        "binding_authority_zzz_eligible",
      ]);
    });
  }, 30_000);

  test("skips an open recovery session for ordinary starts but preserves forced selection", async () => {
    await withSchema(async (client) => {
      const alpha = await seedRoute(
        client,
        "alpha_recovery",
        "binding_alpha_recovery",
        "alpharecovery",
      );
      const bravo = await seedRoute(
        client,
        "bravo_recovery",
        "binding_bravo_recovery",
        "bravorecovery",
      );
      await makeRecoveryTarget(client, alpha);
      await makeRecoveryTarget(client, bravo);
      await insertPendingSession(client, alpha, 2, null);

      const ordinary = await client.query({
        text: HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL,
        values: [0, 1, PRINCIPAL_ID, null, null, ENVIRONMENT, CONFIG_REFERENCE, CONFIG_VERSION],
      });
      expect(ordinary.rows.map((row) => row.route_binding_id)).toEqual(["binding_bravo_recovery"]);

      const forced = await client.query({
        text: HNS_ROUTE_REVALIDATION_START_CANDIDATES_SQL,
        values: [
          86_400,
          1,
          PRINCIPAL_ID,
          "binding_alpha_recovery",
          2,
          ENVIRONMENT,
          CONFIG_REFERENCE,
          CONFIG_VERSION,
        ],
      });
      expect(forced.rows.map((row) => row.route_binding_id)).toEqual(["binding_alpha_recovery"]);
    });
  }, 30_000);

  test("filters exhausted sessions before applying the poll limit", async () => {
    await withSchema(async (client) => {
      const alpha = await seedRoute(
        client,
        "attempt_alpha",
        "binding_attempt_alpha",
        "attemptalpha",
      );
      const bravo = await seedRoute(
        client,
        "attempt_bravo",
        "binding_attempt_bravo",
        "attemptbravo",
      );
      await makeRecoveryTarget(client, alpha);
      await makeRecoveryTarget(client, bravo);
      const exhausted = await insertPendingSession(client, alpha, 2, null);
      await insertPendingSession(client, bravo, 2, null);
      await insertExhaustedAttempts(client, exhausted, alpha);

      const result = await client.query({
        text: HNS_ROUTE_REVALIDATION_PENDING_SESSIONS_SQL,
        values: [PRINCIPAL_ID, CONFIG_REFERENCE, CONFIG_VERSION, ENVIRONMENT, 1],
      });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        route_revalidation_id: `hns-route-revalidation:${bravo.bindingId}:2`,
        revalidation_session_id: `hns-route-revalidation-session:${bravo.bindingId}:2`,
        consumed_attempts: 0,
      });
    });
  }, 30_000);
});
