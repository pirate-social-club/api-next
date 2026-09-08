import { beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  acceptMaster,
  persistRenderPlan,
  startRenderAttempt,
  verifyAndSealMaster,
} from "./song-video-render-repository.ts";
import { finalizedFixture, seedVideoActors } from "./video-publication.pg-fixture.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;

const SAMPLE_RATE = 48_000;
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

  // A fixture output object. Its bytes are real; the prober is a port, so this
  // proves binding and hashing, not real media verification.
  const outputBytes = new TextEncoder().encode("rendered-song-video-master");
  // Each attempt is dispatched to its own output address before execution.
  const dispatchFor = (attemptId: string) => ({
    outputObjectKey: `master-object/${attemptId}`,
    rendererIdentity: "ffmpeg-7.1.5",
    rendererPolicyRevision: 1,
  });
  const outputs = new Map<string, Uint8Array>();
  const outputFor = (attemptId: string) => {
    const key = `master-object/${attemptId}`;
    if (!outputs.has(key)) outputs.set(key, new TextEncoder().encode(`master-for-${attemptId}`));
    return key;
  };
  const store = {
    read: async (key: string) => {
      const bytes = outputs.get(key);
      return bytes === undefined ? null : { bytes, objectVersion: `v1:${key}` };
    },
    readVersion: async (key: string, version: string) => {
      const bytes = outputs.get(key);
      return bytes !== undefined && version === `v1:${key}` ? bytes : null;
    },
  };
  const prober = {
    probe: async () => ({
      videoDurationSamples: basePlan.clipDurationSamples,
      audioDurationSamples: basePlan.clipDurationSamples,
      audioSampleRateHz: 48_000,
      audioChannels: 2,
      hasVideoTrack: true,
    }),
  };
  const seal = (request: Parameters<typeof verifyAndSealMaster>[2]) => {
    outputFor(request.attempt.attemptId);
    return verifyAndSealMaster(client, { store, prober }, request);
  };

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
      await startRenderAttempt(
        client,
        { attemptId: "attempt-1", planId: "plan-song-video-1", generation: 1 },
        dispatchFor("attempt-1"),
      );
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
      await startRenderAttempt(
        client,
        { attemptId: "attempt-mismatch", planId: "plan-mismatch", generation: 1 },
        dispatchFor("attempt-mismatch"),
      );
      const outcome = await seal({
        masterRevisionId: "master-mismatch",
        attempt: { attemptId: "attempt-mismatch", planId: "plan-mismatch", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: "c".repeat(64),
        masterCeilingBytes,
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
      await startRenderAttempt(
        client,
        { attemptId: "attempt-absent", planId: "plan-absent", generation: 1 },
        dispatchFor("attempt-absent"),
      );
      const outcome = await seal({
        masterRevisionId: "master-absent",
        attempt: { attemptId: "attempt-absent", planId: "plan-absent", generation: 1 },
        sourceImmutableRef: "media://immutable/not-stored",
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
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
      await startRenderAttempt(
        client,
        { attemptId: "attempt-bound", planId: "plan-bound", generation: 1 },
        dispatchFor("attempt-bound"),
      );
      const outcome = await seal({
        masterRevisionId: "master-bound",
        attempt: { attemptId: "attempt-bound", planId: "plan-bound", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });
      expect(outcome).toMatchObject({ sealed: true });
      const stored = await client.query(
        "SELECT source_sha256, master_sha256, master_ceiling_bytes FROM media_song_video_masters WHERE master_revision_id = 'master-bound'",
      );
      // The master digest is measured from the verified output bytes, and the
      // source digest is the stored one, so neither came from the caller.
      const attemptBytes = outputs.get(outputFor("attempt-bound"));
      if (attemptBytes === undefined) throw new Error("expected fixture output bytes");
      const measured = await crypto.subtle.digest("SHA-256", attemptBytes);
      const measuredHex = [...new Uint8Array(measured)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      expect(stored.rows[0]).toMatchObject({
        source_sha256: storedSourceSha256,
        master_sha256: measuredHex,
      });
      const facts = await client.query(
        "SELECT verified_object_key, verified_object_version, measured_audio_channels FROM media_song_video_masters WHERE master_revision_id = 'master-bound'",
      );
      expect(facts.rows[0]).toMatchObject({
        verified_object_key: "master-object/attempt-bound",
        verified_object_version: "v1:master-object/attempt-bound",
        measured_audio_channels: 2,
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
        await startRenderAttempt(
          client,
          { attemptId, planId: "plan-race", generation },
          dispatchFor(attemptId),
        );
        const sealed = await seal({
          masterRevisionId: revisionId,
          attempt: { attemptId, planId: "plan-race", generation },
          sourceImmutableRef,
          claimedSourceSha256: storedSourceSha256,
          masterCeilingBytes,
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
      await startRenderAttempt(
        client,
        { attemptId: "attempt-replay", planId: "plan-replay", generation: 1 },
        dispatchFor("attempt-replay"),
      );
      await seal({
        masterRevisionId: "master-replay",
        attempt: { attemptId: "attempt-replay", planId: "plan-replay", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
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
      await startRenderAttempt(
        client,
        { attemptId: "attempt-of-a", planId: "plan-other-a", generation: 1 },
        dispatchFor("attempt-of-a"),
      );
      const outcome = await seal({
        masterRevisionId: "master-crossed",
        // A real attempt and a real plan that are not the same work.
        attempt: { attemptId: "attempt-of-a", planId: "plan-other-b", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });
      expect(outcome).toMatchObject({ sealed: false, failure: { kind: "attempt_not_of_plan" } });
    }
  }, 60_000);

  test("refuses a generation that is not the stored one", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-generation" });
      await startRenderAttempt(
        client,
        { attemptId: "attempt-generation", planId: "plan-generation", generation: 1 },
        dispatchFor("attempt-generation"),
      );
      const outcome = await seal({
        masterRevisionId: "master-generation",
        attempt: { attemptId: "attempt-generation", planId: "plan-generation", generation: 7 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
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
      await startRenderAttempt(
        client,
        { attemptId: "attempt-interval", planId: "plan-interval", generation: 1 },
        dispatchFor("attempt-interval"),
      );
      const outcome = await seal({
        masterRevisionId: "master-interval",
        attempt: { attemptId: "attempt-interval", planId: "plan-interval", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
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
      await startRenderAttempt(
        client,
        { attemptId: "attempt-overlap-a", planId: "plan-overlap", generation: 1 },
        dispatchFor("attempt-overlap-a"),
      );
      await seal({
        masterRevisionId: "master-overlap-a",
        attempt: { attemptId: "attempt-overlap-a", planId: "plan-overlap", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
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
      await startRenderAttempt(
        client,
        { attemptId: "attempt-retry", planId: "plan-retry", generation: 1 },
        dispatchFor("attempt-retry"),
      );
      await seal({
        masterRevisionId: "master-retry",
        attempt: { attemptId: "attempt-retry", planId: "plan-retry", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
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
      await startRenderAttempt(
        client,
        { attemptId: "attempt-reseal", planId: "plan-reseal", generation: 1 },
        dispatchFor("attempt-reseal"),
      );
      const request = {
        masterRevisionId: "master-reseal",
        attempt: { attemptId: "attempt-reseal", planId: "plan-reseal", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      };
      expect(await seal(request)).toMatchObject({ sealed: true });
      // An identical replay of a seal that already committed is success.
      expect(await seal(request)).toEqual({
        sealed: true,
        masterRevisionId: "master-reseal",
      });
      // A different master over the same non-started attempt is refused.
      expect(
        await seal({
          ...request,
          masterRevisionId: "master-reseal-2",
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

  test("refuses to seal when the output cannot be verified, leaving no master", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-unverified" });
      await startRenderAttempt(
        client,
        { attemptId: "attempt-unverified", planId: "plan-unverified", generation: 1 },
        dispatchFor("attempt-unverified"),
      );
      const request = {
        masterRevisionId: "master-unverified",
        attempt: { attemptId: "attempt-unverified", planId: "plan-unverified", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      };
      outputFor("attempt-unverified");
      // No completed output at that key.
      const absent = await verifyAndSealMaster(
        client,
        { store: { read: async () => null, readVersion: async () => null }, prober },
        request,
      );
      expect(absent).toMatchObject({
        sealed: false,
        failure: { kind: "output_not_verified", reason: "output_absent" },
      });
      // A short audio track behind a correct video duration.
      const shortAudio = await verifyAndSealMaster(
        client,
        {
          store,
          prober: {
            probe: async () => ({
              videoDurationSamples: basePlan.clipDurationSamples,
              audioDurationSamples: basePlan.clipDurationSamples - 1,
              audioSampleRateHz: 48_000,
              audioChannels: 2,
              hasVideoTrack: true,
            }),
          },
        },
        request,
      );
      expect(shortAudio).toMatchObject({
        sealed: false,
        failure: { kind: "output_not_verified", reason: "output_duration_not_plan_interval" },
      });
      // Bytes replaced between verification and commit.
      const shifting = {
        read: store.read,
        // The verified version stops resolving before the seal re-reads it.
        readVersion: (() => {
          let calls = 0;
          return async (key: string, version: string) => {
            calls += 1;
            return calls === 1 ? await store.readVersion(key, version) : null;
          };
        })(),
      };
      expect(await verifyAndSealMaster(client, { store: shifting, prober }, request)).toMatchObject(
        {
          sealed: false,
          failure: { kind: "output_changed_during_seal" },
        },
      );

      const masters = await client.query(
        "SELECT count(*)::int AS n FROM media_song_video_masters WHERE plan_id = 'plan-unverified'",
      );
      expect(masters.rows[0]?.n).toBe(0);
      const state = await client.query(
        "SELECT state FROM media_song_video_render_attempts WHERE attempt_id = 'attempt-unverified'",
      );
      expect(state.rows[0]?.state).toBe("started");
    }
  }, 60_000);

  test("refuses a master built from another attempt's output, even when durations match", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-crossed-output" });
      for (const [attemptId, generation] of [
        ["attempt-out-a", 1],
        ["attempt-out-b", 2],
      ] as const) {
        await startRenderAttempt(
          client,
          { attemptId, planId: "plan-crossed-output", generation },
          dispatchFor(attemptId),
        );
        outputFor(attemptId);
      }

      // Both outputs probe identically. The only thing distinguishing them is
      // the dispatch binding recorded before execution.
      const sealedA = await seal({
        masterRevisionId: "master-out-a",
        attempt: { attemptId: "attempt-out-a", planId: "plan-crossed-output", generation: 1 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });
      expect(sealedA).toMatchObject({ sealed: true });

      const storedA = await client.query(
        "SELECT verified_object_key FROM media_song_video_masters WHERE master_revision_id = 'master-out-a'",
      );
      // A's master resolved A's dispatched output, not B's, and nothing in the
      // request could have selected otherwise.
      expect(storedA.rows[0]?.verified_object_key).toBe("master-object/attempt-out-a");

      const sealedB = await seal({
        masterRevisionId: "master-out-b",
        attempt: { attemptId: "attempt-out-b", planId: "plan-crossed-output", generation: 2 },
        sourceImmutableRef,
        claimedSourceSha256: storedSourceSha256,
        masterCeilingBytes,
        decisionClipStartSamples: basePlan.clipStartSamples,
        decisionClipDurationSamples: basePlan.clipDurationSamples,
      });
      expect(sealedB).toMatchObject({ sealed: true });
      const storedB = await client.query(
        "SELECT verified_object_key, master_sha256 FROM media_song_video_masters WHERE master_revision_id = 'master-out-b'",
      );
      expect(storedB.rows[0]?.verified_object_key).toBe("master-object/attempt-out-b");
      // Distinct outputs produced distinct master digests, so the two masters
      // are not interchangeable records of the same bytes.
      expect(storedB.rows[0]?.master_sha256).not.toBe(storedA.rows[0]?.master_sha256);
    }
  }, 60_000);

  test("refuses to seal when the verified version is no longer addressable", async () => {
    {
      await persistRenderPlan(client, { ...basePlan, planId: "plan-version" });
      await startRenderAttempt(
        client,
        { attemptId: "attempt-version", planId: "plan-version", generation: 1 },
        dispatchFor("attempt-version"),
      );
      outputFor("attempt-version");
      const vanishing = {
        read: store.read,
        // Addressable during verification, gone by the time sealing re-resolves.
        readVersion: (() => {
          let calls = 0;
          return async (key: string, version: string) => {
            calls += 1;
            return calls === 1 ? await store.readVersion(key, version) : null;
          };
        })(),
      };
      const outcome = await verifyAndSealMaster(
        client,
        { store: vanishing, prober },
        {
          masterRevisionId: "master-version",
          attempt: { attemptId: "attempt-version", planId: "plan-version", generation: 1 },
          sourceImmutableRef,
          claimedSourceSha256: storedSourceSha256,
          masterCeilingBytes,
          decisionClipStartSamples: basePlan.clipStartSamples,
          decisionClipDurationSamples: basePlan.clipDurationSamples,
        },
      );
      expect(outcome).toMatchObject({
        sealed: false,
        failure: { kind: "output_changed_during_seal" },
      });
      const masters = await client.query(
        "SELECT count(*)::int AS n FROM media_song_video_masters WHERE plan_id = 'plan-version'",
      );
      expect(masters.rows[0]?.n).toBe(0);
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
