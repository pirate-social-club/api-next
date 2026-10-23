import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { historicalReview, runBlockedQuery } from "./moderated-dance-authority.pg-fixture.ts";
import { MODERATED_DANCE_CLOUDCONVERT_REVISION } from "./moderated-dance-cloudconvert-probe.ts";
import { seedModeratedDanceIntake } from "./moderated-dance-intake.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url === undefined ? describe.skip : describe,
  reusableSchema = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(30_000);
afterAll(async () => {
  await reusableSchema.dispose();
});

suite("native private probe provider version and durable grants", () => {
  test("erasure committed during a real inner-START lock wait refuses the grant and retains the original job", async () => {
    if (url === undefined) throw new Error("Isolated native target missing");
    await reusableSchema.run({
      baseConnectionString: url,
      schemaName: "moderated_dance_cloudconvert_probe_pg_v1",
      use: async ({ admin, schema }) => {
        const scoped = new URL(url);
        scoped.searchParams.set("options", `-c search_path=${schema}`);
        await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
        await admin.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
        const f = await seedModeratedDanceIntake(
            admin,
            scoped.toString(),
            MODERATED_DANCE_CLOUDCONVERT_REVISION,
          ),
          review = await historicalReview(f, admin, Date.now() + 604_790_000),
          upload = review.capture.uploadId;
        await admin.query(
          `INSERT INTO dance_moderated_processing_v1(upload_id,state,source_identity,account_fence,work_token,provider_tag,dispatched_at,provider_deadline,observation_token)
        VALUES($1,'claimed','{}',1,'original-purpose','original-normalization',clock_timestamp(),clock_timestamp()+interval '60 seconds','observer')`,
          [upload],
        );
        const allocate = (
          await admin.query("SELECT claim_moderated_dance_probe_v1($1,'observer') packet", [upload])
        ).rows[0]?.packet;
        await admin.query("SELECT persist_moderated_dance_probe_v1($1,'observer',$2::jsonb)", [
          upload,
          JSON.stringify({
            status: "submitted",
            attempt: {
              ...allocate.attempt,
              providerJobId: "original-probe",
              providerJobPhase: "allocated",
            },
          }),
        ]);
        const blocked = await runBlockedQuery(
          scoped.toString(),
          admin,
          { text: "SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE", values: [f.facts.accountId] },
          { text: "SELECT claim_moderated_dance_probe_v1($1,'observer')", values: [upload] },
          async () => {
            await admin.query("SELECT begin_moderated_dance_account_erasure_v1($1)", [
              f.facts.accountId,
            ]);
            await admin.query("COMMIT");
          },
        );
        expect(blocked).toMatchObject({
          error: { code: "DRV05", message: "processing lifecycle changed" },
        });
        expect(
          (
            await admin.query(
              "SELECT probe_phase,probe_attempt->>'providerJobId' job FROM dance_moderated_processing_v1 WHERE upload_id=$1",
              [upload],
            )
          ).rows[0],
        ).toEqual({ probe_phase: "allocated", job: "original-probe" });
        expect(
          (
            await admin.query(
              "SELECT state,provider_job_id FROM dance_moderated_provider_effects_v1 WHERE upload_id=$1 AND purpose='probe'",
              [upload],
            )
          ).rows[0],
        ).toEqual({ state: "registered", provider_job_id: "original-probe" });
        await expect(
          admin.query("SELECT claim_moderated_dance_normalization_v1($1,'observer')", [upload]),
        ).rejects.toMatchObject({ code: "DRV05", message: "processing lifecycle changed" });
      },
    });
  });
  test.each([undefined, MODERATED_DANCE_CLOUDCONVERT_REVISION])(
    "immutable runtime revision %s binds the original provider before allocation",
    async (revision) => {
      if (url === undefined) throw new Error("Isolated native target missing");
      await reusableSchema.run({
        baseConnectionString: url,
        schemaName: "moderated_dance_cloudconvert_probe_pg_v1",
        use: async ({ admin, schema }) => {
          const scoped = new URL(url);
          scoped.searchParams.set("options", `-c search_path=${schema}`);
          await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
          await admin.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
          const f = await seedModeratedDanceIntake(admin, scoped.toString(), revision),
            review = await historicalReview(f, admin, Date.now() + 604_790_000),
            upload = review.capture.uploadId;
          await admin.query(
            `INSERT INTO dance_moderated_processing_v1(upload_id,state,source_identity,account_fence,work_token,provider_tag,dispatched_at,provider_deadline,observation_token)
          VALUES($1,'claimed','{}',1,'original-purpose','original-normalization',clock_timestamp(),clock_timestamp()+interval '60 seconds','observer')`,
            [upload],
          );
          const claim = async () =>
            (
              await admin.query("SELECT claim_moderated_dance_probe_v1($1,'observer') packet", [
                upload,
              ])
            ).rows[0]?.packet;
          const allocate = await claim();
          expect(allocate).toMatchObject({ fresh: true, phase: "allocating" });
          expect(
            (
              await admin.query(
                "SELECT provider,provider_tag,provider_job_id,state FROM dance_moderated_provider_effects_v1 WHERE upload_id=$1 AND purpose='probe'",
                [upload],
              )
            ).rows,
          ).toEqual([
            {
              provider: revision === undefined ? "qencode" : "cloudconvert",
              provider_tag: revision === undefined ? null : `private-probe-${upload}`,
              provider_job_id: null,
              state: "registered",
            },
          ]);
          expect(await claim()).toMatchObject({ fresh: false, phase: "allocating" });
          await admin.query("SELECT persist_moderated_dance_probe_v1($1,'observer',$2::jsonb)", [
            upload,
            JSON.stringify({
              status: "submitted",
              attempt: {
                ...allocate.attempt,
                providerJobId: "original-probe",
                providerJobPhase: "allocated",
              },
            }),
          ]);
          expect(
            (
              await admin.query(
                "SELECT provider_job_id FROM dance_moderated_provider_effects_v1 WHERE upload_id=$1 AND purpose='probe'",
                [upload],
              )
            ).rows[0],
          ).toEqual({ provider_job_id: "original-probe" });
          const start = await claim();
          expect(start).toMatchObject({
            fresh: true,
            phase: "submitting",
            attempt: { providerJobId: "original-probe", providerJobPhase: "submitting" },
          });
          await admin.query("SELECT persist_moderated_dance_probe_v1($1,'observer',$2::jsonb)", [
            upload,
            JSON.stringify({
              status: "retryable_failure",
              reason: "transport",
              attempt: start.attempt,
            }),
          ]);
          expect(await claim()).toMatchObject({
            fresh: false,
            phase: "unknown",
            attempt: start.attempt,
          });
          await expect(
            admin.query("SELECT persist_moderated_dance_probe_v1($1,'observer',$2::jsonb)", [
              upload,
              JSON.stringify({
                status: "processing",
                attempt: {
                  ...start.attempt,
                  providerJobId: "replacement",
                  providerJobPhase: "started",
                },
              }),
            ]),
          ).rejects.toThrow("probe identity changed");
          await admin.query("SELECT persist_moderated_dance_probe_v1($1,'observer',$2::jsonb)", [
            upload,
            JSON.stringify({
              status: "completed",
              attempt: { ...start.attempt, providerJobPhase: "started" },
              probe: {
                durationMs: review.capture.bodyEndMs,
                width: 1080,
                height: 1920,
                frameRateMillihertz: 30000,
                hasAudio: true,
                audioCodec: "aac",
                videoCodec: "h264",
                evidenceRef: "fictional-original-probe-evidence",
              },
            }),
          ]);
          expect(await claim()).toMatchObject({
            fresh: false,
            phase: "complete",
            attempt: { providerJobId: "original-probe" },
          });
          expect(
            (
              await admin.query(
                "SELECT count(*)::INTEGER n FROM dance_moderated_provider_effects_v1 WHERE upload_id=$1 AND purpose='probe'",
                [upload],
              )
            ).rows[0],
          ).toEqual({ n: 1 });
        },
      });
    },
  );
});
