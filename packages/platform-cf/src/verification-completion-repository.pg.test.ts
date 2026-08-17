import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  EvidenceBundle,
  ProofSession,
  SubjectBindingIntent,
} from "@pirate/domain/verification";
import { Effect } from "effect";
import { Client } from "pg";
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
const foundationTestCount = 3;

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
    method: "document",
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: "test.complete",
      rp_scope: "pirate.example",
    },
    requested_claim_ids: ["document.valid", "credential.subject_unique"],
    subject_binding_intent: bindingIntent,
    protocol_version: "complete-v1",
    environment: "test",
    status: "pending",
    started_at: "2026-08-17T00:00:00.000Z",
    expires_at: "2026-08-18T00:00:00.000Z",
  };
}

async function insertSession(admin: Client, session: ProofSession): Promise<void> {
  const scope = session.scope;
  if (scope.kind !== "named") throw new Error("test session must use a named scope");
  await admin.query({
    text: `INSERT INTO proof_sessions (
      proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
      scope_kind, issuer_rp_scope, issuer_rp_action_scope, protocol_version, environment,
      status, requested_claim_ids, subject_binding_intent, started_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13::jsonb,
      $14, $15, $16)`,
    values: [
      session.id,
      session.actor_id,
      session.intent_id,
      session.request_hash,
      session.provider_id,
      session.method,
      scope.issuer,
      scope.scope_semantics,
      scope.rp_scope,
      scope.scope_semantics === "issuer_rp_action_scope" ? scope.action_scope : null,
      session.protocol_version,
      session.environment,
      JSON.stringify(session.requested_claim_ids),
      session.subject_binding_intent,
      session.started_at,
      session.expires_at,
    ],
  });
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
        protocol_version: "complete-v1",
        environment: "test",
        provenance_kind: "proof_session",
        evidence_kind: "document",
        evidence_hash: evidenceHash,
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

function storeFor(connection: string) {
  return makeControlPlaneVerificationCompletionStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
}

function commitInput(session: ProofSession, evidenceHash: string, resultHash: string) {
  return {
    actor_id: session.actor_id,
    idempotency_key: `callback-${session.id}`,
    expected_session: session,
    result_hash: resultHash,
    bundle: evidenceBundle(session, evidenceHash),
  } as const;
}

suite("Postgres 17 verification completion repository", () => {
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
