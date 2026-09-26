import { describe, expect, mock, test } from "bun:test";
import { makeSessionCrypto } from "@pirate/platform-cf/session-crypto";
import { Client } from "pg";
import { makeDirectPostgresControlPlaneLayer } from "../../../packages/platform-cf/src/postgres.ts";
import {
  actor,
  community,
  persona,
  responseBytes,
  responseSha256,
  seedVideoActors,
} from "../../../packages/platform-cf/src/video-publication.pg-fixture.ts";
import { makeControlPlaneVideoPublicationStore } from "../../../packages/platform-cf/src/video-publication-repository.ts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeHttpWorkerTestBindings } from "./composition.test-fixtures.ts";

/**
 * Every new video references a song, whatever the client. These requests
 * bypass the composer and call the production Worker directly, with its real
 * PostgreSQL-backed video services: an original-audio reservation, or a new
 * submission started from an original-audio reservation issued before the
 * rule, is refused with a typed error and leaves no row behind.
 */

// The composition module resolves its Durable Object imports at module load;
// the process-global mock must be registered first.
mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));
const { createProductionHttpWorker } = await import("./composition.ts");

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;

/**
 * Production pins search_path=api_next, so each test gets a disposable
 * database with a real api_next schema rather than a renamed shared one.
 */
async function fixture<A>(use: (admin: Client, connection: string) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("Postgres test configuration is unavailable");
  const database = `video_song_required_${crypto.randomUUID().replaceAll("-", "")}`;
  const control = new Client({ connectionString });
  await control.connect();
  await control.query(`CREATE DATABASE "${database}"`);
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  url.searchParams.set("options", "-c search_path=api_next");
  const connection = url.toString();
  const admin = new Client({ connectionString: connection });
  try {
    await admin.connect();
    await admin.query("CREATE SCHEMA api_next");
    await applyPostgresTestBaselineConnection({ connectionString: connection });
    await seedVideoActors(admin);
    // Authenticated writes require the account's minimum-age attestation.
    await admin.query(
      "INSERT INTO account_minimum_age_attestations(account_id,version,minimum_age,affirmed) VALUES($1,'minimum-age-attestation-v1',16,true)",
      [actor],
    );
    return await use(admin, connection);
  } finally {
    await admin.end();
    await control.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await control.end();
  }
}

async function authedPost(connection: string) {
  const bindings = await makeHttpWorkerTestBindings(connection);
  const worker = await createProductionHttpWorker({
    ...bindings,
    MEDIA_UPLOADS_ENABLED: "true",
    MEDIA_INGRESS_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    MEDIA_INGRESS_R2_BUCKET_NAME: "pirate-media-ingress-staging",
    MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID: "test-access-key",
    MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY: "test-secret-key",
    MEDIA_INGRESS: {
      head: async () => null,
      get: async () => null,
      createMultipartUpload: async () => {
        throw new Error("no upload may be created for a refused video");
      },
      resumeMultipartUpload: () => ({ complete: async () => ({}), abort: async () => {} }),
    },
    MEDIA_IMMUTABLE_ORIGINALS: { head: async () => null, put: async () => null },
  });
  const {
    PIRATE_APP_JWT_PRIVATE_KEY: privateKeyPem,
    PIRATE_APP_JWT_PUBLIC_KEY: publicKeyPem,
    PIRATE_APP_JWT_ISSUER: issuer,
    PIRATE_APP_JWT_AUDIENCE: audience,
    PIRATE_APP_JWT_SCOPE: scope,
  } = bindings;
  if (!privateKeyPem || !publicKeyPem || !issuer || !audience || !scope)
    throw new Error("test bindings carry no session key pair");
  const sessionCrypto = await makeSessionCrypto({
    privateKeyPem,
    publicKeyPem,
    issuer,
    audience,
    defaultScope: scope,
    defaultTtlSeconds: 3_600,
  });
  const token = await sessionCrypto.sign({ sub: actor, scope });
  return (path: string, body: unknown) =>
    worker.fetch(
      new Request(`https://worker.test${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          origin: "https://solid.test",
        },
        body: JSON.stringify(body),
      }),
    );
}

const count = async (admin: Client, table: string): Promise<number> =>
  (
    await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE actor_user_id=$1 AND media_kind='video'`,
      [actor],
    )
  ).rows[0]?.n ?? -1;

suite("new videos must use a song, whatever the client", () => {
  test("a direct original-audio reservation is refused with a typed error and creates nothing", async () => {
    await fixture(async (admin, connection) => {
      const post = await authedPost(connection);
      const response = await post(`/communities/${community}/media-upload-reservations`, {
        track: "video",
        slot: "primary_video",
        intent: "original_audio",
        persona_id: persona,
        idempotency_key: "bypass-reserve",
        expected_content_type: "video/mp4",
        expected_size_bytes: 1_024,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: "bad_request",
          retryable: false,
          details: { reason_code: "song_reference_required", track: "video" },
        },
      });
      expect(await count(admin, "media_upload_reservations")).toBe(0);
    });
  });

  test("a direct start from an original-audio reservation issued before the rule is refused", async () => {
    await fixture(async (admin, connection) => {
      const reservationId = `media-reservation-${crypto.randomUUID()}`;
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      await makeControlPlaneVideoPublicationStore(
        makeDirectPostgresControlPlaneLayer(connection),
      ).createReservation({
        record: {
          reservationId,
          communityId: community,
          intent: "original_audio",
          actorAccountId: actor,
          authorPersonaId: persona,
          requestHash: "b".repeat(64),
          expectedContentType: "video/mp4",
          expectedSizeBytes: 1_024,
          expectedSha256: null,
          ingestPolicyRevision: 1,
          uploadId: "pre-rule-upload",
          partSizeBytes: 5 * 1024 * 1024,
          partCount: 1,
          expiresAt,
          state: "issued",
          submissionId: null,
          operationId: null,
          manifest: null,
          responseBytes,
          updatedAt: new Date().toISOString(),
        },
        idempotencyKey: "pre-rule-reserve",
        responseSha256,
        parts: [{ partNumber: 1, url: "https://upload.invalid/1", expiresAt }],
      });
      const post = await authedPost(connection);
      const response = await post(`/communities/${community}/media-post-submissions`, {
        version: "video-start-input-v1",
        persona_id: persona,
        video_reservation_id: reservationId,
        idempotency_key: "bypass-start",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "bad_request", details: { reason_code: "song_reference_required" } },
      });
      expect(await count(admin, "media_post_submissions")).toBe(0);
    });
  });
});
