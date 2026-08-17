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
const expectedTestCount = 5;
let completedTestCount = 0;

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
    expires_at: "2026-08-18T00:00:00.000Z",
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

suite("Postgres 17 verification session start repository", () => {
  test("creates and replays the exact pending session and presentation", async () => {
    await withSchema(async (connection, admin) => {
      const start = startFor("start-created");
      const store = storeFor(connection);
      const created = await Effect.runPromise(Effect.scoped(store.commit(start)));
      const replay = await Effect.runPromise(Effect.scoped(store.commit(start)));
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
        Effect.runPromise(Effect.scoped(store.commit(start))),
        Effect.runPromise(Effect.scoped(store.commit(start))),
      ]);
      const outcomes = settled.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value.kind;
      });
      expect(outcomes.sort()).toEqual(["created", "replay"]);
      expect((await admin.query("SELECT count(*) FROM proof_sessions")).rows[0]?.count).toBe("1");
    });
    completedTestCount += 1;
  });

  test("returns conflict when an actor and intent are reused with another identity", async () => {
    await withSchema(async (connection) => {
      const start = startFor("start-conflict", "user-a", "intent-conflict");
      const store = storeFor(connection);
      await Effect.runPromise(Effect.scoped(store.commit(start)));
      const mismatch = startFor("different-session", "user-a", "intent-conflict");
      expect(await Effect.runPromise(Effect.scoped(store.commit(mismatch)))).toEqual({
        kind: "conflict",
      });
    });
    completedTestCount += 1;
  });

  test("round-trips provider configuration, upstream reference, full scope and presentation", async () => {
    await withSchema(async (connection, admin) => {
      const start = startFor("start-roundtrip");
      const store = storeFor(connection);
      await Effect.runPromise(Effect.scoped(store.commit(start)));
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
      await expect(Effect.runPromise(Effect.scoped(store.commit(start)))).rejects.toBeDefined();
      expect((await admin.query("SELECT count(*) FROM proof_sessions")).rows[0]?.count).toBe("0");
      expect(
        (await admin.query("SELECT count(*) FROM proof_session_presentations")).rows[0]?.count,
      ).toBe("0");
    });
    completedTestCount += 1;
  });
});

afterAll(async () => {
  if (connectionString !== undefined && completedTestCount === expectedTestCount) {
    await Bun.write(sentinelPath, sentinelContents);
  }
});
