import { beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  acceptMaster,
  persistRenderPlan,
  sealMaster,
  startRenderAttempt,
} from "./song-video-render-repository.ts";
import { finalizedFixture, seedVideoActors } from "./video-publication.pg-fixture.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;

const SAMPLE_RATE = 48_000;
const masterSha256 = "d".repeat(64);
// Test-only. U.6 remains an open gate and nothing in the source supplies a value.
const masterCeilingBytes = 64 * 1024 * 1024;

const basePlan = {
  submissionId: "media-submission-video-publication",
  songPostId: "post-song-1",
  songAssetId: "asset-song-1",
  audioRevision: 1,
  songDurationSamples: 180 * SAMPLE_RATE,
  clipStartSamples: 30 * SAMPLE_RATE,
  clipDurationSamples: 15 * SAMPLE_RATE,
};

suite("song video render persistence", () => {
  const schema = `song_video_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  const scoped = new URL(connectionString ?? "postgresql://unused/unused");
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const client = new Client({ connectionString: scoped.toString() });
  let sourceImmutableRef = "";
  let storedSourceSha256 = "";

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await runPostgresMigrations({ connectionString: scoped.toString() });
    await seedVideoActors(admin);
    // A genuinely sealed source, produced by the real publication store rather
    // than inserted past its guard, so the binding is checked against a row the
    // system itself created.
    await finalizedFixture(scoped.toString());
    const sealed = await admin.query<{ immutable_ref: string; canonical_sha256: string }>(
      "SELECT immutable_ref, canonical_sha256 FROM media_immutable_objects ORDER BY sealed_at LIMIT 1",
    );
    const row = sealed.rows[0];
    if (!row) throw new Error("fixture sealed no immutable object");
    sourceImmutableRef = row.immutable_ref;
    storedSourceSha256 = row.canonical_sha256;
    await client.connect();
  }, 180_000);

  test("persists attempt identity before any master exists", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-song-video-1" });
      await startRenderAttempt(client, {
        attemptId: "attempt-1",
        planId: "plan-song-video-1",
        generation: 1,
      });
      const attempts = await client.query(
        "SELECT attempt_id, generation, state FROM media_song_video_render_attempts WHERE plan_id = $1",
        ["plan-song-video-1"],
      );
      expect(attempts.rows).toEqual([{ attempt_id: "attempt-1", generation: 1, state: "started" }]);
      const masters = await client.query(
        "SELECT count(*)::int AS n FROM media_song_video_masters WHERE plan_id = $1",
        ["plan-song-video-1"],
      );
      expect(masters.rows[0]?.n).toBe(0);
    }
  }, 60_000);

  test("refuses to seal when the claimed source digest is not the stored one", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-mismatch" });
      await startRenderAttempt(client, {
        attemptId: "attempt-mismatch",
        planId: "plan-mismatch",
        generation: 1,
      });
      const outcome = await sealMaster(client, {
        masterRevisionId: "master-mismatch",
        attempt: { attemptId: "attempt-mismatch", planId: "plan-mismatch", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: "c".repeat(64),
        masterSha256,
        masterByteLength: 1_000,
        masterCeilingBytes,
        rendererIdentity: "ffmpeg-7.1.5",
        rendererPolicyRevision: 1,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });
      expect(outcome).toMatchObject({
        sealed: false,
        failure: { kind: "sealed_source_digest_mismatch", storedSha256: storedSourceSha256 },
      });
      const masters = await client.query(
        "SELECT count(*)::int AS n FROM media_song_video_masters WHERE plan_id = 'plan-mismatch'",
      );
      expect(masters.rows[0]?.n).toBe(0);
      const attempt = await client.query(
        "SELECT state FROM media_song_video_render_attempts WHERE attempt_id = 'attempt-mismatch'",
      );
      expect(attempt.rows[0]?.state).toBe("started");
    }
  }, 60_000);

  test("refuses to seal against a source that is not stored at all", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-absent" });
      await startRenderAttempt(client, {
        attemptId: "attempt-absent",
        planId: "plan-absent",
        generation: 1,
      });
      const outcome = await sealMaster(client, {
        masterRevisionId: "master-absent",
        attempt: { attemptId: "attempt-absent", planId: "plan-absent", generation: 1 },
        sourceImmutableRef: "media://immutable/not-stored",
        claimedSourceSha256: storedSourceSha256,
        masterSha256,
        masterByteLength: 1_000,
        masterCeilingBytes,
        rendererIdentity: "ffmpeg-7.1.5",
        rendererPolicyRevision: 1,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });
      expect(outcome).toMatchObject({
        sealed: false,
        failure: { kind: "sealed_source_absent" },
      });
    }
  }, 60_000);

  test("records the stored digest rather than the caller's claim", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-bound" });
      await startRenderAttempt(client, {
        attemptId: "attempt-bound",
        planId: "plan-bound",
        generation: 1,
      });
      const outcome = await sealMaster(client, {
        masterRevisionId: "master-bound",
        attempt: { attemptId: "attempt-bound", planId: "plan-bound", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterSha256,
        masterByteLength: 1_000,
        masterCeilingBytes,
        rendererIdentity: "ffmpeg-7.1.5",
        rendererPolicyRevision: 1,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });
      expect(outcome).toMatchObject({ sealed: true });
      const stored = await client.query(
        "SELECT source_sha256, master_sha256, master_ceiling_bytes FROM media_song_video_masters WHERE master_revision_id = 'master-bound'",
      );
      expect(stored.rows[0]).toMatchObject({
        source_sha256: storedSourceSha256,
        master_sha256: masterSha256,
      });
    }
  }, 60_000);

  test("accepts exactly one master when two are sealed for one plan", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-race" });
      for (const [attemptId, revisionId, digest, generation] of [
        ["attempt-race-a", "master-race-a", "b".repeat(64), 1],
        ["attempt-race-b", "master-race-b", "c".repeat(64), 2],
      ] as const) {
        await startRenderAttempt(client, { attemptId, planId: "plan-race", generation });
        const sealed = await sealMaster(client, {
          masterRevisionId: revisionId,
          attempt: { attemptId, planId: "plan-race", generation },
          sourceImmutableRef,
          claimedSourceSha256: storedSourceSha256,
          masterSha256: digest,
          masterByteLength: 1_000,
          masterCeilingBytes,
          rendererIdentity: "ffmpeg-7.1.5",
          rendererPolicyRevision: 1,
          decisionClipStartSamples: basePlan.clipStartSamples,
          decisionClipDurationSamples: basePlan.clipDurationSamples,
        });
        expect(sealed).toMatchObject({ sealed: true });
      }

      const first = await acceptMaster(client, {
        planId: "plan-race",
        masterRevisionId: "master-race-a",
        attemptId: "attempt-race-a",
      });
      const second = await acceptMaster(client, {
        planId: "plan-race",
        masterRevisionId: "master-race-b",
        attemptId: "attempt-race-b",
      });

      expect(first).toEqual({ accepted: true, masterRevisionId: "master-race-a" });
      expect(second).toEqual({ accepted: false, winningMasterRevisionId: "master-race-a" });

      const accepted = await client.query(
        "SELECT master_revision_id FROM media_song_video_accepted_masters WHERE plan_id = 'plan-race'",
      );
      expect(accepted.rows).toEqual([{ master_revision_id: "master-race-a" }]);

      // The loser keeps its sealed identity and a recorded disposition; nothing
      // is erased and no replacement render is authorized.
      const states = await client.query(
        "SELECT attempt_id, state, disposition FROM media_song_video_render_attempts WHERE plan_id = 'plan-race' ORDER BY attempt_id",
      );
      expect(states.rows).toEqual([
        { attempt_id: "attempt-race-a", state: "accepted", disposition: null },
        {
          attempt_id: "attempt-race-b",
          state: "loser",
          disposition: "not_first_accepted_master",
        },
      ]);
      const survivingMasters = await client.query(
        "SELECT count(*)::int AS n FROM media_song_video_masters WHERE plan_id = 'plan-race'",
      );
      expect(survivingMasters.rows[0]?.n).toBe(2);
    }
  }, 60_000);

  test("rejects a plan whose interval runs past the song, in the schema itself", async () => {
    await expect(
      persistRenderPlan(client, {
        ...basePlan,
        planId: "plan-uncontained",
        clipStartSamples: basePlan.songDurationSamples,
        clipDurationSamples: 5 * SAMPLE_RATE,
      }),
    ).rejects.toThrow(/song_video_plan_canonical_containment/);
  }, 60_000);
});
