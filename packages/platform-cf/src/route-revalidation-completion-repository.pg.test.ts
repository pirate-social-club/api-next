import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  HnsRouteRevalidationCompletionAttemptReservation,
  HnsRouteRevalidationCompletionStore,
  HnsRouteRevalidationStoredCompletion,
} from "@pirate/application/route-revalidation";
import {
  hnsRouteRevalidationResultHash,
  hnsRouteRevalidationResultPreimage,
} from "@pirate/application/route-revalidation";
import { Effect } from "effect";
import { Client } from "pg";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";
import { applyPostgresMigrations, type PostgresMigration } from "./postgres-migrations";
import { makeControlPlaneRouteRevalidationCompletionStore } from "./route-revalidation-completion-repository";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;

const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const migrationFiles = [
  "0001_v1_product_slice.sql",
  "0002_identity.sql",
  "0003_m2_community_content.sql",
  "0004_post_comment_lock.sql",
  "0005_m2_behavior_invariants.sql",
  "0006_public_profile_handle_index.sql",
  "0007_public_profile_handle_invariants.sql",
  "0008_community_route_slug.sql",
  "0009_gates_v2_foundation.sql",
  "0010_proof_session_provenance.sql",
  "0011_verification_start_reservations.sql",
  "0012_verification_completion_attempts.sql",
  "0013_m3_community_purchase_funding_journal.sql",
  "0014_m3_community_purchase_funding_plans.sql",
  "0015_identity_credentials.sql",
  "0016_identity_credential_invariants.sql",
  "0017_identity_credential_delete_guard.sql",
  "0018_m3_funding_dormancy_and_retention.sql",
  "0019_m3_reconciliation_attempts.sql",
  "0020_m3_reconciliation_finalization.sql",
  "0021_m3_community_purchase_commerce.sql",
  "0022_m3_community_purchase_immutability.sql",
  "0023_community_creation_intents.sql",
  "0024_community_creation_preflight_transition.sql",
  "0025_community_creation_storage_identity.sql",
  "0026_text_moderation_foundation.sql",
  "0027_community_routes_and_creation_requirements.sql",
  "0028_community_creation_requirement_result_guard.sql",
  "0029_namespace_ownership_persistence.sql",
  "0030_namespace_ownership_completion_expiry.sql",
  "0031_community_creation_route_contract.sql",
  "0032_route_authority_version.sql",
  "0033_namespace_ownership_challenge_topologies.sql",
  "0034_effective_active_route.sql",
  "0035_route_revalidation_persistence.sql",
  "0036_route_revalidation_completion_outcome_guard.sql",
] as const;
const migrations: readonly PostgresMigration[] = await Promise.all(
  migrationFiles.map(async (version) => {
    const sql = await Bun.file(
      new URL(`../../../db/postgres/migrations/${version}`, import.meta.url),
    ).text();
    return { version, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }),
);

function schemaName(): string {
  return `api_next_completion_${crypto.randomUUID().replaceAll("-", "")}`;
}
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function scopedConnection(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (client: Client, connection: string) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("Postgres test configuration is unavailable");
  const schema = schemaName();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  try {
    const connection = scopedConnection(connectionString, schema);
    await Effect.runPromise(
      Effect.scoped(
        applyPostgresMigrations(migrations).pipe(
          Effect.provide(makeDirectPostgresControlPlaneLayer(connection)),
        ),
      ),
    );
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    return await use(admin, connection);
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function seedNamespaceAuthority(client: Client, suffix: string): Promise<void> {
  await client.query("INSERT INTO users (user_id) VALUES ($1)", [`actor_${suffix}`]);
  await client.query(
    `INSERT INTO community_creation_intents (
    intent_id, actor_id, create_idempotency_key, create_request_hash, revision, status, draft,
    canonical_policy_revision, canonical_policy_hash, verification_requirement_hash,
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
    'managed', 'namespace-config', 'v1', 'hns', 'example_root', 'example_root', 'app.example_root')`,
    [`intent_${suffix}`, `actor_${suffix}`, SHA_B, SHA_C],
  );
  await client.query(
    `INSERT INTO community_creation_ceremony_attempts (
    ceremony_intent_id, actor_id, intent_id, requirement_kind, generation, requirement_hash,
    provider_id, provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
    provider_configuration_version, route_family, route_root_label, route_root_label_display,
    route_path_segment, reservation_request_hash, reservation_request, expires_at
  ) VALUES ($1, $2, $3, 'namespace_ownership', 1, $4, 'namespace-provider', $5,
    'managed', 'namespace-config', 'v1', 'hns', 'example_root', 'example_root', 'app.example_root',
    $6, '{}'::jsonb, clock_timestamp() + interval '1 hour')`,
    [`ceremony_${suffix}`, `actor_${suffix}`, `intent_${suffix}`, SHA_B, SHA_C, SHA],
  );
  await client.query(
    `UPDATE community_creation_requirement_states
    SET status = 'pending', generation = 1, current_ceremony_intent_id = $1, updated_at = clock_timestamp()
    WHERE intent_id = $2 AND requirement_kind = 'namespace_ownership'`,
    [`ceremony_${suffix}`, `intent_${suffix}`],
  );
}

async function seedNamespaceSession(client: Client, suffix: string): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO namespace_ownership_start_reservations (
    reservation_id, namespace_session_id, actor_id, creation_intent_id, ceremony_intent_id,
    generation, requirement_hash, expected_revision, client_idempotency_key, request_hash,
    provider_id, provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
    provider_configuration_version, protocol_version, environment, route_family, route_root_label,
    route_root_label_display, route_path_segment, route_href, route_app_host, state, fence_token,
    lease_expires_at
  ) VALUES ($1, $2, $3, $4, $5, 1, $6, 1, $7, $8, 'namespace-provider', $9,
    'managed', 'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns', 'example_root',
    'example_root', 'app.example_root', '/c/app.example_root', NULL, 'acquired', 1,
    clock_timestamp() + interval '30 minutes')`,
    [
      `namespace_start_${suffix}`,
      `namespace_session_${suffix}`,
      `actor_${suffix}`,
      `intent_${suffix}`,
      `ceremony_${suffix}`,
      SHA_B,
      `start-key-${suffix}`,
      SHA_C,
      SHA_C,
    ],
  );
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  await client.query(
    `INSERT INTO namespace_ownership_sessions (
    namespace_session_id, actor_id, creation_intent_id, ceremony_intent_id, start_reservation_id,
    start_fence_token, expected_revision, generation, requirement_hash, request_hash, provider_id,
    provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
    provider_configuration_version, protocol_version, environment, route_family, route_root_label,
    route_root_label_display, route_path_segment, route_href, route_app_host, upstream_session_ref,
    presentation_kind, presentation_payload, status, started_at, expires_at
  ) VALUES ($1, $2, $3, $4, $5, 1, 1, 1, $6, $7, 'namespace-provider', $8, 'managed',
    'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns', 'example_root', 'example_root',
    'app.example_root', '/c/app.example_root', NULL, $9, 'poll', '{"session_id":"provider-session"}'::jsonb,
    'pending', clock_timestamp() - interval '1 minute', $10)`,
    [
      `namespace_session_${suffix}`,
      `actor_${suffix}`,
      `intent_${suffix}`,
      `ceremony_${suffix}`,
      `namespace_start_${suffix}`,
      SHA_B,
      SHA_C,
      SHA_C,
      `upstream_${suffix}`,
      expires,
    ],
  );
  await client.query(
    `UPDATE namespace_ownership_start_reservations SET state = 'finalized'
    WHERE reservation_id = $1`,
    [`namespace_start_${suffix}`],
  );
  await client.query("COMMIT");
  await client.query(
    `INSERT INTO namespace_ownership_completion_attempts (
    completion_attempt_id, namespace_session_id, actor_id, idempotency_key, evidence_ref,
    completion_request_hash, submission_channel, state, fence_token, lease_expires_at
  ) VALUES ($1, $2, $3, $4, $5, $6, 'poll_result', 'leased', 1,
    clock_timestamp() + interval '15 minutes')`,
    [
      `namespace_completion_${suffix}`,
      `namespace_session_${suffix}`,
      `actor_${suffix}`,
      `namespace-key-${suffix}`,
      `evidence_${suffix}`,
      SHA,
    ],
  );
  const observed = new Date(Date.now() - 60_000).toISOString();
  const expiresEvidence = new Date(Date.now() + 3_600_000).toISOString();
  const raw = Buffer.from('{"status":"verified"}', "utf8");
  const rawHash = createHash("sha256").update(raw).digest("hex");
  await client.query("BEGIN");
  await client.query(
    `UPDATE namespace_ownership_completion_attempts
    SET state = 'consumed', consumption_kind = 'verified', updated_at = clock_timestamp()
    WHERE completion_attempt_id = $1`,
    [`namespace_completion_${suffix}`],
  );
  await client.query(
    `INSERT INTO namespace_ownership_evidence_snapshots (
    evidence_ref, completion_attempt_id, namespace_session_id, actor_id, creation_intent_id,
    ceremony_intent_id, generation, requirement_hash, request_hash, provider_id, provider_binding_hash,
    provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
    protocol_version, environment, family, root_label, root_label_display, path_segment,
    href, app_host, upstream_session_ref, fence_token, abi_version, ownership_source,
    challenge_name, challenge_value_sha256, root_exists, root_control_verified, expiry_horizon_sufficient,
    chain_network, chain_anchor_height, chain_anchor_block_hash, chain_anchor_median_time, expiry_height,
    observed_at, expires_at, provider_evidence_ref, observation_sha256, provider_identity_digest,
    evidence_digest, observation, raw_response_bytes
  ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, 'namespace-provider', $9, 'managed', 'namespace-config',
    'v1', 'hns-txt-v1', 'test', 'hns', 'example_root', 'example_root', 'app.example_root',
    '/c/app.example_root', NULL, $10, 1, 'pirate-hns-ownership-evidence-v1', 'owner_authoritative_dns_txt',
    '_pirate.example_root', $11, TRUE, TRUE, TRUE, 'hns-testnet', 10, $12, 100, 20, $13, $14,
    'provider-observation', $15, $16, $17, '{"status":"verified"}'::jsonb, $18)`,
    [
      `evidence_${suffix}`,
      `namespace_completion_${suffix}`,
      `namespace_session_${suffix}`,
      `actor_${suffix}`,
      `intent_${suffix}`,
      `ceremony_${suffix}`,
      SHA_B,
      SHA_C,
      SHA_C,
      `upstream_${suffix}`,
      SHA,
      SHA_B,
      observed,
      expiresEvidence,
      rawHash,
      SHA_B,
      SHA_C,
      raw,
    ],
  );
  const terminal = new Date(Date.now() - 10_000).toISOString();
  await client.query(
    `INSERT INTO community_creation_ceremony_results (
    ceremony_intent_id, actor_id, intent_id, requirement_kind, generation, requirement_hash,
    provider_id, provider_binding_hash, provider_configuration_version, callback_idempotency_key,
    callback_request_hash, outcome_status, result_hash, evidence_ref, evidence_digest,
    provider_identity_digest, terminal_at, satisfied_at, namespace_session_id, completion_attempt_id,
    submission_channel
  ) VALUES ($1, $2, $3, 'namespace_ownership', 1, $4, 'namespace-provider', $5, 'v1', $6, $7,
    'satisfied', $8, $9, $10, $11, $12, $12, $13, $14, 'poll_result')`,
    [
      `ceremony_${suffix}`,
      `actor_${suffix}`,
      `intent_${suffix}`,
      SHA_B,
      SHA_C,
      `namespace-key-${suffix}`,
      SHA,
      SHA_B,
      `evidence_${suffix}`,
      SHA_C,
      SHA_B,
      terminal,
      `namespace_session_${suffix}`,
      `namespace_completion_${suffix}`,
    ],
  );
  await client.query(
    `UPDATE community_creation_requirement_states SET status = 'satisfied',
    satisfied_at = $1, updated_at = clock_timestamp() WHERE intent_id = $2 AND requirement_kind = 'namespace_ownership'`,
    [terminal, `intent_${suffix}`],
  );
  await client.query(
    `UPDATE namespace_ownership_sessions SET status = 'completed', terminal_at = $1,
    completed_at = $1, updated_at = clock_timestamp() WHERE namespace_session_id = $2`,
    [terminal, `namespace_session_${suffix}`],
  );
  await client.query(
    `INSERT INTO community_route_ownership_evidence (
    evidence_ref, creation_ceremony_intent_id, verified_by_actor_id, family, root_label,
    root_label_display, path_segment, requirement_hash, provider_id, provider_binding_hash,
    provider_configuration_version, provider_identity_digest, evidence_digest, binding_generation,
    verified_at, expires_at
  ) VALUES ($1, $2, $3, 'hns', 'example_root', 'example_root', 'app.example_root', $4,
    'namespace-provider', $5, 'v1', $6, $7, 1, $8, $9)`,
    [
      `evidence_${suffix}`,
      `ceremony_${suffix}`,
      `actor_${suffix}`,
      SHA_B,
      SHA_C,
      SHA_B,
      SHA_C,
      terminal,
      expiresEvidence,
    ],
  );
  await client.query("COMMIT");
}

async function seedActiveRoute(client: Client, suffix: string): Promise<void> {
  await seedNamespaceAuthority(client, suffix);
  await seedNamespaceSession(client, suffix);
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO communities (
    community_id, display_name, status, created_by_user_id, canonical_route_binding_id,
    route_authority_version, created_at, updated_at, route_slug
  ) VALUES ($1, $2, 'active', $3, $4, 'route_v1', clock_timestamp(), clock_timestamp(), NULL)`,
    [`community_${suffix}`, `Community ${suffix}`, `actor_${suffix}`, `binding_${suffix}`],
  );
  await client.query(
    `INSERT INTO community_canonical_route_bindings (
    route_binding_id, community_id, family, root_label, root_label_display,
    ownership_status, route_lifecycle_status, binding_generation, verified_evidence_ref
  ) VALUES ($1, $2, 'hns', 'example_root', 'example_root', 'verified', 'active', 1, $3)`,
    [`binding_${suffix}`, `community_${suffix}`, `evidence_${suffix}`],
  );
  await client.query("COMMIT");
}

async function seedRevalidationSession(
  client: Client,
  suffix: string,
  expiresAt?: string,
): Promise<void> {
  const expiry = expiresAt ?? new Date(Date.now() + 3_600_000).toISOString();
  const upstream = `upstream_${suffix}`;
  const presentation = JSON.stringify({
    kind: "embedded_sdk",
    session_id: upstream,
    protocol: "hns-txt-challenge",
    version: "1",
    payload: {
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.example_root",
      challenge_value: `pirate-verification=${upstream}`,
      expires_at: expiry,
    },
  });
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO community_route_revalidation_start_reservations (
    route_revalidation_id, revalidation_session_id, community_id, route_binding_id, principal_kind,
    principal_id, expected_binding_generation, expected_verified_evidence_ref, requirement_hash,
    provider_id, provider_binding_hash, provider_configuration_kind, provider_configuration_reference,
    provider_configuration_version, protocol_version, environment, family, root_label, root_label_display,
    path_segment, start_request_hash, state, fence_token, lease_expires_at
  ) VALUES ($1, $2, $3, $4, 'system', 'route-revalidation-scheduler', 1, $5, $6,
    'namespace-provider', $7, 'managed', 'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns',
    'example_root', 'example_root', 'app.example_root', $8, 'acquired', 1, clock_timestamp() + interval '15 seconds')`,
    [
      `route_${suffix}`,
      `session_${suffix}`,
      `community_${suffix}`,
      `binding_${suffix}`,
      `evidence_${suffix}`,
      SHA,
      SHA_C,
      SHA_B,
    ],
  );
  await client.query(
    `INSERT INTO community_route_revalidation_sessions (
    revalidation_session_id, route_revalidation_id, start_fence_token, community_id, route_binding_id,
    principal_kind, principal_id, expected_binding_generation, expected_verified_evidence_ref,
    requirement_hash, start_request_hash, provider_id, provider_binding_hash, provider_configuration_kind,
    provider_configuration_reference, provider_configuration_version, protocol_version, environment,
    family, root_label, root_label_display, path_segment, upstream_session_ref, start_presentation,
    status, started_at, expires_at
  ) VALUES ($1, $2, 1, $3, $4, 'system', 'route-revalidation-scheduler', 1, $5, $6, $7,
    'namespace-provider', $8, 'managed', 'namespace-config', 'v1', 'hns-txt-v1', 'test', 'hns', 'example_root',
    'example_root', 'app.example_root', $9, $10::jsonb, 'pending', clock_timestamp(), $11)`,
    [
      `session_${suffix}`,
      `route_${suffix}`,
      `community_${suffix}`,
      `binding_${suffix}`,
      `evidence_${suffix}`,
      SHA,
      SHA_B,
      SHA_C,
      upstream,
      presentation,
      expiry,
    ],
  );
  await client.query(
    `UPDATE community_route_revalidation_start_reservations SET state = 'finalized'
    WHERE route_revalidation_id = $1`,
    [`route_${suffix}`],
  );
  await client.query("COMMIT");
}

type Fixture = {
  readonly client: Client;
  readonly store: HnsRouteRevalidationCompletionStore;
  readonly stored: HnsRouteRevalidationStoredCompletion;
  readonly connection: string;
};

async function fixture(
  client: Client,
  connection: string,
  suffix: string,
  expiresAt?: string,
): Promise<Fixture> {
  await seedActiveRoute(client, suffix);
  await seedRevalidationSession(client, suffix, expiresAt);
  const store = makeControlPlaneRouteRevalidationCompletionStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
  const stored = await Effect.runPromise(
    Effect.scoped(
      store.load({
        route_revalidation_id: `route_${suffix}`,
        revalidation_session_id: `session_${suffix}`,
        idempotency_key: `poll_${suffix}`,
      }),
    ),
  );
  if (stored === null) throw new Error("expected pending revalidation session");
  return { client, store, stored, connection };
}

function reserveInput(
  suffix: string,
  overrides: Partial<Parameters<HnsRouteRevalidationCompletionStore["reserve"]>[0]> = {},
) {
  return {
    route_revalidation_id: `route_${suffix}`,
    revalidation_session_id: `session_${suffix}`,
    expected_binding_generation: 1,
    expected_verified_evidence_ref: `evidence_${suffix}`,
    idempotency_key: `poll_${suffix}`,
    lease_ms: 1_000,
    max_consumed_attempts: 3,
    ...overrides,
  } as const;
}

function resultHash(
  attempt: HnsRouteRevalidationCompletionAttemptReservation,
  status: HnsRouteRevalidationStoredCompletion["terminal"] extends never
    ? never
    :
        | "session_expired"
        | "database_time_expired"
        | "missing_root"
        | "challenge_mismatch"
        | "stale_cas"
        | "verified",
): Promise<string> {
  const authority =
    status === "verified"
      ? { ownership: "verified", lifecycle: "active" }
      : status === "missing_root"
        ? { ownership: "revoked", lifecycle: "suspended" }
        : status === "database_time_expired"
          ? { ownership: "expired", lifecycle: "suspended" }
          : status === "session_expired" || status === "stale_cas"
            ? { ownership: null, lifecycle: null }
            : { ownership: "disputed", lifecycle: "suspended" };
  return hnsRouteRevalidationResultHash({
    route_revalidation_id: attempt.route_revalidation_id,
    revalidation_session_id: attempt.revalidation_session_id,
    route_revalidation_attempt_id: attempt.route_revalidation_attempt_id,
    route_binding_id: attempt.route_binding_id,
    expected_binding_generation: attempt.expected_binding_generation,
    idempotency_key: attempt.idempotency_key,
    completion_request_hash: attempt.completion_request_hash,
    outcome_status: status,
    evidence_ref_or_null: null,
    evidence_digest_or_null: null,
    provider_identity_digest_or_null: null,
    ownership_status_or_null: authority.ownership,
    route_lifecycle_status_or_null: authority.lifecycle,
  });
}

suite("route revalidation completion repository", () => {
  test("reserves, releases, reacquires, and fences the attempt", async () => {
    await withSchema(async (client, connection) => {
      const { store, stored } = await fixture(client, connection, "lease");
      const input = reserveInput("lease");
      const first = await Effect.runPromise(Effect.scoped(store.reserve(input)));
      expect(first.kind).toBe("acquired");
      if (first.kind !== "acquired") throw new Error("expected reservation");
      expect(await Effect.runPromise(Effect.scoped(store.reserve(input)))).toMatchObject({
        kind: "in_flight",
      });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.release({
              expected: stored,
              idempotency_key: input.idempotency_key,
              completion_request_hash: first.reservation.completion_request_hash,
              expired_result_hash: SHA_B,
              attempt: first.reservation,
            }),
          ),
        ),
      ).toEqual({ kind: "released" });
      const second = await Effect.runPromise(Effect.scoped(store.reserve(input)));
      expect(second).toMatchObject({ kind: "acquired", reservation: { fence_token: 2 } });
      if (second.kind !== "acquired") throw new Error("expected reacquisition");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.release({
              expected: stored,
              idempotency_key: input.idempotency_key,
              completion_request_hash: first.reservation.completion_request_hash,
              expired_result_hash: SHA_B,
              attempt: first.reservation,
            }),
          ),
        ),
      ).toEqual({ kind: "lease_lost" });
    });
  });

  test("consumes semantic contradiction without terminal result and enforces the three-attempt budget", async () => {
    await withSchema(async (client, connection) => {
      const { store, stored } = await fixture(client, connection, "consume");
      for (let index = 0; index < 3; index += 1) {
        const input = reserveInput("consume", { idempotency_key: `poll_consume_${index}` });
        const reserved = await Effect.runPromise(Effect.scoped(store.reserve(input)));
        expect(reserved.kind).toBe("acquired");
        if (reserved.kind !== "acquired") throw new Error("expected reservation");
        expect(
          await Effect.runPromise(
            Effect.scoped(
              store.consume({
                expected: stored,
                idempotency_key: input.idempotency_key,
                completion_request_hash: reserved.reservation.completion_request_hash,
                attempt: reserved.reservation,
                consumption_kind: "challenge_mismatch",
                expired_result_hash: SHA_B,
              }),
            ),
          ),
        ).toEqual({ kind: "consumed_without_terminal" });
      }
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.reserve(reserveInput("consume", { idempotency_key: "poll_consume_4" })),
          ),
        ),
      ).toEqual({ kind: "budget_exhausted" });
      const row = (
        await client.query(
          "SELECT count(*)::int AS count, count(*) FILTER (WHERE result_hash IS NULL)::int AS null_results FROM community_route_revalidation_completion_attempts",
        )
      ).rows[0];
      expect(row).toEqual({ count: 3, null_results: 3 });
    });
  });

  test("projects a consumed semantic attempt as nonterminal and permits a later terminal attempt", async () => {
    await withSchema(async (client, connection) => {
      const { store, stored } = await fixture(client, connection, "semantic-terminal");
      const semanticInput = reserveInput("semantic-terminal", {
        idempotency_key: "poll_semantic_terminal_1",
      });
      const semantic = await Effect.runPromise(Effect.scoped(store.reserve(semanticInput)));
      expect(semantic.kind).toBe("acquired");
      if (semantic.kind !== "acquired") throw new Error("expected semantic reservation");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.consume({
              expected: stored,
              idempotency_key: semanticInput.idempotency_key,
              completion_request_hash: semantic.reservation.completion_request_hash,
              attempt: semantic.reservation,
              consumption_kind: "challenge_mismatch",
              expired_result_hash: SHA_B,
            }),
          ),
        ),
      ).toEqual({ kind: "consumed_without_terminal" });

      expect(await Effect.runPromise(Effect.scoped(store.reserve(semanticInput)))).toEqual({
        kind: "consumed",
      });

      const terminalInput = reserveInput("semantic-terminal", {
        idempotency_key: "poll_semantic_terminal_2",
      });
      const terminal = await Effect.runPromise(Effect.scoped(store.reserve(terminalInput)));
      expect(terminal.kind).toBe("acquired");
      if (terminal.kind !== "acquired") throw new Error("expected terminal reservation");
      const terminalResultHash = await resultHash(terminal.reservation, "missing_root");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.reject({
              expected: stored,
              idempotency_key: terminalInput.idempotency_key,
              completion_request_hash: terminal.reservation.completion_request_hash,
              result_hash: terminalResultHash,
              expired_result_hash: SHA_B,
              attempt: terminal.reservation,
              status: "missing_root",
              observed_expires_at: null,
            }),
          ),
        ),
      ).toMatchObject({ kind: "committed", status: "missing_root" });

      const persisted = await Effect.runPromise(
        Effect.scoped(
          store.load({
            route_revalidation_id: "route_semantic-terminal",
            revalidation_session_id: "session_semantic-terminal",
            idempotency_key: semanticInput.idempotency_key,
          }),
        ),
      );
      expect(persisted?.terminal).toMatchObject({
        status: "missing_root",
        result_hash: terminalResultHash,
      });
      expect(
        (
          await client.query(
            `SELECT state, consumption_kind, result_hash
               FROM community_route_revalidation_completion_attempts
              ORDER BY attempt_number`,
          )
        ).rows,
      ).toEqual([
        { state: "consumed", consumption_kind: "challenge_mismatch", result_hash: null },
        { state: "consumed", consumption_kind: "missing_root", result_hash: terminalResultHash },
      ]);
    });
  });

  test("rejects database-time-expired while the session itself is still fresh", async () => {
    await withSchema(async (client, connection) => {
      const { store, stored } = await fixture(client, connection, "expired-proof");
      const input = reserveInput("expired-proof");
      const reserved = await Effect.runPromise(Effect.scoped(store.reserve(input)));
      expect(reserved.kind).toBe("acquired");
      if (reserved.kind !== "acquired") throw new Error("expected reservation");
      const hash = await resultHash(reserved.reservation, "database_time_expired");
      const staleHash = await resultHash(reserved.reservation, "stale_cas");
      const observedExpiresAt = new Date(Date.now() - 60_000).toISOString();
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.reject({
              expected: stored,
              idempotency_key: input.idempotency_key,
              completion_request_hash: reserved.reservation.completion_request_hash,
              result_hash: hash,
              expired_result_hash: SHA_B,
              stale_result_hash: staleHash,
              attempt: reserved.reservation,
              status: "database_time_expired",
              observed_expires_at: observedExpiresAt,
            }),
          ),
        ),
      ).toMatchObject({ kind: "committed", status: "database_time_expired", result_hash: hash });
      const replay = await Effect.runPromise(
        Effect.scoped(
          store.load({
            route_revalidation_id: "route_expired-proof",
            revalidation_session_id: "session_expired-proof",
            idempotency_key: input.idempotency_key,
          }),
        ),
      );
      expect(replay?.terminal).toMatchObject({
        status: "database_time_expired",
        result_hash: hash,
      });
      expect(
        (await client.query("SELECT status FROM community_route_revalidation_sessions")).rows[0],
      ).toEqual({ status: "failed" });
      expect(
        (
          await client.query(
            "SELECT binding_generation, verified_evidence_ref, ownership_status, route_lifecycle_status FROM community_canonical_route_bindings",
          )
        ).rows[0],
      ).toEqual({
        binding_generation: "2",
        verified_evidence_ref: null,
        ownership_status: "expired",
        route_lifecycle_status: "suspended",
      });
    });
  });

  test("accepts only the exact terminal preimage and null negative evidence", async () => {
    await withSchema(async (client, connection) => {
      const { store } = await fixture(client, connection, "terminal-bytes");
      const input = reserveInput("terminal-bytes");
      const reserved = await Effect.runPromise(Effect.scoped(store.reserve(input)));
      if (reserved.kind !== "acquired") throw new Error("expected reservation");
      const base = {
        route_revalidation_id: reserved.reservation.route_revalidation_id,
        revalidation_session_id: reserved.reservation.revalidation_session_id,
        route_revalidation_attempt_id: reserved.reservation.route_revalidation_attempt_id,
        route_binding_id: reserved.reservation.route_binding_id,
        expected_binding_generation: reserved.reservation.expected_binding_generation,
        idempotency_key: reserved.reservation.idempotency_key,
        completion_request_hash: reserved.reservation.completion_request_hash,
        outcome_status: "missing_root" as const,
        evidence_ref_or_null: null,
        evidence_digest_or_null: null,
        provider_identity_digest_or_null: null,
        ownership_status_or_null: "revoked",
        route_lifecycle_status_or_null: "suspended",
      };
      const exact = hnsRouteRevalidationResultPreimage(base);
      const exactHash = await hnsRouteRevalidationResultHash(base);
      const validate = async (document: string, hash: string) =>
        (
          await client.query<{ valid: boolean }>(
            `SELECT validate_community_route_revalidation_terminal_document(
              $1, $2, 'missing_root', $3, $4, $5, $6, $7, $8, $9) AS valid`,
            [
              document,
              hash,
              base.route_revalidation_id,
              base.revalidation_session_id,
              base.route_revalidation_attempt_id,
              base.route_binding_id,
              base.expected_binding_generation,
              base.idempotency_key,
              base.completion_request_hash,
            ],
          )
        ).rows[0]?.valid;
      expect(await validate(exact, exactHash)).toBe(true);
      expect(await validate(exact.replace("[", "[ "), exactHash)).toBe(false);
      for (const alternate of ["1.0", "1.00", "1e0"]) {
        const alternateDocument = exact.replace(',1,"idempotency_', `,${alternate},"idempotency_`);
        const alternateHash = createHash("sha256").update(alternateDocument).digest("hex");
        expect(await validate(alternateDocument, alternateHash)).toBe(false);
      }
      const leaked = {
        ...base,
        evidence_ref_or_null: "provider-ref",
        evidence_digest_or_null: SHA,
        provider_identity_digest_or_null: SHA_B,
      };
      expect(
        await validate(
          hnsRouteRevalidationResultPreimage(leaked),
          await hnsRouteRevalidationResultHash(leaked),
        ),
      ).toBe(false);
    });
  });

  test("rejects a database-time-expired claim whose observation expiry is still fresh", async () => {
    await withSchema(async (client, connection) => {
      const { store, stored } = await fixture(client, connection, "fresh-expiry");
      const input = reserveInput("fresh-expiry");
      const reserved = await Effect.runPromise(Effect.scoped(store.reserve(input)));
      if (reserved.kind !== "acquired") throw new Error("expected reservation");
      const hash = await resultHash(reserved.reservation, "database_time_expired");
      const staleHash = await resultHash(reserved.reservation, "stale_cas");
      await expect(
        Effect.runPromise(
          Effect.scoped(
            store.reject({
              expected: stored,
              idempotency_key: input.idempotency_key,
              completion_request_hash: reserved.reservation.completion_request_hash,
              result_hash: hash,
              expired_result_hash: SHA_B,
              stale_result_hash: staleHash,
              attempt: reserved.reservation,
              status: "database_time_expired",
              observed_expires_at: new Date(Date.now() + 60_000).toISOString(),
            }),
          ),
        ),
      ).rejects.toMatchObject({ _tag: "HnsRouteRevalidationCompletionStorageFailed" });
      expect(
        (
          await client.query(
            "SELECT binding_generation, verified_evidence_ref, ownership_status, route_lifecycle_status FROM community_canonical_route_bindings",
          )
        ).rows[0],
      ).toEqual({
        binding_generation: "1",
        verified_evidence_ref: "evidence_fresh-expiry",
        ownership_status: "verified",
        route_lifecycle_status: "active",
      });
    });
  });

  test("finalizes verified authority and creates the route evidence projection", async () => {
    await withSchema(async (client, connection) => {
      const { store, stored } = await fixture(client, connection, "verified");
      const input = reserveInput("verified");
      const reserved = await Effect.runPromise(Effect.scoped(store.reserve(input)));
      expect(reserved.kind).toBe("acquired");
      if (reserved.kind !== "acquired") throw new Error("expected reservation");
      const observedAt = new Date(Date.now() - 60_000).toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const upstream = "upstream_verified";
      const observation = {
        ownership_source: "owner_authoritative_dns_txt",
        challenge_name: "_pirate.example_root",
        challenge_value: "pirate-verification=upstream_verified",
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
        provider_evidence_ref: "provider-verified",
      } as const;
      const raw = Buffer.from(JSON.stringify({ status: "verified", observation }), "utf8");
      const challengeValueHash = createHash("sha256")
        .update(observation.challenge_value)
        .digest("hex");
      const envelope = {
        version: "pirate-hns-route-revalidation-evidence-v1",
        route_revalidation_id: "route_verified",
        revalidation_session_id: "session_verified",
        route_revalidation_attempt_id: reserved.reservation.route_revalidation_attempt_id,
        community_id: "community_verified",
        route_binding_id: "binding_verified",
        principal_kind: "system",
        principal_id: "route-revalidation-scheduler",
        requirement_hash: SHA,
        expected_binding_generation: 1,
        binding_generation: 2,
        expected_verified_evidence_ref: "evidence_verified",
        start_request_hash: SHA_B,
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
        upstream_session_ref: upstream,
        ownership_source: "owner_authoritative_dns_txt",
        challenge_name: "_pirate.example_root",
        challenge_value_sha256: challengeValueHash,
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
        evidence_ref: reserved.reservation.evidence_ref,
        provider_evidence_ref: "provider-verified",
        observation_sha256: createHash("sha256").update(raw).digest("hex"),
        provider_identity_digest: SHA_B,
        evidence_digest: SHA_C,
      } as const;
      const hash = await hnsRouteRevalidationResultHash({
        route_revalidation_id: reserved.reservation.route_revalidation_id,
        revalidation_session_id: reserved.reservation.revalidation_session_id,
        route_revalidation_attempt_id: reserved.reservation.route_revalidation_attempt_id,
        route_binding_id: reserved.reservation.route_binding_id,
        expected_binding_generation: reserved.reservation.expected_binding_generation,
        idempotency_key: reserved.reservation.idempotency_key,
        completion_request_hash: reserved.reservation.completion_request_hash,
        outcome_status: "verified",
        evidence_ref_or_null: envelope.evidence_ref,
        evidence_digest_or_null: envelope.evidence_digest,
        provider_identity_digest_or_null: envelope.provider_identity_digest,
        ownership_status_or_null: "verified",
        route_lifecycle_status_or_null: "active",
      });
      const verified = {
        envelope,
        observation,
        raw_response_bytes: raw,
      } as const;
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.verify({
              expected: stored,
              idempotency_key: input.idempotency_key,
              completion_request_hash: reserved.reservation.completion_request_hash,
              result_hash: hash,
              expired_result_hash: SHA_B,
              stale_result_hash: SHA_C,
              database_time_expired_result_hash: SHA,
              attempt: reserved.reservation,
              verified,
            }),
          ),
        ),
      ).toMatchObject({ kind: "committed", status: "verified", result_hash: hash });
      expect(
        (await client.query("SELECT status FROM community_route_revalidation_sessions")).rows[0],
      ).toEqual({ status: "completed" });
      expect(
        (
          await client.query(
            "SELECT ownership_status, route_lifecycle_status, binding_generation FROM community_canonical_route_bindings",
          )
        ).rows[0],
      ).toEqual({
        ownership_status: "verified",
        route_lifecycle_status: "active",
        binding_generation: "2",
      });
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM community_route_ownership_evidence WHERE origin = 'route_revalidation'",
          )
        ).rows[0],
      ).toEqual({ count: 1 });
    });
  });

  test("turns a binding-generation race into stale_cas without a route mutation", async () => {
    await withSchema(async (client, connection) => {
      const { store, stored } = await fixture(client, connection, "stale");
      const input = reserveInput("stale");
      const reserved = await Effect.runPromise(Effect.scoped(store.reserve(input)));
      expect(reserved.kind).toBe("acquired");
      if (reserved.kind !== "acquired") throw new Error("expected reservation");
      await client.query(
        "UPDATE community_canonical_route_bindings SET binding_generation = 2, ownership_status = 'disputed', route_lifecycle_status = 'suspended', updated_at = clock_timestamp() WHERE route_binding_id = 'binding_stale'",
      );
      const hash = await resultHash(reserved.reservation, "missing_root");
      const staleHash = await resultHash(reserved.reservation, "stale_cas");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.reject({
              expected: stored,
              idempotency_key: input.idempotency_key,
              completion_request_hash: reserved.reservation.completion_request_hash,
              result_hash: hash,
              expired_result_hash: SHA_B,
              stale_result_hash: staleHash,
              attempt: reserved.reservation,
              status: "missing_root",
              observed_expires_at: null,
            }),
          ),
        ),
      ).toEqual({ kind: "committed", status: "stale_cas", result_hash: staleHash });
      expect(
        (
          await client.query(
            "SELECT binding_generation, ownership_status, route_lifecycle_status FROM community_canonical_route_bindings",
          )
        ).rows[0],
      ).toEqual({
        binding_generation: "2",
        ownership_status: "disputed",
        route_lifecycle_status: "suspended",
      });
    });
  });
});
