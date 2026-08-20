import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  VERY_OAUTH_CONFIGURATION_REFERENCE,
  VERY_OAUTH_CONFIGURATION_VERSION,
  VERY_OAUTH_ISSUER,
  VERY_OAUTH_METHOD,
  VERY_OAUTH_PROTOCOL_VERSION,
  VERY_OAUTH_PROVIDER_ID,
  VERY_OAUTH_RP_SCOPE,
} from "@pirate/domain";
import type {
  EvidenceBundle,
  ProofSession,
  SubjectBindingIntent,
} from "@pirate/domain/verification";
import { Effect } from "effect";
import { Client } from "pg";
import { makeControlPlaneCommunityCreationStore } from "./community-creation-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";
import { applyPostgresMigrations, type PostgresMigration } from "./postgres-migrations";
import {
  makeControlPlaneVerificationCompletionStore,
  makeSha256VerificationCompletionHasher,
} from "./verification-completion-repository";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_VERIFICATION_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-verification-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-verification-suite-complete\n";
let completedTestCount = 0;
const foundationTestCount = 10;
// Keep ordinary pending-session fixtures valid independently of the day the
// CI database runs. Expiry-specific tests override this value with an
// intentionally past or database-relative timestamp below.
const defaultSessionExpiresAt = "2099-08-18T00:00:00.000Z";

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
  "0023_community_creation_intents.sql",
  "0024_community_creation_preflight_transition.sql",
  "0025_community_creation_storage_identity.sql",
] as const;
const migrations: readonly PostgresMigration[] = await Promise.all(
  migrationFiles.map(async (version) => {
    const sql = await Bun.file(
      new URL(`../../../db/postgres/migrations/${version}`, import.meta.url),
    ).text();
    return { version, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }),
);

function schemaIdentifier(): string {
  return `api_next_verification_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
    const scoped = connectionForSchema(connectionString, schema);
    await Effect.runPromise(
      Effect.scoped(
        applyPostgresMigrations(migrations).pipe(
          Effect.provide(makeDirectPostgresControlPlaneLayer(scoped)),
        ),
      ),
    );
    await admin.query("INSERT INTO users (user_id) VALUES ('user-a'), ('user-b')");
    return await use(scoped, admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function proofSession(
  id: string,
  actorId: string,
  requestHash: string,
  bindingIntent: SubjectBindingIntent,
): ProofSession {
  return {
    id,
    actor_id: actorId,
    intent_id: `intent-${id}`,
    request_hash: requestHash,
    provider_id: "test.complete",
    upstream_session_ref: `upstream-${id}`,
    method: "document",
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: "test.complete",
      rp_scope: "pirate.example",
    },
    request_mode: "dynamic",
    provider_configuration: { kind: "dynamic", reference: "test-query", version: "1" },
    requested_requirements: [
      { claim_id: "credential.subject_unique" },
      { claim_id: "document.valid" },
    ],
    requested_claim_ids: ["credential.subject_unique", "document.valid"],
    subject_binding_intent: bindingIntent,
    protocol_version: "complete-v1",
    environment: "test",
    status: "pending",
    started_at: "2026-08-17T00:00:00.000Z",
    expires_at: defaultSessionExpiresAt,
  };
}

async function insertSession(admin: Client, session: ProofSession): Promise<void> {
  const scope = session.scope;
  if (scope.kind !== "named") throw new Error("test session must use a named scope");
  await admin.query({
    text: `INSERT INTO proof_sessions (
      proof_session_id, actor_id, intent_id, request_hash, provider_id,
      provider_configuration_kind, provider_configuration_ref,
      provider_configuration_version, method, issuer,
      scope_kind, issuer_rp_scope, issuer_rp_action_scope, request_mode, protocol_version,
      environment, status, requested_requirements, requested_claim_ids, subject_binding_intent,
      started_at, expires_at, upstream_session_ref
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16, 'pending', $17::jsonb, $18::jsonb, $19, $20, $21, $22)`,
    values: [
      session.id,
      session.actor_id,
      session.intent_id,
      session.request_hash,
      session.provider_id,
      session.provider_configuration.kind,
      session.provider_configuration.reference,
      session.provider_configuration.version,
      session.method,
      scope.issuer,
      scope.scope_semantics,
      scope.rp_scope,
      scope.scope_semantics === "issuer_rp_action_scope" ? scope.action_scope : null,
      session.request_mode,
      session.protocol_version,
      session.environment,
      JSON.stringify(session.requested_requirements),
      JSON.stringify(session.requested_claim_ids),
      session.subject_binding_intent,
      session.started_at,
      session.expires_at,
      session.upstream_session_ref ?? null,
    ],
  });
  await admin.query(
    `INSERT INTO verification_completion_attempts
       (attempt_id, proof_session_id, idempotency_key, state, fence_token, lease_expires_at)
     VALUES ($1, $2, $3, 'leased', 1, CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
    [`test-attempt-${session.id}`, session.id, `callback-${session.id}`],
  );
}

function evidenceBundle(session: ProofSession, evidenceHash: string): EvidenceBundle {
  return {
    id: `bundle-${session.id}`,
    proof_session_id: session.id,
    subject_keys: [
      {
        id: "provider-subject",
        issuer: "test.complete",
        method: "document",
        scope: {
          kind: "named",
          scope_semantics: "issuer_rp_scope",
          issuer: "test.complete",
          rp_scope: "pirate.example",
        },
        subject_digest: "3".repeat(64),
      },
    ],
    receipts: [
      {
        id: "provider-receipt",
        proof_session_id: session.id,
        provider_id: "test.complete",
        issuer: "test.complete",
        method: "document",
        scope: session.scope,
        provider_configuration: session.provider_configuration,
        protocol_version: "complete-v1",
        environment: "test",
        provenance_kind: "proof_session",
        evidence_kind: "document",
        evidence_hash: evidenceHash,
        metadata: { credential_type: "test_document", source_attestation_id: "test-1" },
        observed_at: "2026-08-17T00:20:00.000Z",
        subject_key_id: "provider-subject",
      },
    ],
    binding_groups: [
      { id: "provider-binding", kind: "same_subject", subject_key_id: "provider-subject" },
    ],
    assertions: [
      {
        id: "provider-assertion-document",
        subject_key_id: "provider-subject",
        evidence_receipt_id: "provider-receipt",
        claim_id: "document.valid",
        value: { valid: true },
        assurance: "document_zk",
        binding_group_id: "provider-binding",
        observed_at: "2026-08-17T00:20:00.000Z",
      },
      {
        id: "provider-assertion-unique",
        subject_key_id: "provider-subject",
        evidence_receipt_id: "provider-receipt",
        claim_id: "credential.subject_unique",
        value: { subject_unique: true },
        assurance: "document_zk",
        binding_group_id: "provider-binding",
        observed_at: "2026-08-17T00:20:00.000Z",
      },
    ],
  };
}

function communityCreationProofSession(intentId: string): ProofSession {
  return {
    id: "community-creation-proof",
    actor_id: "user-a",
    intent_id: intentId,
    request_hash: "c".repeat(64),
    provider_id: VERY_OAUTH_PROVIDER_ID,
    upstream_session_ref: "very-session-1",
    method: VERY_OAUTH_METHOD,
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: VERY_OAUTH_ISSUER,
      rp_scope: VERY_OAUTH_RP_SCOPE,
    },
    request_mode: "dynamic",
    provider_configuration: {
      kind: "dynamic",
      reference: VERY_OAUTH_CONFIGURATION_REFERENCE,
      version: VERY_OAUTH_CONFIGURATION_VERSION,
    },
    requested_requirements: [
      { claim_id: "credential.subject_unique" },
      { claim_id: "human.personhood" },
    ],
    requested_claim_ids: ["credential.subject_unique", "human.personhood"],
    subject_binding_intent: "establish",
    protocol_version: VERY_OAUTH_PROTOCOL_VERSION,
    environment: "test",
    status: "pending",
    started_at: "2026-01-01T00:00:00.000Z",
    expires_at: defaultSessionExpiresAt,
  };
}

function veryEvidenceBundle(session: ProofSession, evidenceHash: string): EvidenceBundle {
  if (session.scope.kind !== "named") throw new Error("expected named Very scope");
  return {
    id: "very-bundle",
    proof_session_id: session.id,
    subject_keys: [
      {
        id: "very-subject",
        issuer: session.scope.issuer,
        method: session.method,
        scope: session.scope,
        subject_digest: "d".repeat(64),
      },
    ],
    receipts: [
      {
        id: "very-receipt",
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
        evidence_hash: evidenceHash,
        observed_at: "2026-01-01T00:00:30.000Z",
        subject_key_id: "very-subject",
      },
    ],
    binding_groups: [{ id: "very-binding", kind: "same_subject", subject_key_id: "very-subject" }],
    assertions: [
      {
        id: "very-unique",
        subject_key_id: "very-subject",
        evidence_receipt_id: "very-receipt",
        claim_id: "credential.subject_unique",
        value: { subject_unique: true },
        assurance: "provider_attested",
        binding_group_id: "very-binding",
        observed_at: "2026-01-01T00:00:30.000Z",
      },
      {
        id: "very-personhood",
        subject_key_id: "very-subject",
        evidence_receipt_id: "very-receipt",
        claim_id: "human.personhood",
        value: { personhood: true },
        assurance: "provider_attested",
        binding_group_id: "very-binding",
        observed_at: "2026-01-01T00:00:30.000Z",
      },
    ],
  };
}

async function cloneCompletedCreationEvidence(
  admin: Client,
  input: Readonly<{
    readonly sourceSessionId: string;
    readonly sessionId: string;
    readonly intentId: string;
    readonly suffix: string;
  }>,
): Promise<{ readonly idempotencyKey: string; readonly resultHash: string }> {
  const idempotencyKey = `complete-${input.suffix}`;
  const eventId = `completion-${input.suffix}`;
  const receiptId = `receipt-${input.suffix}`;
  const bindingId = `binding-${input.suffix}`;
  const clonedEvidenceHash = createHash("sha256").update(input.suffix).digest("hex");
  await admin.query("BEGIN");
  try {
    await admin.query({
      text: `INSERT INTO proof_sessions (
        proof_session_id, actor_id, intent_id, request_hash, provider_id,
        method, issuer, scope_kind, issuer_rp_scope, issuer_rp_action_scope,
        request_mode, protocol_version, environment, status, upstream_session_ref,
        requested_requirements, requested_claim_ids, started_at, completed_at,
        expires_at, subject_binding_intent, completion_idempotency_key,
        completion_result_hash, terminal_at, provider_configuration_kind,
        provider_configuration_ref, provider_configuration_version
      ) SELECT $1, actor_id, $2, request_hash, provider_id,
               method, issuer, scope_kind, issuer_rp_scope, issuer_rp_action_scope,
               request_mode, protocol_version, environment, 'pending',
               upstream_session_ref || '-' || $3, requested_requirements,
               requested_claim_ids, started_at, NULL, expires_at,
               subject_binding_intent, NULL, NULL, NULL,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version
          FROM proof_sessions
         WHERE proof_session_id = $4`,
      values: [input.sessionId, input.intentId, input.suffix, input.sourceSessionId],
    });
    const source = await admin.query<{ result_hash: string; terminal_at: Date }>({
      text: `SELECT completion_result_hash AS result_hash, terminal_at
               FROM proof_sessions
              WHERE proof_session_id = $1`,
      values: [input.sourceSessionId],
    });
    const resultHash = source.rows[0]?.result_hash;
    const terminalAt = source.rows[0]?.terminal_at;
    if (resultHash === undefined || terminalAt === undefined) {
      throw new Error("cloned completion fixture is incomplete");
    }
    await admin.query({
      text: `UPDATE proof_sessions
                SET status = 'completed', completion_idempotency_key = $1,
                    completion_result_hash = $2, completed_at = $3, terminal_at = $3,
                    updated_at = clock_timestamp()
              WHERE proof_session_id = $4`,
      values: [idempotencyKey, resultHash, terminalAt, input.sessionId],
    });
    await admin.query({
      text: `INSERT INTO proof_session_completion_events (
        completion_event_id, proof_session_id, actor_id, idempotency_key,
        terminal_status, result_hash, terminal_at
      ) VALUES ($1, $2, 'user-a', $3, 'completed', $4, $5)`,
      values: [eventId, input.sessionId, idempotencyKey, resultHash, terminalAt],
    });
    await admin.query({
      text: `INSERT INTO evidence_receipts (
        evidence_receipt_id, proof_session_id, user_id, provider_id, issuer,
        method, scope_kind, issuer_rp_scope, issuer_rp_action_scope,
        protocol_version, environment, evidence_kind, evidence_hash,
        receipt_metadata, observed_at, expires_at, provenance_kind,
        subject_key_id, subject_binding_event_id, subject_binding_epoch,
        provider_configuration_kind, provider_configuration_ref,
        provider_configuration_version
      ) SELECT $1, $2, user_id, provider_id, issuer, method, scope_kind,
               issuer_rp_scope, issuer_rp_action_scope, protocol_version,
               environment, evidence_kind, $4, receipt_metadata,
               observed_at, expires_at, provenance_kind, subject_key_id,
               subject_binding_event_id, subject_binding_epoch,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version
          FROM evidence_receipts
         WHERE proof_session_id = $3`,
      values: [receiptId, input.sessionId, input.sourceSessionId, clonedEvidenceHash],
    });
    await admin.query({
      text: `INSERT INTO assertion_bindings (
        binding_group_id, user_id, binding_mode, subject_key_id,
        evidence_receipt_id, subject_binding_event_id, subject_binding_epoch
      ) SELECT DISTINCT $1, binding.user_id, binding.binding_mode,
               binding.subject_key_id, binding.evidence_receipt_id,
               binding.subject_binding_event_id, binding.subject_binding_epoch
          FROM assertion_bindings AS binding
          JOIN assertions AS assertion
            ON assertion.binding_group_id = binding.binding_group_id
          JOIN evidence_receipts AS receipt
            ON receipt.evidence_receipt_id = assertion.evidence_receipt_id
         WHERE receipt.proof_session_id = $2`,
      values: [bindingId, input.sourceSessionId],
    });
    await admin.query({
      text: `INSERT INTO assertions (
        assertion_id, binding_group_id, evidence_receipt_id, subject_key_id,
        user_id, claim_id, assertion_value, assurance, observed_at, expires_at
      ) SELECT assertion.assertion_id || '-' || $1, $2, $3,
               assertion.subject_key_id, assertion.user_id, assertion.claim_id,
               assertion.assertion_value, assertion.assurance,
               assertion.observed_at, assertion.expires_at
          FROM assertions AS assertion
          JOIN evidence_receipts AS receipt
            ON receipt.evidence_receipt_id = assertion.evidence_receipt_id
         WHERE receipt.proof_session_id = $4`,
      values: [input.suffix, bindingId, receiptId, input.sourceSessionId],
    });
    await admin.query("COMMIT");
    return { idempotencyKey, resultHash };
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function markCreationIntentCommitReady(
  admin: Client,
  intent: Readonly<Record<string, unknown>> & {
    readonly intent_id: string;
    readonly revision: number;
  },
  requestHash: string,
): Promise<void> {
  const snapshot = {
    ...intent,
    revision: intent.revision + 1,
    status: "commit_ready",
    next_action: { kind: "commit" },
  };
  await admin.query("BEGIN");
  try {
    const updated = await admin.query({
      text: `UPDATE community_creation_intents
                SET revision = $1, status = 'commit_ready', updated_at = clock_timestamp()
              WHERE intent_id = $2 AND revision = $3 AND status = 'verification_required'`,
      values: [snapshot.revision, intent.intent_id, intent.revision],
    });
    if (updated.rowCount !== 1) throw new Error("creation intent fixture did not advance");
    await admin.query({
      text: `INSERT INTO community_creation_intent_revisions (
        intent_id, revision, actor_id, operation_kind, idempotency_key,
        request_hash, status, state_snapshot
      ) VALUES ($1, $2, 'user-a', 'verification', NULL, $3, 'commit_ready', $4::jsonb)`,
      values: [intent.intent_id, snapshot.revision, requestHash, JSON.stringify(snapshot)],
    });
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

function storeFor(connection: string) {
  return makeControlPlaneVerificationCompletionStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
}

function commitInput(session: ProofSession, evidenceHash: string, resultHash: string) {
  return {
    actor_id: session.actor_id,
    idempotency_key: `callback-${session.id}`,
    attempt: {
      attempt_id: `test-attempt-${session.id}`,
      fence_token: 1,
      lease_expires_at: "2099-08-17T00:00:00.000Z",
    },
    expected_session: session,
    result_hash: resultHash,
    bundle: evidenceBundle(session, evidenceHash),
  } as const;
}

async function reserveAttempt(
  store: ReturnType<typeof storeFor>,
  proofSessionId: string,
  idempotencyKey: string,
  maxConsumedAttempts = 3,
) {
  const result = await Effect.runPromise(
    Effect.scoped(
      store.reserveAttempt({
        proof_session_id: proofSessionId,
        idempotency_key: idempotencyKey,
        lease_ms: 60_000,
        max_consumed_attempts: maxConsumedAttempts,
      }),
    ),
  );
  return result;
}

suite("Postgres 17 verification completion repository", () => {
  test("atomically admits one duplicate idempotency key and fences the other", async () => {
    await withSchema(async (connection, admin) => {
      const session = proofSession("attempt-duplicate", "user-a", "1".repeat(64), "none");
      await insertSession(admin, session);
      await admin.query(
        "DELETE FROM verification_completion_attempts WHERE proof_session_id = $1",
        [session.id],
      );
      const store = storeFor(connection);
      const results = await Promise.all([
        reserveAttempt(store, session.id, "duplicate-key"),
        reserveAttempt(store, session.id, "duplicate-key"),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(["acquired", "in_flight"]);
      expect(
        (await admin.query("SELECT count(*) FROM verification_completion_attempts")).rows[0]?.count,
      ).toBe("1");
    });
    completedTestCount += 1;
  });

  test("uses wall-clock expiry after waiting on the session lock", async () => {
    await withSchema(async (connection, admin) => {
      const databaseClock = await admin.query<{ database_now: Date }>(
        "SELECT clock_timestamp() AS database_now",
      );
      const databaseNow = databaseClock.rows[0]?.database_now;
      if (!(databaseNow instanceof Date)) throw new Error("expected the Postgres clock");
      const expiring: ProofSession = {
        ...proofSession("attempt-lock-expiry", "user-a", "f".repeat(64), "none"),
        started_at: new Date(databaseNow.getTime() - 60_000).toISOString(),
        expires_at: new Date(databaseNow.getTime() + 500).toISOString(),
      };
      await insertSession(admin, expiring);
      const store = storeFor(connection);
      await admin.query("BEGIN");
      await admin.query(
        "SELECT proof_session_id FROM proof_sessions WHERE proof_session_id = $1 FOR UPDATE",
        [expiring.id],
      );
      const waiting = reserveAttempt(store, expiring.id, "lock-expiry");
      await new Promise((resolve) => setTimeout(resolve, 750));
      await admin.query("COMMIT");
      expect((await waiting).kind).toBe("expired");
    });
    completedTestCount += 1;
  });

  test("temporarily throttles active leases and permanently caps consumed attempts", async () => {
    await withSchema(async (connection, admin) => {
      const session = proofSession("attempt-budget", "user-a", "2".repeat(64), "none");
      await insertSession(admin, session);
      await admin.query(
        "DELETE FROM verification_completion_attempts WHERE proof_session_id = $1",
        [session.id],
      );
      const store = storeFor(connection);
      const concurrent = await Promise.all(
        ["budget-1", "budget-2", "budget-3", "budget-4", "budget-5"].map((key) =>
          reserveAttempt(store, session.id, key),
        ),
      );
      expect(concurrent.filter((result) => result.kind === "acquired")).toHaveLength(3);
      expect(concurrent.filter((result) => result.kind === "in_flight")).toHaveLength(2);
      const first = concurrent.find((result) => result.kind === "acquired");
      if (first?.kind !== "acquired") throw new Error("expected an acquired reservation");
      await Effect.runPromise(Effect.scoped(store.releaseAttempt(first.reservation)));
      const released = await admin.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM verification_completion_attempts WHERE attempt_id = $1",
        [first.reservation.attempt_id],
      );
      const releasedKey = released.rows[0]?.idempotency_key;
      if (releasedKey === undefined) throw new Error("expected the released idempotency key");
      expect((await reserveAttempt(store, session.id, "budget-refill")).kind).toBe("acquired");
      expect((await reserveAttempt(store, session.id, releasedKey)).kind).toBe("in_flight");
      const active = await admin.query<{ attempt_id: string }>(
        `SELECT attempt_id
           FROM verification_completion_attempts
          WHERE proof_session_id = $1 AND state = 'leased'
          ORDER BY attempt_id
          LIMIT 1`,
        [session.id],
      );
      const staleAttempt = active.rows[0]?.attempt_id;
      if (staleAttempt === undefined) throw new Error("expected an active reservation");
      await admin.query(
        `UPDATE verification_completion_attempts
            SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
          WHERE attempt_id = $1`,
        [staleAttempt],
      );
      expect((await reserveAttempt(store, session.id, "budget-after-expiry")).kind).toBe(
        "acquired",
      );
      await admin.query(
        `UPDATE verification_completion_attempts
            SET state = 'consumed', updated_at = clock_timestamp()
          WHERE proof_session_id = $1 AND state = 'leased'`,
        [session.id],
      );
      expect((await reserveAttempt(store, session.id, "budget-permanently-spent")).kind).toBe(
        "budget_exhausted",
      );
    });
    completedTestCount += 1;
  });

  test("releases a provider-unavailable generation for same-key retry", async () => {
    await withSchema(async (connection, admin) => {
      const session = proofSession("attempt-release", "user-a", "3".repeat(64), "none");
      await insertSession(admin, session);
      await admin.query(
        "DELETE FROM verification_completion_attempts WHERE proof_session_id = $1",
        [session.id],
      );
      const store = storeFor(connection);
      const first = await reserveAttempt(store, session.id, "retry-key");
      if (first.kind !== "acquired") throw new Error("expected first reservation");
      await Effect.runPromise(Effect.scoped(store.releaseAttempt(first.reservation)));
      const second = await reserveAttempt(store, session.id, "retry-key");
      expect(second.kind).toBe("acquired");
      if (second.kind === "acquired") {
        expect(second.reservation.fence_token).toBe(first.reservation.fence_token + 1);
      }
    });
    completedTestCount += 1;
  });

  test("rejects a stale finalizer without writing evidence", async () => {
    await withSchema(async (connection, admin) => {
      const session = proofSession("attempt-stale", "user-a", "4".repeat(64), "establish");
      await insertSession(admin, session);
      await admin.query(
        "DELETE FROM verification_completion_attempts WHERE proof_session_id = $1",
        [session.id],
      );
      const store = storeFor(connection);
      const first = await reserveAttempt(store, session.id, "stale-key");
      if (first.kind !== "acquired") throw new Error("expected first reservation");
      await admin.query(
        `UPDATE verification_completion_attempts
            SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
          WHERE attempt_id = $1`,
        [first.reservation.attempt_id],
      );
      const second = await reserveAttempt(store, session.id, "stale-key");
      if (second.kind !== "acquired") throw new Error("expected reacquisition");
      const staleInput = {
        ...commitInput(session, "5".repeat(64), "6".repeat(64)),
        idempotency_key: "stale-key",
        attempt: first.reservation,
      };
      expect(await Effect.runPromise(Effect.scoped(store.commit(staleInput)))).toEqual({
        kind: "rejected",
        reason: "unavailable",
      });
      expect(
        (
          await admin.query("SELECT count(*) FROM evidence_receipts WHERE proof_session_id = $1", [
            session.id,
          ])
        ).rows[0]?.count,
      ).toBe("0");
      expect(
        (
          await admin.query(
            "SELECT state, fence_token FROM verification_completion_attempts WHERE attempt_id = $1",
            [second.kind === "acquired" ? second.reservation.attempt_id : "missing"],
          )
        ).rows[0],
      ).toMatchObject({ state: "leased", fence_token: "2" });
    });
    completedTestCount += 1;
  });

  test("commits one complete ledger and returns replay under concurrent callbacks", async () => {
    await withSchema(async (connection, admin) => {
      const session = proofSession("session-concurrent", "user-a", "1".repeat(64), "establish");
      await insertSession(admin, session);
      const store = storeFor(connection);
      const request = commitInput(session, "2".repeat(64), "4".repeat(64));
      const settled = await Promise.allSettled([
        Effect.runPromise(Effect.scoped(store.commit(request))),
        Effect.runPromise(Effect.scoped(store.commit(request))),
      ]);
      const outcomes = settled.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["committed", "replay"]);
      for (const table of [
        "subject_keys",
        "subject_key_binding_events",
        "active_subject_key_bindings",
        "evidence_receipts",
        "assertion_bindings",
        "proof_session_completion_events",
      ]) {
        const count = await admin.query<{ count: string }>(`SELECT count(*) FROM ${table}`);
        expect(count.rows[0]?.count).toBe("1");
      }
      const assertions = await admin.query<{ count: string }>("SELECT count(*) FROM assertions");
      expect(assertions.rows[0]?.count).toBe("2");
      const receiptMetadata = await admin.query<{ receipt_metadata: unknown }>(
        "SELECT receipt_metadata FROM evidence_receipts WHERE proof_session_id = $1",
        [session.id],
      );
      expect(receiptMetadata.rows[0]?.receipt_metadata).toEqual({
        credential_type: "test_document",
        source_attestation_id: "test-1",
      });
      const loaded = await Effect.runPromise(
        Effect.scoped(store.load({ proof_session_id: session.id })),
      );
      expect(loaded?.terminal).toEqual({
        status: "completed",
        idempotency_key: request.idempotency_key,
        result_hash: "4".repeat(64),
      });
      expect(
        await Effect.runPromise(
          Effect.scoped(store.commit({ ...request, idempotency_key: "callback-conflict" })),
        ),
      ).toEqual({ kind: "rejected", reason: "terminal" });
      expect(
        await Effect.runPromise(
          Effect.scoped(store.commit({ ...request, result_hash: "5".repeat(64) })),
        ),
      ).toEqual({ kind: "rejected", reason: "terminal" });

      const expired = proofSession("session-expired", "user-a", "6".repeat(64), "establish");
      const expiredSession: ProofSession = {
        ...expired,
        started_at: "2026-08-15T00:00:00.000Z",
        expires_at: "2026-08-16T00:00:00.000Z",
      };
      await insertSession(admin, expiredSession);
      expect(
        await Effect.runPromise(
          Effect.scoped(store.commit(commitInput(expiredSession, "7".repeat(64), "8".repeat(64)))),
        ),
      ).toEqual({ kind: "rejected", reason: "expired" });
      const expiredLedger = await admin.query<{ count: string }>(
        "SELECT count(*) FROM evidence_receipts WHERE proof_session_id = 'session-expired'",
      );
      expect(expiredLedger.rows[0]?.count).toBe("0");

      const databaseClock = await admin.query<{ database_now: Date }>(
        "SELECT clock_timestamp() AS database_now",
      );
      const databaseNow = databaseClock.rows[0]?.database_now;
      if (!(databaseNow instanceof Date)) throw new Error("expected the Postgres clock");
      const crossingSession: ProofSession = {
        ...proofSession("session-cross-expiry", "user-a", "9".repeat(64), "establish"),
        started_at: new Date(databaseNow.getTime() - 60_000).toISOString(),
        expires_at: new Date(databaseNow.getTime() + 1_000).toISOString(),
      };
      await insertSession(admin, crossingSession);
      await admin.query(`CREATE FUNCTION test_delay_crossing_receipt()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(1.5);
          RETURN NEW;
        END;
        $$`);
      await admin.query(`CREATE TRIGGER test_delay_crossing_receipt
        BEFORE INSERT ON evidence_receipts
        FOR EACH ROW
        WHEN (NEW.proof_session_id = 'session-cross-expiry')
        EXECUTE FUNCTION test_delay_crossing_receipt()`);
      const crossingStartedAt = performance.now();
      const crossingOutcome = await Effect.runPromise(
        Effect.scoped(store.commit(commitInput(crossingSession, "a".repeat(64), "b".repeat(64)))),
      );
      const crossingElapsed = performance.now() - crossingStartedAt;
      await admin.query("DROP TRIGGER test_delay_crossing_receipt ON evidence_receipts");
      await admin.query("DROP FUNCTION test_delay_crossing_receipt()");
      expect(crossingElapsed).toBeGreaterThanOrEqual(1_300);
      expect(crossingOutcome).toEqual({ kind: "rejected", reason: "expired" });
      expect(
        (
          await admin.query<{ status: string }>(
            "SELECT status FROM proof_sessions WHERE proof_session_id = 'session-cross-expiry'",
          )
        ).rows[0]?.status,
      ).toBe("pending");
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*) FROM evidence_receipts WHERE proof_session_id = 'session-cross-expiry'",
          )
        ).rows[0]?.count,
      ).toBe("0");
    });
    completedTestCount += 1;
  });

  test("rolls back ordinary cross-account binding and permits an explicit recovery epoch", async () => {
    await withSchema(async (connection, admin) => {
      const initial = proofSession("session-initial", "user-a", "5".repeat(64), "establish");
      const ordinary = proofSession("session-ordinary", "user-b", "6".repeat(64), "establish");
      const recovery = proofSession("session-recovery", "user-b", "7".repeat(64), "recover");
      await insertSession(admin, initial);
      await insertSession(admin, ordinary);
      await insertSession(admin, recovery);
      const store = storeFor(connection);
      expect(
        await Effect.runPromise(
          Effect.scoped(store.commit(commitInput(initial, "8".repeat(64), "9".repeat(64)))),
        ),
      ).toMatchObject({ kind: "committed" });
      expect(
        await Effect.runPromise(
          Effect.scoped(store.commit(commitInput(ordinary, "a".repeat(64), "b".repeat(64)))),
        ),
      ).toEqual({ kind: "rejected", reason: "binding_conflict" });
      expect(
        await Effect.runPromise(
          Effect.scoped(store.commit(commitInput(recovery, "c".repeat(64), "d".repeat(64)))),
        ),
      ).toMatchObject({ kind: "committed" });

      const active = await admin.query<{ user_id: string; binding_epoch: string }>(
        "SELECT user_id, binding_epoch::text FROM active_subject_key_bindings",
      );
      expect(active.rows).toEqual([{ user_id: "user-b", binding_epoch: "2" }]);
      const ordinaryStatus = await admin.query<{ status: string }>(
        "SELECT status FROM proof_sessions WHERE proof_session_id = 'session-ordinary'",
      );
      expect(ordinaryStatus.rows[0]?.status).toBe("pending");
      const receiptCount = await admin.query<{ count: string }>(
        "SELECT count(*) FROM evidence_receipts",
      );
      expect(receiptCount.rows[0]?.count).toBe("2");
    });
    completedTestCount += 1;
  });

  test("atomically advances a Very-backed creation intent and replays once", async () => {
    await withSchema(async (connection, admin) => {
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const creationStore = makeControlPlaneCommunityCreationStore(runtime, {
        next_intent_id: () => "community-intent-1",
        next_community_id: () => "community-jazleeuw",
        next_subject_claim_id: () => "creation-claim-jazleeuw",
      });
      const created = await Effect.runPromise(
        creationStore.create({
          actor: { kind: "user", userId: "user-a" },
          requestHash: "a".repeat(64),
          body: {
            idempotency_key: "create-community-1",
            draft: {
              name: "Jazleeuw",
              slug: "jazleeuw",
              description: "Verified people",
              policy: {
                version: 1,
                accessPaths: [
                  {
                    id: "verified-people",
                    operator: "and",
                    requirements: [{ requirement: "human-verification" }],
                  },
                ],
              },
            },
          },
        }),
      );
      expect(created.status).toBe("verification_required");

      const session = communityCreationProofSession(created.intent_id);
      await insertSession(admin, session);
      const completionStore = storeFor(connection);
      const request = {
        ...commitInput(session, "e".repeat(64), "f".repeat(64)),
        bundle: veryEvidenceBundle(session, "e".repeat(64)),
      };
      expect(await Effect.runPromise(Effect.scoped(completionStore.commit(request)))).toEqual({
        kind: "committed",
        result_hash: "f".repeat(64),
      });

      const advanced = await admin.query<{
        revision: number;
        status: string;
        operation_kind: string;
        request_hash: string;
      }>(
        `SELECT intent.revision, intent.status, revision.operation_kind, revision.request_hash
           FROM community_creation_intents AS intent
           JOIN community_creation_intent_revisions AS revision
             ON revision.intent_id = intent.intent_id
            AND revision.revision = intent.revision
          WHERE intent.intent_id = $1`,
        [created.intent_id],
      );
      expect(advanced.rows).toEqual([
        {
          revision: 2,
          status: "commit_ready",
          operation_kind: "verification",
          request_hash: "f".repeat(64),
        },
      ]);

      await expect(
        Effect.runPromise(
          Effect.scoped(
            completionStore.settleCompleted({
              actor_id: session.actor_id,
              proof_session_id: session.id,
              idempotency_key: request.idempotency_key,
              result_hash: request.result_hash,
            }),
          ),
        ),
      ).resolves.toBeUndefined();
      expect(await Effect.runPromise(Effect.scoped(completionStore.commit(request)))).toEqual({
        kind: "replay",
        result_hash: "f".repeat(64),
      });
      const counts = await admin.query<{
        completion_events: number;
        verification_revisions: number;
      }>(`SELECT
        (SELECT COUNT(*)::integer FROM proof_session_completion_events
          WHERE proof_session_id = 'community-creation-proof') AS completion_events,
        (SELECT COUNT(*)::integer FROM community_creation_intent_revisions
          WHERE intent_id = 'community-intent-1'
            AND operation_kind = 'verification') AS verification_revisions`);
      expect(counts.rows).toEqual([{ completion_events: 1, verification_revisions: 1 }]);

      const commitRequest = {
        actor: { kind: "user" as const, userId: "user-a" },
        intentId: created.intent_id,
        requestHash: "1".repeat(64),
        body: { idempotency_key: "commit-community-1", expected_revision: 2 },
      };
      const committed = await Effect.runPromise(creationStore.commit(commitRequest));
      expect(committed).toMatchObject({
        revision: 3,
        status: "committed",
        next_action: { kind: "none", reason: "committed" },
        committed_resource: {
          community_id: "community-jazleeuw",
          href: "/communities/community-jazleeuw",
        },
      });
      await expect(Effect.runPromise(creationStore.commit(commitRequest))).resolves.toEqual(
        committed,
      );
      await expect(
        Effect.runPromise(creationStore.commit({ ...commitRequest, requestHash: "2".repeat(64) })),
      ).rejects.toMatchObject({
        _tag: "CommunityCreationRepositoryError",
        reason: "idempotency-conflict",
      });

      const committedRows = await admin.query<{
        description: string;
        display_name: string;
        route_slug: string;
        membership_mode: string;
        human_verification_lane: string;
        policy_version_id: string;
        policy_key: string;
        provider_id: string;
        issuer: string;
        scope_kind: string;
        issuer_rp_scope: string;
        request_mode: string;
        evaluator_id: string;
        slot_number: number;
        approval_id: string | null;
      }>(
        `SELECT community.description, community.display_name, community.route_slug,
                community.membership_mode, community.human_verification_lane,
                policy.policy_version_id, policy.policy_key,
                binding.provider_id, binding.issuer, binding.scope_kind,
                binding.issuer_rp_scope, binding.request_mode, binding.evaluator_id,
                claim.slot_number, claim.approval_id
           FROM communities AS community
           JOIN policy_versions AS policy
             ON policy.community_id = community.community_id
           JOIN community_policy_current AS current_policy
             ON current_policy.community_id = policy.community_id
            AND current_policy.policy_key = policy.policy_key
            AND current_policy.policy_version_id = policy.policy_version_id
           JOIN community_policy_provider_bindings AS binding
             ON binding.community_id = policy.community_id
            AND binding.policy_key = policy.policy_key
            AND binding.policy_version_id = policy.policy_version_id
           JOIN community_creation_subject_claims AS claim
             ON claim.community_id = community.community_id
          WHERE community.community_id = 'community-jazleeuw'`,
      );
      expect(committedRows.rows).toEqual([
        {
          description: "Verified people",
          display_name: "Jazleeuw",
          route_slug: "jazleeuw",
          membership_mode: "gated",
          human_verification_lane: "very",
          policy_version_id: "curated-human-membership-v1",
          policy_key: "curated-human-membership",
          provider_id: "very.oauth",
          issuer: "https://connect.very.org",
          scope_kind: "issuer_rp_scope",
          issuer_rp_scope: "pirate-social",
          request_mode: "dynamic",
          evaluator_id: "curated-human-membership-v1",
          slot_number: 1,
          approval_id: null,
        },
      ]);
      const derivedCounts = await admin.query<{
        communities: number;
        claims: number;
        commits: number;
        memberships: number;
        follows: number;
      }>(`SELECT
        (SELECT COUNT(*)::integer FROM communities
          WHERE community_id = 'community-jazleeuw') AS communities,
        (SELECT COUNT(*)::integer FROM community_creation_subject_claims
          WHERE intent_id = 'community-intent-1') AS claims,
        (SELECT COUNT(*)::integer FROM community_creation_intent_revisions
          WHERE intent_id = 'community-intent-1' AND operation_kind = 'commit') AS commits,
        (SELECT COUNT(*)::integer FROM community_memberships
          WHERE community_id = 'community-jazleeuw') AS memberships,
        (SELECT COUNT(*)::integer FROM community_follows
          WHERE community_id = 'community-jazleeuw') AS follows`);
      expect(derivedCounts.rows).toEqual([
        { communities: 1, claims: 1, commits: 1, memberships: 0, follows: 0 },
      ]);

      const secondStore = makeControlPlaneCommunityCreationStore(runtime, {
        next_intent_id: () => "community-intent-2",
        next_community_id: () => "community-should-not-exist",
        next_subject_claim_id: () => "creation-claim-should-not-exist",
      });
      const second = await Effect.runPromise(
        secondStore.create({
          actor: { kind: "user", userId: "user-a" },
          requestHash: "3".repeat(64),
          body: {
            idempotency_key: "create-community-2",
            draft: {
              ...created.draft,
              name: "Second community",
              slug: "second-community",
            },
          },
        }),
      );
      const secondEvidence = await cloneCompletedCreationEvidence(admin, {
        sourceSessionId: "community-creation-proof",
        sessionId: "community-creation-proof-2",
        intentId: second.intent_id,
        suffix: "community-2",
      });
      await markCreationIntentCommitReady(admin, second, secondEvidence.resultHash);
      const secondReady = await Effect.runPromise(
        secondStore.get({ actor: { kind: "user", userId: "user-a" }, intentId: second.intent_id }),
      );
      expect(secondReady).toMatchObject({ revision: 2, status: "commit_ready" });
      const quotaExceeded = await Effect.runPromise(
        secondStore.commit({
          actor: { kind: "user", userId: "user-a" },
          intentId: second.intent_id,
          requestHash: "4".repeat(64),
          body: {
            idempotency_key: "commit-community-2",
            expected_revision: secondReady?.revision ?? 0,
          },
        }),
      );
      expect(quotaExceeded).toMatchObject({
        revision: 3,
        status: "quota_exceeded",
        next_action: { kind: "blocked", reason: "quota_exceeded" },
        committed_resource: null,
      });
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*) FROM communities WHERE community_id = 'community-should-not-exist'",
          )
        ).rows[0]?.count,
      ).toBe("0");

      const thirdStore = makeControlPlaneCommunityCreationStore(runtime, {
        next_intent_id: () => "community-intent-3",
        next_community_id: () => "community-approved",
        next_subject_claim_id: () => "creation-claim-approved",
      });
      const third = await Effect.runPromise(
        thirdStore.create({
          actor: { kind: "user", userId: "user-a" },
          requestHash: "5".repeat(64),
          body: {
            idempotency_key: "create-community-3",
            draft: {
              ...created.draft,
              name: "Approved community",
              slug: "approved-community",
            },
          },
        }),
      );
      const thirdEvidence = await cloneCompletedCreationEvidence(admin, {
        sourceSessionId: "community-creation-proof",
        sessionId: "community-creation-proof-3",
        intentId: third.intent_id,
        suffix: "community-3",
      });
      await markCreationIntentCommitReady(admin, third, thirdEvidence.resultHash);
      const thirdReady = await Effect.runPromise(
        thirdStore.get({ actor: { kind: "user", userId: "user-a" }, intentId: third.intent_id }),
      );
      expect(thirdReady).toMatchObject({ revision: 2, status: "commit_ready" });
      const claimedSubject = await admin.query<{ subject_key_id: string }>(
        `SELECT subject_key_id
           FROM community_creation_subject_claims
          WHERE community_id = 'community-jazleeuw'`,
      );
      const claimedSubjectKeyId = claimedSubject.rows[0]?.subject_key_id;
      if (claimedSubjectKeyId === undefined) throw new Error("missing claimed subject fixture");
      await admin.query(
        `INSERT INTO community_creation_quota_approvals (
          approval_id, subject_key_id, actor_id, slot_number,
          approved_by_user_id, reason, expires_at
        ) VALUES (
          'approval-community-3', $1, 'user-a', 2,
          'user-b', 'Operator-approved second community',
          clock_timestamp() + interval '1 hour'
        )`,
        [claimedSubjectKeyId],
      );
      const approved = await Effect.runPromise(
        thirdStore.commit({
          actor: { kind: "user", userId: "user-a" },
          intentId: third.intent_id,
          requestHash: "6".repeat(64),
          body: {
            idempotency_key: "commit-community-3",
            expected_revision: thirdReady?.revision ?? 0,
          },
        }),
      );
      expect(approved).toMatchObject({
        status: "committed",
        committed_resource: { community_id: "community-approved" },
      });
      expect(
        (
          await admin.query<{ slot_number: number; approval_id: string }>(
            `SELECT slot_number, approval_id
               FROM community_creation_subject_claims
              WHERE community_id = 'community-approved'`,
          )
        ).rows,
      ).toEqual([{ slot_number: 2, approval_id: "approval-community-3" }]);

      const raceStores = [
        makeControlPlaneCommunityCreationStore(runtime, {
          next_intent_id: () => "community-intent-race-a",
          next_community_id: () => "community-race-a",
          next_subject_claim_id: () => "creation-claim-race-a",
        }),
        makeControlPlaneCommunityCreationStore(runtime, {
          next_intent_id: () => "community-intent-race-b",
          next_community_id: () => "community-race-b",
          next_subject_claim_id: () => "creation-claim-race-b",
        }),
      ] as const;
      const raceIntents = await Promise.all(
        raceStores.map((store, index) =>
          Effect.runPromise(
            store.create({
              actor: { kind: "user", userId: "user-a" },
              requestHash: `${index === 0 ? "7" : "8"}`.repeat(64),
              body: {
                idempotency_key: `create-community-race-${index}`,
                draft: {
                  ...created.draft,
                  name: `Race community ${index}`,
                  slug: `race-community-${index}`,
                },
              },
            }),
          ),
        ),
      );
      for (const [index, intent] of raceIntents.entries()) {
        const cloned = await cloneCompletedCreationEvidence(admin, {
          sourceSessionId: "community-creation-proof",
          sessionId: `community-creation-proof-race-${index}`,
          intentId: intent.intent_id,
          suffix: `community-race-${index}`,
        });
        await markCreationIntentCommitReady(admin, intent, cloned.resultHash);
      }
      await admin.query(
        `INSERT INTO community_creation_quota_approvals (
          approval_id, subject_key_id, actor_id, slot_number,
          approved_by_user_id, reason, expires_at
        ) VALUES (
          'approval-community-race', $1, 'user-a', 3,
          'user-b', 'One additional concurrent slot',
          clock_timestamp() + interval '1 hour'
        )`,
        [claimedSubjectKeyId],
      );
      const raceResults = await Promise.all(
        raceStores.map((store, index) =>
          Effect.runPromise(
            store.commit({
              actor: { kind: "user", userId: "user-a" },
              intentId: raceIntents[index]?.intent_id ?? "",
              requestHash: `${index === 0 ? "9" : "a"}`.repeat(64),
              body: {
                idempotency_key: `commit-community-race-${index}`,
                expected_revision: 2,
              },
            }),
          ),
        ),
      );
      expect(raceResults.map((result) => result.status).sort()).toEqual([
        "committed",
        "quota_exceeded",
      ]);
      const raceCounts = await admin.query<{
        communities: number;
        slot_claims: number;
      }>(
        `SELECT
        (SELECT COUNT(*)::integer FROM communities
          WHERE community_id IN ('community-race-a', 'community-race-b')) AS communities,
        (SELECT COUNT(*)::integer FROM community_creation_subject_claims
          WHERE subject_key_id = $1 AND slot_number = 3) AS slot_claims`,
        [claimedSubjectKeyId],
      );
      expect(raceCounts.rows).toEqual([{ communities: 1, slot_claims: 1 }]);

      const rollbackStore = makeControlPlaneCommunityCreationStore(runtime, {
        next_intent_id: () => "community-intent-rollback",
        next_community_id: () => "community-jazleeuw",
        next_subject_claim_id: () => "creation-claim-rollback",
      });
      const rollbackIntent = await Effect.runPromise(
        rollbackStore.create({
          actor: { kind: "user", userId: "user-a" },
          requestHash: "b".repeat(64),
          body: {
            idempotency_key: "create-community-rollback",
            draft: {
              ...created.draft,
              name: "Rollback community",
              slug: "rollback-community",
            },
          },
        }),
      );
      const rollbackEvidence = await cloneCompletedCreationEvidence(admin, {
        sourceSessionId: "community-creation-proof",
        sessionId: "community-creation-proof-rollback",
        intentId: rollbackIntent.intent_id,
        suffix: "community-rollback",
      });
      await markCreationIntentCommitReady(admin, rollbackIntent, rollbackEvidence.resultHash);
      await admin.query(
        `INSERT INTO community_creation_quota_approvals (
          approval_id, subject_key_id, actor_id, slot_number,
          approved_by_user_id, reason, expires_at
        ) VALUES (
          'approval-community-rollback', $1, 'user-a', 4,
          'user-b', 'Rollback fixture slot',
          clock_timestamp() + interval '1 hour'
        )`,
        [claimedSubjectKeyId],
      );
      await expect(
        Effect.runPromise(
          rollbackStore.commit({
            actor: { kind: "user", userId: "user-a" },
            intentId: rollbackIntent.intent_id,
            requestHash: "c".repeat(64),
            body: { idempotency_key: "commit-community-rollback", expected_revision: 2 },
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "ControlPlaneStatementFailed",
        constraint: "communities_pkey",
      });
      await expect(
        Effect.runPromise(
          rollbackStore.get({
            actor: { kind: "user", userId: "user-a" },
            intentId: rollbackIntent.intent_id,
          }),
        ),
      ).resolves.toMatchObject({ revision: 2, status: "commit_ready" });
      const rollbackCounts = await admin.query<{ claims: number; policies: number }>(`SELECT
        (SELECT COUNT(*)::integer FROM community_creation_subject_claims
          WHERE intent_id = 'community-intent-rollback') AS claims,
        (SELECT COUNT(*)::integer FROM policy_versions
          WHERE community_id = 'community-jazleeuw'
            AND created_by_user_id = 'user-a') AS policies`);
      expect(rollbackCounts.rows).toEqual([{ claims: 0, policies: 1 }]);
    });
    completedTestCount += 1;
  });

  test("serializes Very completion before creation commit without a lock-order cycle", async () => {
    await withSchema(async (connection, admin) => {
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const creationStore = makeControlPlaneCommunityCreationStore(runtime, {
        next_intent_id: () => "community-intent-lock-order",
        next_community_id: () => "community-lock-order",
        next_subject_claim_id: () => "creation-claim-lock-order",
      });
      const created = await Effect.runPromise(
        creationStore.create({
          actor: { kind: "user", userId: "user-a" },
          requestHash: "3".repeat(64),
          body: {
            idempotency_key: "create-community-lock-order",
            draft: {
              name: "Lock order",
              slug: "lock-order",
              description: null,
              policy: {
                version: 1,
                accessPaths: [
                  {
                    id: "verified-people",
                    operator: "and",
                    requirements: [{ requirement: "human-verification" }],
                  },
                ],
              },
            },
          },
        }),
      );
      const session = {
        ...communityCreationProofSession(created.intent_id),
        id: "community-creation-proof-lock-order",
        upstream_session_ref: "very-session-lock-order",
      };
      await insertSession(admin, session);
      await admin.query(`CREATE FUNCTION delay_lock_order_receipt()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(1);
          RETURN NEW;
        END;
        $$`);
      await admin.query(`CREATE TRIGGER delay_lock_order_receipt
        BEFORE INSERT ON evidence_receipts
        FOR EACH ROW
        WHEN (NEW.proof_session_id = 'community-creation-proof-lock-order')
        EXECUTE FUNCTION delay_lock_order_receipt()`);

      const completionStore = storeFor(connection);
      const completion = Effect.runPromise(
        Effect.scoped(
          completionStore.commit({
            ...commitInput(session, "4".repeat(64), "5".repeat(64)),
            bundle: veryEvidenceBundle(session, "4".repeat(64)),
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const communityCommit = Effect.runPromise(
        creationStore.commit({
          actor: { kind: "user", userId: "user-a" },
          intentId: created.intent_id,
          requestHash: "6".repeat(64),
          body: {
            idempotency_key: "commit-community-lock-order",
            expected_revision: 2,
          },
        }),
      );

      await expect(completion).resolves.toEqual({
        kind: "committed",
        result_hash: "5".repeat(64),
      });
      await expect(communityCommit).resolves.toMatchObject({
        status: "committed",
        committed_resource: { community_id: "community-lock-order" },
      });
    });
    completedTestCount += 1;
  });

  test("hashes canonical evidence independently of object key insertion order", async () => {
    const session = proofSession("session-hash", "user-a", "e".repeat(64), "establish");
    const original = evidenceBundle(session, "f".repeat(64));
    const reordered = {
      assertions: original.assertions,
      binding_groups: original.binding_groups,
      receipts: original.receipts,
      subject_keys: original.subject_keys,
      proof_session_id: original.proof_session_id,
      id: original.id,
    } satisfies EvidenceBundle;
    const hasher = makeSha256VerificationCompletionHasher();
    const [left, right] = await Promise.all([
      Effect.runPromise(hasher.hash(original)),
      Effect.runPromise(hasher.hash(reordered)),
    ]);
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/u);
    completedTestCount += 1;
  });
});

afterAll(async () => {
  if (connectionString !== undefined && completedTestCount === foundationTestCount) {
    await Bun.write(sentinelPath, sentinelContents);
  }
});
