import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createReusablePostgresTestSchemaOwner } from "../../../scripts/postgres-test-baseline.ts";
import { makePublicationInputFixture } from "./moderated-dance-publication-input.pg-fixture.ts";
import { publicationRuntimeFixture } from "./moderated-dance-publication-runtime.pg-fixture.ts";

const suite = process.env.CONTROL_PLANE_POSTGRES_TEST_URL === undefined ? describe.skip : describe,
  reusableSchema = createReusablePostgresTestSchemaOwner(),
  withFixture = makePublicationInputFixture(reusableSchema);
setDefaultTimeout(30_000);
afterAll(async () => {
  await reusableSchema.dispose();
});
suite(
  "native composed Dance provider to ordinary Post handoff with explicit external stand-ins",
  () => {
    for (const interrupted of ["none", "create_reply", "storage_reply"] as const)
      test(`one original Post survives ${interrupted}`, async () =>
        withFixture(
          async (f, admin, r) => {
            const io = await publicationRuntimeFixture(f, admin, r);
            const before = (
              await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [
                r.capture.reviewId,
              ])
            ).rows[0]?.state;
            if (interrupted === "create_reply") io.loseCreate();
            if (interrupted === "storage_reply") io.losePut();
            expect(await io.runtime.run()).toEqual({
              outcome: interrupted === "none" ? "transferred" : "waiting",
            });
            if (interrupted !== "none")
              expect(await io.runtime.run()).toEqual({ outcome: "transferred" });
            expect(await io.runtime.run()).toEqual({ outcome: "idle" });
            expect(io.counts()).toEqual({
              creates: 1,
              shows: 1,
              finds: interrupted === "create_reply" ? 1 : 0,
              puts: 1,
              reads: 1,
            });
            expect(io.objects.size).toBe(1);
            expect(io.objects.has(io.key)).toBe(true);
            const submissions = (
              await admin.query(
                "SELECT phase,status,current_immutable_ref FROM media_post_submissions",
              )
            ).rows;
            expect(submissions).toHaveLength(1);
            expect(submissions[0]).toMatchObject({ phase: "analysis", status: "processing" });
            expect(
              (await admin.query("SELECT count(*)::INTEGER n FROM media_video_analysis_outbox"))
                .rows[0]?.n,
            ).toBe(1);
            expect(
              (
                await admin.query(
                  "SELECT input_source,multipart_upload_id,multipart_completed_at FROM media_upload_reservations WHERE input_source='dance_handoff'",
                )
              ).rows,
            ).toEqual([
              {
                input_source: "dance_handoff",
                multipart_upload_id: null,
                multipart_completed_at: null,
              },
            ]);
            const after = (
              await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [
                r.capture.reviewId,
              ])
            ).rows[0]?.state;
            expect(after).toEqual({
              ...before,
              publication: "transferred",
              publicationRevision: before.publicationRevision + 1,
            });
            expect(
              (
                await admin.query(
                  "SELECT claim_moderated_dance_publication_cleanup_v1('private-cleanup') packet",
                )
              ).rows[0]?.packet,
            ).toBeNull();
          },
          undefined,
          false,
          7,
        ));
  },
);
