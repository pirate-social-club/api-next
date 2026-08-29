import { describe, expect, test } from "bun:test";
import type { ScorableKaraokeLine } from "../scoring";
import { createKaraokeSessionState } from "../session";
import { KaraokeSessionHost, type KaraokeTransportGuardDiagnostic } from "../session-host";
import {
  KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  type KaraokeClientBinaryFrame,
  type KaraokeClientEvent,
  type KaraokeStreamingSttEvent,
} from "../transport";
import { FakeKaraokeEffectRunner, FakeKaraokeStreamingSttAdapter } from "./testing";

const LINES: ScorableKaraokeLine[] = [
  {
    endMs: 1000,
    lineId: "line-1",
    lineIndex: 0,
    scoredLineIndex: 0,
    startMs: 0,
    text: "hold on",
    words: [
      { endMs: 400, startMs: 0, text: "hold" },
      { endMs: 900, startMs: 500, text: "on" },
    ],
  },
];

const ENVELOPE = {
  attemptId: "attempt-1",
  protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  sessionId: "session-1",
} as const;

function state() {
  return createKaraokeSessionState({
    attemptId: ENVELOPE.attemptId,
    lines: LINES,
    scoringPolicy: {
      kind: "enabled",
      model: "fake-model",
      provider: "elevenlabs",
      retention: "not_stored",
    },
    sessionId: ENVELOPE.sessionId,
  });
}

function client(
  sequence: number,
  event: { type: KaraokeClientEvent["type"] } & Record<string, unknown>,
): KaraokeClientEvent {
  return { ...ENVELOPE, ...event, sequence } as KaraokeClientEvent;
}

function stt(sequence: number): KaraokeStreamingSttEvent {
  return {
    ...ENVELOPE,
    deliveredAtAudioMs: 900,
    sequence,
    text: "hold on",
    type: "stt_final",
    words: [
      { confidence: 0.95, endMs: 400, startMs: 0, text: "hold" },
      { confidence: 0.95, endMs: 900, startMs: 500, text: "on" },
    ],
  };
}

describe("KaraokeSessionHost (package)", () => {
  test("drives the reducer, binary audio adapter, and ordered effect runner", async () => {
    const effectRunner = new FakeKaraokeEffectRunner();
    const sttAdapter = new FakeKaraokeStreamingSttAdapter();
    const host = new KaraokeSessionHost(state(), effectRunner, sttAdapter);

    await host.handleClientEvent(
      client(0, { postId: "post-1", startedAtAudioMs: 0, type: "start" }),
    );
    const audioFrame: KaraokeClientBinaryFrame = {
      ...ENVELOPE,
      chunkId: 1,
      pcm16: new ArrayBuffer(8),
      sampleRate: 16000,
      sequence: 1,
      songEndMs: 400,
      songStartMs: 0,
      type: "audio_chunk",
    };
    await host.handleAudioFrame(audioFrame);
    await sttAdapter.emit(stt(0));
    await host.handleClientEvent(
      client(2, {
        audioTimeMs: 1100,
        lineId: "line-1",
        lineIndex: 0,
        scoredLineIndex: 0,
        type: "line_boundary",
      }),
    );
    await host.handleClientEvent(client(3, { audioTimeMs: 1200, type: "finish" }));
    // Finish drains on the serialized commit chain; settle it before asserting.
    await host.drainCommitChain();

    expect(host.snapshot().state.status).toBe("finalized");
    expect(sttAdapter.startCount).toBe(1);
    expect(sttAdapter.frames).toEqual([audioFrame]);
    expect(sttAdapter.closeCount).toBe(1);
    expect(effectRunner.relayedSttEvents).toEqual([stt(0)]);
    expect(effectRunner.relayedStates[0]?.recognizedWords.map((word) => word.text)).toEqual([
      "hold",
      "on",
    ]);
    // The fake adapter refuses commits, so the watermark never advances: the line
    // defers at the boundary (request_stt_commit is handled by the host scheduler,
    // not surfaced to the effect runner) and is finalized by the terminal sweep at
    // finish. With a commit-capable adapter it finalizes at the boundary instead.
    expect(effectRunner.effects.map((effect) => effect.type)).toEqual([
      "resume_audio_stream",
      "close_stt_stream",
      "lock_line_assignment",
      "emit_line_score",
      "discard_audio",
      "emit_summary",
    ]);
  });

  test("JSON and binary frames share a single sequence space", async () => {
    const effectRunner = new FakeKaraokeEffectRunner();
    const host = new KaraokeSessionHost(
      state(),
      effectRunner,
      new FakeKaraokeStreamingSttAdapter(),
    );

    expect(
      await host.handleClientEvent(
        client(0, { postId: "post-1", startedAtAudioMs: 0, type: "start" }),
      ),
    ).toBeNull();

    const replayedJson = await host.handleClientEvent(
      client(0, { audioTimeMs: 100, type: "pause" }),
    );
    expect(replayedJson?.code).toBe("non_monotonic_sequence");

    const replayedBinary = await host.handleAudioFrame({
      ...ENVELOPE,
      chunkId: 1,
      pcm16: new ArrayBuffer(8),
      sampleRate: 16000,
      sequence: 0,
      songEndMs: 400,
      songStartMs: 0,
      type: "audio_chunk",
    });
    expect(replayedBinary?.code).toBe("non_monotonic_sequence");

    expect(effectRunner.transportErrors.map((err) => err.code)).toEqual([
      "non_monotonic_sequence",
      "non_monotonic_sequence",
    ]);
  });

  test("rejects audio unless the session is recording", async () => {
    const effectRunner = new FakeKaraokeEffectRunner();
    const sttAdapter = new FakeKaraokeStreamingSttAdapter();
    const host = new KaraokeSessionHost(state(), effectRunner, sttAdapter);
    const audioFrame: KaraokeClientBinaryFrame = {
      ...ENVELOPE,
      chunkId: 1,
      pcm16: new ArrayBuffer(8),
      sampleRate: 16000,
      sequence: 0,
      songEndMs: 400,
      songStartMs: 0,
      type: "audio_chunk",
    };

    expect((await host.handleAudioFrame(audioFrame))?.code).toBe("session_not_recording");
    expect(sttAdapter.frames).toHaveLength(0);
    expect(host.snapshot().lastClientSequence).toBeNull();

    await host.handleClientEvent(
      client(0, { postId: "post-1", startedAtAudioMs: 0, type: "start" }),
    );
    await host.handleClientEvent(client(1, { audioTimeMs: 100, type: "pause" }));
    expect((await host.handleAudioFrame({ ...audioFrame, sequence: 2 }))?.code).toBe(
      "session_not_recording",
    );
    expect(sttAdapter.frames).toHaveLength(0);
  });

  test("STT adapter start failure aborts with stt_adapter_start_failed", async () => {
    const effectRunner = new FakeKaraokeEffectRunner();
    const sttAdapter = new FakeKaraokeStreamingSttAdapter();
    sttAdapter.start = async () => {
      throw new Error("auth failed");
    };
    const host = new KaraokeSessionHost(state(), effectRunner, sttAdapter);

    const result = await host.handleClientEvent(
      client(0, { postId: "post-1", startedAtAudioMs: 0, type: "start" }),
    );

    expect(result?.code).toBe("session_aborted");
    expect(host.snapshot().state.status).toBe("aborted");
    expect(host.snapshot().state.errorCode).toBe("stt_adapter_start_failed");
  });

  test("restores client and STT sequence counters", async () => {
    const effectRunner = new FakeKaraokeEffectRunner();
    const host = new KaraokeSessionHost(
      state(),
      effectRunner,
      new FakeKaraokeStreamingSttAdapter(),
      { restore: { lastClientSequence: 4, lastSttSequence: 2 } },
    );

    const clientReplay = await host.handleClientEvent(
      client(4, {
        audioTimeMs: 100,
        type: "pause",
      }),
    );
    const sttReplay = await host.handleSttEvent(stt(2));

    expect(clientReplay?.code).toBe("non_monotonic_sequence");
    expect(sttReplay?.code).toBe("non_monotonic_sequence");
    expect(host.snapshot()).toMatchObject({
      lastClientSequence: 4,
      lastSttSequence: 2,
    });
  });
});

describe("KaraokeSessionHost transport guard diagnostics", () => {
  function hostWithDiagnostics() {
    const diagnostics: KaraokeTransportGuardDiagnostic[] = [];
    const effectRunner = new FakeKaraokeEffectRunner();
    const sttAdapter = new FakeKaraokeStreamingSttAdapter();
    const host = new KaraokeSessionHost(state(), effectRunner, sttAdapter, {
      onTransportGuardFailure: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });
    return { diagnostics, effectRunner, host, sttAdapter };
  }

  test("records a client-channel rejection with both sequences", async () => {
    const { diagnostics, host } = hostWithDiagnostics();
    await host.handleClientEvent(
      client(5, { postId: "post-1", startedAtAudioMs: 0, type: "start" }),
    );
    // Replaying 5 is non-monotonic against the accepted high-water mark of 5.
    await host.handleClientEvent(client(5, { audioTimeMs: 10, type: "pause" }));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      attemptId: ENVELOPE.attemptId,
      channel: "client",
      code: "non_monotonic_sequence",
      incomingSequence: 5,
      previousSequence: 5,
      sessionId: ENVELOPE.sessionId,
    });
  });

  test("records an STT-channel rejection and the stream generation", async () => {
    const { diagnostics, host, sttAdapter } = hostWithDiagnostics();
    await host.handleClientEvent(
      client(1, { postId: "post-1", startedAtAudioMs: 0, type: "start" }),
    );
    await sttAdapter.emit(stt(4));
    await host.drainCommitChain();
    // A restarted stream replaying 1 against a high-water mark of 4 — the shape
    // the seeding defect produced in production.
    await sttAdapter.emit(stt(1));
    await host.drainCommitChain();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      channel: "stt",
      code: "non_monotonic_sequence",
      incomingSequence: 1,
      previousSequence: 4,
    });
    expect(diagnostics[0]?.sttStreamGeneration).toBe(sttAdapter.streamGeneration);
  });

  test("stays silent on healthy traffic", async () => {
    const { diagnostics, host, sttAdapter } = hostWithDiagnostics();
    await host.handleClientEvent(
      client(1, { postId: "post-1", startedAtAudioMs: 0, type: "start" }),
    );
    await host.handleAudioFrame({
      ...ENVELOPE,
      chunkId: 1,
      pcm16: new ArrayBuffer(8),
      sampleRate: 16000,
      sequence: 2,
      songEndMs: 400,
      songStartMs: 0,
      type: "audio_chunk",
    });
    await sttAdapter.emit(stt(1));
    await sttAdapter.emit(stt(2));
    await host.drainCommitChain();

    expect(diagnostics).toEqual([]);
  });

  test("a throwing sink cannot break the transport path", async () => {
    const effectRunner = new FakeKaraokeEffectRunner();
    const sttAdapter = new FakeKaraokeStreamingSttAdapter();
    const host = new KaraokeSessionHost(state(), effectRunner, sttAdapter, {
      onTransportGuardFailure: () => {
        throw new Error("sink exploded");
      },
    });
    await host.handleClientEvent(
      client(5, { postId: "post-1", startedAtAudioMs: 0, type: "start" }),
    );
    const rejected = await host.handleClientEvent(client(5, { audioTimeMs: 10, type: "pause" }));

    // The rejection is still reported normally despite the sink throwing.
    expect(rejected?.code).toBe("non_monotonic_sequence");
    expect(effectRunner.transportErrors.at(-1)?.code).toBe("non_monotonic_sequence");
  });
});
