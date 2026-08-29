import { describe, expect, test } from "bun:test";
import type { KaraokeRecognizedWord, ScorableKaraokeLine } from "../scoring";
import { createKaraokeSessionState, type KaraokeScoringPolicy } from "../session";
import {
  KaraokeSessionHost,
  type KaraokeStreamingSttAdapter,
  type KaraokeSttAdapterMessage,
} from "../session-host";
import type { KaraokeClientBinaryFrame, KaraokeClientEvent } from "../transport";
import { KARAOKE_TRANSPORT_PROTOCOL_VERSION } from "../transport";
import { FakeKaraokeEffectRunner } from "./testing";

const PV = KARAOKE_TRANSPORT_PROTOCOL_VERSION;
const LINES: ScorableKaraokeLine[] = [
  {
    endMs: 1000,
    lineId: "l1",
    lineIndex: 0,
    scoredLineIndex: 0,
    startMs: 0,
    text: "hold on",
    words: [{ endMs: 400, startMs: 0, text: "hold" }],
  },
  {
    endMs: 2200,
    lineId: "l2",
    lineIndex: 1,
    scoredLineIndex: 1,
    startMs: 1200,
    text: "almost home",
    words: [{ endMs: 1600, startMs: 1200, text: "almost" }],
  },
];
const ENABLED: KaraokeScoringPolicy = {
  kind: "enabled",
  model: "m",
  provider: "elevenlabs",
  retention: "not_stored",
};
const L1_WORDS: KaraokeRecognizedWord[] = [
  { confidence: 0.95, endMs: 400, final: true, startMs: 0, text: "hold" },
];

class FakeTimers {
  now = 0;
  private timers = new Map<number, { at: number; cb: () => void }>();
  private id = 0;
  setTimer = (cb: () => void, ms: number): unknown => {
    this.id += 1;
    this.timers.set(this.id, { at: this.now + ms, cb });
    return this.id;
  };
  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  advance(ms: number): void {
    this.now += ms;
  }
  fireAll(): void {
    for (const [id, timer] of [...this.timers]) {
      this.timers.delete(id);
      timer.cb();
    }
  }
}

class ControllableSttAdapter implements KaraokeStreamingSttAdapter {
  streamGeneration: string | null = null;
  commitCalls = 0;
  refuseCommits = false;
  private onMessage: ((m: KaraokeSttAdapterMessage) => Promise<void>) | null = null;
  private inFlight: { commitId: string; frontierMs: number } | null = null;
  private commitSeq = 0;
  private sttSeq = 0;
  private submittedFrontierMs = 0;

  constructor(private readonly generation = "gen-1") {}

  async start(input: {
    attemptId: string;
    sessionId: string;
    onMessage: (m: KaraokeSttAdapterMessage) => Promise<void>;
  }): Promise<void> {
    this.streamGeneration = this.generation;
    this.onMessage = input.onMessage;
    this.inFlight = null;
  }
  async sendPcm16(frame: KaraokeClientBinaryFrame): Promise<void> {
    this.submittedFrontierMs = frame.songEndMs;
  }
  async commit(): Promise<{
    commitId: string;
    streamGeneration: string;
    frontierMs: number;
  } | null> {
    this.commitCalls += 1;
    if (this.refuseCommits || this.inFlight || !this.streamGeneration) return null;
    this.commitSeq += 1;
    const handle = {
      commitId: `c${this.commitSeq}`,
      frontierMs: this.submittedFrontierMs,
      streamGeneration: this.streamGeneration,
    };
    this.inFlight = { commitId: handle.commitId, frontierMs: handle.frontierMs };
    return handle;
  }
  async close(): Promise<void> {
    this.streamGeneration = null;
    this.onMessage = null;
  }

  hasInFlight(): boolean {
    return this.inFlight !== null;
  }

  // Emits a committed final acknowledging the in-flight commit. Overrides let a
  // test forge a stale/mismatched ack.
  async ack(
    words: KaraokeRecognizedWord[],
    overrides: { commitId?: string; streamGeneration?: string; coverageMs?: number } = {},
  ): Promise<void> {
    const inflight = this.inFlight;
    this.inFlight = null;
    this.sttSeq += 1;
    const commit = {
      commitId: overrides.commitId ?? inflight?.commitId ?? "c?",
      coverageMs: overrides.coverageMs ?? inflight?.frontierMs ?? 0,
      streamGeneration: overrides.streamGeneration ?? this.streamGeneration ?? "gen-1",
    };
    await this.onMessage?.({
      commit,
      event: {
        attemptId: "a",
        deliveredAtAudioMs: commit.coverageMs,
        protocolVersion: PV,
        sequence: this.sttSeq,
        sessionId: "s",
        text: words.map((w) => w.text).join(" "),
        type: "stt_final",
        words,
      },
    });
  }
}

let clientSeq = 0;
function client(
  event: Omit<
    KaraokeClientEvent,
    keyof { protocolVersion: 1; sessionId: string; attemptId: string; sequence: number }
  > &
    Record<string, unknown>,
): KaraokeClientEvent {
  clientSeq += 1;
  return {
    attemptId: "a",
    protocolVersion: PV,
    sequence: clientSeq,
    sessionId: "s",
    ...event,
  } as KaraokeClientEvent;
}
function audioFrame(songEndMs: number): KaraokeClientBinaryFrame {
  clientSeq += 1;
  return {
    attemptId: "a",
    chunkId: clientSeq,
    pcm16: new ArrayBuffer(8),
    protocolVersion: PV,
    sampleRate: 16_000,
    sequence: clientSeq,
    sessionId: "s",
    songEndMs,
    songStartMs: 0,
    type: "audio_chunk",
  };
}

function setup(
  adapter: ControllableSttAdapter,
  timers: FakeTimers,
  onCommitSettled?: (latencyMs: number) => void,
) {
  const effectRunner = new FakeKaraokeEffectRunner();
  const host = new KaraokeSessionHost(
    createKaraokeSessionState({
      attemptId: "a",
      lines: LINES,
      scoringPolicy: ENABLED,
      sessionId: "s",
    }),
    effectRunner,
    adapter,
    {
      clearTimer: timers.clearTimer,
      commitAckTimeoutMs: 5_000,
      now: () => timers.now,
      ...(onCommitSettled === undefined ? {} : { onCommitSettled }),
      setTimer: timers.setTimer,
    },
  );
  return { effectRunner, host };
}

// Drive start + one audio frame + a playback_sync past l1 so l1 is due and the
// scheduler issues a commit.
async function reachPendingCommit(
  host: KaraokeSessionHost,
  _adapter: ControllableSttAdapter,
): Promise<void> {
  clientSeq = 0;
  await host.handleClientEvent(client({ postId: "p", startedAtAudioMs: 0, type: "start" }));
  await host.handleAudioFrame(audioFrame(1000));
  await host.handleClientEvent(client({ audioTimeMs: 1100, playing: true, type: "playback_sync" }));
  await host.drainCommitChain();
}

describe("karaoke commit scheduler (host)", () => {
  test("commit ack advances the watermark and finalizes the covered line", async () => {
    const adapter = new ControllableSttAdapter();
    const timers = new FakeTimers();
    const { host } = setup(adapter, timers);
    await reachPendingCommit(host, adapter);
    expect(adapter.commitCalls).toBe(1);
    expect(host.snapshot().state.pendingCommit).not.toBeNull();

    await adapter.ack(L1_WORDS);
    await host.drainCommitChain();
    const scores = host.snapshot().state.finalizedLineScores;
    expect(scores).toHaveLength(1);
    expect(scores[0]?.finalizedReason).toBe("asr_final");
    expect(host.snapshot().state.pendingCommit).toBeNull();
  });

  test("reports provider commit acknowledgement latency", async () => {
    const adapter = new ControllableSttAdapter();
    const timers = new FakeTimers();
    const latencies: number[] = [];
    const { host } = setup(adapter, timers, (latencyMs) => latencies.push(latencyMs));
    await reachPendingCommit(host, adapter);
    timers.advance(275);
    await adapter.ack(L1_WORDS);
    await host.drainCommitChain();
    expect(latencies).toEqual([275]);
  });

  test("duplicate request_stt_commit effects produce one adapter call", async () => {
    const adapter = new ControllableSttAdapter();
    const timers = new FakeTimers();
    const { host } = setup(adapter, timers);
    await reachPendingCommit(host, adapter);
    // More playback ticks while the commit is still in flight → each emits a
    // request, but the scheduler coalesces them.
    await host.handleClientEvent(
      client({ audioTimeMs: 1150, playing: true, type: "playback_sync" }),
    );
    await host.handleClientEvent(
      client({ audioTimeMs: 1180, playing: true, type: "playback_sync" }),
    );
    await host.drainCommitChain();
    expect(adapter.commitCalls).toBe(1);
  });

  test("ack and timeout race: only one finalization wins (ack first)", async () => {
    const adapter = new ControllableSttAdapter();
    const timers = new FakeTimers();
    const { host } = setup(adapter, timers);
    await reachPendingCommit(host, adapter);
    await adapter.ack(L1_WORDS); // enqueues the ack
    timers.fireAll(); // enqueues the timeout AFTER the ack
    await host.drainCommitChain();
    const scores = host.snapshot().state.finalizedLineScores;
    expect(scores).toHaveLength(1);
    expect(scores[0]?.finalizedReason).toBe("asr_final"); // ack won; timeout was a no-op
  });

  test("ack and timeout race: only one finalization wins (timeout first)", async () => {
    const adapter = new ControllableSttAdapter();
    const timers = new FakeTimers();
    const { host } = setup(adapter, timers);
    await reachPendingCommit(host, adapter);
    timers.fireAll(); // enqueues the timeout
    await adapter.ack(L1_WORDS); // enqueues the ack AFTER the timeout
    await host.drainCommitChain();
    const scores = host.snapshot().state.finalizedLineScores;
    expect(scores).toHaveLength(1);
    expect(scores[0]?.finalizedReason).toBe("timeout"); // timeout won; stale ack dropped
    expect(host.snapshot().state.sttWatermarkMs).toBe(0); // dropped ack never advanced the watermark
  });

  test("finish while a boundary commit is in flight reuses it (no second commit)", async () => {
    const adapter = new ControllableSttAdapter();
    const timers = new FakeTimers();
    const { host } = setup(adapter, timers);
    await reachPendingCommit(host, adapter);
    expect(adapter.commitCalls).toBe(1);

    await host.handleClientEvent(client({ audioTimeMs: 2300, type: "finish" }));
    await host.drainCommitChain();
    expect(adapter.commitCalls).toBe(1); // reused the in-flight commit, did not issue another
    expect(host.snapshot().state.summary).toBeNull(); // not summarized while pending

    await adapter.ack(L1_WORDS);
    await host.drainCommitChain();
    expect(host.snapshot().state.status).toBe("finalized");
    expect(host.snapshot().state.summary).not.toBeNull();
  });

  test("seek while a commit is in flight drops the later acknowledgement", async () => {
    const adapter = new ControllableSttAdapter();
    const timers = new FakeTimers();
    const { host } = setup(adapter, timers);
    await reachPendingCommit(host, adapter); // pending commit frontier 1000, watermark still 0 (unacked)
    await host.handleClientEvent(client({ audioTimeMs: 500, type: "seek" }));
    expect(host.snapshot().state.pendingCommit).toBeNull(); // incompatible pending cleared
    expect(host.snapshot().state.sttWatermarkMs).toBe(0); // min(0, 500)

    await adapter.ack(L1_WORDS); // late ack for the abandoned commit
    await host.drainCommitChain();
    // The late ack is dropped (no matching pending) — the watermark never reaches
    // the abandoned commit's frontier (1000).
    expect(host.snapshot().state.sttWatermarkMs).toBe(0);
  });

  test("an orphaned pending commit from an evicted stream finalizes as provider_failed/uncertain", async () => {
    const adapter = new ControllableSttAdapter();
    const timers = new FakeTimers();
    const { host } = setup(adapter, timers);
    await reachPendingCommit(host, adapter); // pending commit on gen-1
    expect(host.snapshot().state.pendingCommit).not.toBeNull();

    // Simulate restore on a fresh stream: a different generation can never ack the
    // persisted commit.
    await host.invalidateOrphanedPendingCommit("gen-2-fresh");
    const scores = host.snapshot().state.finalizedLineScores;
    expect(host.snapshot().state.pendingCommit).toBeNull();
    expect(scores).toHaveLength(1);
    expect(scores[0]?.finalizedReason).toBe("provider_failed");
    expect(scores[0]?.uncertain).toBe(true);
  });

  test("invalidateOrphanedPendingCommit keeps a commit from the same generation", async () => {
    const adapter = new ControllableSttAdapter();
    const timers = new FakeTimers();
    const { host } = setup(adapter, timers);
    await reachPendingCommit(host, adapter);
    await host.invalidateOrphanedPendingCommit(adapter.streamGeneration); // same gen
    expect(host.snapshot().state.pendingCommit).not.toBeNull();
    expect(host.snapshot().state.finalizedLineScores).toHaveLength(0);
  });

  test("below-floor terminal finish uses the terminal sweep, not provider_failed", async () => {
    const adapter = new ControllableSttAdapter();
    adapter.refuseCommits = true; // every commit refused (below floor)
    const timers = new FakeTimers();
    const { host } = setup(adapter, timers);
    clientSeq = 0;
    await host.handleClientEvent(client({ postId: "p", startedAtAudioMs: 0, type: "start" }));
    await host.handleAudioFrame(audioFrame(1000));
    await host.handleClientEvent(
      client({ audioTimeMs: 1100, playing: true, type: "playback_sync" }),
    );
    await host.drainCommitChain();
    expect(host.snapshot().state.pendingCommit).toBeNull(); // commit refused → never pending

    await host.handleClientEvent(client({ audioTimeMs: 2300, type: "finish" }));
    await host.drainCommitChain();
    const scores = host.snapshot().state.finalizedLineScores;
    expect(host.snapshot().state.status).toBe("finalized");
    expect(scores.length).toBeGreaterThan(0);
    expect(scores.every((s) => s.finalizedReason !== "provider_failed")).toBe(true);
    expect(scores.some((s) => s.finalizedReason === "session_end")).toBe(true);
  });
});
