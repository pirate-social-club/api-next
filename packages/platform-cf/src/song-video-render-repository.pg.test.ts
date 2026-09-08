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

  test("accepts exactly one master under concurrent acceptance on separate connections", async () => {
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

      // Two connections, two overlapping serializable transactions. A single
      // client would serialize these and prove only sequential exclusion.
      const second = new Client({ connectionString: scoped.toString() });
      await second.connect();
      try {
        const [first, other] = await Promise.all([
          acceptMaster(client, {
            planId: "plan-race",
            masterRevisionId: "master-race-a",
            attemptId: "attempt-race-a",
          }),
          acceptMaster(second, {
            planId: "plan-race",
            masterRevisionId: "master-race-b",
            attemptId: "attempt-race-b",
          }),
        ]);
        const outcomes = [first, other];
        expect(outcomes.filter((outcome) => outcome.accepted)).toHaveLength(1);
        expect(outcomes.filter((outcome) => !outcome.accepted)).toHaveLength(1);
        const winner = outcomes.find((outcome) => outcome.accepted);
        const loser = outcomes.find((outcome) => !outcome.accepted);
        if (!winner?.accepted || loser?.accepted !== false) throw new Error("expected one of each");
        expect(loser.winningMasterRevisionId).toBe(winner.masterRevisionId);
      } finally {
        await second.end();
      }

      const accepted = await client.query(
        "SELECT master_revision_id FROM media_song_video_accepted_masters WHERE plan_id = 'plan-race'",
      );
      expect(accepted.rows).toHaveLength(1);
      const states = await client.query(
        "SELECT state FROM media_song_video_render_attempts WHERE plan_id = 'plan-race' ORDER BY attempt_id",
      );
      expect(states.rows.map((row) => row.state).sort()).toEqual(["accepted", "loser"]);
      const survivingMasters = await client.query(
        "SELECT count(*)::int AS n FROM media_song_video_masters WHERE plan_id = 'plan-race'",
      );
      expect(survivingMasters.rows[0]?.n).toBe(2);
    }
  }, 60_000);

  test("replaying the winning acceptance returns success and changes nothing", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-replay" });
      await startRenderAttempt(client, {
        attemptId: "attempt-replay",
        planId: "plan-replay",
        generation: 1,
      });
      await sealMaster(client, {
        masterRevisionId: "master-replay",
        attempt: { attemptId: "attempt-replay", planId: "plan-replay", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterSha256: "e".repeat(64),
        masterByteLength: 1_000,
        masterCeilingBytes,
        rendererIdentity: "ffmpeg-7.1.5",
        rendererPolicyRevision: 1,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });
      const input = {
        planId: "plan-replay",
        masterRevisionId: "master-replay",
        attemptId: "attempt-replay",
      };
      expect(await acceptMaster(client, input)).toEqual({
        accepted: true,
        masterRevisionId: "master-replay",
      });
      // The lost-response case: the write already succeeded and the caller
      // retried. It must not demote its own winning attempt.
      expect(await acceptMaster(client, input)).toEqual({
        accepted: true,
        masterRevisionId: "master-replay",
      });
      const state = await client.query(
        "SELECT state, disposition FROM media_song_video_render_attempts WHERE attempt_id = 'attempt-replay'",
      );
      expect(state.rows[0]).toEqual({ state: "accepted", disposition: null });
    }
  }, 60_000);

  test("refuses to seal an attempt that belongs to a different plan", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-other-a" });
      await persistRenderPlan(client, { ...basePlan, planId: "plan-other-b" });
      await startRenderAttempt(client, {
        attemptId: "attempt-of-a",
        planId: "plan-other-a",
        generation: 1,
      });
      const outcome = await sealMaster(client, {
        masterRevisionId: "master-crossed",
        // A real attempt and a real plan that are not the same work.
        attempt: { attemptId: "attempt-of-a", planId: "plan-other-b", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterSha256: "f".repeat(64),
        masterByteLength: 1_000,
        masterCeilingBytes,
        rendererIdentity: "ffmpeg-7.1.5",
        rendererPolicyRevision: 1,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });
      expect(outcome).toMatchObject({ sealed: false, failure: { kind: "attempt_not_of_plan" } });
    }
  }, 60_000);

  test("refuses a generation that is not the stored one", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-generation" });
      await startRenderAttempt(client, {
        attemptId: "attempt-generation",
        planId: "plan-generation",
        generation: 1,
      });
      const outcome = await sealMaster(client, {
        masterRevisionId: "master-generation",
        attempt: { attemptId: "attempt-generation", planId: "plan-generation", generation: 7 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterSha256: "1".repeat(64),
        masterByteLength: 1_000,
        masterCeilingBytes,
        rendererIdentity: "ffmpeg-7.1.5",
        rendererPolicyRevision: 1,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });
      expect(outcome).toMatchObject({
        sealed: false,
        failure: { kind: "attempt_generation_mismatch", storedGeneration: 1 },
      });
    }
  }, 60_000);

  test("refuses an applied interval that is not the plan's frozen interval", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-interval" });
      await startRenderAttempt(client, {
        attemptId: "attempt-interval",
        planId: "plan-interval",
        generation: 1,
      });
      const outcome = await sealMaster(client, {
        masterRevisionId: "master-interval",
        attempt: { attemptId: "attempt-interval", planId: "plan-interval", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterSha256: "2".repeat(64),
        masterByteLength: 1_000,
        masterCeilingBytes,
        rendererIdentity: "ffmpeg-7.1.5",
        rendererPolicyRevision: 1,
        decisionClipStartSamples: basePlan.clipStartSamples + 1,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });
      expect(outcome).toMatchObject({
        sealed: false,
        failure: { kind: "decision_does_not_match_plan" },
      });
    }
  }, 60_000);

  test("a controlled overlap really does raise a serialization failure", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-overlap" });
      await startRenderAttempt(client, {
        attemptId: "attempt-overlap-a",
        planId: "plan-overlap",
        generation: 1,
      });
      await sealMaster(client, {
        masterRevisionId: "master-overlap-a",
        attempt: { attemptId: "attempt-overlap-a", planId: "plan-overlap", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterSha256: "3".repeat(64),
        masterByteLength: 1_000,
        masterCeilingBytes,
        rendererIdentity: "ffmpeg-7.1.5",
        rendererPolicyRevision: 1,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });

      // Interleave two serializable transactions by hand. Promise.all alone does
      // not establish that they overlapped; this drives the overlap explicitly
      // and records what PostgreSQL actually raises.
      const a = new Client({ connectionString: scoped.toString() });
      const b = new Client({ connectionString: scoped.toString() });
      await a.connect();
      await b.connect();
      const raised: { code?: string; message: string }[] = [];
      try {
        await a.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await b.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        // Both read the empty acceptance set, then both try to win it.
        await a.query(
          "SELECT master_revision_id FROM media_song_video_accepted_masters WHERE plan_id = 'plan-overlap'",
        );
        await b.query(
          "SELECT master_revision_id FROM media_song_video_accepted_masters WHERE plan_id = 'plan-overlap'",
        );
        await a.query(
          "INSERT INTO media_song_video_accepted_masters (plan_id, master_revision_id) VALUES ('plan-overlap','master-overlap-a')",
        );
        const blocked = b
          .query(
            "INSERT INTO media_song_video_accepted_masters (plan_id, master_revision_id) VALUES ('plan-overlap','master-overlap-a')",
          )
          .catch((error: unknown) => {
            raised.push(
              error instanceof Error
                ? { code: Reflect.get(error, "code"), message: error.message }
                : { message: String(error) },
            );
            return null;
          });
        await a.query("COMMIT");
        await blocked;
        await b.query("ROLLBACK").catch(() => undefined);
      } finally {
        await a.end();
        await b.end();
      }

      // The overlap is real and the retry path is reachable in production, not
      // only under injection. Because both transactions read the empty
      // acceptance set before writing, PostgreSQL reports a read/write
      // dependency as SQLSTATE 40001 rather than a plain unique violation.
      expect(raised).toHaveLength(1);
      expect(raised[0]?.code).toBe("40001");
      expect(raised[0]?.message).toMatch(/could not serialize access/);
      const accepted = await client.query(
        "SELECT count(*)::int AS n FROM media_song_video_accepted_masters WHERE plan_id = 'plan-overlap'",
      );
      expect(accepted.rows[0]?.n).toBe(1);
    }
  }, 60_000);

  test("the retry path runs and then observes the committed winner", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-retry" });
      await startRenderAttempt(client, {
        attemptId: "attempt-retry",
        planId: "plan-retry",
        generation: 1,
      });
      await sealMaster(client, {
        masterRevisionId: "master-retry",
        attempt: { attemptId: "attempt-retry", planId: "plan-retry", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterSha256: "4".repeat(64),
        masterByteLength: 1_000,
        masterCeilingBytes,
        rendererIdentity: "ffmpeg-7.1.5",
        rendererPolicyRevision: 1,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });

      // Inject a serialization failure on the first attempt so the retry path is
      // exercised deterministically rather than hoped for.
      let injected = 0;
      const retries: number[] = [];
      const flaky = new Proxy(client, {
        get(target, property, receiver) {
          if (property !== "query") return Reflect.get(target, property, receiver);
          return async (...args: unknown[]) => {
            const text = typeof args[0] === "string" ? args[0] : "";
            if (
              text.startsWith("INSERT INTO media_song_video_accepted_masters") &&
              injected === 0
            ) {
              injected += 1;
              const error = new Error("could not serialize access") as Error & { code: string };
              error.code = "40001";
              throw error;
            }
            return await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        },
      }) as typeof client;

      const outcome = await acceptMaster(
        flaky,
        {
          planId: "plan-retry",
          masterRevisionId: "master-retry",
          attemptId: "attempt-retry",
        },
        { sleep: async () => undefined, onSerializationRetry: (n) => retries.push(n) },
      );
      expect(injected).toBe(1);
      expect(retries).toEqual([1]);
      expect(outcome).toEqual({ accepted: true, masterRevisionId: "master-retry" });
      const state = await client.query(
        "SELECT state FROM media_song_video_render_attempts WHERE attempt_id = 'attempt-retry'",
      );
      expect(state.rows[0]?.state).toBe("accepted");
    }
  }, 60_000);

  test("refuses to seal an attempt that is no longer started, and replays an identical seal", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-reseal" });
      await startRenderAttempt(client, {
        attemptId: "attempt-reseal",
        planId: "plan-reseal",
        generation: 1,
      });
      const request = {
        masterRevisionId: "master-reseal",
        attempt: { attemptId: "attempt-reseal", planId: "plan-reseal", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterSha256: "5".repeat(64),
        masterByteLength: 1_000,
        masterCeilingBytes,
        rendererIdentity: "ffmpeg-7.1.5",
        rendererPolicyRevision: 1,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      };
      expect(await sealMaster(client, request)).toMatchObject({ sealed: true });
      // An identical replay of a seal that already committed is success.
      expect(await sealMaster(client, request)).toEqual({
        sealed: true,
        masterRevisionId: "master-reseal",
      });
      // A different master over the same non-started attempt is refused.
      expect(
        await sealMaster(client, {
          ...request,
          masterRevisionId: "master-reseal-2",
          masterSha256: "6".repeat(64),
        }),
      ).toMatchObject({
        sealed: false,
        failure: { kind: "attempt_state_incompatible", state: "sealed" },
      });
      const masters = await client.query(
        "SELECT count(*)::int AS n FROM media_song_video_masters WHERE plan_id = 'plan-reseal'",
      );
      expect(masters.rows[0]?.n).toBe(1);
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
