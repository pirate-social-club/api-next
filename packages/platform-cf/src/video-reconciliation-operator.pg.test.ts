import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MediaTransformVideoJobs } from "@pirate/application/media/transform";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeQencodeReconciliationObserver } from "./qencode-media-transform.ts";
import {
  finalizedFixture,
  operationId,
  seedVideoActors,
  submissionId,
  trustedAnalysis,
  videoSha256,
} from "./video-publication.pg-fixture.ts";
import { makeVideoReconciliationOperator } from "./video-reconciliation-operator.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("PostgreSQL required");
const suite = connectionString ? describe : describe.skip;
suite("video reconciliation operator PostgreSQL", () => {
  const schema = `video_operator_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  const scoped = new URL(connectionString ?? "postgresql://unused/unused");
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const layer = makeDirectPostgresControlPlaneLayer(scoped.toString());
  let fixture: Awaited<ReturnType<typeof finalizedFixture>>;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await runPostgresMigrations({ connectionString: scoped.toString() });
    await seedVideoActors(admin);
    fixture = await finalizedFixture(scoped.toString());
  }, 120_000);
  beforeEach(async () => {
    await admin.query("DELETE FROM media_video_stage_facts");
    await admin.query("DELETE FROM media_video_transform_attempts");
    await admin.query(
      `UPDATE media_post_submissions SET video_state_snapshot=$2::jsonb,
      status='processing',phase='analysis',failure_code=NULL,retryable=true,
      event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1`,
      [submissionId, JSON.stringify(fixture.finalized.state)],
    );
    const refreshed = await fixture.store.getSubmissionByOperation({ submissionId, operationId });
    if (refreshed === null) throw new Error("fixture missing");
    fixture = { ...fixture, finalized: refreshed };
    await admin.query(
      `INSERT INTO media_video_transform_attempts
      (request_id,submission_id,operation_id,video_revision,creation_revision,analysis_revision,
       canonical_video_sha256,capability,submitted_at_ms,runtime_deadline_ms,provider_job_id,provider_job_phase)
      VALUES ('operator-task',$1,$2,1,1,1,$3,'probe',0,10000,$4,'submitting')`,
      [submissionId, operationId, videoSha256, "b".repeat(32)],
    );
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });
  const required = () =>
    fixture.store.enterAttemptReconciliation({
      submission: fixture.finalized.state,
      observedEventSequence: fixture.finalized.eventSequence,
      requestId: "operator-task",
      state: "required",
      observation: { status: "not_found", observedAt: "2026-09-06T00:00:00Z" },
    });
  for (const outcome of ["completed", "failed", "workflow_terminal"] as const) {
    test(`operator resolution: ${outcome}`, async () => {
      await required();
      let calls = 0;
      const observer = {
        observe: ((input) => {
          calls += 1;
          expect(input.attempt.runtimeFence.runtimeDeadlineMs).toBe(10000);
          if (outcome === "completed")
            return Effect.succeed({
              status: "completed",
              attempt: input.attempt,
              context: { adapterRevision: "qencode-video-analysis-v1" },
              probe: trustedAnalysis().probe,
            });
          if (outcome === "failed")
            return Effect.succeed({
              status: "rejected",
              reason: "provider_rejected",
              attempt: input.attempt,
            });
          return Effect.succeed({ status: "not_found", attempt: input.attempt });
        }) as MediaTransformVideoJobs["observe"],
      };
      const operator = makeVideoReconciliationOperator(layer, {
        observer,
        artifactHead: async () => null,
      });
      expect((await operator.list(submissionId))[0]?.provider_job_id).toBe("b".repeat(32));
      expect(await operator.resolve(submissionId, "operator-task", false)).toMatchObject({
        outcome: "would_observe",
      });
      expect(calls).toBe(0);
      expect(await operator.resolve(submissionId, "operator-task", true)).toMatchObject({
        outcome,
        reconciliationRequired: outcome === "workflow_terminal",
        submissionStatus: outcome === "completed" ? "processing" : "processing_failed",
      });
      expect(calls).toBe(1);
      const facts = await admin.query(
        "SELECT stage FROM media_video_stage_facts WHERE submission_id=$1",
        [submissionId],
      );
      expect(facts.rows.length).toBe(outcome === "completed" ? 1 : 0);
    });
  }
  test("operator refuses non-reconciliation attempt without observation", async () => {
    const operator = makeVideoReconciliationOperator(layer, {
      observer: {
        observe: () => {
          throw new Error("must not observe");
        },
      },
      artifactHead: async () => null,
    });
    await expect(operator.resolve(submissionId, "operator-task", true)).rejects.toThrow(
      "not in required reconciliation",
    );
  });
  test("operator transport failure writes no observation or submission state", async () => {
    await required();
    const before = await fixture.store.getSubmissionByOperation({ submissionId, operationId });
    const operator = makeVideoReconciliationOperator(layer, {
      observer: makeQencodeReconciliationObserver({
        transport: {
          getStatus: async () => {
            throw new Error("transport unavailable");
          },
        },
        artifacts: {
          readJson: async () => {
            throw new Error("must not read");
          },
          seal: async () => {
            throw new Error("must not seal");
          },
        },
      }),
      artifactHead: async () => null,
    });
    expect(await operator.resolve(submissionId, "operator-task", true)).toMatchObject({
      outcome: "unchanged_unavailable",
    });
    expect(await fixture.store.getSubmissionByOperation({ submissionId, operationId })).toEqual(
      before,
    );
    const row = await admin.query(
      "SELECT last_observation FROM media_video_transform_attempts WHERE request_id='operator-task'",
    );
    expect(row.rows[0]?.last_observation.status).toBe("not_found");
  });
  test("operator CLI lists identifiers without provider composition", async () => {
    await required();
    const child = Bun.spawn(
      [process.execPath, "scripts/video-reconciliation.ts", "--submission", submissionId],
      {
        env: { ...process.env, CONTROL_PLANE_DATABASE_URL: scoped.toString() },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(errors).toBe("");
    expect(JSON.parse(output)).toMatchObject({
      requestId: "operator-task",
      providerJobId: "b".repeat(32),
      lastObservation: "not_found",
    });
    expect(output).not.toContain(videoSha256);
    expect(output).not.toContain("immutable");
  }, 30_000);
  test("operator rejects a sequence change during provider observation", async () => {
    await required();
    const operator = makeVideoReconciliationOperator(layer, {
      observer: {
        observe: (input) =>
          Effect.promise(async () => {
            await admin.query(
              "UPDATE media_post_submissions SET event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1",
              [submissionId],
            );
            return { status: "not_found" as const, attempt: input.attempt };
          }),
      },
      artifactHead: async () => null,
    });
    await expect(operator.resolve(submissionId, "operator-task", true)).rejects.toThrow(
      "resolution fence rejected",
    );
  });
});
