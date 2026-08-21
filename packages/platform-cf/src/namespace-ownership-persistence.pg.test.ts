import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  NamespaceOwnershipCompletionAttemptReservation,
  NamespaceOwnershipProviderStartResult,
  NamespaceOwnershipStartReservationInput,
  NamespaceOwnershipStoredCompletion,
} from "@pirate/application";
import type {
  HnsRouteRevalidationProviderStartResult,
  HnsRouteRevalidationStartReservationInput,
} from "@pirate/application/route-revalidation";
import { Effect } from "effect";
import { Client } from "pg";
import { makeControlPlaneNamespaceOwnershipCompletionStore } from "./namespace-ownership-completion-repository";
import {
  makeControlPlaneNamespaceOwnershipStartAuthorityResolver,
  makeControlPlaneNamespaceOwnershipStartStore,
} from "./namespace-ownership-start-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";
import { makeControlPlaneRouteRevalidationStartStore } from "./route-revalidation-start-repository";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}

const suite = connectionString === undefined ? describe.skip : describe;
const namespacePersistenceTestCount = 32;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_NAMESPACE_OWNERSHIP_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-namespace-ownership-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-namespace-ownership-suite-complete\n";
let completedTestCount = 0;
const { runPostgresMigrations } =
  connectionString === undefined
    ? { runPostgresMigrations: undefined }
    : await import("../../../scripts/postgres-migrations.ts");

const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
type QueryValue = Buffer | null | undefined | string | number;
const _ROUTE = {
  family: "hns",
  root_label: "example_root",
  root_label_display: "example_root",
  route_path_segment: "app.example_root",
  route_href: "/c/app.example_root",
} as const;

function schemaName(): string {
  return `api_next_namespace_${crypto.randomUUID().replaceAll("-", "")}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedConnection(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function failure(client: Client, text: string, values: QueryValue[] = []): Promise<void> {
  try {
    await client.query(text, values);
    throw new Error("expected PostgreSQL failure");
  } catch (error) {
    expect(error).toMatchObject({ code: expect.stringMatching(/^(23514|23503|23505|P0001)$/) });
  }
}

async function seed(client: Client, suffix: string): Promise<void> {
  await client.query("INSERT INTO users (user_id) VALUES ($1), ($2)", [
    `actor_${suffix}`,
    `other_${suffix}`,
  ]);
  await client.query(
    `INSERT INTO community_creation_intents (
       intent_id, actor_id, create_idempotency_key, create_request_hash, revision, status,
       draft, canonical_policy_revision, canonical_policy_hash, verification_requirement_hash,
       verification_provider_id, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, expires_at
     ) VALUES ($1, $2, 'create-key', $3, 1, 'verification_required', '{}'::jsonb, 1, $3, $4,
       'namespace-provider', 'managed', 'namespace-config', 'v1', clock_timestamp() + interval '1 day')`,
    [`intent_${suffix}`, `actor_${suffix}`, SHA, SHA_B],
  );
  await client.query(
    `INSERT INTO community_creation_requirement_states (
       intent_id, actor_id, requirement_kind, status, requirement_hash, provider_id,
       provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, route_family, route_root_label, route_root_label_display,
       route_path_segment
     ) VALUES ($1, $2, 'namespace_ownership', 'unmet', $3, 'namespace-provider', $4,
       'managed', 'namespace-config', 'v1', 'hns', 'example_root', 'example_root',
       'app.example_root')`,
    [`intent_${suffix}`, `actor_${suffix}`, SHA_B, SHA_C],
  );
  await client.query(
    `INSERT INTO community_creation_ceremony_attempts (
       ceremony_intent_id, actor_id, intent_id, requirement_kind, generation, requirement_hash,
       provider_id, provider_binding_hash, provider_configuration_kind,
       provider_configuration_ref, provider_configuration_version, route_family,
       route_root_label, route_root_label_display, route_path_segment,
       reservation_request_hash, reservation_request, expires_at
     ) VALUES ($1, $2, $3, 'namespace_ownership', 1, $4, 'namespace-provider', $5,
       'managed', 'namespace-config', 'v1', 'hns', 'example_root', 'example_root',
       'app.example_root', $6, '{}'::jsonb, clock_timestamp() + interval '1 hour')`,
    [`ceremony_${suffix}`, `actor_${suffix}`, `intent_${suffix}`, SHA_B, SHA_C, SHA],
  );
  await client.query(
    `UPDATE community_creation_requirement_states
        SET status = 'pending', generation = 1, current_ceremony_intent_id = $1,
            updated_at = clock_timestamp()
      WHERE intent_id = $2 AND requirement_kind = 'namespace_ownership'`,
    [`ceremony_${suffix}`, `intent_${suffix}`],
  );
}

async function insertSession(
  client: Client,
  suffix: string,
  overrides: Record<string, unknown> = {},
) {
  const reuseReservation = overrides.reuseReservation === true;
  const values = {
    session: `namespace_session_${suffix}`,
    reservation:
      typeof overrides.startReservation === "string"
        ? overrides.startReservation
        : `namespace_start_${suffix}`,
    startFence: typeof overrides.startFence === "number" ? overrides.startFence : 1,
    actor: `actor_${suffix}`,
    intent: `intent_${suffix}`,
    ceremony: `ceremony_${suffix}`,
    upstream: `upstream_${suffix}`,
    reservationLease: undefined,
    startedAt: undefined,
    expiresAt: undefined,
    expectFailure: false,
    ...overrides,
  };
  await client.query("BEGIN");
  if (!reuseReservation)
    await client.query(
      `INSERT INTO namespace_ownership_start_reservations (
       reservation_id, namespace_session_id, actor_id, creation_intent_id,
       ceremony_intent_id, generation, requirement_hash, expected_revision,
       client_idempotency_key, request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
       protocol_version, environment, route_family, route_root_label, route_root_label_display,
       route_path_segment, route_href, route_app_host, state, fence_token,
       lease_expires_at
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, 1, $7, $8, 'namespace-provider', $9,
       'managed', 'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns', 'example_root',
       'example_root', 'app.example_root', '/c/app.example_root', NULL, 'acquired', 1,
       COALESCE($10::timestamptz, clock_timestamp() + interval '30 minutes'))`,
      [
        values.reservation,
        values.session,
        values.actor,
        values.intent,
        values.ceremony,
        SHA_B,
        `start-key-${suffix}`,
        SHA_C,
        SHA_C,
        values.reservationLease,
      ],
    );
  const sessionSql = `INSERT INTO namespace_ownership_sessions (
       namespace_session_id, actor_id, creation_intent_id, ceremony_intent_id,
       start_reservation_id, start_fence_token, expected_revision, generation,
       requirement_hash, request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
       protocol_version, environment, route_family, route_root_label, route_root_label_display,
       route_path_segment, route_href, route_app_host, upstream_session_ref,
       presentation_kind, presentation_payload, status, started_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, 1, $7, $8, 'namespace-provider', $9,
       'managed', 'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns',
       'example_root', 'example_root', 'app.example_root', '/c/app.example_root', NULL,
       $10, 'poll', '{"session_id":"provider-session"}'::jsonb, 'pending',
       COALESCE($11::timestamptz, clock_timestamp() - interval '1 minute'),
       COALESCE($12::timestamptz, clock_timestamp() + interval '1 hour'))`;
  const sessionValues = [
    values.session,
    values.actor,
    values.intent,
    values.ceremony,
    values.reservation,
    values.startFence,
    SHA_B,
    SHA_C,
    SHA_C,
    values.upstream,
    values.startedAt,
    values.expiresAt,
  ];
  if (values.expectFailure === true) {
    await failure(client, sessionSql, sessionValues);
    await client.query("ROLLBACK");
    return values;
  }
  await client.query(sessionSql, sessionValues);
  await client.query(
    `UPDATE namespace_ownership_start_reservations
        SET state = 'finalized', updated_at = clock_timestamp()
      WHERE reservation_id = $1`,
    [values.reservation],
  );
  await client.query("COMMIT");
  return values;
}

async function insertAttempt(
  client: Client,
  suffix: string,
  fence = 1,
  state = "leased",
  leaseMilliseconds = 1_800_000,
) {
  await client.query(
    `INSERT INTO namespace_ownership_completion_attempts (
       completion_attempt_id, namespace_session_id, actor_id, idempotency_key, evidence_ref,
       completion_request_hash, submission_channel, state, fence_token, lease_expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'poll_result', $7, $8,
       clock_timestamp() + $9::integer * interval '1 millisecond')`,
    [
      `completion_${suffix}`,
      `namespace_session_${suffix}`,
      `actor_${suffix}`,
      `callback-${suffix}`,
      `evidence_${suffix}`,
      SHA,
      state,
      fence,
      leaseMilliseconds,
    ],
  );
}

async function consumeAttempt(
  client: Client,
  suffix: string,
  consumptionKind: "semantic_contradiction" | "verified" | "rejected" | "expired",
) {
  await client.query(
    `UPDATE namespace_ownership_completion_attempts
        SET state = 'consumed', consumption_kind = $1, updated_at = clock_timestamp()
      WHERE completion_attempt_id = $2`,
    [consumptionKind, `completion_${suffix}`],
  );
}

async function insertSnapshot(
  client: Client,
  suffix: string,
  overrides: Partial<{
    observed: string;
    expires: string;
    expectFailure: boolean;
    raw: Buffer;
    providerEvidence: string;
  }> = {},
) {
  const value = {
    evidence: `evidence_${suffix}`,
    attempt: `completion_${suffix}`,
    session: `namespace_session_${suffix}`,
    actor: `actor_${suffix}`,
    intent: `intent_${suffix}`,
    ceremony: `ceremony_${suffix}`,
    observed: undefined,
    expires: undefined,
    expectFailure: false,
    raw: Buffer.from('{"status":"verified"}', "utf8"),
    providerEvidence: "provider-observation-shared",
    ...overrides,
  };
  const snapshotSql = `INSERT INTO namespace_ownership_evidence_snapshots (
       evidence_ref, completion_attempt_id, namespace_session_id, actor_id, creation_intent_id,
       ceremony_intent_id, generation, requirement_hash, request_hash, provider_id,
       provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, protocol_version, environment, family, root_label,
       root_label_display, path_segment, href, app_host, upstream_session_ref, fence_token,
       abi_version, ownership_source, challenge_name, challenge_value_sha256, root_exists,
       root_control_verified, expiry_horizon_sufficient, chain_network, chain_anchor_height,
       chain_anchor_block_hash, chain_anchor_median_time, expiry_height, observed_at, expires_at,
       provider_evidence_ref, observation_sha256, provider_identity_digest, evidence_digest,
       observation, raw_response_bytes
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, 'namespace-provider', $9,
       'managed', 'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns', 'example_root',
       'example_root', 'app.example_root', '/c/app.example_root', NULL, $10, 1,
       'pirate-hns-ownership-evidence-v1', 'owner_authoritative_dns_txt',
       '_pirate.example_root', $11, TRUE, TRUE, TRUE, 'hns-testnet', 10, $12, 100, 20,
       COALESCE($13::timestamptz, clock_timestamp() - interval '1 minute'),
       COALESCE($14::timestamptz, clock_timestamp() + interval '1 hour'),
       $15, $16, $17, $18, $19::jsonb, $20)`;
  const snapshotValues = [
    value.evidence,
    value.attempt,
    value.session,
    value.actor,
    value.intent,
    value.ceremony,
    SHA_B,
    SHA_C,
    SHA_C,
    `upstream_${suffix}`,
    SHA,
    SHA_C,
    value.observed,
    value.expires,
    value.providerEvidence,
    SHA,
    SHA_B,
    SHA_C,
    '{"status":"verified"}',
    value.raw,
  ];
  if (value.expectFailure === true) {
    await failure(client, snapshotSql, snapshotValues);
  } else {
    await client.query(snapshotSql, snapshotValues);
  }
}

async function databaseTerminalAt(client: Client): Promise<string> {
  const result = await client.query<{ value: string }>(
    "SELECT (clock_timestamp() - interval '10 seconds')::text AS value",
  );
  return result.rows[0]?.value ?? new Date(Date.now() - 10_000).toISOString();
}

type NamespaceOutcome = "satisfied" | "failed" | "expired";

async function insertNamespaceResult(
  client: Client,
  suffix: string,
  outcome: NamespaceOutcome,
  terminalAt: string,
): Promise<void> {
  const satisfied = outcome === "satisfied";
  await client.query(
    `INSERT INTO community_creation_ceremony_results (
       ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
       requirement_hash, provider_id, provider_binding_hash, provider_configuration_version,
       callback_idempotency_key, callback_request_hash, outcome_status, result_hash,
       evidence_ref, evidence_digest, provider_identity_digest, terminal_at, satisfied_at,
       namespace_session_id, completion_attempt_id, submission_channel
     ) VALUES ($1, $2, $3, 'namespace_ownership', 1, $4, 'namespace-provider', $5, 'v1',
       $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'poll_result')`,
    [
      `ceremony_${suffix}`,
      `actor_${suffix}`,
      `intent_${suffix}`,
      SHA_B,
      SHA_C,
      `callback-${suffix}`,
      SHA,
      outcome,
      SHA_B,
      satisfied ? `evidence_${suffix}` : null,
      satisfied ? SHA_C : null,
      satisfied ? SHA_B : null,
      terminalAt,
      satisfied ? terminalAt : null,
      `namespace_session_${suffix}`,
      `completion_${suffix}`,
    ],
  );
}

async function insertRouteEvidence(
  client: Client,
  suffix: string,
  verifiedAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO community_route_ownership_evidence (
       evidence_ref, creation_ceremony_intent_id, verified_by_actor_id,
       family, root_label, root_label_display, path_segment,
       requirement_hash, provider_id, provider_binding_hash,
       provider_configuration_version, provider_identity_digest,
       evidence_digest, binding_generation, verified_at, expires_at
     ) VALUES ($1, $2, $3, 'hns', 'example_root', 'example_root', 'app.example_root',
       $4, 'namespace-provider', $5, 'v1', $6, $7, 1, $8,
       (SELECT expires_at FROM namespace_ownership_evidence_snapshots WHERE evidence_ref = $1))`,
    [
      `evidence_${suffix}`,
      `ceremony_${suffix}`,
      `actor_${suffix}`,
      SHA_B,
      SHA_C,
      SHA_B,
      SHA_C,
      verifiedAt,
    ],
  );
}

async function finalizeVerifiedSnapshot(client: Client, suffix: string): Promise<void> {
  await client.query("BEGIN");
  await consumeAttempt(client, suffix, "verified");
  await insertSnapshot(client, suffix);
  const terminalAt = await databaseTerminalAt(client);
  await insertNamespaceResult(client, suffix, "satisfied", terminalAt);
  await client.query(
    `UPDATE community_creation_requirement_states
        SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
      WHERE intent_id = $2 AND requirement_kind = 'namespace_ownership'`,
    [terminalAt, `intent_${suffix}`],
  );
  await insertRouteEvidence(client, suffix, terminalAt);
  await client.query(
    `UPDATE namespace_ownership_sessions
        SET status = 'completed', terminal_at = $1, completed_at = $1,
            updated_at = clock_timestamp()
      WHERE namespace_session_id = $2`,
    [terminalAt, `namespace_session_${suffix}`],
  );
  await client.query("COMMIT");
}

async function seedActiveRevalidationRoute(client: Client, suffix: string): Promise<void> {
  await seed(client, suffix);
  await insertSession(client, suffix);
  await insertAttempt(client, suffix);
  await finalizeVerifiedSnapshot(client, suffix);
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id, canonical_route_binding_id,
       route_authority_version, created_at, updated_at, route_slug
     ) VALUES ($1, $2, 'active', $3, $4, 'route_v1',
       clock_timestamp(), clock_timestamp(), NULL)`,
    [`community_${suffix}`, `Community ${suffix}`, `actor_${suffix}`, `route_binding_${suffix}`],
  );
  await client.query(
    `INSERT INTO community_canonical_route_bindings (
       route_binding_id, community_id, family, root_label, root_label_display,
       ownership_status, route_lifecycle_status, binding_generation,
       verified_evidence_ref
     ) VALUES ($1, $2, 'hns', 'example_root', 'example_root',
       'verified', 'active', 1, $3)`,
    [`route_binding_${suffix}`, `community_${suffix}`, `evidence_${suffix}`],
  );
  await client.query("COMMIT");
}

async function insertRevalidationSession(client: Client, suffix: string): Promise<void> {
  const upstreamSessionRef = `revalidation_upstream_${suffix}`;
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const startPresentation = {
    kind: "embedded_sdk",
    session_id: upstreamSessionRef,
    protocol: "hns-txt-challenge",
    version: "1",
    payload: {
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.example_root",
      challenge_value: `pirate-verification=${upstreamSessionRef}`,
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
     ) VALUES ($1, $2, $3, $4, 'system', 'route-revalidation-scheduler', 1, $5,
       $6, 'namespace-provider', $7, 'managed', 'namespace-config', 'v1',
       'hns-txt-v1', 'test', 'hns', 'example_root', 'example_root',
       'app.example_root', $8, 'acquired', 1, clock_timestamp() + interval '15 seconds')`,
    [
      `route_revalidation_${suffix}`,
      `revalidation_session_${suffix}`,
      `community_${suffix}`,
      `route_binding_${suffix}`,
      `evidence_${suffix}`,
      SHA,
      SHA_C,
      SHA_B,
    ],
  );
  await client.query(
    `INSERT INTO community_route_revalidation_sessions (
       revalidation_session_id, route_revalidation_id, start_fence_token,
       community_id, route_binding_id, principal_kind, principal_id,
       expected_binding_generation, expected_verified_evidence_ref,
       requirement_hash, start_request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_reference,
       provider_configuration_version, protocol_version, environment, family,
       root_label, root_label_display, path_segment, upstream_session_ref,
       start_presentation, status, started_at, expires_at
     ) VALUES ($1, $2, 1, $3, $4, 'system', 'route-revalidation-scheduler',
       1, $5, $6, $7, 'namespace-provider', $8, 'managed', 'namespace-config',
       'v1', 'hns-txt-v1', 'test', 'hns', 'example_root', 'example_root',
       'app.example_root', $9, $10::jsonb, 'pending', clock_timestamp(), $11)`,
    [
      `revalidation_session_${suffix}`,
      `route_revalidation_${suffix}`,
      `community_${suffix}`,
      `route_binding_${suffix}`,
      `evidence_${suffix}`,
      SHA,
      SHA_B,
      SHA_C,
      upstreamSessionRef,
      JSON.stringify(startPresentation),
      expiresAt,
    ],
  );
  await client.query(
    `UPDATE community_route_revalidation_start_reservations
        SET state = 'finalized'
      WHERE route_revalidation_id = $1`,
    [`route_revalidation_${suffix}`],
  );
  await client.query("COMMIT");
}

async function insertRevalidationAttempt(client: Client, suffix: string): Promise<void> {
  await client.query(
    `INSERT INTO community_route_revalidation_completion_attempts (
       route_revalidation_attempt_id, route_revalidation_id,
       revalidation_session_id, route_binding_id, expected_binding_generation,
       expected_verified_evidence_ref, attempt_number, idempotency_key,
       completion_request_hash, evidence_ref, state, fence_token, lease_expires_at
     ) VALUES ($1, $2, $3, $4, 1, $5, 1, $6, $7, $8, 'leased', 1,
       clock_timestamp() + interval '15 seconds')`,
    [
      `revalidation_attempt_${suffix}`,
      `route_revalidation_${suffix}`,
      `revalidation_session_${suffix}`,
      `route_binding_${suffix}`,
      `evidence_${suffix}`,
      `revalidation-key-${suffix}`,
      SHA_C,
      `revalidation_evidence_${suffix}`,
    ],
  );
}

async function finalizeRevalidationEvidence(
  client: Client,
  suffix: string,
  options: { challengeValueOverride?: string; corruptRawResponse?: boolean } = {},
): Promise<void> {
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const challengeValue =
    options.challengeValueOverride ?? `pirate-verification=revalidation_upstream_${suffix}`;
  const observation = {
    status: "verified",
    observation: {
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.example_root",
      challenge_value: challengeValue,
      root_exists: true,
      root_control_verified: true,
      expiry_horizon_sufficient: true,
      chain_network: "hns-testnet",
      chain_anchor_height: 10,
      chain_anchor_block_hash: SHA_B,
      chain_anchor_median_time: 100,
      expiry_height: 20,
      observed_at: observedAt,
      expires_at: expiresAt,
      provider_evidence_ref: `provider-revalidation-${suffix}`,
    },
  };
  const rawResponse = Buffer.from(JSON.stringify(observation), "utf8");
  const storedRawResponse = options.corruptRawResponse
    ? Buffer.concat([rawResponse, Buffer.from(" ", "utf8")])
    : rawResponse;
  const challengeValueSha256 = createHash("sha256").update(challengeValue).digest("hex");
  const observationSha256 = createHash("sha256").update(rawResponse).digest("hex");
  await client.query("BEGIN");
  await client.query(
    `UPDATE community_canonical_route_bindings
        SET binding_generation = 2, verified_evidence_ref = $1,
            ownership_status = 'verified', route_lifecycle_status = 'active',
            updated_at = clock_timestamp()
      WHERE route_binding_id = $2`,
    [`revalidation_evidence_${suffix}`, `route_binding_${suffix}`],
  );
  await client.query(
    `UPDATE community_route_revalidation_completion_attempts
        SET state = 'consumed', consumption_kind = 'verified', result_hash = $1,
            terminal_at = clock_timestamp()
      WHERE route_revalidation_attempt_id = $2`,
    [SHA, `revalidation_attempt_${suffix}`],
  );
  await client.query(
    `UPDATE community_route_revalidation_sessions
        SET status = 'completed', terminal_at = clock_timestamp()
      WHERE revalidation_session_id = $1`,
    [`revalidation_session_${suffix}`],
  );
  await client.query(
    `INSERT INTO community_route_revalidation_evidence_snapshots (
       evidence_ref, route_revalidation_attempt_id, route_revalidation_id,
       revalidation_session_id, community_id, route_binding_id, principal_kind,
       principal_id, requirement_hash, expected_binding_generation,
       binding_generation, expected_verified_evidence_ref, start_request_hash,
       provider_id, provider_binding_hash, provider_configuration_kind,
       provider_configuration_reference, provider_configuration_version,
       protocol_version, environment, family, root_label, root_label_display,
       path_segment, upstream_session_ref, fence_token, ownership_source,
       challenge_name, challenge_value_sha256, root_exists, root_control_verified,
       expiry_horizon_sufficient, chain_network, chain_anchor_height,
       chain_anchor_block_hash, chain_anchor_median_time, expiry_height,
       observed_at, expires_at, provider_evidence_ref, observation_sha256,
       provider_identity_digest, evidence_digest, observation, raw_response_bytes
     ) VALUES ($1, $2, $3, $4, $5, $6, 'system', 'route-revalidation-scheduler',
       $7, 1, 2, $8, $9, 'namespace-provider', $10, 'managed',
       'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns', 'example_root',
       'example_root', 'app.example_root', $11, 1,
       'owner_authoritative_dns_txt', '_pirate.example_root', $12,
       TRUE, TRUE, TRUE, 'hns-testnet', 10, $13, 100, 20,
       $14::timestamptz, $15::timestamptz, $16, $17, $18, $19, $20::jsonb, $21)`,
    [
      `revalidation_evidence_${suffix}`,
      `revalidation_attempt_${suffix}`,
      `route_revalidation_${suffix}`,
      `revalidation_session_${suffix}`,
      `community_${suffix}`,
      `route_binding_${suffix}`,
      SHA,
      `evidence_${suffix}`,
      SHA_B,
      SHA_C,
      `revalidation_upstream_${suffix}`,
      challengeValueSha256,
      SHA_B,
      observedAt,
      expiresAt,
      `provider-revalidation-${suffix}`,
      observationSha256,
      SHA_B,
      SHA,
      JSON.stringify(observation),
      storedRawResponse,
    ],
  );
  await client.query(
    `INSERT INTO community_route_ownership_evidence (
       evidence_ref, origin, route_revalidation_attempt_id,
       creation_ceremony_intent_id, verified_by_actor_id, family, root_label,
       root_label_display, path_segment, requirement_hash, provider_id,
       provider_binding_hash, provider_configuration_version,
       provider_identity_digest, evidence_digest, evidence_receipt_id,
       binding_generation, verified_at, expires_at
     ) SELECT evidence_ref, 'route_revalidation', route_revalidation_attempt_id,
       NULL, NULL, family, root_label, root_label_display, path_segment,
       requirement_hash, provider_id, provider_binding_hash,
       provider_configuration_version, provider_identity_digest, evidence_digest,
       NULL, binding_generation, observed_at, expires_at
     FROM community_route_revalidation_evidence_snapshots
     WHERE route_revalidation_attempt_id = $1`,
    [`revalidation_attempt_${suffix}`],
  );
  await client.query("COMMIT");
}

async function seedRepositoryStart(client: Client, suffix: string): Promise<void> {
  await client.query("INSERT INTO users (user_id) VALUES ($1)", [`start_actor_${suffix}`]);
  await client.query(
    `INSERT INTO community_creation_intents (
       intent_id, actor_id, create_idempotency_key, create_request_hash, revision, status,
       draft, canonical_policy_revision, canonical_policy_hash, verification_requirement_hash,
       verification_provider_id, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, expires_at
     ) VALUES ($1, $2, $3, $4, 1, 'verification_required', '{}'::jsonb, 1, $4, $5,
       'hns.owner.v1', 'managed', 'hns-owner', '1', clock_timestamp() + interval '1 day')`,
    [`start_intent_${suffix}`, `start_actor_${suffix}`, `create_${suffix}`, SHA, SHA_B],
  );
  await client.query(
    `INSERT INTO community_creation_requirement_states (
       intent_id, actor_id, requirement_kind, status, requirement_hash, provider_id,
       provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, route_family, route_root_label, route_root_label_display,
       route_path_segment
     ) VALUES ($1, $2, 'namespace_ownership', 'unmet', $3, 'hns.owner.v1', $4,
       'managed', 'hns-owner', '1', 'hns', 'jazleeuw', 'jazleeuw', 'app.jazleeuw')`,
    [`start_intent_${suffix}`, `start_actor_${suffix}`, SHA_B, SHA_C],
  );
  await client.query(
    `INSERT INTO community_creation_ceremony_attempts (
       ceremony_intent_id, actor_id, intent_id, requirement_kind, generation, requirement_hash,
       provider_id, provider_binding_hash, provider_configuration_kind,
       provider_configuration_ref, provider_configuration_version, route_family,
       route_root_label, route_root_label_display, route_path_segment,
       reservation_request_hash, reservation_request, expires_at
     ) VALUES ($1, $2, $3, 'namespace_ownership', 1, $4, 'hns.owner.v1', $5,
       'managed', 'hns-owner', '1', 'hns', 'jazleeuw', 'jazleeuw', 'app.jazleeuw',
       $6, '{"requirement":"namespace_ownership"}'::jsonb,
       clock_timestamp() + interval '1 hour')`,
    [
      `start_ceremony_${suffix}`,
      `start_actor_${suffix}`,
      `start_intent_${suffix}`,
      SHA_B,
      SHA_C,
      SHA,
    ],
  );
  await client.query(
    `UPDATE community_creation_requirement_states
        SET status = 'pending', generation = 1, current_ceremony_intent_id = $1,
            updated_at = clock_timestamp()
      WHERE intent_id = $2 AND requirement_kind = 'namespace_ownership'`,
    [`start_ceremony_${suffix}`, `start_intent_${suffix}`],
  );
}

function repositoryStartInput(
  suffix: string,
  overrides: Partial<NamespaceOwnershipStartReservationInput> = {},
): NamespaceOwnershipStartReservationInput {
  return {
    provider_id: "hns.owner.v1",
    start: {
      actor_id: `start_actor_${suffix}`,
      creation_intent_id: `start_intent_${suffix}`,
      ceremony_intent_id: `start_ceremony_${suffix}`,
      requirement_hash: SHA_B,
      generation: 1,
      request_hash: SHA,
      provider_binding_hash: SHA_C,
      provider_configuration: { kind: "managed", reference: "hns-owner", version: "1" },
      protocol_version: "hns-txt-v1",
      environment: "test",
      route: {
        family: "hns",
        root_label: "jazleeuw",
        root_label_display: "jazleeuw",
        path_segment: "app.jazleeuw",
        href: "/c/app.jazleeuw",
        app_host: null,
      },
    },
    expected_revision: 1,
    client_idempotency_key: `start_key_${suffix}`,
    reservation_id: `start_reservation_${suffix}`,
    namespace_session_id: `start_session_${suffix}`,
    ttl_ms: 6_000,
    ...overrides,
  };
}

function repositoryStartResult(
  input: NamespaceOwnershipStartReservationInput,
  expiresAt = "2099-08-21T00:00:00.000Z",
): NamespaceOwnershipProviderStartResult {
  return {
    session: {
      ...input.start,
      provider_id: input.provider_id,
      upstream_session_ref: `upstream_${input.namespace_session_id}`,
      expires_at: expiresAt,
    },
    presentation: {
      kind: "poll",
      session_id: `upstream_${input.namespace_session_id}`,
      poll_url: "/provider/poll",
    },
  };
}

function routeRevalidationStartInput(
  suffix: string,
  overrides: Partial<HnsRouteRevalidationStartReservationInput> = {},
): HnsRouteRevalidationStartReservationInput {
  return {
    authority: {
      version: "pirate-hns-route-revalidation-authority-v1",
      route_revalidation_id: `route_revalidation_start_${suffix}`,
      community_id: `community_${suffix}`,
      route_binding_id: `route_binding_${suffix}`,
      principal_kind: "system",
      principal_id: "route-revalidation-scheduler",
      expected_binding_generation: 1,
      expected_verified_evidence_ref: `evidence_${suffix}`,
      requirement_hash: SHA,
      provider_id: "namespace-provider",
      provider_binding_hash: SHA_C,
      provider_configuration_kind: "managed",
      provider_configuration_reference: "namespace-config",
      provider_configuration_version: "v1",
      protocol_version: "hns-txt-v1",
      environment: "test",
      family: "hns",
      root_label: "example_root",
      root_label_display: "example_root",
      path_segment: "app.example_root",
    },
    revalidation_session_id: `revalidation_session_start_${suffix}`,
    start_request_hash: SHA_B,
    ttl_ms: 6_000,
    ...overrides,
  };
}

function routeRevalidationStartResult(
  input: HnsRouteRevalidationStartReservationInput,
  upstreamSessionRef = `upstream_start_${input.revalidation_session_id}`,
  expiresAt = "2099-08-21T00:00:00.000Z",
): HnsRouteRevalidationProviderStartResult {
  return {
    upstream_session_ref: upstreamSessionRef,
    expires_at: expiresAt,
    presentation: {
      kind: "embedded_sdk",
      session_id: upstreamSessionRef,
      protocol: "hns-txt-challenge",
      version: "1",
      payload: {
        ownership_source: "owner_authoritative_dns_txt",
        challenge_name: `_pirate.${input.authority.root_label}`,
        challenge_value: `pirate-verification=${upstreamSessionRef}`,
        expires_at: expiresAt,
      },
    },
  };
}

async function createRepositoryNamespaceSession(
  client: Client,
  scoped: string,
  suffix: string,
  options: Readonly<{ readonly ttl_ms?: number; readonly expires_at?: string }> = {},
) {
  await seedRepositoryStart(client, suffix);
  const layer = makeDirectPostgresControlPlaneLayer(scoped);
  const startStore = makeControlPlaneNamespaceOwnershipStartStore(layer);
  const startInput = repositoryStartInput(suffix, { ttl_ms: options.ttl_ms ?? 6_000 });
  const reserved = await Effect.runPromise(Effect.scoped(startStore.reserve(startInput)));
  if (reserved.kind !== "acquired") throw new Error("expected namespace START reservation");
  const finalized = await Effect.runPromise(
    Effect.scoped(
      startStore.finalize(
        reserved.reservation,
        repositoryStartResult(startInput, options.expires_at),
      ),
    ),
  );
  if (finalized.kind !== "created")
    throw new Error(`expected namespace START finalization, received ${finalized.kind}`);
  const completionStore = makeControlPlaneNamespaceOwnershipCompletionStore(layer);
  const completionInput = {
    actor_id: startInput.start.actor_id,
    creation_intent_id: startInput.start.creation_intent_id,
    ceremony_intent_id: startInput.start.ceremony_intent_id,
    session_id: startInput.namespace_session_id,
    expected_revision: 1,
    idempotency_key: `poll_${suffix}`,
    completion_request_hash: SHA,
    expired_result_hash: SHA_B,
    completion_attempt_id: `completion_attempt_${suffix}`,
    evidence_ref: `completion_evidence_${suffix}`,
    lease_ms: 16_000,
    max_consumed_attempts: 3,
  } as const;
  const stored = await Effect.runPromise(
    Effect.scoped(
      completionStore.load({
        actor_id: completionInput.actor_id,
        creation_intent_id: completionInput.creation_intent_id,
        ceremony_intent_id: completionInput.ceremony_intent_id,
        session_id: completionInput.session_id,
      }),
    ),
  );
  if (stored === null) throw new Error("expected namespace completion session");
  return { completionStore, completionInput, startInput, stored };
}

function verifiedCompletionInput(
  expected: NamespaceOwnershipStoredCompletion,
  attempt: NamespaceOwnershipCompletionAttemptReservation,
  request: Readonly<{
    readonly idempotency_key: string;
    readonly completion_request_hash: string;
  }>,
  ownershipSource:
    | "hns_parent_chain_txt"
    | "owner_authoritative_dns_txt" = "owner_authoritative_dns_txt",
) {
  const raw = Buffer.from(
    JSON.stringify({ status: "verified", provider_evidence_ref: "provider-observation" }),
    "utf8",
  );
  return {
    actor_id: expected.session.actor_id,
    expected,
    idempotency_key: request.idempotency_key,
    completion_request_hash: request.completion_request_hash,
    result_hash: SHA_C,
    expired_result_hash: SHA_B,
    attempt,
    verified: {
      envelope: {
        version: "pirate-hns-ownership-evidence-v1" as const,
        actor_id: expected.session.actor_id,
        creation_intent_id: expected.session.creation_intent_id,
        requirement: "namespace_ownership" as const,
        requirement_hash: expected.session.requirement_hash,
        ceremony_intent_id: expected.session.ceremony_intent_id,
        generation: expected.session.generation,
        request_hash: expected.session.request_hash,
        provider_id: expected.session.provider_id,
        provider_binding_hash: expected.session.provider_binding_hash,
        provider_configuration_kind: expected.session.provider_configuration.kind,
        provider_configuration_reference: expected.session.provider_configuration.reference,
        provider_configuration_version: expected.session.provider_configuration.version,
        protocol_version: expected.session.protocol_version,
        environment: expected.session.environment,
        family: "hns" as const,
        root_label: expected.session.route.root_label,
        root_label_display: expected.session.route.root_label_display,
        path_segment: expected.session.route.path_segment,
        upstream_session_ref: expected.session.upstream_session_ref,
        ownership_source: ownershipSource,
        challenge_name:
          ownershipSource === "hns_parent_chain_txt"
            ? expected.session.route.root_label
            : `_pirate.${expected.session.route.root_label}`,
        challenge_value_sha256: SHA,
        root_exists: true as const,
        root_control_verified: true as const,
        expiry_horizon_sufficient: true as const,
        chain_network: "regtest",
        chain_anchor_height: 123,
        chain_anchor_block_hash: SHA_B,
        chain_anchor_median_time: 456,
        expiry_height: 789,
        observed_at: "2026-08-20T00:00:00.000Z",
        expires_at: "2099-08-21T00:00:00.000Z",
        evidence_ref: attempt.evidence_ref,
        provider_evidence_ref: "provider-observation",
        observation_sha256: SHA,
        provider_identity_digest: SHA_B,
        evidence_digest: SHA_C,
      },
      observation: { status: "verified", provider_evidence_ref: "provider-observation" },
      raw_response_bytes: raw,
    },
  } as const;
}

async function withSchema<A>(
  use: (client: Client, scopedConnectionString: string) => Promise<A>,
): Promise<A> {
  if (connectionString === undefined || runPostgresMigrations === undefined) {
    throw new Error("Postgres test configuration is unavailable");
  }
  const schema = schemaName();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  try {
    const scoped = scopedConnection(connectionString, schema);
    await runPostgresMigrations({ connectionString: scoped });
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    return await use(admin, scoped);
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

suite("Postgres namespace ownership persistence foundation", () => {
  test("accepts a complete HNS snapshot and both deferred terminal insertion orders", async () => {
    await withSchema(async (client) => {
      await seed(client, "valid");
      await insertSession(client, "valid");
      await insertAttempt(client, "valid");
      await client.query("BEGIN");
      await consumeAttempt(client, "valid", "verified");
      await insertSnapshot(client, "valid");
      const terminalAt = await databaseTerminalAt(client);
      await client.query(
        `INSERT INTO community_creation_ceremony_results (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash, provider_configuration_version,
           callback_idempotency_key, callback_request_hash, outcome_status, result_hash,
           evidence_ref, evidence_digest, provider_identity_digest, terminal_at, satisfied_at,
           namespace_session_id, completion_attempt_id, submission_channel
         ) VALUES ($1, $2, $3, 'namespace_ownership', 1, $4, 'namespace-provider', $5, 'v1',
           'callback-valid', $6, 'satisfied', $7, $8, $9, $10, $11, $11, $12, $13, 'poll_result')`,
        [
          "ceremony_valid",
          "actor_valid",
          "intent_valid",
          SHA_B,
          SHA_C,
          SHA,
          SHA_B,
          "evidence_valid",
          SHA_C,
          SHA_B,
          terminalAt,
          "namespace_session_valid",
          "completion_valid",
        ],
      );
      await client.query(
        `UPDATE community_creation_requirement_states
            SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
          WHERE intent_id = 'intent_valid' AND requirement_kind = 'namespace_ownership'`,
        [terminalAt],
      );
      await insertRouteEvidence(client, "valid", terminalAt);
      await client.query(
        `UPDATE namespace_ownership_sessions
            SET status = 'completed', terminal_at = $1,
                completed_at = $1, updated_at = clock_timestamp()
          WHERE namespace_session_id = 'namespace_session_valid'`,
        [terminalAt],
      );
      await client.query("COMMIT");
      await seed(client, "deferred");
      await insertSession(client, "deferred");
      await insertAttempt(client, "deferred");
      await client.query("BEGIN");
      await consumeAttempt(client, "deferred", "verified");
      await insertSnapshot(client, "deferred");
      const deferredTerminalAt = await databaseTerminalAt(client);
      await client.query(
        `UPDATE community_creation_requirement_states
            SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
          WHERE intent_id = 'intent_deferred' AND requirement_kind = 'namespace_ownership'`,
        [deferredTerminalAt],
      );
      await client.query(
        `UPDATE namespace_ownership_sessions
            SET status = 'completed', terminal_at = $1, completed_at = $1,
                updated_at = clock_timestamp()
          WHERE namespace_session_id = 'namespace_session_deferred'`,
        [deferredTerminalAt],
      );
      await client.query(
        `INSERT INTO community_creation_ceremony_results (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash, provider_configuration_version,
           callback_idempotency_key, callback_request_hash, outcome_status, result_hash,
           evidence_ref, evidence_digest, provider_identity_digest, terminal_at, satisfied_at,
           namespace_session_id, completion_attempt_id, submission_channel
         ) VALUES ('ceremony_deferred', 'actor_deferred', 'intent_deferred',
           'namespace_ownership', 1, $1, 'namespace-provider', $2, 'v1', 'callback-deferred',
           $3, 'satisfied', $4, 'evidence_deferred', $5, $6, $7, $7,
           'namespace_session_deferred', 'completion_deferred', 'poll_result')`,
        [SHA_B, SHA_C, SHA, SHA_B, SHA_C, SHA_B, deferredTerminalAt],
      );
      await insertRouteEvidence(client, "deferred", deferredTerminalAt);
      await client.query("COMMIT");
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM namespace_ownership_evidence_snapshots",
          )
        ).rows[0]?.count,
      ).toBe(2);
    });
    completedTestCount += 1;
  });

  test("rejects pending sessions with failed or expired results and expired snapshots", async () => {
    await withSchema(async (client) => {
      await seed(client, "pending-failed");
      await insertSession(client, "pending-failed");
      await insertAttempt(client, "pending-failed");
      const terminalAt = await databaseTerminalAt(client);
      await client.query("BEGIN");
      await consumeAttempt(client, "pending-failed", "rejected");
      await insertNamespaceResult(client, "pending-failed", "failed", terminalAt);
      await client.query(
        `UPDATE community_creation_requirement_states
            SET status = 'failed', satisfied_at = NULL, updated_at = clock_timestamp()
          WHERE intent_id = 'intent_pending-failed' AND requirement_kind = 'namespace_ownership'`,
      );
      await failure(client, "COMMIT");
    });

    await withSchema(async (client) => {
      await seed(client, "pending-expired");
      await insertSession(client, "pending-expired");
      await insertAttempt(client, "pending-expired");
      await client.query("BEGIN");
      expect(
        (
          await client.query(
            `UPDATE namespace_ownership_completion_attempts
            SET state = 'consumed', consumption_kind = 'expired',
                updated_at = clock_timestamp()
          WHERE completion_attempt_id = 'completion_pending-expired'`,
          )
        ).rowCount,
      ).toBe(0);
      await client.query("ROLLBACK");
    });

    await withSchema(async (client) => {
      await seed(client, "terminal-expiry");
      await insertSession(client, "terminal-expiry");
      await insertAttempt(client, "terminal-expiry");
      await client.query("BEGIN");
      await consumeAttempt(client, "terminal-expiry", "verified");
      await insertSnapshot(client, "terminal-expiry", {
        expires: new Date(Date.now() + 100).toISOString(),
      });
      await client.query("SELECT pg_sleep(0.2)");
      const terminalAt = await databaseTerminalAt(client);
      await insertNamespaceResult(client, "terminal-expiry", "satisfied", terminalAt);
      await client.query(
        `UPDATE community_creation_requirement_states
            SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
          WHERE intent_id = 'intent_terminal-expiry' AND requirement_kind = 'namespace_ownership'`,
        [terminalAt],
      );
      await client.query(
        `UPDATE namespace_ownership_sessions
            SET status = 'completed', terminal_at = $1, completed_at = $1,
                updated_at = clock_timestamp()
          WHERE namespace_session_id = 'namespace_session_terminal-expiry'`,
        [terminalAt],
      );
      await failure(client, "COMMIT");
    });
    completedTestCount += 1;
  });

  test("rejects route evidence that has no matching namespace snapshot", async () => {
    await withSchema(async (client) => {
      await seed(client, "orphan");
      await insertSession(client, "orphan");
      await insertAttempt(client, "orphan");
      const terminalAt = await databaseTerminalAt(client);
      await client.query("BEGIN");
      await consumeAttempt(client, "orphan", "verified");
      await client.query(
        `INSERT INTO community_creation_ceremony_results (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash, provider_configuration_version,
           callback_idempotency_key, callback_request_hash, outcome_status, result_hash,
           evidence_ref, evidence_digest, provider_identity_digest, terminal_at, satisfied_at,
           namespace_session_id, completion_attempt_id, submission_channel
         ) VALUES ('ceremony_orphan', 'actor_orphan', 'intent_orphan',
           'namespace_ownership', 1, $1, 'namespace-provider', $2, 'v1', 'callback-orphan',
           $3, 'satisfied', $4, 'orphan-evidence', $5, $6, $7, $7,
           'namespace_session_orphan', 'completion_orphan', 'poll_result')`,
        [SHA_B, SHA_C, SHA, SHA_B, SHA_C, SHA_B, terminalAt],
      );
      await client.query(
        `UPDATE community_creation_requirement_states
            SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
          WHERE intent_id = 'intent_orphan' AND requirement_kind = 'namespace_ownership'`,
        [terminalAt],
      );
      await failure(
        client,
        `INSERT INTO community_route_ownership_evidence (
           evidence_ref, creation_ceremony_intent_id, verified_by_actor_id, family,
           root_label, root_label_display, path_segment, requirement_hash, provider_id,
           provider_binding_hash, provider_configuration_version, provider_identity_digest,
           evidence_digest, binding_generation, verified_at, expires_at
         ) VALUES ('orphan-evidence', 'ceremony_orphan', 'actor_orphan', 'hns',
           'example_root', 'example_root', 'app.example_root', $1, 'namespace-provider',
           $2, 'v1', $3, $4, 1, $5, clock_timestamp() + interval '1 hour')`,
        [SHA_B, SHA_C, SHA_B, SHA_C, terminalAt],
      );
      await client.query("ROLLBACK");
    });
    completedTestCount += 1;
  });

  test("rejects actor, provider, route, protocol, environment, and upstream substitutions", async () => {
    await withSchema(async (client) => {
      await seed(client, "mismatch");
      await failure(
        client,
        `INSERT INTO namespace_ownership_sessions (
        namespace_session_id, actor_id, creation_intent_id, ceremony_intent_id, generation,
        requirement_hash, request_hash, provider_id, provider_binding_hash,
        provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
        protocol_version, environment, route_family, route_root_label, route_root_label_display,
        route_path_segment, route_href, upstream_session_ref, presentation_kind, status,
        started_at, expires_at
      ) SELECT 'bad-actor', 'other_mismatch', intent_id, current_ceremony_intent_id,
        generation, requirement_hash, $1, provider_id, provider_binding_hash,
        provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
        'wrong-protocol', 'wrong-environment', route_family, route_root_label,
        route_root_label_display, route_path_segment, '/c/' || route_path_segment, $2,
        'poll', 'pending', clock_timestamp(), clock_timestamp() + interval '1 hour'
        FROM community_creation_requirement_states
       WHERE intent_id = 'intent_mismatch' AND requirement_kind = 'namespace_ownership'`,
        [SHA, "x".repeat(16385)],
      );
      await insertSession(client, "mismatch");
      await insertAttempt(client, "mismatch");
      await failure(
        client,
        `INSERT INTO namespace_ownership_evidence_snapshots (
        evidence_ref, completion_attempt_id, namespace_session_id, actor_id, creation_intent_id,
        ceremony_intent_id, generation, requirement_hash, request_hash, provider_id,
        provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
        provider_configuration_version, protocol_version, environment, family, root_label,
        root_label_display, path_segment, href, upstream_session_ref, fence_token,
        ownership_source, challenge_name, challenge_value_sha256, root_exists,
        root_control_verified, expiry_horizon_sufficient, chain_network, chain_anchor_height,
        chain_anchor_block_hash, chain_anchor_median_time, expiry_height, observed_at, expires_at,
        provider_evidence_ref, observation_sha256, provider_identity_digest, evidence_digest,
        observation, raw_response_bytes
      ) SELECT 'evidence-mismatch', 'completion_mismatch', 'namespace_session_mismatch',
        'actor_mismatch', 'intent_mismatch', 'ceremony_mismatch', generation, requirement_hash,
        $1, provider_id, provider_binding_hash, provider_configuration_kind,
        provider_configuration_ref, provider_configuration_version, 'wrong-protocol',
        'wrong-environment', 'hns', 'example_root', 'example_root', 'app.example_root',
        '/c/app.example_root', 'upstream_mismatch', 1, 'owner_authoritative_dns_txt',
        '_pirate.example_root', $2, TRUE, TRUE, TRUE, 'hns-testnet', 10, $3, 100, 20,
        clock_timestamp(), clock_timestamp() + interval '1 hour', 'provider-evidence', $4,
        $5, $6, '{"status":"verified"}'::jsonb, decode('01', 'hex')
        FROM community_creation_requirement_states
       WHERE intent_id = 'intent_mismatch' AND requirement_kind = 'namespace_ownership'`,
        [SHA, SHA, SHA_C, SHA, SHA_B, SHA_C],
      );
      await seed(client, "callback-mismatch");
      await insertSession(client, "callback-mismatch");
      await insertAttempt(client, "callback-mismatch");
      const callbackTerminalAt = await databaseTerminalAt(client);
      const callbackResultSql = `INSERT INTO community_creation_ceremony_results (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash, provider_configuration_version,
           callback_idempotency_key, callback_request_hash, outcome_status, result_hash,
           evidence_ref, evidence_digest, provider_identity_digest, terminal_at, satisfied_at,
           namespace_session_id, completion_attempt_id, submission_channel
         ) VALUES ('ceremony_callback-mismatch', 'actor_callback-mismatch',
           'intent_callback-mismatch', 'namespace_ownership', 1, $1, 'namespace-provider', $2,
           'v1', $3, $4, 'satisfied', $5, 'evidence_callback-mismatch', $6, $7, $8, $8,
           'namespace_session_callback-mismatch', 'completion_callback-mismatch', 'poll_result')`;
      await failure(client, callbackResultSql, [
        SHA_B,
        SHA_C,
        "wrong-callback-idempotency",
        SHA,
        SHA_B,
        SHA_C,
        SHA_B,
        callbackTerminalAt,
      ]);
      await failure(client, callbackResultSql, [
        SHA_B,
        SHA_C,
        "callback-callback-mismatch",
        SHA_C,
        SHA_B,
        SHA_C,
        SHA_B,
        callbackTerminalAt,
      ]);
    });
    completedTestCount += 1;
  });

  test("requires acquired start reservations and fenced finalization", async () => {
    await withSchema(async (client) => {
      await seed(client, "start");
      const reservationValues = [
        "namespace_start_start",
        "namespace_session_start",
        "actor_start",
        "intent_start",
        "ceremony_start",
        SHA_B,
        "start-key-start",
        SHA_C,
        SHA_C,
      ];
      await failure(
        client,
        `INSERT INTO namespace_ownership_start_reservations (
           reservation_id, namespace_session_id, actor_id, creation_intent_id,
           ceremony_intent_id, generation, requirement_hash, expected_revision,
           client_idempotency_key, request_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
           protocol_version, environment, route_family, route_root_label, route_root_label_display,
           route_path_segment, route_href, state, fence_token, lease_expires_at
         ) VALUES ($1, $2, $3, $4, $5, 1, $6, 1, $7, $8, 'namespace-provider', $9,
           'managed', 'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns',
           'example_root', 'example_root', 'app.example_root', '/c/app.example_root',
           'released', 1, clock_timestamp() + interval '30 minutes')`,
        reservationValues,
      );
      await failure(
        client,
        `INSERT INTO namespace_ownership_start_reservations (
           reservation_id, namespace_session_id, actor_id, creation_intent_id,
           ceremony_intent_id, generation, requirement_hash, expected_revision,
           client_idempotency_key, request_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
           protocol_version, environment, route_family, route_root_label, route_root_label_display,
           route_path_segment, route_href, state, fence_token, lease_expires_at
         ) VALUES ($1, $2, $3, $4, $5, 1, $6, 1, $7, $8, 'namespace-provider', $9,
           'managed', 'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns',
           'example_root', 'example_root', 'app.example_root', '/c/app.example_root',
           'acquired', 1, clock_timestamp() - interval '1 second')`,
        reservationValues,
      );
      await client.query(
        `INSERT INTO namespace_ownership_start_reservations (
           reservation_id, namespace_session_id, actor_id, creation_intent_id,
           ceremony_intent_id, generation, requirement_hash, expected_revision,
           client_idempotency_key, request_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
           protocol_version, environment, route_family, route_root_label, route_root_label_display,
           route_path_segment, route_href, state, fence_token, lease_expires_at
         ) VALUES ($1, $2, $3, $4, $5, 1, $6, 1, $7, $8, 'namespace-provider', $9,
           'managed', 'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns',
           'example_root', 'example_root', 'app.example_root', '/c/app.example_root',
           'acquired', 1, clock_timestamp() + interval '30 minutes')`,
        reservationValues,
      );
      await client.query(
        `UPDATE namespace_ownership_start_reservations
            SET state = 'released', updated_at = clock_timestamp()
          WHERE reservation_id = 'namespace_start_start'`,
      );
      await client.query(
        `UPDATE namespace_ownership_start_reservations
            SET state = 'acquired', fence_token = 2,
                lease_expires_at = clock_timestamp() + interval '30 minutes',
                updated_at = clock_timestamp()
          WHERE reservation_id = 'namespace_start_start'`,
      );
      await failure(
        client,
        `UPDATE namespace_ownership_start_reservations
            SET state = 'finalized', fence_token = 1, updated_at = clock_timestamp()
          WHERE reservation_id = 'namespace_start_start'`,
      );
      await insertSession(client, "start", {
        reuseReservation: true,
        startReservation: "namespace_start_start",
        startFence: 2,
      });
      const requestHashes = (
        await client.query<{ ceremony_request_hash: string; start_request_hash: string }>(
          `SELECT cca.reservation_request_hash AS ceremony_request_hash,
                  nsr.request_hash AS start_request_hash
             FROM community_creation_ceremony_attempts AS cca
             JOIN namespace_ownership_start_reservations AS nsr
               ON nsr.ceremony_intent_id = cca.ceremony_intent_id
            WHERE cca.ceremony_intent_id = 'ceremony_start'`,
        )
      ).rows[0];
      expect(requestHashes).toMatchObject({
        ceremony_request_hash: SHA,
        start_request_hash: SHA_C,
      });
      expect(requestHashes?.start_request_hash).not.toBe(requestHashes?.ceremony_request_hash);
      expect(
        (
          await client.query(
            "SELECT state, fence_token FROM namespace_ownership_start_reservations WHERE reservation_id = 'namespace_start_start'",
          )
        ).rows[0],
      ).toMatchObject({ state: "finalized", fence_token: "2" });
    });
    completedTestCount += 1;
  });

  test("does not deadlock a fenced attempt race with a snapshot insert", async () => {
    await withSchema(async (client) => {
      await seed(client, "race");
      await insertSession(client, "race");
      await insertAttempt(client, "race");
      const schema = (await client.query<{ schema: string }>("SELECT current_schema() AS schema"))
        .rows[0]?.schema;
      if (connectionString === undefined || schema === undefined) {
        throw new Error("race connection configuration was unavailable");
      }
      const racer = new Client({ connectionString: scopedConnection(connectionString, schema) });
      await racer.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE namespace_ownership_completion_attempts
              SET state = 'released', updated_at = clock_timestamp()
            WHERE completion_attempt_id = 'completion_race'`,
        );
        await client.query(
          `UPDATE namespace_ownership_completion_attempts
              SET state = 'leased', fence_token = 2,
                  lease_expires_at = clock_timestamp() + interval '30 minutes',
                  updated_at = clock_timestamp()
            WHERE completion_attempt_id = 'completion_race'`,
        );

        await racer.query("BEGIN");
        await racer.query(
          `SELECT namespace_session_id
             FROM namespace_ownership_sessions
            WHERE namespace_session_id = 'namespace_session_race'
            FOR SHARE`,
        );
        const racerPid = (await racer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        if (racerPid === undefined) throw new Error("race backend pid was unavailable");
        const staleSnapshot = insertSnapshot(racer, "race", { expectFailure: true });
        let waiting = false;
        for (let index = 0; index < 200 && !waiting; index += 1) {
          waiting =
            (
              await client.query<{ waiting: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted) AS waiting",
                [racerPid],
              )
            ).rows[0]?.waiting === true;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await client.query("COMMIT");
        await staleSnapshot;
        await racer.query("ROLLBACK");
        const attempt = (
          await racer.query<{ state: string; fence_token: string }>(
            "SELECT state, fence_token FROM namespace_ownership_completion_attempts WHERE completion_attempt_id = 'completion_race'",
          )
        ).rows[0];
        expect(attempt).toMatchObject({ state: "leased", fence_token: "2" });
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await racer.end();
      }
    });
    completedTestCount += 1;
  });

  test("enforces raw byte bounds, future/expired timestamps, and true authorization facts", async () => {
    await withSchema(async (client) => {
      await seed(client, "bounds");
      await insertSession(client, "bounds");
      await insertAttempt(client, "bounds");
      await client.query("BEGIN");
      await consumeAttempt(client, "bounds", "verified");
      await failure(
        client,
        `INSERT INTO namespace_ownership_evidence_snapshots (
        evidence_ref, completion_attempt_id, namespace_session_id, actor_id, creation_intent_id,
        ceremony_intent_id, generation, requirement_hash, request_hash, provider_id,
        provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
        provider_configuration_version, protocol_version, environment, family, root_label,
        root_label_display, path_segment, href, upstream_session_ref, fence_token,
        ownership_source, challenge_name, challenge_value_sha256, root_exists,
        root_control_verified, expiry_horizon_sufficient, chain_network, chain_anchor_height,
        chain_anchor_block_hash, chain_anchor_median_time, expiry_height, observed_at, expires_at,
        provider_evidence_ref, observation_sha256, provider_identity_digest, evidence_digest,
        observation, raw_response_bytes
      ) VALUES ('bad-zero', 'completion_bounds', 'namespace_session_bounds', 'actor_bounds',
        'intent_bounds', 'ceremony_bounds', 1, $1, $2, 'namespace-provider', $3, 'managed',
        'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns', 'example_root', 'example_root',
        'app.example_root', '/c/app.example_root', 'upstream_bounds', 1,
        'owner_authoritative_dns_txt', '_pirate.example_root', $4, FALSE, TRUE, TRUE,
        'hns-testnet', 10, $5, 100, 20, clock_timestamp(), clock_timestamp() + interval '1 hour',
        'provider-evidence', $6, $7, $8, '{"status":"verified"}'::jsonb, ''::bytea)`,
        [SHA_B, SHA, SHA_C, SHA, SHA_C, SHA, SHA_B, SHA_C],
      );
      await client.query("ROLLBACK");
      await seed(client, "raw-one-megabyte");
      await insertSession(client, "raw-one-megabyte");
      await insertAttempt(client, "raw-one-megabyte");
      await client.query("BEGIN");
      await consumeAttempt(client, "raw-one-megabyte", "verified");
      await insertSnapshot(client, "raw-one-megabyte", {
        raw: Buffer.alloc(1024 * 1024, 0x78),
      });
      const exactRaw = (
        await client.query<{ raw_response_bytes: Buffer }>(
          "SELECT raw_response_bytes FROM namespace_ownership_evidence_snapshots WHERE evidence_ref = 'evidence_raw-one-megabyte'",
        )
      ).rows[0]?.raw_response_bytes;
      expect(exactRaw).toBeInstanceOf(Buffer);
      expect(exactRaw?.length).toBe(1024 * 1024);
      expect(Array.from(exactRaw ?? []).slice(0, 4)).toEqual([0x78, 0x78, 0x78, 0x78]);
      await client.query("ROLLBACK");
      await seed(client, "raw-too-large");
      await insertSession(client, "raw-too-large");
      await insertAttempt(client, "raw-too-large");
      await client.query("BEGIN");
      await consumeAttempt(client, "raw-too-large", "verified");
      await insertSnapshot(client, "raw-too-large", {
        raw: Buffer.alloc(1024 * 1024 + 1, 0x78),
        expectFailure: true,
      });
      await client.query("ROLLBACK");
      await seed(client, "future-observation");
      await insertSession(client, "future-observation");
      await insertAttempt(client, "future-observation");
      await client.query("BEGIN");
      await consumeAttempt(client, "future-observation", "verified");
      await insertSnapshot(client, "future-observation", {
        observed: new Date(Date.now() + 60_000).toISOString(),
        expectFailure: true,
      });
      await client.query("ROLLBACK");
      await seed(client, "expired-snapshot");
      await insertSession(client, "expired-snapshot");
      await insertAttempt(client, "expired-snapshot");
      await client.query("BEGIN");
      await consumeAttempt(client, "expired-snapshot", "verified");
      await insertSnapshot(client, "expired-snapshot", {
        expires: new Date(Date.now() - 1_000).toISOString(),
        expectFailure: true,
      });
      await client.query("ROLLBACK");
      await seed(client, "expired-session");
      await insertSession(client, "expired-session", {
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        expectFailure: true,
      });
      await failure(
        client,
        "UPDATE namespace_ownership_completion_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE completion_attempt_id = 'completion_bounds'",
      );
    });
    completedTestCount += 1;
  });

  test("allows a provider evidence reference to repeat across sessions but rejects target-ref substitution", async () => {
    await withSchema(async (client) => {
      await seed(client, "one");
      await insertSession(client, "one");
      await insertAttempt(client, "one");
      await finalizeVerifiedSnapshot(client, "one");
      await seed(client, "two");
      await insertSession(client, "two");
      await insertAttempt(client, "two");
      await finalizeVerifiedSnapshot(client, "two");
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM namespace_ownership_evidence_snapshots WHERE provider_evidence_ref = 'provider-observation-shared'",
          )
        ).rows[0]?.count,
      ).toBe(2);
      await failure(
        client,
        `INSERT INTO namespace_ownership_evidence_snapshots (
        evidence_ref, completion_attempt_id, namespace_session_id, actor_id, creation_intent_id,
        ceremony_intent_id, generation, requirement_hash, request_hash, provider_id,
        provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
        provider_configuration_version, protocol_version, environment, family, root_label,
        root_label_display, path_segment, href, upstream_session_ref, fence_token,
        ownership_source, challenge_name, challenge_value_sha256, root_exists,
        root_control_verified, expiry_horizon_sufficient, chain_network, chain_anchor_height,
        chain_anchor_block_hash, chain_anchor_median_time, expiry_height, observed_at, expires_at,
        provider_evidence_ref, observation_sha256, provider_identity_digest, evidence_digest,
        observation, raw_response_bytes
      ) SELECT 'evidence-substitute', 'completion_two', 'namespace_session_two', 'actor_two',
        'intent_two', 'ceremony_two', 1, $1, $2, 'namespace-provider', $3, 'managed',
        'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns', 'example_root', 'example_root',
        'app.example_root', '/c/app.example_root', 'upstream_one', 1,
        'owner_authoritative_dns_txt', '_pirate.example_root', $4, TRUE, TRUE, TRUE,
        'hns-testnet', 10, $5, 100, 20, clock_timestamp(), clock_timestamp() + interval '1 hour',
        'provider-observation-shared', $6, $7, $8, '{"status":"verified"}'::jsonb, decode('01', 'hex')`,
        [SHA_B, SHA, SHA_C, SHA, SHA_C, SHA, SHA, SHA_B],
      );
    });
    completedTestCount += 1;
  });

  test("requires live fenced attempts and prevents terminal sessions without matching snapshots", async () => {
    await withSchema(async (client) => {
      await seed(client, "fence");
      await insertSession(client, "fence");
      await insertAttempt(client, "fence");
      await client.query(
        "UPDATE namespace_ownership_completion_attempts SET state = 'released' WHERE completion_attempt_id = 'completion_fence'",
      );
      await expect(
        insertNamespaceResult(client, "fence", "satisfied", await databaseTerminalAt(client)),
      ).rejects.toMatchObject({ code: "P0001" });
      await client.query(
        "UPDATE namespace_ownership_completion_attempts SET state = 'leased', fence_token = 2, lease_expires_at = clock_timestamp() + interval '30 minutes' WHERE completion_attempt_id = 'completion_fence'",
      );
      await failure(
        client,
        "UPDATE namespace_ownership_completion_attempts SET state = 'consumed', fence_token = 1 WHERE completion_attempt_id = 'completion_fence'",
      );
      await failure(
        client,
        `UPDATE namespace_ownership_sessions SET status = 'completed', terminal_at = clock_timestamp(), completed_at = clock_timestamp() WHERE namespace_session_id = 'namespace_session_fence'`,
      );
    });
    completedTestCount += 1;
  });

  test("rejects consumed attempts without a kind and verified consumption after lease expiry", async () => {
    await withSchema(async (client) => {
      await seed(client, "expired-consume");
      await insertSession(client, "expired-consume");
      await insertAttempt(client, "expired-consume", 1, "leased", 100);
      await failure(
        client,
        `UPDATE namespace_ownership_completion_attempts
            SET updated_at = '2000-01-01T00:00:00.000Z'::timestamptz
          WHERE completion_attempt_id = 'completion_expired-consume'`,
      );
      await failure(
        client,
        `UPDATE namespace_ownership_completion_attempts
            SET state = 'consumed', consumption_kind = NULL,
                updated_at = clock_timestamp()
          WHERE completion_attempt_id = 'completion_expired-consume'`,
      );
      await client.query("SELECT pg_sleep(0.2)");
      expect(
        (
          await client.query(
            `UPDATE namespace_ownership_completion_attempts
            SET state = 'consumed', consumption_kind = 'verified',
                updated_at = '2000-01-01T00:00:00.000Z'::timestamptz
          WHERE completion_attempt_id = 'completion_expired-consume'`,
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            `SELECT state, consumption_kind
               FROM namespace_ownership_completion_attempts
              WHERE completion_attempt_id = 'completion_expired-consume'`,
          )
        ).rows[0],
      ).toEqual({ state: "leased", consumption_kind: null });
    });
    completedTestCount += 1;
  });

  test("keeps post-CAS verified writes valid after the lease wall clock passes", async () => {
    await withSchema(async (client) => {
      await seed(client, "post-cas");
      await insertSession(client, "post-cas");
      await insertAttempt(client, "post-cas", 1, "leased", 500);
      await client.query("BEGIN");
      await consumeAttempt(client, "post-cas", "verified");
      await client.query("SELECT pg_sleep(0.6)");
      await insertSnapshot(client, "post-cas");
      const terminalAt = await databaseTerminalAt(client);
      await insertNamespaceResult(client, "post-cas", "satisfied", terminalAt);
      await client.query(
        `UPDATE community_creation_requirement_states
            SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
          WHERE intent_id = 'intent_post-cas' AND requirement_kind = 'namespace_ownership'`,
        [terminalAt],
      );
      await insertRouteEvidence(client, "post-cas", terminalAt);
      await client.query(
        `UPDATE namespace_ownership_sessions
            SET status = 'completed', terminal_at = $1, completed_at = $1,
                updated_at = clock_timestamp()
          WHERE namespace_session_id = 'namespace_session_post-cas'`,
        [terminalAt],
      );
      await client.query("COMMIT");
      expect(
        (
          await client.query(
            `SELECT
               (SELECT consumption_kind FROM namespace_ownership_completion_attempts)
                 AS consumption_kind,
               (SELECT count(*)::int FROM namespace_ownership_evidence_snapshots) AS snapshots,
               (SELECT count(*)::int FROM community_creation_ceremony_results) AS results`,
          )
        ).rows[0],
      ).toEqual({ consumption_kind: "verified", snapshots: 1, results: 1 });
    });
    completedTestCount += 1;
  });

  test("runs namespace START reserve, finalize, and exact replay through the real repository", async () => {
    await withSchema(async (client, scoped) => {
      await seedRepositoryStart(client, "repository");
      const store = makeControlPlaneNamespaceOwnershipStartStore(
        makeDirectPostgresControlPlaneLayer(scoped),
      );
      const input = repositoryStartInput("repository");
      const authority = makeControlPlaneNamespaceOwnershipStartAuthorityResolver(
        makeDirectPostgresControlPlaneLayer(scoped),
      );
      expect(
        await Effect.runPromise(
          authority.resolve({
            actor_id: input.start.actor_id,
            creation_intent_id: input.start.creation_intent_id,
            ceremony_intent_id: input.start.ceremony_intent_id,
            expected_revision: input.expected_revision,
          }),
        ),
      ).toEqual({
        actor_id: input.start.actor_id,
        creation_intent_id: input.start.creation_intent_id,
        ceremony_intent_id: input.start.ceremony_intent_id,
        expected_revision: input.expected_revision,
        requirement_hash: input.start.requirement_hash,
        generation: input.start.generation,
        provider_id: input.provider_id,
        provider_binding_hash: input.start.provider_binding_hash,
        provider_configuration: input.start.provider_configuration,
        route: input.start.route,
      });
      const replayInput = {
        actor_id: input.start.actor_id,
        creation_intent_id: input.start.creation_intent_id,
        ceremony_intent_id: input.start.ceremony_intent_id,
        expected_revision: input.expected_revision,
        client_idempotency_key: input.client_idempotency_key,
      };
      expect(await Effect.runPromise(Effect.scoped(store.replay(replayInput)))).toEqual({
        kind: "none",
      });
      const reserved = await Effect.runPromise(Effect.scoped(store.reserve(input)));
      expect(reserved.kind).toBe("acquired");
      if (reserved.kind !== "acquired") throw new Error("expected acquired reservation");
      const providerResult = repositoryStartResult(input);
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.finalize(reserved.reservation, {
              ...providerResult,
              session: { ...providerResult.session, protocol_version: "substituted-v1" },
            }),
          ),
        ),
      ).toEqual({ kind: "conflict" });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.finalize(reserved.reservation, {
              ...providerResult,
              session: { ...providerResult.session, environment: "production" },
            }),
          ),
        ),
      ).toEqual({ kind: "conflict" });
      const finalized = await Effect.runPromise(
        Effect.scoped(store.finalize(reserved.reservation, providerResult)),
      );
      expect(finalized.kind).toBe("created");
      const replayed = await Effect.runPromise(Effect.scoped(store.replay(replayInput)));
      expect(replayed).toMatchObject({
        kind: "replay",
        namespace_session_id: input.namespace_session_id,
      });
      expect(
        (
          await client.query(
            `SELECT
               (SELECT count(*)::int FROM namespace_ownership_sessions) AS namespace_sessions,
               (SELECT count(*)::int FROM proof_sessions) AS proof_sessions,
               (SELECT count(*)::int FROM namespace_ownership_completion_attempts) AS attempts,
               (SELECT count(*)::int FROM namespace_ownership_evidence_snapshots) AS snapshots,
               (SELECT count(*)::int FROM community_creation_ceremony_results) AS results`,
          )
        ).rows[0],
      ).toEqual({
        namespace_sessions: 1,
        proof_sessions: 0,
        attempts: 0,
        snapshots: 0,
        results: 0,
      });
    });
    completedTestCount += 1;
  });

  test("serializes concurrent START, expires by database time, and fences late finalizers", async () => {
    await withSchema(async (client, scoped) => {
      await seedRepositoryStart(client, "race");
      const store = makeControlPlaneNamespaceOwnershipStartStore(
        makeDirectPostgresControlPlaneLayer(scoped),
      );
      const firstInput = repositoryStartInput("race", { ttl_ms: 20 });
      const secondInput = repositoryStartInput("race", {
        reservation_id: "start_reservation_race_second",
        namespace_session_id: "start_session_race_second",
        ttl_ms: 20,
      });
      const outcomes = await Promise.all([
        Effect.runPromise(Effect.scoped(store.reserve(firstInput))),
        Effect.runPromise(Effect.scoped(store.reserve(secondInput))),
      ]);
      expect(outcomes.map(({ kind }) => kind).sort()).toEqual(["acquired", "in_flight"]);
      const acquired = outcomes.find((outcome) => outcome.kind === "acquired");
      if (acquired?.kind !== "acquired") throw new Error("expected one acquired reservation");
      await client.query("SELECT pg_sleep(0.05)");
      const replayInput = {
        actor_id: firstInput.start.actor_id,
        creation_intent_id: firstInput.start.creation_intent_id,
        ceremony_intent_id: firstInput.start.ceremony_intent_id,
        expected_revision: firstInput.expected_revision,
        client_idempotency_key: firstInput.client_idempotency_key,
      };
      expect(await Effect.runPromise(Effect.scoped(store.replay(replayInput)))).toEqual({
        kind: "none",
      });
      const reacquired = await Effect.runPromise(
        Effect.scoped(store.reserve({ ...firstInput, ttl_ms: 6_000 })),
      );
      expect(reacquired).toMatchObject({ kind: "acquired", reservation: { fence_token: 2 } });
      if (reacquired.kind !== "acquired") throw new Error("expected reacquired reservation");
      expect(
        await Effect.runPromise(
          Effect.scoped(store.finalize(acquired.reservation, repositoryStartResult(firstInput))),
        ),
      ).toEqual({ kind: "stale" });
      expect(
        await Effect.runPromise(
          Effect.scoped(store.finalize(reacquired.reservation, repositoryStartResult(firstInput))),
        ),
      ).toMatchObject({ kind: "created" });
      expect(
        (await client.query("SELECT count(*)::int AS count FROM namespace_ownership_sessions"))
          .rows[0]?.count,
      ).toBe(1);
    });
    completedTestCount += 1;
  });

  test("reserves, releases, and reacquires one completion attempt with a stable evidence reference", async () => {
    await withSchema(async (client, scoped) => {
      const { completionStore, completionInput, stored } = await createRepositoryNamespaceSession(
        client,
        scoped,
        "completion_retry",
      );
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completionStore.load({
              actor_id: completionInput.actor_id,
              creation_intent_id: "intent_other",
              ceremony_intent_id: completionInput.ceremony_intent_id,
              session_id: completionInput.session_id,
            }),
          ),
        ),
      ).toBeNull();
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completionStore.reserve({
              ...completionInput,
              creation_intent_id: "intent_other",
            }),
          ),
        ),
      ).toEqual({ kind: "not_found" });
      const first = await Effect.runPromise(
        Effect.scoped(completionStore.reserve(completionInput)),
      );
      expect(first).toMatchObject({ kind: "acquired", reservation: { fence_token: 1 } });
      if (first.kind !== "acquired") throw new Error("expected completion reservation");
      expect(
        await Effect.runPromise(Effect.scoped(completionStore.reserve(completionInput))),
      ).toMatchObject({ kind: "in_flight" });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completionStore.release({
              actor_id: stored.session.actor_id,
              expected: stored,
              idempotency_key: completionInput.idempotency_key,
              completion_request_hash: completionInput.completion_request_hash,
              expired_result_hash: completionInput.expired_result_hash,
              attempt: first.reservation,
            }),
          ),
        ),
      ).toEqual({ kind: "released" });
      const reacquired = await Effect.runPromise(
        Effect.scoped(
          completionStore.reserve({
            ...completionInput,
            completion_attempt_id: "ignored_new_attempt_id",
            evidence_ref: "ignored_new_evidence_ref",
          }),
        ),
      );
      expect(reacquired).toMatchObject({
        kind: "acquired",
        reservation: {
          fence_token: 2,
          completion_attempt_id: first.reservation.completion_attempt_id,
          evidence_ref: first.reservation.evidence_ref,
        },
      });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completionStore.reserve({
              ...completionInput,
              completion_request_hash: SHA_C,
            }),
          ),
        ),
      ).toEqual({ kind: "idempotency_conflict" });
    });
    completedTestCount += 1;
  });

  test("terminally expires the exact attempt when release crosses the session deadline", async () => {
    await withSchema(async (client, scoped) => {
      const expiresAt = new Date(Date.now() + 4_000).toISOString();
      const { completionStore, completionInput, stored } = await createRepositoryNamespaceSession(
        client,
        scoped,
        "release_after_expiry",
        { ttl_ms: 1_000, expires_at: expiresAt },
      );
      const reserved = await Effect.runPromise(
        Effect.scoped(completionStore.reserve({ ...completionInput, lease_ms: 1_100 })),
      );
      if (reserved.kind !== "acquired") throw new Error("expected completion reservation");
      await client.query("SELECT pg_sleep(4.1)");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completionStore.release({
              actor_id: stored.session.actor_id,
              expected: stored,
              idempotency_key: completionInput.idempotency_key,
              completion_request_hash: completionInput.completion_request_hash,
              expired_result_hash: completionInput.expired_result_hash,
              attempt: reserved.reservation,
            }),
          ),
        ),
      ).toEqual({ kind: "expired", result_hash: SHA_B });
      expect(
        (
          await client.query(
            `SELECT
               (SELECT state FROM namespace_ownership_completion_attempts LIMIT 1)
                 AS attempt_state,
               (SELECT consumption_kind FROM namespace_ownership_completion_attempts LIMIT 1)
                 AS consumption_kind,
               (SELECT completion_attempt_id FROM community_creation_ceremony_results LIMIT 1)
                 AS result_attempt,
               (SELECT status FROM namespace_ownership_sessions LIMIT 1) AS session_status,
               (SELECT status FROM community_creation_requirement_states
                 WHERE requirement_kind = 'namespace_ownership' LIMIT 1) AS requirement_status`,
          )
        ).rows[0],
      ).toEqual({
        attempt_state: "consumed",
        consumption_kind: "expired",
        result_attempt: reserved.reservation.completion_attempt_id,
        session_status: "expired",
        requirement_status: "expired",
      });
    });
    completedTestCount += 1;
  });

  test("loses an expired completion lease before evidence is persisted", async () => {
    await withSchema(async (client, scoped) => {
      const { completionStore, completionInput, stored } = await createRepositoryNamespaceSession(
        client,
        scoped,
        "lease_boundary",
      );
      const requestInput = { ...completionInput, lease_ms: 1_100 };
      const reserved = await Effect.runPromise(
        Effect.scoped(completionStore.reserve(requestInput)),
      );
      if (reserved.kind !== "acquired") throw new Error("expected completion reservation");
      await client.query("SELECT pg_sleep(1.2)");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completionStore.verify(
              verifiedCompletionInput(stored, reserved.reservation, requestInput),
            ),
          ),
        ),
      ).toEqual({ kind: "lease_lost" });
      expect(
        (
          await client.query(
            `SELECT
               (SELECT state FROM namespace_ownership_completion_attempts LIMIT 1)
                 AS attempt_state,
               (SELECT count(*)::int FROM namespace_ownership_evidence_snapshots) AS snapshots,
               (SELECT count(*)::int FROM community_creation_ceremony_results) AS results,
               (SELECT count(*)::int FROM community_route_ownership_evidence) AS route_evidence`,
          )
        ).rows[0],
      ).toEqual({ attempt_state: "released", snapshots: 0, results: 0, route_evidence: 0 });
    });
    completedTestCount += 1;
  });

  test("atomically verifies a completion and replays one immutable snapshot and route evidence", async () => {
    await withSchema(async (client, scoped) => {
      const { completionStore, completionInput, stored } = await createRepositoryNamespaceSession(
        client,
        scoped,
        "verified",
      );
      const reserved = await Effect.runPromise(
        Effect.scoped(completionStore.reserve(completionInput)),
      );
      if (reserved.kind !== "acquired") throw new Error("expected completion reservation");
      const verified = verifiedCompletionInput(stored, reserved.reservation, completionInput);
      expect(await Effect.runPromise(Effect.scoped(completionStore.verify(verified)))).toEqual({
        kind: "committed",
        result_hash: SHA_C,
      });
      expect(await Effect.runPromise(Effect.scoped(completionStore.verify(verified)))).toEqual({
        kind: "replay",
        status: "verified",
        result_hash: SHA_C,
      });
      const rows = (
        await client.query(
          `SELECT
             (SELECT count(*)::int FROM namespace_ownership_evidence_snapshots) AS snapshots,
             (SELECT count(*)::int FROM community_route_ownership_evidence) AS route_evidence,
             (SELECT count(*)::int FROM community_creation_ceremony_results) AS results,
             (SELECT status FROM namespace_ownership_sessions LIMIT 1) AS session_status,
             (SELECT status FROM community_creation_requirement_states
               WHERE requirement_kind = 'namespace_ownership' LIMIT 1) AS requirement_status,
             (SELECT state FROM namespace_ownership_completion_attempts LIMIT 1) AS attempt_state`,
        )
      ).rows[0];
      expect(rows).toEqual({
        snapshots: 1,
        route_evidence: 1,
        results: 1,
        session_status: "completed",
        requirement_status: "satisfied",
        attempt_state: "consumed",
      });
      const raw = (
        await client.query<{ raw: Buffer }>(
          "SELECT raw_response_bytes AS raw FROM namespace_ownership_evidence_snapshots",
        )
      ).rows[0]?.raw;
      expect(raw).toEqual(Buffer.from(verified.verified.raw_response_bytes));
    });
    completedTestCount += 1;
  });

  test("atomically verifies parent-chain apex evidence through the persistence trigger", async () => {
    await withSchema(async (client, scoped) => {
      const { completionStore, completionInput, stored } = await createRepositoryNamespaceSession(
        client,
        scoped,
        "parent_chain",
      );
      const reserved = await Effect.runPromise(
        Effect.scoped(completionStore.reserve(completionInput)),
      );
      if (reserved.kind !== "acquired") throw new Error("expected completion reservation");
      const verified = verifiedCompletionInput(
        stored,
        reserved.reservation,
        completionInput,
        "hns_parent_chain_txt",
      );
      expect(await Effect.runPromise(Effect.scoped(completionStore.verify(verified)))).toEqual({
        kind: "committed",
        result_hash: SHA_C,
      });
      expect(
        (
          await client.query<{ ownership_source: string; challenge_name: string }>(
            `SELECT ownership_source, challenge_name
               FROM namespace_ownership_evidence_snapshots`,
          )
        ).rows[0],
      ).toEqual({
        ownership_source: "hns_parent_chain_txt",
        challenge_name: stored.session.route.root_label,
      });
    });
    completedTestCount += 1;
  });

  test("persists rejection without evidence and returns the same terminal replay", async () => {
    await withSchema(async (client, scoped) => {
      const { completionStore, completionInput, stored } = await createRepositoryNamespaceSession(
        client,
        scoped,
        "rejected",
      );
      const reserved = await Effect.runPromise(
        Effect.scoped(completionStore.reserve(completionInput)),
      );
      if (reserved.kind !== "acquired") throw new Error("expected completion reservation");
      const rejected = {
        actor_id: completionInput.actor_id,
        expected: stored,
        idempotency_key: completionInput.idempotency_key,
        completion_request_hash: completionInput.completion_request_hash,
        result_hash: SHA_C,
        expired_result_hash: SHA_B,
        attempt: reserved.reservation,
      } as const;
      expect(await Effect.runPromise(Effect.scoped(completionStore.reject(rejected)))).toEqual({
        kind: "committed",
        result_hash: SHA_C,
      });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completionStore.verify(
              verifiedCompletionInput(stored, reserved.reservation, completionInput),
            ),
          ),
        ),
      ).toEqual({ kind: "replay", status: "rejected", result_hash: SHA_C });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completionStore.reserve({
              ...completionInput,
              idempotency_key: "different-terminal-key",
              completion_attempt_id: "different-terminal-attempt",
              evidence_ref: "different-terminal-evidence",
            }),
          ),
        ),
      ).toEqual({ kind: "idempotency_conflict" });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completionStore.load({
              actor_id: completionInput.actor_id,
              creation_intent_id: completionInput.creation_intent_id,
              ceremony_intent_id: completionInput.ceremony_intent_id,
              session_id: completionInput.session_id,
            }),
          ),
        ),
      ).toMatchObject({
        status: "failed",
        terminal: { status: "rejected", result_hash: SHA_C },
      });
      expect(
        (
          await client.query(
            `SELECT
               (SELECT count(*)::int FROM namespace_ownership_evidence_snapshots) AS snapshots,
               (SELECT count(*)::int FROM community_route_ownership_evidence) AS route_evidence`,
          )
        ).rows[0],
      ).toEqual({ snapshots: 0, route_evidence: 0 });
    });
    completedTestCount += 1;
  });

  test("consumes semantic contradictions without terminal authority and enforces the three-attempt budget", async () => {
    await withSchema(async (client, scoped) => {
      const expiresAt = new Date(Date.now() + 5_000).toISOString();
      const { completionStore, completionInput, stored } = await createRepositoryNamespaceSession(
        client,
        scoped,
        "budget",
        { ttl_ms: 1_000, expires_at: expiresAt },
      );
      for (const [index, requestHash] of [SHA, SHA_B, SHA_C].entries()) {
        const requestInput = {
          ...completionInput,
          idempotency_key: `poll_budget_${index}`,
          completion_request_hash: requestHash,
          completion_attempt_id: `completion_attempt_budget_${index}`,
          evidence_ref: `completion_evidence_budget_${index}`,
          lease_ms: 1_100,
        };
        const reserved = await Effect.runPromise(
          Effect.scoped(completionStore.reserve(requestInput)),
        );
        if (reserved.kind !== "acquired") throw new Error("expected budget reservation");
        expect(
          await Effect.runPromise(
            Effect.scoped(
              completionStore.consume({
                actor_id: completionInput.actor_id,
                expected: stored,
                idempotency_key: requestInput.idempotency_key,
                completion_request_hash: requestInput.completion_request_hash,
                expired_result_hash: SHA_B,
                attempt: reserved.reservation,
              }),
            ),
          ),
        ).toEqual({ kind: "consumed" });
      }
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completionStore.reserve({
              ...completionInput,
              idempotency_key: "poll_budget_fourth",
              completion_attempt_id: "completion_attempt_budget_fourth",
              evidence_ref: "completion_evidence_budget_fourth",
              lease_ms: 1_100,
            }),
          ),
        ),
      ).toEqual({ kind: "budget_exhausted" });
      expect(
        (
          await client.query(
            `SELECT
               (SELECT count(*)::int FROM namespace_ownership_completion_attempts
                 WHERE state = 'consumed') AS consumed,
               (SELECT count(*)::int FROM community_creation_ceremony_results) AS results,
               (SELECT count(*)::int FROM namespace_ownership_evidence_snapshots) AS snapshots`,
          )
        ).rows[0],
      ).toEqual({ consumed: 3, results: 0, snapshots: 0 });
      await client.query("SELECT pg_sleep(5.1)");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            completionStore.reserve({
              ...completionInput,
              idempotency_key: "poll_budget_after_expiry",
              completion_attempt_id: "completion_attempt_budget_after_expiry",
              evidence_ref: "completion_evidence_budget_after_expiry",
              lease_ms: 1_100,
            }),
          ),
        ),
      ).toEqual({ kind: "expired", result_hash: SHA_B });
      expect(
        (
          await client.query(
            `SELECT
               (SELECT count(*)::int FROM community_creation_ceremony_results) AS results,
               (SELECT status FROM namespace_ownership_sessions LIMIT 1) AS session_status,
               (SELECT status FROM community_creation_requirement_states
                 WHERE requirement_kind = 'namespace_ownership' LIMIT 1) AS requirement_status`,
          )
        ).rows[0],
      ).toEqual({ results: 1, session_status: "expired", requirement_status: "expired" });
    });
    completedTestCount += 1;
  }, 10_000);

  test("rolls back every verified projection when the evidence envelope drifts", async () => {
    await withSchema(async (client, scoped) => {
      const { completionStore, completionInput, stored } = await createRepositoryNamespaceSession(
        client,
        scoped,
        "rollback",
      );
      const reserved = await Effect.runPromise(
        Effect.scoped(completionStore.reserve(completionInput)),
      );
      if (reserved.kind !== "acquired") throw new Error("expected completion reservation");
      const verified = verifiedCompletionInput(stored, reserved.reservation, completionInput);
      const drifted = {
        ...verified,
        verified: {
          ...verified.verified,
          envelope: { ...verified.verified.envelope, root_label: "wrong-root" },
        },
      };
      await expect(
        Effect.runPromise(Effect.scoped(completionStore.verify(drifted))),
      ).rejects.toBeInstanceOf(Error);
      expect(
        (
          await client.query(
            `SELECT
               (SELECT state FROM namespace_ownership_completion_attempts LIMIT 1) AS attempt_state,
               (SELECT status FROM namespace_ownership_sessions LIMIT 1) AS session_status,
               (SELECT status FROM community_creation_requirement_states
                 WHERE requirement_kind = 'namespace_ownership' LIMIT 1) AS requirement_status,
               (SELECT count(*)::int FROM namespace_ownership_evidence_snapshots) AS snapshots,
               (SELECT count(*)::int FROM community_creation_ceremony_results) AS results,
               (SELECT count(*)::int FROM community_route_ownership_evidence) AS route_evidence`,
          )
        ).rows[0],
      ).toEqual({
        attempt_state: "leased",
        session_status: "pending",
        requirement_status: "pending",
        snapshots: 0,
        results: 0,
        route_evidence: 0,
      });
    });
    completedTestCount += 1;
  });

  test("terminally expires by database time before admitting a completion attempt", async () => {
    await withSchema(async (client, scoped) => {
      const expiresAt = new Date(Date.now() + 3_000).toISOString();
      const { completionStore, completionInput } = await createRepositoryNamespaceSession(
        client,
        scoped,
        "expired_before_reserve",
        { ttl_ms: 1_000, expires_at: expiresAt },
      );
      await client.query("SELECT pg_sleep(3.1)");
      expect(
        await Effect.runPromise(Effect.scoped(completionStore.reserve(completionInput))),
      ).toEqual({ kind: "expired", result_hash: SHA_B });
      expect(
        (
          await client.query(
            `SELECT
               (SELECT count(*)::int FROM namespace_ownership_completion_attempts) AS attempts,
               (SELECT completion_attempt_id FROM community_creation_ceremony_results LIMIT 1)
                 AS result_attempt,
               (SELECT status FROM namespace_ownership_sessions LIMIT 1) AS session_status,
               (SELECT status FROM community_creation_requirement_states
                 WHERE requirement_kind = 'namespace_ownership' LIMIT 1) AS requirement_status`,
          )
        ).rows[0],
      ).toEqual({
        attempts: 0,
        result_attempt: null,
        session_status: "expired",
        requirement_status: "expired",
      });
    });
    completedTestCount += 1;
  }, 10_000);

  test("persists one complete scheduler-owned route revalidation evidence chain", async () => {
    await withSchema(async (client) => {
      await seedActiveRevalidationRoute(client, "revalidation_valid");
      await insertRevalidationSession(client, "revalidation_valid");
      await insertRevalidationAttempt(client, "revalidation_valid");
      await finalizeRevalidationEvidence(client, "revalidation_valid");
      expect(
        (
          await client.query(
            `SELECT
               evidence.origin,
               evidence.creation_ceremony_intent_id,
               evidence.verified_by_actor_id,
               evidence.route_revalidation_attempt_id,
               evidence.binding_generation::int,
               snapshot.principal_kind,
               snapshot.principal_id,
               encode(sha256(snapshot.raw_response_bytes), 'hex') =
                 snapshot.observation_sha256 AS raw_hash_matches,
               snapshot.observation #>> '{observation,provider_evidence_ref}'
                 AS provider_evidence_ref,
               binding.binding_generation::int AS live_generation,
               binding.verified_evidence_ref
             FROM community_route_ownership_evidence AS evidence
             JOIN community_route_revalidation_evidence_snapshots AS snapshot
               ON snapshot.evidence_ref = evidence.evidence_ref
             JOIN community_canonical_route_bindings AS binding
               ON binding.route_binding_id = snapshot.route_binding_id
            WHERE evidence.evidence_ref = $1`,
            ["revalidation_evidence_revalidation_valid"],
          )
        ).rows[0],
      ).toEqual({
        origin: "route_revalidation",
        creation_ceremony_intent_id: null,
        verified_by_actor_id: null,
        route_revalidation_attempt_id: "revalidation_attempt_revalidation_valid",
        binding_generation: 2,
        principal_kind: "system",
        principal_id: "route-revalidation-scheduler",
        raw_hash_matches: true,
        provider_evidence_ref: "provider-revalidation-revalidation_valid",
        live_generation: 2,
        verified_evidence_ref: "revalidation_evidence_revalidation_valid",
      });
    });
    completedTestCount += 1;
  });

  test("rejects crossed evidence origins and substituted revalidation authority", async () => {
    await withSchema(async (client) => {
      await seedActiveRevalidationRoute(client, "revalidation_origin");
      await insertRevalidationSession(client, "revalidation_origin");
      await insertRevalidationAttempt(client, "revalidation_origin");
      await failure(
        client,
        `INSERT INTO community_route_ownership_evidence (
           evidence_ref, origin, creation_ceremony_intent_id,
           route_revalidation_attempt_id, verified_by_actor_id, family,
           root_label, root_label_display, path_segment, requirement_hash,
           provider_id, provider_binding_hash, provider_configuration_version,
           provider_identity_digest, evidence_digest, binding_generation,
           verified_at, expires_at
         ) VALUES ('crossed-origin', 'route_revalidation', $1, $2, $3, 'hns',
           'example_root', 'example_root', 'app.example_root', $4,
           'namespace-provider', $5, 'v1', $6, $7, 2,
           clock_timestamp(), clock_timestamp() + interval '1 hour')`,
        [
          "ceremony_revalidation_origin",
          "revalidation_attempt_revalidation_origin",
          "actor_revalidation_origin",
          SHA,
          SHA_C,
          SHA_B,
          SHA_C,
        ],
      );
      await failure(
        client,
        `UPDATE community_route_revalidation_sessions
            SET provider_configuration_reference = 'substituted'
          WHERE revalidation_session_id = $1`,
        ["revalidation_session_revalidation_origin"],
      );
    });
    completedTestCount += 1;
  });

  test("enforces reservation, session, attempt fences and append-only authority", async () => {
    await withSchema(async (client) => {
      await seedActiveRevalidationRoute(client, "revalidation_fence");
      await insertRevalidationSession(client, "revalidation_fence");
      await insertRevalidationAttempt(client, "revalidation_fence");
      await failure(
        client,
        `UPDATE community_route_revalidation_start_reservations
            SET principal_id = 'other-scheduler'
          WHERE route_revalidation_id = $1`,
        ["route_revalidation_revalidation_fence"],
      );
      await failure(
        client,
        `UPDATE community_route_revalidation_completion_attempts
            SET fence_token = 2
          WHERE route_revalidation_attempt_id = $1`,
        ["revalidation_attempt_revalidation_fence"],
      );
      await failure(
        client,
        `INSERT INTO community_route_revalidation_completion_attempts (
           route_revalidation_attempt_id, route_revalidation_id,
           revalidation_session_id, route_binding_id,
           expected_binding_generation, expected_verified_evidence_ref,
           attempt_number, idempotency_key, completion_request_hash,
           evidence_ref, state, fence_token, lease_expires_at
         ) VALUES ('second-leased', $1, $2, $3, 1, $4, 2, 'second-key',
           $5, 'second-evidence', 'leased', 1,
           clock_timestamp() + interval '15 seconds')`,
        [
          "route_revalidation_revalidation_fence",
          "revalidation_session_revalidation_fence",
          "route_binding_revalidation_fence",
          "evidence_revalidation_fence",
          SHA,
        ],
      );
    });
    completedTestCount += 1;
  });

  test("consumes a negative revalidation without evidence and admits only fresh-generation recovery", async () => {
    await withSchema(async (client) => {
      await seedActiveRevalidationRoute(client, "revalidation_negative");
      await insertRevalidationSession(client, "revalidation_negative");
      await insertRevalidationAttempt(client, "revalidation_negative");
      await client.query("BEGIN");
      await client.query(
        `UPDATE community_canonical_route_bindings
            SET binding_generation = 2, verified_evidence_ref = NULL,
                ownership_status = 'revoked', route_lifecycle_status = 'suspended',
                updated_at = clock_timestamp()
          WHERE route_binding_id = $1`,
        ["route_binding_revalidation_negative"],
      );
      await client.query(
        `UPDATE community_route_revalidation_completion_attempts
            SET state = 'consumed', consumption_kind = 'missing_root',
                result_hash = $1, terminal_at = clock_timestamp()
          WHERE route_revalidation_attempt_id = $2`,
        [SHA, "revalidation_attempt_revalidation_negative"],
      );
      await client.query(
        `UPDATE community_route_revalidation_sessions
            SET status = 'completed', terminal_at = clock_timestamp()
          WHERE revalidation_session_id = $1`,
        ["revalidation_session_revalidation_negative"],
      );
      await client.query("COMMIT");
      expect(
        (
          await client.query(
            `SELECT
               (SELECT count(*)::int
                  FROM community_route_revalidation_evidence_snapshots) AS snapshots,
               (SELECT count(*)::int
                  FROM community_route_ownership_evidence
                 WHERE origin = 'route_revalidation') AS route_evidence,
               (SELECT consumption_kind
                  FROM community_route_revalidation_completion_attempts
                 WHERE route_revalidation_attempt_id = $1) AS consumption_kind`,
            ["revalidation_attempt_revalidation_negative"],
          )
        ).rows[0],
      ).toEqual({ snapshots: 0, route_evidence: 0, consumption_kind: "missing_root" });
      await failure(
        client,
        `UPDATE community_route_revalidation_completion_attempts
            SET result_hash = $1
          WHERE route_revalidation_attempt_id = $2`,
        [SHA_B, "revalidation_attempt_revalidation_negative"],
      );
      await client.query(
        `INSERT INTO community_route_revalidation_start_reservations (
           route_revalidation_id, revalidation_session_id, community_id,
           route_binding_id, principal_kind, principal_id,
           expected_binding_generation, expected_verified_evidence_ref,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_reference,
           provider_configuration_version, protocol_version, environment,
           family, root_label, root_label_display, path_segment,
           start_request_hash, state, fence_token, lease_expires_at
         ) VALUES ($1, $2, $3, $4, 'system', 'route-revalidation-scheduler',
           2, NULL, $5, 'namespace-provider', $6, 'managed', 'namespace-config',
           'v1', 'hns-txt-v1', 'test', 'hns', 'example_root', 'example_root',
           'app.example_root', $7, 'acquired', 1,
           clock_timestamp() + interval '15 seconds')`,
        [
          "route_revalidation_negative_recovery",
          "revalidation_session_negative_recovery",
          "community_revalidation_negative",
          "route_binding_revalidation_negative",
          SHA_B,
          SHA_C,
          SHA,
        ],
      );
      expect(
        (
          await client.query(
            `SELECT expected_binding_generation::int, expected_verified_evidence_ref
               FROM community_route_revalidation_start_reservations
              WHERE route_revalidation_id = $1`,
            ["route_revalidation_negative_recovery"],
          )
        ).rows[0],
      ).toEqual({ expected_binding_generation: 2, expected_verified_evidence_ref: null });
    });
    completedTestCount += 1;
  });

  test("rejects a fabricated revalidation snapshot and rolls back the authority transition", async () => {
    await withSchema(async (client) => {
      await seedActiveRevalidationRoute(client, "revalidation_fabricated");
      await insertRevalidationSession(client, "revalidation_fabricated");
      await insertRevalidationAttempt(client, "revalidation_fabricated");
      await expect(
        finalizeRevalidationEvidence(client, "revalidation_fabricated", {
          corruptRawResponse: true,
        }),
      ).rejects.toThrow("route revalidation snapshot observation is incomplete or inconsistent");
      await client.query("ROLLBACK");
      expect(
        (
          await client.query(
            `SELECT
               binding.binding_generation::int,
               binding.verified_evidence_ref,
               session.status AS session_status,
               attempt.state AS attempt_state,
               (SELECT count(*)::int
                  FROM community_route_revalidation_evidence_snapshots) AS snapshots
             FROM community_canonical_route_bindings AS binding
             JOIN community_route_revalidation_sessions AS session
               ON session.route_binding_id = binding.route_binding_id
             JOIN community_route_revalidation_completion_attempts AS attempt
               ON attempt.revalidation_session_id = session.revalidation_session_id
            WHERE binding.route_binding_id = $1`,
            ["route_binding_revalidation_fabricated"],
          )
        ).rows[0],
      ).toEqual({
        binding_generation: 1,
        verified_evidence_ref: "evidence_revalidation_fabricated",
        session_status: "pending",
        attempt_state: "leased",
        snapshots: 0,
      });
    });
    completedTestCount += 1;
  });

  test("rejects a poll challenge that does not match the persisted start presentation", async () => {
    await withSchema(async (client) => {
      await seedActiveRevalidationRoute(client, "revalidation_challenge_mismatch");
      await insertRevalidationSession(client, "revalidation_challenge_mismatch");
      await insertRevalidationAttempt(client, "revalidation_challenge_mismatch");
      await expect(
        finalizeRevalidationEvidence(client, "revalidation_challenge_mismatch", {
          challengeValueOverride: "pirate-verification=substituted-upstream-session",
        }),
      ).rejects.toThrow("route revalidation snapshot observation is incomplete or inconsistent");
      await client.query("ROLLBACK");
      expect(
        (
          await client.query(
            `SELECT binding.binding_generation::int,
                    session.status AS session_status,
                    attempt.state AS attempt_state,
                    (SELECT count(*)::int
                       FROM community_route_revalidation_evidence_snapshots) AS snapshots
               FROM community_canonical_route_bindings AS binding
               JOIN community_route_revalidation_sessions AS session
                 ON session.route_binding_id = binding.route_binding_id
               JOIN community_route_revalidation_completion_attempts AS attempt
                 ON attempt.revalidation_session_id = session.revalidation_session_id
              WHERE binding.route_binding_id = $1`,
            ["route_binding_revalidation_challenge_mismatch"],
          )
        ).rows[0],
      ).toEqual({
        binding_generation: 1,
        session_status: "pending",
        attempt_state: "leased",
        snapshots: 0,
      });
    });
    completedTestCount += 1;
  });

  test("rejects a terminal session whose status contradicts its consumed outcome", async () => {
    await withSchema(async (client) => {
      await seedActiveRevalidationRoute(client, "revalidation_outcome_mismatch");
      await insertRevalidationSession(client, "revalidation_outcome_mismatch");
      await insertRevalidationAttempt(client, "revalidation_outcome_mismatch");
      await client.query("BEGIN");
      await client.query(
        `UPDATE community_route_revalidation_completion_attempts
            SET state = 'consumed', consumption_kind = 'missing_root',
                result_hash = $1, terminal_at = clock_timestamp()
          WHERE route_revalidation_attempt_id = $2`,
        [SHA, "revalidation_attempt_revalidation_outcome_mismatch"],
      );
      await client.query(
        `UPDATE community_route_revalidation_sessions
            SET status = 'failed', terminal_at = clock_timestamp()
          WHERE revalidation_session_id = $1`,
        ["revalidation_session_revalidation_outcome_mismatch"],
      );
      await expect(client.query("COMMIT")).rejects.toThrow(
        "route revalidation session status contradicts its consumed outcome",
      );
      await client.query("ROLLBACK");
      expect(
        (
          await client.query(
            `SELECT session.status AS session_status, attempt.state AS attempt_state
               FROM community_route_revalidation_sessions AS session
               JOIN community_route_revalidation_completion_attempts AS attempt
                 ON attempt.revalidation_session_id = session.revalidation_session_id
              WHERE session.revalidation_session_id = $1`,
            ["revalidation_session_revalidation_outcome_mismatch"],
          )
        ).rows[0],
      ).toEqual({ session_status: "pending", attempt_state: "leased" });
    });
    completedTestCount += 1;
  });

  test("reacquires an expired start reservation with the next fence", async () => {
    await withSchema(async (client) => {
      await seedActiveRevalidationRoute(client, "revalidation_start_reacquire");
      await client.query(
        `INSERT INTO community_route_revalidation_start_reservations (
           route_revalidation_id, revalidation_session_id, community_id,
           route_binding_id, principal_kind, principal_id,
           expected_binding_generation, expected_verified_evidence_ref,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_reference,
           provider_configuration_version, protocol_version, environment,
           family, root_label, root_label_display, path_segment,
           start_request_hash, state, fence_token, lease_expires_at
         ) VALUES ($1, $2, $3, $4, 'system', 'route-revalidation-scheduler',
           1, $5, $6, 'namespace-provider', $7, 'managed', 'namespace-config',
           'v1', 'hns-txt-v1', 'test', 'hns', 'example_root', 'example_root',
           'app.example_root', $8, 'acquired', 1,
           clock_timestamp() + interval '100 milliseconds')`,
        [
          "route_revalidation_start_reacquire",
          "revalidation_session_start_reacquire",
          "community_revalidation_start_reacquire",
          "route_binding_revalidation_start_reacquire",
          "evidence_revalidation_start_reacquire",
          SHA,
          SHA_C,
          SHA_B,
        ],
      );
      await client.query("SELECT pg_sleep(0.15)");
      await client.query(
        `UPDATE community_route_revalidation_start_reservations
            SET state = 'acquired', fence_token = 2,
                lease_expires_at = clock_timestamp() + interval '15 seconds'
          WHERE route_revalidation_id = $1`,
        ["route_revalidation_start_reacquire"],
      );
      expect(
        (
          await client.query(
            `SELECT state, fence_token::int
               FROM community_route_revalidation_start_reservations
              WHERE route_revalidation_id = $1`,
            ["route_revalidation_start_reacquire"],
          )
        ).rows[0],
      ).toEqual({ state: "acquired", fence_token: 2 });
    });
    completedTestCount += 1;
  });

  test("runs route-revalidation START reserve, finalize, and exact replay", async () => {
    await withSchema(async (client, scoped) => {
      await seedActiveRevalidationRoute(client, "route_start_repository");
      const store = makeControlPlaneRouteRevalidationStartStore(
        makeDirectPostgresControlPlaneLayer(scoped),
      );
      const input = routeRevalidationStartInput("route_start_repository");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.replay({
              route_revalidation_id: input.authority.route_revalidation_id,
              revalidation_session_id: input.revalidation_session_id,
              start_request_hash: input.start_request_hash,
            }),
          ),
        ),
      ).toEqual({ kind: "none" });
      const reserved = await Effect.runPromise(Effect.scoped(store.reserve(input)));
      expect(reserved.kind).toBe("acquired");
      if (reserved.kind !== "acquired") throw new Error("expected route START reservation");
      const finalized = await Effect.runPromise(
        Effect.scoped(store.finalize(reserved.reservation, routeRevalidationStartResult(input))),
      );
      expect(finalized.kind).toBe("created");
      const replayed = await Effect.runPromise(
        Effect.scoped(
          store.replay({
            route_revalidation_id: input.authority.route_revalidation_id,
            revalidation_session_id: input.revalidation_session_id,
            start_request_hash: input.start_request_hash,
          }),
        ),
      );
      expect(replayed).toMatchObject({ kind: "replay" });
      expect(
        (
          await client.query(
            `SELECT
               (SELECT count(*)::int
                  FROM community_route_revalidation_start_reservations) AS reservations,
               (SELECT count(*)::int
                  FROM community_route_revalidation_sessions) AS sessions`,
          )
        ).rows[0],
      ).toEqual({ reservations: 1, sessions: 1 });
    });
    completedTestCount += 1;
  });

  test("rejects route START authority conflicts and fences a late finalizer", async () => {
    await withSchema(async (client, scoped) => {
      await seedActiveRevalidationRoute(client, "route_start_fence");
      const store = makeControlPlaneRouteRevalidationStartStore(
        makeDirectPostgresControlPlaneLayer(scoped),
      );
      const input = routeRevalidationStartInput("route_start_fence", { ttl_ms: 100 });
      const reserved = await Effect.runPromise(Effect.scoped(store.reserve(input)));
      expect(reserved.kind).toBe("acquired");
      if (reserved.kind !== "acquired") throw new Error("expected route START reservation");
      const conflict = await Effect.runPromise(
        Effect.scoped(
          store.reserve({
            ...input,
            revalidation_session_id: "conflicting-session",
            start_request_hash: SHA,
          }),
        ),
      );
      expect(conflict).toEqual({ kind: "conflict" });
      await client.query("SELECT pg_sleep(0.2)");
      const reacquired = await Effect.runPromise(
        Effect.scoped(store.reserve({ ...input, ttl_ms: 6_000 })),
      );
      expect(reacquired).toMatchObject({ kind: "acquired", reservation: { fence_token: 2 } });
      if (reacquired.kind !== "acquired") throw new Error("expected route START reacquisition");
      expect(
        await Effect.runPromise(
          Effect.scoped(store.finalize(reserved.reservation, routeRevalidationStartResult(input))),
        ),
      ).toEqual({ kind: "stale" });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.finalize(reacquired.reservation, routeRevalidationStartResult(input)),
          ),
        ),
      ).toMatchObject({ kind: "created" });
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === namespacePersistenceTestCount) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
