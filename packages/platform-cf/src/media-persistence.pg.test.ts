import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";

import { runPostgresMigrations } from "../../../scripts/postgres-migrations";
import { makeControlPlaneMediaOutboxRepository } from "./media-outbox-repository";
import { makeControlPlaneMediaSubmissionRepository } from "./media-submission-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;

const actor = "media_pg_actor";
const community = "media_pg_community";
const operation = "media_pg_operation";
const submission = "media_pg_submission";
const reservation = "media_pg_reservation";
const endpoint = "/media-post-submissions/:submissionId/finalize";
const bytes = new TextEncoder().encode('{"status":"processing"}');
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const digest = sha256(bytes);
const requestHash = "a".repeat(64);
const response2 = new TextEncoder().encode('{"status":"different"}');

function schemaName(): string {
  return `api_next_media_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`;
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
  const connection = scopedConnection(connectionString, schema);
  try {
    await runPostgresMigrations({ connectionString: connection });
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    const emptyFoundation = await admin.query<{
      readonly users: string;
      readonly communities: string;
    }>({
      text: "SELECT (SELECT count(*)::text FROM users) AS users, (SELECT count(*)::text FROM communities) AS communities",
    });
    expect(emptyFoundation.rows[0]).toEqual({ users: "0", communities: "0" });
    await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor]);
    await admin.query(
      "INSERT INTO communities (community_id, display_name, status, created_by_user_id, created_at, updated_at) VALUES ($1, $2, 'active', $3, now(), now())",
      [community, "Media fixture", actor],
    );
    await admin.query(
      "INSERT INTO community_memberships (community_id, membership_id, user_id, status, joined_at, created_at, updated_at) VALUES ($1, $2, $3, 'member', now(), now(), now())",
      [community, "media_pg_membership", actor],
    );
    const populatedFoundation = await admin.query<{
      readonly users: string;
      readonly communities: string;
    }>({
      text: "SELECT (SELECT count(*)::text FROM users) AS users, (SELECT count(*)::text FROM communities) AS communities",
    });
    expect(populatedFoundation.rows[0]).toEqual({ users: "1", communities: "1" });
    return await use(admin, connection);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function run<A>(
  connection: string,
  program: (
    submissionStore: ReturnType<typeof makeControlPlaneMediaSubmissionRepository>,
    outboxStore: ReturnType<typeof makeControlPlaneMediaOutboxRepository>,
  ) => Effect.Effect<A, unknown, ControlPlaneDb>,
): Promise<A> {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const submissionStore = makeControlPlaneMediaSubmissionRepository();
  const outboxStore = makeControlPlaneMediaOutboxRepository();
  return Effect.runPromise(
    Effect.scoped(program(submissionStore, outboxStore).pipe(Effect.provide(layer))),
  );
}

async function seedSubmission(admin: Client): Promise<void> {
  await admin.query(
    `INSERT INTO media_upload_reservations (
       reservation_id, community_id, actor_user_id, idempotency_key, request_hash,
       track, slot, expected_content_type, expected_size_bytes, upload_url,
       expires_at, response_snapshot_bytes, response_snapshot_sha256, state,
       submission_id, operation_id
     ) VALUES ($1, $2, $3, 'reserve-key', $4, 'song', 'primary_audio', 'audio/mpeg', 1,
       'https://upload.test/media', now() + interval '1 hour', $5, $6, 'claimed', $7, $8)`,
    [reservation, community, actor, requestHash, bytes, digest, submission, operation],
  );
  await admin.query(
    `INSERT INTO media_post_submissions (
       submission_id, community_id, actor_user_id, operation_id, idempotency_key,
       request_hash, track, author_input, title, lyrics, rights_kind, license_preset,
       commercial_rev_share_bps, royalty_allocations, access_mode, audio_reservation_id,
       phase, last_safe_phase, response_snapshot_bytes, response_snapshot_sha256
     ) VALUES ($1, $2, $3, $4, 'create-key', $5, 'song', $6::jsonb, 'Fixture', NULL,
       'original', 'non-commercial', 0, $7::jsonb, 'public', $8, 'finalize', 'finalize', $9, $10)`,
    [
      submission,
      community,
      actor,
      operation,
      requestHash,
      JSON.stringify({
        version: "song-author-input-v1",
        title: "Fixture",
        lyrics: null,
        audio_reservation_id: reservation,
        rights_declaration: { kind: "original" },
        license_preset: "non-commercial",
        royalty_allocations: [{ recipient_id: actor, share_bps: 10000 }],
        access_mode: "public",
      }),
      JSON.stringify([{ recipient_id: actor, share_bps: 10000 }]),
      reservation,
      bytes,
      digest,
    ],
  );
  await admin.query(
    "INSERT INTO media_moderation_projections (submission_id, operation_id, status) VALUES ($1, $2, 'none')",
    [submission, operation],
  );
}

suite("song media persistence Postgres 17 fixture", () => {
  test("replays exact command bytes, fences revisions, and converges one outbox effect", async () => {
    await withSchema(async (admin, connection) => {
      const reserved = await run(connection, (store) =>
        store.reserve({
          communityId: community,
          actorUserId: actor,
          idempotencyKey: "namespace-reserve-key",
          requestHash: "c".repeat(64),
          expectedContentType: "audio/mpeg",
          expectedSizeBytes: 1,
          expectedSha256: digest,
          uploadUrl: "https://upload.test/media/namespaceless",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          responseBytes: bytes,
          responseSha256: digest,
          reservationId: "media_pg_namespaceless_reservation",
        }),
      );
      expect(reserved).toMatchObject({
        kind: "created",
        reservationId: "media_pg_namespaceless_reservation",
      });
      await seedSubmission(admin);
      const outbox = {
        outboxEventId: "media_pg_outbox",
        workflowRevision: 1,
        workflowInstanceId: "media_pg_workflow_1",
        eventType: "analysis_launch" as const,
        effectIdentity: "media_pg_effect_1",
        payload: { operation_id: operation, creation_revision: 1 },
      };
      const first = await run(connection, (store) =>
        store.transition({
          submissionId: submission,
          actorUserId: actor,
          endpointTemplate: endpoint,
          idempotencyKey: "finalize-key",
          requestHash,
          expectedRevision: 1,
          responseBytes: bytes,
          responseSha256: digest,
          status: "processing",
          phase: "analysis",
          lastSafePhase: "analysis",
          outbox,
        }),
      );
      expect(first).toEqual({ kind: "committed", submissionId: submission });
      const replay = await run(connection, (store) =>
        store.transition({
          submissionId: submission,
          actorUserId: actor,
          endpointTemplate: endpoint,
          idempotencyKey: "finalize-key",
          requestHash,
          expectedRevision: 1,
          responseBytes: response2,
          responseSha256: sha256(response2),
          status: "processing",
          phase: "analysis",
          outbox,
        }),
      );
      expect(replay).toMatchObject({ kind: "replay", bytes, sha256: digest });
      const conflict = await run(connection, (store) =>
        store.transition({
          submissionId: submission,
          actorUserId: actor,
          endpointTemplate: endpoint,
          idempotencyKey: "finalize-key",
          requestHash: "b".repeat(64),
          expectedRevision: 1,
          responseBytes: response2,
          responseSha256: sha256(response2),
          status: "processing",
          phase: "analysis",
        }),
      );
      expect(conflict).toEqual({ kind: "conflict", submissionId: submission });
      const stale = await run(connection, (store) =>
        store
          .transition({
            submissionId: submission,
            actorUserId: actor,
            endpointTemplate: endpoint,
            idempotencyKey: "stale-key",
            requestHash,
            expectedRevision: 2,
            responseBytes: bytes,
            responseSha256: digest,
            status: "processing",
            phase: "analysis",
          })
          .pipe(Effect.flip),
      );
      expect(stale).toMatchObject({ reason: "stale-revision" });
      const effectReplay = await run(connection, (_, outboxRepository) =>
        outboxRepository.enqueue({
          submissionId: submission,
          operationId: operation,
          creationRevision: 1,
          ...outbox,
        }),
      );
      expect(effectReplay).toEqual({ kind: "replay", outboxEventId: outbox.outboxEventId });
      const claimed = await run(connection, (_, outboxRepository) =>
        outboxRepository.claim({ outboxEventId: outbox.outboxEventId, workflowRevision: 1 }),
      );
      expect(claimed?.state).toBe("claimed");
      const duplicateClaim = await run(connection, (_, outboxRepository) =>
        outboxRepository.claim({ outboxEventId: outbox.outboxEventId, workflowRevision: 1 }),
      );
      expect(duplicateClaim).toBeNull();
      expect(
        await run(connection, (_, outboxRepository) =>
          outboxRepository.markDelivered({
            outboxEventId: outbox.outboxEventId,
            workflowRevision: 1,
            workflowInstanceId: outbox.workflowInstanceId,
          }),
        ),
      ).toBe(true);
      expect(
        await run(connection, (_, outboxRepository) =>
          outboxRepository.markDelivered({
            outboxEventId: outbox.outboxEventId,
            workflowRevision: 1,
            workflowInstanceId: outbox.workflowInstanceId,
          }),
        ),
      ).toBe(false);
      const counts = await admin.query<{ readonly effects: string; readonly snapshots: string }>({
        text: `SELECT (SELECT count(*)::text FROM media_submission_outbox WHERE effect_identity = $1) AS effects, (SELECT count(*)::text FROM media_submission_command_replays WHERE idempotency_key = 'finalize-key') AS snapshots`,
        values: [outbox.effectIdentity],
      });
      expect(counts.rows[0]).toEqual({ effects: "1", snapshots: "1" });
    });
  }, 30_000);
});
