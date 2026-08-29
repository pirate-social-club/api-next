/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { runInDurableObject, env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { KaraokeSessionSummary } from "../../packages/application/src/karaoke-runtime/scoring.ts";
import type {
  KaraokeRecordingResult,
  KaraokeSessionAuthority,
} from "../../packages/application/src/karaoke-service.ts";
import type { KaraokeAttemptDO } from "../../packages/platform-cf/src/karaoke-attempt-do.ts";

const env = testEnv as unknown as {
  readonly KARAOKE_ATTEMPT: DurableObjectNamespace<KaraokeAttemptDO>;
  readonly LEARNER_AUDIO: R2Bucket;
};

type ArchiveHarness = {
  archiveFrame(frameSequence: number, pcm: ArrayBuffer, songEndMs: number): Promise<void>;
  finishArchive(): Promise<KaraokeRecordingResult>;
};

const abandonedSummary: KaraokeSessionSummary = {
  confidenceMean: null,
  finalScore: 0,
  lineCount: 1,
  lineDiagnostics: [],
  lowConfidenceLineCount: 0,
  lyricsScore: 0,
  missedWords: [],
  noRecognitionLineCount: 1,
  phoneticUnavailableLineCount: 1,
  scoredLineCount: 0,
  strongestLines: [],
  timingCalibration: {
    matchedWordCount: 0,
    measuredLineCount: 0,
    offsetMs: 0,
    rawOffsetMs: 0,
    reason: "insufficient_evidence",
    residualSpreadMs: 0,
    state: "uncalibrated",
  },
  timingScore: null,
  timingTrend: "on_time",
  uncertainLineCount: 1,
  weakestLines: [],
};

const authority = (sessionId: string): KaraokeSessionAuthority => ({
  accountId: "account-workerd",
  artifactId: `artifact-${sessionId}`,
  attemptId: `attempt-${sessionId}`,
  audioRevision: 1,
  communityId: "community-workerd",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
  karaokeRevisionId: "karaoke-revision-workerd",
  lines: [
    {
      end_ms: 1_000,
      id: "line-workerd",
      index: 0,
      kind: "lyric",
      start_ms: 0,
      text: "hold on",
      words: [{ end_ms: 400, start_ms: 0, text: "hold" }],
    },
  ],
  lyricsRevision: 1,
  personaId: "persona-workerd",
  playbackKind: "full_mix",
  postId: "post-workerd",
  qualificationPolicyVersionId: "karaoke_qualification_v2@1",
  requestHash: "a".repeat(64),
  scoringModel: "scribe_v2_realtime",
  scoringProvider: "elevenlabs",
  scoringVersion: 5,
  sessionId,
  timezone: "UTC",
});

const connect = async (stub: DurableObjectStub<KaraokeAttemptDO>, token: string) => {
  const response = await stub.fetch(`https://worker.test/?token=${encodeURIComponent(token)}`, {
    headers: { Upgrade: "websocket" },
  });
  response.webSocket?.accept();
  return response;
};

describe("Karaoke attempt Durable Object", () => {
  it("consumes connection tokens once and counts only later sockets as reconnects", async () => {
    const sessionId = `karaoke-${crypto.randomUUID()}`;
    const stub = env.KARAOKE_ATTEMPT.getByName(sessionId);
    const frozenAuthority = authority(sessionId);
    const first = await stub.initialize(frozenAuthority);

    expect((await connect(stub, first.token)).status).toBe(101);
    expect((await connect(stub, first.token)).status).toBe(401);

    const second = await stub.initialize(frozenAuthority);
    expect((await connect(stub, second.token)).status).toBe(101);

    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ epoch_count: number; reconnect_count: number }>(
          "SELECT epoch_count,reconnect_count FROM karaoke_transport WHERE id=1",
        )
        .one();
      expect(row).toEqual({ epoch_count: 2, reconnect_count: 1 });
    });
  });

  it("orders and deduplicates accepted PCM by validated frame sequence", async () => {
    const sessionId = `karaoke-stored-${crypto.randomUUID()}`;
    const stub = env.KARAOKE_ATTEMPT.getByName(sessionId);
    await stub.initialize(authority(sessionId));
    const chunk = new Uint8Array(256 * 1024);
    chunk.fill(7);
    const tail = new Uint8Array([1, 2, 3, 4]);

    const result = await runInDurableObject(stub, async (instance) => {
      const archive = instance as unknown as ArchiveHarness;
      for (let index = 1; index <= 20; index += 1) {
        await archive.archiveFrame(index, chunk.buffer, index * 500);
      }
      await archive.archiveFrame(21, tail.buffer, 10_001);
      await archive.archiveFrame(21, new Uint8Array([9, 9]).buffer, 20_000);
      return await archive.finishArchive();
    });

    expect(result).toMatchObject({
      byteSize: chunk.byteLength * 20 + tail.byteLength,
      durationMs: 10_001,
      state: "stored",
    });
    const stored = await env.LEARNER_AUDIO.get(`karaoke/account-workerd/attempt-${sessionId}.pcm`);
    expect(stored?.size).toBe(chunk.byteLength * 20 + tail.byteLength);
    await env.LEARNER_AUDIO.delete(`karaoke/account-workerd/attempt-${sessionId}.pcm`);
    const cached = await runInDurableObject(
      stub,
      async (instance) => await (instance as unknown as ArchiveHarness).finishArchive(),
    );
    expect(cached).toEqual(result);
  });

  it("aborts an open multipart upload after archival fails", async () => {
    const sessionId = `karaoke-failed-${crypto.randomUUID()}`;
    const stub = env.KARAOKE_ATTEMPT.getByName(sessionId);
    await stub.initialize(authority(sessionId));
    const chunk = new Uint8Array(256 * 1024);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const archive = instance as unknown as ArchiveHarness;
      for (let index = 1; index <= 20; index += 1) {
        await archive.archiveFrame(index, chunk.buffer, index * 500);
      }
      state.storage.sql.exec("UPDATE karaoke_archive SET state='failed' WHERE id=1");
      return await archive.finishArchive();
    });

    expect(result).toEqual({ failureKind: "multipart_failed", state: "failed" });
    expect(
      await env.LEARNER_AUDIO.get(`karaoke/account-workerd/attempt-${sessionId}.pcm`),
    ).toBeNull();
  });

  it("keeps both outbox legs pending and rearms the alarm when Postgres is unavailable", async () => {
    const sessionId = `karaoke-alarm-${crypto.randomUUID()}`;
    const stub = env.KARAOKE_ATTEMPT.getByName(sessionId);
    await stub.initialize(authority(sessionId));

    await runInDurableObject(stub, async (instance, state) => {
      await instance.enqueueFinalization("abandoned", abandonedSummary);
      await instance.alarm();
      const row = state.storage.sql
        .exec<{ recording_state: string; score_state: string }>(
          "SELECT recording_state,score_state FROM karaoke_outbox WHERE id=1",
        )
        .one();
      expect(row).toEqual({ recording_state: "pending", score_state: "pending" });
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      const terminal = state.storage.sql
        .exec<{ payload_json: string; snapshot_json: string; terminal: number }>(
          `SELECT outbox.payload_json,session.snapshot_json,session.terminal
             FROM karaoke_outbox AS outbox CROSS JOIN karaoke_session AS session
            WHERE outbox.id=1 AND session.id=1`,
        )
        .one();
      expect(terminal.snapshot_json).toBe("{}");
      expect(terminal.terminal).toBe(1);
      expect(terminal.payload_json).not.toContain("hold on");
    });
  });
});
