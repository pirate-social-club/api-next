import { afterAll, describe, expect, test } from "bun:test";
import type {
  NamespaceOwnershipProviderStartResult,
  NamespaceOwnershipStartReservationInput,
} from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import {
  makeControlPlaneNamespaceOwnershipStartAuthorityResolver,
  makeControlPlaneNamespaceOwnershipStartStore,
} from "./namespace-ownership-start-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}

const suite = connectionString === undefined ? describe.skip : describe;
const namespacePersistenceTestCount = 11;
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

async function insertAttempt(client: Client, suffix: string, fence = 1, state = "leased") {
  await client.query(
    `INSERT INTO namespace_ownership_completion_attempts (
       completion_attempt_id, namespace_session_id, actor_id, idempotency_key, evidence_ref,
       completion_request_hash, submission_channel, state, fence_token, lease_expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'poll_result', $7, $8,
       clock_timestamp() + interval '30 minutes')`,
    [
      `completion_${suffix}`,
      `namespace_session_${suffix}`,
      `actor_${suffix}`,
      `callback-${suffix}`,
      `evidence_${suffix}`,
      SHA,
      state,
      fence,
    ],
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
): NamespaceOwnershipProviderStartResult {
  return {
    session: {
      ...input.start,
      provider_id: input.provider_id,
      upstream_session_ref: `upstream_${input.namespace_session_id}`,
      expires_at: "2099-08-21T00:00:00.000Z",
    },
    presentation: {
      kind: "poll",
      session_id: `upstream_${input.namespace_session_id}`,
      poll_url: "/provider/poll",
    },
  };
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
      await insertSnapshot(client, "valid");
      await client.query(
        `UPDATE namespace_ownership_completion_attempts
            SET state = 'consumed', updated_at = clock_timestamp()
          WHERE completion_attempt_id = 'completion_valid'`,
      );
      const terminalAt = await databaseTerminalAt(client);
      await client.query("BEGIN");
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
      await insertSnapshot(client, "deferred");
      await client.query(
        `UPDATE namespace_ownership_completion_attempts
            SET state = 'consumed', updated_at = clock_timestamp()
          WHERE completion_attempt_id = 'completion_deferred'`,
      );
      const deferredTerminalAt = await databaseTerminalAt(client);
      await client.query("BEGIN");
      await client.query(
        `UPDATE community_creation_requirement_states
            SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
          WHERE intent_id = 'intent_deferred' AND requirement_kind = 'namespace_ownership'`,
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
      await client.query(
        `UPDATE namespace_ownership_sessions
            SET status = 'completed', terminal_at = $1, completed_at = $1,
                updated_at = clock_timestamp()
          WHERE namespace_session_id = 'namespace_session_deferred'`,
        [deferredTerminalAt],
      );
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
      const terminalAt = await databaseTerminalAt(client);
      await client.query("BEGIN");
      await insertNamespaceResult(client, "pending-expired", "expired", terminalAt);
      await client.query(
        `UPDATE community_creation_requirement_states
            SET status = 'expired', satisfied_at = NULL, updated_at = clock_timestamp()
          WHERE intent_id = 'intent_pending-expired' AND requirement_kind = 'namespace_ownership'`,
      );
      await failure(client, "COMMIT");
    });

    await withSchema(async (client) => {
      await seed(client, "terminal-expiry");
      await insertSession(client, "terminal-expiry");
      await insertAttempt(client, "terminal-expiry");
      await insertSnapshot(client, "terminal-expiry", {
        expires: new Date(Date.now() + 100).toISOString(),
      });
      await client.query("SELECT pg_sleep(0.2)");
      const terminalAt = await databaseTerminalAt(client);
      await client.query("BEGIN");
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
      await seed(client, "raw-one-megabyte");
      await insertSession(client, "raw-one-megabyte");
      await insertAttempt(client, "raw-one-megabyte");
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
      await seed(client, "raw-too-large");
      await insertSession(client, "raw-too-large");
      await insertAttempt(client, "raw-too-large");
      await insertSnapshot(client, "raw-too-large", {
        raw: Buffer.alloc(1024 * 1024 + 1, 0x78),
        expectFailure: true,
      });
      await seed(client, "future-observation");
      await insertSession(client, "future-observation");
      await insertAttempt(client, "future-observation");
      await insertSnapshot(client, "future-observation", {
        observed: new Date(Date.now() + 60_000).toISOString(),
        expectFailure: true,
      });
      await seed(client, "expired-snapshot");
      await insertSession(client, "expired-snapshot");
      await insertAttempt(client, "expired-snapshot");
      await insertSnapshot(client, "expired-snapshot", {
        expires: new Date(Date.now() - 1_000).toISOString(),
        expectFailure: true,
      });
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
      await insertSnapshot(client, "one");
      await seed(client, "two");
      await insertSession(client, "two");
      await insertAttempt(client, "two");
      await insertSnapshot(client, "two");
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

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === namespacePersistenceTestCount) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
