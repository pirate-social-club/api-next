import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeAcceptedAnalysisCleanup } from "./video-accepted-analysis-cleanup.ts";
import {
  finalizedFixture,
  operationId,
  seedVideoActors,
  submissionId,
  trustedAnalysis,
  videoSha256,
} from "./video-publication.pg-fixture.ts";
import { makeControlPlaneVideoStageFactStore } from "./video-stage-fact-repository.ts";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!connection && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("PostgreSQL required");
const suite = connection ? describe : describe.skip;
suite("accepted-analysis marker cleanup PostgreSQL", () => {
  const schema = `video_cleanup_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: connection });
  const scoped = new URL(connection ?? "postgresql://unused/unused");
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const runtime = makeDirectPostgresControlPlaneLayer(scoped.toString());
  const operator = makeAcceptedAnalysisCleanup(runtime);
  const target = { submissionId, requestIds: ["cleanup-frames", "cleanup-probe"] };
  let fixture: Awaited<ReturnType<typeof finalizedFixture>>;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await runPostgresMigrations({ connectionString: scoped.toString() });
    await seedVideoActors(admin);
    fixture = await finalizedFixture(scoped.toString());
  }, 120000);
  beforeEach(async () => {
    await admin.query("DELETE FROM media_video_stage_facts");
    await admin.query("DELETE FROM media_video_transform_attempts");
    await admin.query(
      `UPDATE media_post_submissions SET video_state_snapshot=$2::jsonb,
      status='processing',phase='analysis',analysis_revision=0,failure_code=NULL,retryable=true,
      event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1`,
      [submissionId, JSON.stringify(fixture.finalized.state)],
    );
    const current = await fixture.store.getSubmissionByOperation({ submissionId, operationId });
    if (!current) throw new Error("fixture absent");
    const analysis = trustedAnalysis();
    const facts = makeControlPlaneVideoStageFactStore(runtime);
    await facts.write({
      submission: current.state,
      observedEventSequence: current.eventSequence,
      fact: {
        stage: "probe",
        adapterRevision: "probe-v1",
        snapshot: analysis.probe,
        artifacts: [],
      },
    });
    await facts.write({
      submission: current.state,
      observedEventSequence: current.eventSequence,
      fact: {
        stage: "frames",
        adapterRevision: "frames-v1",
        snapshot: {
          evidenceRef: analysis.frames.evidenceRef,
          adapterRevision: analysis.frames.adapterRevision,
          posterPolicyRevision: analysis.frames.posterPolicyRevision,
          sourceSha256: videoSha256,
          videoRevision: 1,
          frames: analysis.frames.extracted,
        },
        artifacts: analysis.frames.extracted.map((frame) => ({
          artifactRef: frame.artifactRef,
          canonicalSha256: frame.sha256,
          sizeBytes: 10,
          contentType: "image/jpeg",
        })),
      },
    });
    const failed = {
      ...current.state,
      status: "processing_failed",
      phase: null,
      analysisRevision: 1,
      analysis,
      reconciliationRequired: true,
      failureCode: "transform_failed",
    };
    await admin.query(
      `UPDATE media_post_submissions SET video_state_snapshot=$2::jsonb,
      status='processing_failed',phase=NULL,analysis_revision=1,failure_code='transform_failed',
      retryable=false,failure_retry_count=0,last_safe_phase='analysis',
      event_sequence=event_sequence+1,updated_at=clock_timestamp() WHERE submission_id=$1`,
      [submissionId, JSON.stringify(failed)],
    );
    for (const [request, capability] of [
      ["cleanup-probe", "probe"],
      ["cleanup-frames", "frames"],
    ])
      await admin.query(
        `INSERT INTO media_video_transform_attempts
        (request_id,submission_id,operation_id,video_revision,creation_revision,analysis_revision,
        canonical_video_sha256,capability,submitted_at_ms,runtime_deadline_ms,
        provider_job_id,provider_job_phase,reconciliation_state,first_uncertainty_at,
        last_observation,reconciliation_evidence_ref)
        VALUES ($1,$2,$3,1,1,1,$4,$5,0,10000,$6,'started','required',clock_timestamp(),
        '{"status":"workflow_terminal","observedAt":"2026-09-30T07:00:00Z"}', 'fixture:uncertain')`,
        [request, submissionId, operationId, videoSha256, capability, "b".repeat(32)],
      );
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });
  const markers = async () =>
    (
      await admin.query(`SELECT request_id,reconciliation_state,
    provider_job_id,provider_job_phase FROM media_video_transform_attempts ORDER BY request_id`)
    ).rows;
  const unchangedFacts = async () =>
    (
      await admin.query(
        `SELECT to_jsonb(s)::text AS submission,
    (SELECT jsonb_agg(to_jsonb(f) ORDER BY stage)::text FROM media_video_stage_facts f) AS facts,
    (SELECT jsonb_agg(to_jsonb(v))::text FROM media_video_revisions v) AS revisions,
    (SELECT jsonb_agg(to_jsonb(i))::text FROM media_immutable_objects i) AS immutable,
    (SELECT jsonb_agg(to_jsonb(r))::text FROM media_song_video_render_attempts r) AS render,
    (SELECT jsonb_agg(to_jsonb(o))::text FROM media_video_analysis_outbox o) AS outbox
    FROM media_post_submissions s WHERE submission_id=$1`,
        [submissionId],
      )
    ).rows[0];
  test("preview is read-only and returns only safe hashes and exact fences", async () => {
    const before = await unchangedFacts();
    const fence = await operator.preview(target);
    expect(fence.entries).toHaveLength(2);
    expect(fence.entries[0]?.analysis_revision).toBe("1");
    expect(JSON.stringify(fence)).not.toContain('"fact_snapshot"');
    expect(JSON.stringify(fence)).not.toContain('"provider_job_id"');
    expect(await unchangedFacts()).toEqual(before);
    expect((await markers()).every((row) => row.reconciliation_state === "required")).toBe(true);
  });
  test("repairs only stale markers and preserves failed state, source, facts, outbox and renders", async () => {
    const before = await unchangedFacts();
    const prior = await markers();
    const fence = await operator.preview(target);
    expect(await operator.apply(fence)).toMatchObject({
      outcome: "accepted_analysis_markers_resolved",
    });
    expect(await unchangedFacts()).toEqual(before);
    expect(await markers()).toEqual(
      prior.map((row) => ({ ...row, reconciliation_state: "resolved" })),
    );
    expect(await operator.apply(fence).catch(() => "refused")).toBe("refused");
  });
  test("stale event sequence refuses both writes", async () => {
    const fence = await operator.preview(target);
    await admin.query(
      "UPDATE media_post_submissions SET event_sequence=event_sequence+1,updated_at=clock_timestamp()",
    );
    await expect(operator.apply(fence)).rejects.toThrow("stale fence");
    expect((await markers()).every((row) => row.reconciliation_state === "required")).toBe(true);
  });
  test("changed provider identity refuses both writes", async () => {
    const fence = await operator.preview(target);
    await admin.query(
      "UPDATE media_video_transform_attempts SET provider_job_id=$1 WHERE request_id='cleanup-probe'",
      ["c".repeat(32)],
    );
    await expect(operator.apply(fence)).rejects.toThrow("stale fence");
    expect((await markers()).every((row) => row.reconciliation_state === "required")).toBe(true);
  });
  test("missing accepted stage refuses before any marker write", async () => {
    const fence = await operator.preview(target);
    await admin.query("DELETE FROM media_video_stage_facts WHERE stage='probe'");
    await expect(operator.apply(fence)).rejects.toThrow("exact request set");
    expect((await markers()).every((row) => row.reconciliation_state === "required")).toBe(true);
  });
  test("source ownership mismatch refuses", async () => {
    await admin.query(`UPDATE media_post_submissions SET video_state_snapshot=
      jsonb_set(video_state_snapshot,'{actorAccountId}','"other-account"'),
      event_sequence=event_sequence+1,updated_at=clock_timestamp()`);
    await expect(operator.preview(target)).rejects.toThrow();
  });
  test("accepted analysis revision mismatch refuses", async () => {
    await admin.query(`UPDATE media_post_submissions SET video_state_snapshot=
      jsonb_set(video_state_snapshot,'{analysis,analysisRevision}','2'),
      event_sequence=event_sequence+1,updated_at=clock_timestamp()`);
    await expect(operator.preview(target)).rejects.toThrow();
  });
  test("changed accepted frame lineage refuses", async () => {
    await admin.query(`UPDATE media_post_submissions SET video_state_snapshot=
      jsonb_set(video_state_snapshot,'{analysis,frames,evidenceRef}','"different:frames"'),
      event_sequence=event_sequence+1,updated_at=clock_timestamp()`);
    await expect(operator.preview(target)).rejects.toThrow();
  });
  test("ordinary in-progress analysis is outside the repair scope", async () => {
    await admin.query(`UPDATE media_post_submissions SET status='processing',phase='analysis',
      video_state_snapshot=jsonb_set(video_state_snapshot,'{reconciliationRequired}','false'),
      event_sequence=event_sequence+1,updated_at=clock_timestamp()`);
    await expect(operator.preview(target)).rejects.toThrow();
  });
  test("duplicate or incomplete explicit target set refuses", async () => {
    await expect(
      operator.preview({ submissionId, requestIds: ["cleanup-probe", "cleanup-probe"] }),
    ).rejects.toThrow("duplicate");
    await expect(
      operator.preview({ submissionId, requestIds: ["cleanup-probe", "absent"] }),
    ).rejects.toThrow("exact request set");
  });
  test("closed fence schema refuses additional authority or provider-copy fields", async () => {
    const fence = await operator.preview(target);
    await expect(operator.apply({ ...fence, copyAllowed: true })).rejects.toThrow();
    expect((await markers()).every((row) => row.reconciliation_state === "required")).toBe(true);
  });
  test("a write-side authority change fails post-verification and rolls back every marker", async () => {
    const fence = await operator.preview(target);
    const before = await markers();
    await admin.query(`CREATE FUNCTION fixture_marker_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.provider_job_id=repeat('c',32); RETURN NEW; END; $$;
      CREATE TRIGGER fixture_marker_side_effect BEFORE UPDATE ON media_video_transform_attempts
      FOR EACH ROW EXECUTE FUNCTION fixture_marker_side_effect()`);
    try {
      await expect(operator.apply(fence)).rejects.toThrow("preservation refused");
      expect(await markers()).toEqual(before);
    } finally {
      await admin.query(`DROP TRIGGER fixture_marker_side_effect ON media_video_transform_attempts;
        DROP FUNCTION fixture_marker_side_effect()`);
    }
  });
});
