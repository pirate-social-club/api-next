import { describe, expect, test } from "bun:test";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { mediaSha256Bytes } from "../../application/src/media/submission-service.ts";
import { createOriginalVideoSubmission } from "../../domain/src/video-submission.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { actor, community, persona, seedVideoActors } from "./video-publication.pg-fixture.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";
import { makeVideoReservationCleanup } from "./video-reservation-cleanup.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("PostgreSQL test URL required");
const suite = url ? describe : describe.skip;

suite("video reservation cleanup PostgreSQL", () => {
  test("aborts expired uploads, retries uncertain abort, skips live and manifested reservations", async () => {
    if (!url) throw new Error("missing URL");
    await withReusablePostgresTestSchema({
      baseConnectionString: url,
      schemaName: "video_reservation_cleanup_pg_test",
      use: async ({ admin, schema }) => {
        const connection = `${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
        await admin.query(`SET search_path TO "${schema}"`);
        await applyPostgresTestBaselineConnection({ connectionString: connection });
        await seedVideoActors(admin);
        const layer = makeDirectPostgresControlPlaneLayer(connection);
        const store = makeControlPlaneVideoPublicationStore(layer);
        const responseBytes = new TextEncoder().encode('{"reservation_id":"fixture"}');
        const responseSha256 = await mediaSha256Bytes(responseBytes);
        const create = async (id: string, expiresAt = "2020-01-01T00:00:00Z") => {
          await store.createReservation({
            record: {
              reservationId: id,
              communityId: community,
              actorAccountId: actor,
              authorPersonaId: persona,
              requestHash: "a".repeat(64),
              expectedContentType: "video/mp4",
              expectedSizeBytes: 1024,
              expectedSha256: null,
              ingestPolicyRevision: 1,
              uploadId: `upload-${id}`,
              partSizeBytes: 10485760,
              partCount: 1,
              expiresAt: expiresAt,
              state: "issued",
              submissionId: null,
              operationId: null,
              manifest: null,
              responseBytes,
              updatedAt: "2020-01-01T00:00:00Z",
            },
            idempotencyKey: id,
            responseSha256,
            parts: [{ partNumber: 1, url: "https://upload.invalid/1", expiresAt: expiresAt }],
          });
        };
        await create("expired");
        await create("uncertain");
        await create("manifested");
        await create("live", "2099-01-01T00:00:00Z");
        await admin.query(
          `UPDATE media_upload_reservations SET multipart_manifest='[{"partNumber":1,"etag":"sealed"}]',updated_at=clock_timestamp() WHERE reservation_id='manifested'`,
        );
        const calls: string[] = [];
        let lostResponse = true;
        const sweep = makeVideoReservationCleanup(layer, {
          resumeMultipartUpload: (key, uploadId) => ({
            abort: async () => {
              calls.push(uploadId);
              expect(key).toBe(`reservations/${uploadId.slice(7)}/source`);
              if (uploadId === "upload-uncertain" && lostResponse) {
                lostResponse = false;
                throw new Error("lost response");
              }
            },
          }),
        });
        expect(await sweep()).toEqual({ selected: 2, aborted: 1, failed: 1 });
        expect(
          (
            await admin.query(
              "SELECT state,multipart_aborted_at FROM media_upload_reservations WHERE reservation_id='uncertain'",
            )
          ).rows[0],
        ).toMatchObject({ state: "issued", multipart_aborted_at: null });
        expect(await sweep()).toEqual({ selected: 1, aborted: 1, failed: 0 });
        expect(await sweep()).toEqual({ selected: 0, aborted: 0, failed: 0 });
        expect(calls).toEqual(["upload-expired", "upload-uncertain", "upload-uncertain"]);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM media_upload_reservations WHERE state='expired' AND multipart_aborted_at IS NOT NULL",
            )
          ).rows[0].n,
        ).toBe(2);
        await create("rollback");
        await admin.query(`CREATE SEQUENCE cleanup_failure_count;
          CREATE FUNCTION reject_first_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.reservation_id='rollback' AND NEW.state='expired' AND nextval('cleanup_failure_count')=1
          THEN RAISE EXCEPTION 'injected commit-boundary failure'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER cleanup_failure BEFORE UPDATE ON media_upload_reservations FOR EACH ROW EXECUTE FUNCTION reject_first_cleanup()`);
        try {
          expect(await sweep()).toEqual({ selected: 1, aborted: 0, failed: 1 });
          expect(await sweep()).toEqual({ selected: 1, aborted: 1, failed: 0 });
          expect(calls.filter((id) => id === "upload-rollback")).toHaveLength(2);
        } finally {
          await admin.query(
            "DROP TRIGGER cleanup_failure ON media_upload_reservations; DROP FUNCTION reject_first_cleanup(); DROP SEQUENCE cleanup_failure_count",
          );
        }
        await create("locked");
        let concurrentCalls = 0;
        const concurrent = makeVideoReservationCleanup(layer, {
          resumeMultipartUpload: () => ({
            abort: async () => {
              concurrentCalls++;
              expect(await sweep()).toEqual({ selected: 1, aborted: 0, failed: 0 });
            },
          }),
        });
        expect(await concurrent()).toEqual({ selected: 1, aborted: 1, failed: 0 });
        expect(concurrentCalls).toBe(1);
        await create("claimed", new Date(Date.now() + 2000).toISOString());
        const state = createOriginalVideoSubmission({
          submissionId: "cleanup-submission",
          operationId: "cleanup-operation",
          communityId: community,
          actorAccountId: actor,
          authorPersonaId: persona,
          reservationId: "claimed",
          caption: null,
          authorDeclaredRating: "general",
        });
        await store.createSubmission({
          state,
          idempotencyKey: "cleanup-create",
          requestHash: "b".repeat(64),
          startInput: { version: "video-start-input-v1", video_reservation_id: "claimed" },
          responseBytes,
          responseSha256,
        });
        await admin.query("SELECT pg_sleep(2.1)");
        const finalize = {
          submission: state,
          expectedCreationRevision: 1,
          posterTimestampMs: null,
          manifest: [{ partNumber: 1, etag: "part" }],
        };
        await expect(store.beginFinalize(finalize)).rejects.toMatchObject({
          details: { reason_code: "action_expired" },
        });
        expect(await sweep()).toEqual({ selected: 1, aborted: 1, failed: 0 });
        await expect(store.beginFinalize(finalize)).rejects.toMatchObject({
          details: { reason_code: "action_expired" },
        });
      },
    });
  });
});
