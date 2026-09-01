import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneKaraokeFinalizationRecoveryStore } from "./karaoke-finalization-recovery.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

suite("Karaoke finalization recovery candidates", () => {
  test("finds expired score work and completed recording work without selecting live sessions", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_karaoke_recovery_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      const scopedConnection = connectionForSchema(connectionString, schema);
      await applyPostgresTestBaselineConnection({ connectionString: scopedConnection });
      await admin.query("SET session_replication_role = replica");
      try {
        const insertSession = async (
          id: string,
          status: "active" | "completed",
          expiresAt: string,
        ) =>
          admin.query(
            `INSERT INTO karaoke_sessions (
               session_id,attempt_id,account_id,persona_id,community_id,post_id,
               audio_revision,karaoke_revision_id,qualification_policy_version_id,
               idempotency_key,request_hash,timezone,status,created_at,expires_at,
               completed_at,lyrics_revision,line_snapshot
             ) VALUES ($1,$2,'account','persona','community','post',1,'revision',
               'karaoke_qualification_v2@1',$3,$4,'UTC',$5,
               '2026-09-01T00:00:00.000Z',$6::timestamptz,
               CASE WHEN $5='completed' THEN '2026-09-01T00:01:00.000Z'::timestamptz END,
               1,'[{"id":"line","index":0,"kind":"lyric","text":"hold","start_ms":0,"end_ms":1,"words":[]}]'::jsonb)`,
            [id, `attempt-${id}`, `key-${id}`, "a".repeat(64), status, expiresAt],
          );
        const insertRecording = async (id: string, state: "pending" | "stored") =>
          admin.query(
            `INSERT INTO karaoke_recordings (
               session_id,attempt_id,account_id,artifact_id,state,object_ref,
               content_sha256,byte_size,duration_ms,reconciled_at
             ) VALUES ($1,$2,'account',$3,$4,
               CASE WHEN $4='stored' THEN 'karaoke/object' END,
               CASE WHEN $4='stored' THEN $5 END,
               CASE WHEN $4='stored' THEN 1 END,
               CASE WHEN $4='stored' THEN 1 END,
               CASE WHEN $4='stored' THEN clock_timestamp() END)`,
            [id, `attempt-${id}`, `artifact-${id}`, state, "b".repeat(64)],
          );

        await insertSession("expired", "active", "2026-09-01T00:02:00.000Z");
        await insertRecording("expired", "pending");
        await insertSession("completed-pending", "completed", "2026-09-01T00:03:00.000Z");
        await insertRecording("completed-pending", "pending");
        await insertSession("live", "active", "2099-09-01T00:00:00.000Z");
        await insertRecording("live", "pending");
        await insertSession("completed-stored", "completed", "2026-09-01T00:04:00.000Z");
        await insertRecording("completed-stored", "stored");
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const store = makeControlPlaneKaraokeFinalizationRecoveryStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const candidates = await Effect.runPromise(
        Effect.scoped(store.listCandidates({ limit: 50 })),
      );
      expect(candidates).toEqual([{ sessionId: "expired" }, { sessionId: "completed-pending" }]);
      expect(await Effect.runPromise(Effect.scoped(store.listCandidates({ limit: 1 })))).toEqual([
        { sessionId: "expired" },
      ]);
    } finally {
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });
});
