import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProviderSessionStart } from "@pirate/application/verification";
import type { ProofSession } from "@pirate/domain/verification";
import { Effect } from "effect";
import { Client } from "pg";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";
import { applyPostgresMigrations, type PostgresMigration } from "./postgres-migrations";
import { makeControlPlaneVerificationSessionStartStore } from "./verification-start-repository";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_VERIFICATION_START_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-verification-start-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-verification-start-suite-complete\n";
const expectedTestCount = 10;
let completedTestCount = 0;
// Keep the ordinary pending-session fixture valid independently of the day the
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
  return `api_next_verification_start_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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

function startFor(id: string, actorId = "user-a", intentId = `intent-${id}`): ProviderSessionStart {
  const session: ProofSession = {
    id,
    actor_id: actorId,
    intent_id: intentId,
    request_hash: "1".repeat(64),
    provider_id: "test.start",
    upstream_session_ref: `upstream-${id}`,
    provider_configuration: { kind: "dynamic", reference: "query-v1", version: "1" },
    method: "document",
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_action_scope",
      issuer: "test.start",
      rp_scope: "pirate.example",
      action_scope: "join",
    },
    request_mode: "dynamic",
    requested_requirements: [{ claim_id: "document.valid" }],
    requested_claim_ids: ["document.valid"],
    subject_binding_intent: "establish",
    protocol_version: "start-v1",
    environment: "test",
    status: "pending",
    started_at: "2026-08-17T00:00:00.000Z",
    expires_at: defaultSessionExpiresAt,
  };
  return {
    session,
    presentation: {
      kind: "redirect",
      session_id: id,
      url: `https://provider.example/sessions/${id}`,
    },
  };
}

function storeFor(connection: string) {
  return makeControlPlaneVerificationSessionStartStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
}

async function reserve(store: ReturnType<typeof storeFor>, start: ProviderSessionStart) {
  return Effect.runPromise(Effect.scoped(store.reserve({ start: start.session, ttl_ms: 60_000 })));
}

async function finalize(store: ReturnType<typeof storeFor>, start: ProviderSessionStart) {
  const reservation = await reserve(store, start);
  if (reservation.kind !== "acquired")
    throw new Error(`expected reservation, got ${reservation.kind}`);
  return Effect.runPromise(Effect.scoped(store.finalize(reservation.reservation, start)));
}

suite("Postgres 17 verification session start repository", () => {
  test("creates and replays the exact pending session and presentation", async () => {
    await withSchema(async (connection, admin) => {
      const start = startFor("start-created");
      const store = storeFor(connection);
      const created = await finalize(store, start);
      const replay = await Effect.runPromise(
        Effect.scoped(store.reserve({ start: start.session, ttl_ms: 60_000 })),
      );
      expect(created.kind).toBe("created");
      expect(replay).toEqual({ kind: "replay", start });
      expect((await admin.query("SELECT count(*) FROM proof_sessions")).rows[0]?.count).toBe("1");
      expect(
        (await admin.query("SELECT count(*) FROM proof_session_presentations")).rows[0]?.count,
      ).toBe("1");
    });
    completedTestCount += 1;
  });

  test("allows only one created session for concurrent same-intent starts", async () => {
    await withSchema(async (connection, admin) => {
      const start = startFor("start-concurrent", "user-a", "intent-concurrent");
      const store = storeFor(connection);
      const settled = await Promise.allSettled([
        Effect.runPromise(Effect.scoped(store.reserve({ start: start.session, ttl_ms: 60_000 }))),
        Effect.runPromise(Effect.scoped(store.reserve({ start: start.session, ttl_ms: 60_000 }))),
      ]);
      const outcomes = settled.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value.kind;
      });
      expect(outcomes.sort()).toEqual(["acquired", "in_flight"]);
      expect((await admin.query("SELECT count(*) FROM proof_sessions")).rows[0]?.count).toBe("0");
    });
    completedTestCount += 1;
  });

  test("returns conflict when an actor and intent are reused with another identity", async () => {
    await withSchema(async (connection) => {
      const start = startFor("start-conflict", "user-a", "intent-conflict");
      const store = storeFor(connection);
      await Effect.runPromise(
        Effect.scoped(store.reserve({ start: start.session, ttl_ms: 60_000 })),
      );
      const mismatch = startFor("different-session", "user-a", "intent-conflict");
      const mismatchedSession = {
        ...mismatch.session,
        request_hash: "2".repeat(64),
      };
      expect(
        await Effect.runPromise(
          Effect.scoped(store.reserve({ start: mismatchedSession, ttl_ms: 60_000 })),
        ),
      ).toEqual({
        kind: "conflict",
      });
    });
    completedTestCount += 1;
  });

  test("compares the persisted session request hash before replay", async () => {
    await withSchema(async (connection) => {
      const start = startFor("start-session-hash", "user-a", "intent-session-hash");
      const store = storeFor(connection);
      await finalize(store, start);
      const mismatch = {
        ...startFor("different-session", "user-a", "intent-session-hash"),
        session: { ...start.session, id: "different-session", request_hash: "2".repeat(64) },
      };
      expect(
        await Effect.runPromise(
          Effect.scoped(store.reserve({ start: mismatch.session, ttl_ms: 60_000 })),
        ),
      ).toEqual({ kind: "conflict" });
    });
    completedTestCount += 1;
  });

  test("does not replay an expired pending session", async () => {
    await withSchema(async (connection) => {
      const start = startFor("start-expired", "user-a", "intent-expired");
      const expired = {
        ...start,
        session: { ...start.session, expires_at: "2020-01-01T00:00:00.000Z" },
      };
      const store = storeFor(connection);
      await finalize(store, expired);
      expect(
        await Effect.runPromise(
          Effect.scoped(store.reserve({ start: expired.session, ttl_ms: 60_000 })),
        ),
      ).toMatchObject({ kind: "terminal", status: "expired", start: expired });
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
      const start = startFor("start-lock-expiry", "user-a", "intent-lock-expiry");
      const expiring = {
        ...start,
        session: {
          ...start.session,
          started_at: new Date(databaseNow.getTime() - 60_000).toISOString(),
          expires_at: new Date(databaseNow.getTime() + 500).toISOString(),
        },
      };
      const store = storeFor(connection);
      await finalize(store, expiring);
      await admin.query("BEGIN");
      await admin.query(
        "SELECT proof_session_id FROM proof_sessions WHERE proof_session_id = $1 FOR UPDATE",
        [expiring.session.id],
      );
      const waiting = reserve(store, expiring);
      await new Promise((resolve) => setTimeout(resolve, 750));
      await admin.query("COMMIT");
      expect(await waiting).toMatchObject({ kind: "terminal", status: "expired" });
    });
    completedTestCount += 1;
  });

  test("uses the database clock for lease expiry and reacquisition", async () => {
    await withSchema(async (connection, admin) => {
      const start = startFor("start-lease-expiry", "user-a", "intent-lease-expiry");
      const store = storeFor(connection);
      const first = await reserve(store, start);
      if (first.kind !== "acquired") throw new Error("expected initial reservation");
      await admin.query(
        `UPDATE verification_start_reservations
            SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
          WHERE reservation_id = $1`,
        [first.reservation.reservation_id],
      );
      const second = await reserve(store, start);
      expect(second.kind).toBe("acquired");
      if (second.kind === "acquired") {
        expect(second.reservation.fence_token).toBe(first.reservation.fence_token + 1);
      }
    });
    completedTestCount += 1;
  });

  test("round-trips provider configuration, upstream reference, full scope and presentation", async () => {
    await withSchema(async (connection, admin) => {
      const start = startFor("start-roundtrip");
      const store = storeFor(connection);
      await finalize(store, start);
      const row = await admin.query(
        `SELECT provider_configuration_kind, provider_configuration_ref,
                provider_configuration_version, upstream_session_ref,
                scope_kind, issuer_rp_scope, issuer_rp_action_scope,
                requested_requirements, requested_claim_ids, started_at, expires_at
           FROM proof_sessions
          WHERE proof_session_id = $1`,
        [start.session.id],
      );
      expect(row.rows[0]).toMatchObject({
        provider_configuration_kind: "dynamic",
        provider_configuration_ref: "query-v1",
        provider_configuration_version: "1",
        upstream_session_ref: "upstream-start-roundtrip",
        scope_kind: "issuer_rp_action_scope",
        issuer_rp_scope: "pirate.example",
        issuer_rp_action_scope: "join",
      });
      const presentation = await admin.query(
        "SELECT presentation_kind, payload FROM proof_session_presentations WHERE proof_session_id = $1",
        [start.session.id],
      );
      if (start.presentation.kind !== "redirect") {
        throw new Error("start fixture must use a redirect presentation");
      }
      expect(presentation.rows[0]).toEqual({
        presentation_kind: "redirect",
        payload: { session_id: start.session.id, url: start.presentation.url },
      });
    });
    completedTestCount += 1;
  });

  test("rolls back the session when presentation persistence fails", async () => {
    await withSchema(async (connection, admin) => {
      await admin.query(`
        CREATE FUNCTION test_reject_start_presentation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'presentation insert rejected'; END;
        $$;
        CREATE TRIGGER test_reject_start_presentation
        BEFORE INSERT ON proof_session_presentations
        FOR EACH ROW EXECUTE FUNCTION test_reject_start_presentation();
      `);
      const start = startFor("start-rollback");
      const store = storeFor(connection);
      const reservation = await reserve(store, start);
      if (reservation.kind !== "acquired") throw new Error("expected reservation");
      await expect(
        Effect.runPromise(Effect.scoped(store.finalize(reservation.reservation, start))),
      ).rejects.toBeDefined();
      expect((await admin.query("SELECT count(*) FROM proof_sessions")).rows[0]?.count).toBe("0");
      expect(
        (await admin.query("SELECT count(*) FROM proof_session_presentations")).rows[0]?.count,
      ).toBe("0");
    });
    completedTestCount += 1;
  });

  test("rejects a stale finalizer before inserting session rows", async () => {
    await withSchema(async (connection, admin) => {
      const start = startFor("start-stale-finalizer");
      const store = storeFor(connection);
      const reservation = await reserve(store, start);
      if (reservation.kind !== "acquired") throw new Error("expected reservation");
      await admin.query(
        `UPDATE verification_start_reservations
            SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
          WHERE reservation_id = $1`,
        [reservation.reservation.reservation_id],
      );
      const reacquired = await reserve(store, start);
      if (reacquired.kind !== "acquired") throw new Error("expected reacquisition");
      expect(reacquired.reservation.fence_token).toBe(reservation.reservation.fence_token + 1);
      expect(
        await Effect.runPromise(Effect.scoped(store.finalize(reservation.reservation, start))),
      ).toEqual({ kind: "stale" });
      expect((await admin.query("SELECT count(*) FROM proof_sessions")).rows[0]?.count).toBe("0");
      expect(
        (await admin.query("SELECT count(*) FROM proof_session_presentations")).rows[0]?.count,
      ).toBe("0");
      expect(
        (
          await admin.query(
            "SELECT state, fence_token FROM verification_start_reservations WHERE reservation_id = $1",
            [reacquired.reservation.reservation_id],
          )
        ).rows[0],
      ).toEqual({ state: "acquired", fence_token: "2" });
    });
    completedTestCount += 1;
  });
});

afterAll(async () => {
  if (connectionString !== undefined && completedTestCount === expectedTestCount) {
    await Bun.write(sentinelPath, sentinelContents);
  }
});
