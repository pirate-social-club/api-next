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

// A fake clock that fires only timers whose due time has elapsed, so a long
// commit-ack timeout never fires while a short reconnect backoff is pumped.
class FakeClock {
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
    for (const [id, t] of [...this.timers]) {
      if (t.at <= this.now) {
        this.timers.delete(id);
        t.cb();
      }
    }
  }
}

// Flush microtasks (and let chain tasks reach their next `await`).
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface ReconnectAdapterOptions {
  /** Re-open attempts (after the first start) that should throw before succeeding. */
  failReopens?: number;
}

class ReconnectAdapter implements KaraokeStreamingSttAdapter {
  streamGeneration: string | null = null;
  startCount = 0;
  closeCount = 0;
  readonly frames: KaraokeClientBinaryFrame[] = [];
  private onMessage: ((m: KaraokeSttAdapterMessage) => Promise<void>) | null = null;
  private onUnexpectedClose: (() => void) | null = null;
  private onTerminalError: ((code: string) => void) | null = null;
  private inFlight: { commitId: string; frontierMs: number } | null = null;
  private commitSeq = 0;
  private sttSeq = 0;
  private submittedFrontierMs = 0;
  private failReopens: number;

  constructor(options: ReconnectAdapterOptions = {}) {
    this.failReopens = options.failReopens ?? 0;
  }

  async start(input: {
    attemptId: string;
    sessionId: string;
    initialSequence: number;
    onMessage: (m: KaraokeSttAdapterMessage) => Promise<void>;
    onUnexpectedClose?: () => void;
    onTerminalError?: (code: string) => void;
  }): Promise<void> {
    // First start() is the initial stream; subsequent ones are reconnect re-opens.
    if (this.startCount > 0 && this.failReopens > 0) {
      this.failReopens -= 1;
      throw new Error("reopen_failed");
    }
    this.startCount += 1;
    this.streamGeneration = `gen-${this.startCount}`;
    // Seed from the host on EVERY start, like the real emitter. Carrying our own
    // counter across re-opens instead would make this fake strictly more
    // monotonic than production and hide the reset defect.
    this.sttSeq = input.initialSequence;
    this.onMessage = input.onMessage;
    this.onUnexpectedClose = input.onUnexpectedClose ?? null;
    this.onTerminalError = input.onTerminalError ?? null;
    this.inFlight = null;
  }

  /** Emit a final with a self-assigned sequence, as the real emitter does. */
  async emitFinal(
    words: KaraokeRecognizedWord[],
    commit?: { commitId: string; coverageMs: number; streamGeneration: string },
  ): Promise<number> {
    if (!this.onMessage) throw new Error("adapter not started");
    this.sttSeq += 1;
    await this.onMessage({
      commit,
      event: {
        attemptId: "a",
        deliveredAtAudioMs: this.submittedFrontierMs,
        protocolVersion: PV,
        sequence: this.sttSeq,
        sessionId: "s",
        text: words.map((w) => w.text).join(" "),
        type: "stt_final",
        words,
      },
    });
    return this.sttSeq;
  }
  async sendPcm16(frame: KaraokeClientBinaryFrame): Promise<void> {
    this.frames.push(frame);
    this.submittedFrontierMs = frame.songEndMs;
  }
  async commit(): Promise<{
    commitId: string;
    streamGeneration: string;
    frontierMs: number;
  } | null> {
    if (this.inFlight || !this.streamGeneration) return null;
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
    this.closeCount += 1;
    this.streamGeneration = null;
    this.onMessage = null;
  }

  hasInFlight(): boolean {
    return this.inFlight !== null;
  }

  /** Simulate a network-level provider drop. */
  triggerUnexpectedClose(): void {
    if (!this.onUnexpectedClose) throw new Error("adapter not started");
    this.onUnexpectedClose();
  }

  /** Simulate a terminal provider error (auth/quota/input/time-limit). */
  triggerTerminalError(code: string): void {
    if (!this.onTerminalError) throw new Error("adapter not started");
    this.onTerminalError(code);
  }
}

let clientSeq = 0;
function client(event: Record<string, unknown>): KaraokeClientEvent {
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
  adapter: ReconnectAdapter,
  clock: FakeClock,
  options: { commitAckTimeoutMs?: number } = {},
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
      clearTimer: clock.clearTimer,
      commitAckTimeoutMs: options.commitAckTimeoutMs ?? 5_000,
      now: () => clock.now,
      setTimer: clock.setTimer,
    },
  );
  return { effectRunner, host };
}

// Drive: start recording, then run the reconnect cycle to completion by pumping
// the backoff timers across all possible attempts.
async function pumpReconnect(clock: FakeClock, host: KaraokeSessionHost): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await flush();
    clock.advance(2_000);
  }
  await flush();
  await host.drainCommitChain();
}

describe("KaraokeSessionHost reconnect", () => {
  test("reconnects the provider stream after an unexpected drop", async () => {
    const adapter = new ReconnectAdapter();
    const clock = new FakeClock();
    const { host } = setup(adapter, clock);

    await host.handleClientEvent(client({ startedAtAudioMs: 0, type: "start" }));
    expect(adapter.startCount).toBe(1);

    adapter.triggerUnexpectedClose();
    await pumpReconnect(clock, host);

    // A fresh stream was opened.
    expect(adapter.startCount).toBe(2);
    expect(adapter.streamGeneration).toBe("gen-2");

    // Grading survives: audio after the reconnect is forwarded to the new stream.
    await host.handleAudioFrame(audioFrame(1300));
    expect(adapter.frames.at(-1)?.songEndMs).toBe(1300);
  });

  test("resumes the STT sequence across a provider reconnect, so grading survives", async () => {
    const adapter = new ReconnectAdapter();
    const clock = new FakeClock();
    const { effectRunner, host } = setup(adapter, clock);

    await host.handleClientEvent(client({ startedAtAudioMs: 0, type: "start" }));
    await host.handleAudioFrame(audioFrame(400));

    // Build a high-water mark before the drop, as a real stream's partials do.
    for (let i = 0; i < 5; i += 1) {
      await adapter.emitFinal([{ confidence: 0.9, endMs: 400, startMs: 0, text: "hold" }]);
    }
    await host.drainCommitChain();
    expect(effectRunner.relayedSttEvents.length).toBe(5);
    expect(effectRunner.transportErrors).toEqual([]);

    adapter.triggerUnexpectedClose();
    await pumpReconnect(clock, host);
    expect(adapter.startCount).toBe(2);

    // The fresh stream must continue at N+1, not restart at 1. Before the
    // initialSequence contract this emitted sequence 1 against lastSttSequence 5,
    // which the host rejected WITHOUT advancing its counter — suppressing this
    // and every later event for the rest of the attempt.
    const resumed = await adapter.emitFinal([
      { confidence: 0.9, endMs: 1600, startMs: 1200, text: "almost" },
    ]);
    await host.drainCommitChain();
    expect(resumed).toBe(6);

    // Relayed, not rejected — and the host's counter actually advanced.
    expect(effectRunner.transportErrors).toEqual([]);
    expect(effectRunner.relayedSttEvents.length).toBe(6);
    expect(effectRunner.relayedSttEvents.at(-1)?.sequence).toBe(6);
    expect(host.snapshot().lastSttSequence).toBe(6);

    // And it keeps flowing afterwards (the defect suppressed the whole tail).
    await adapter.emitFinal([{ confidence: 0.9, endMs: 1700, startMs: 1600, text: "home" }]);
    await host.drainCommitChain();
    expect(effectRunner.transportErrors).toEqual([]);
    expect(host.snapshot().lastSttSequence).toBe(7);
  });

  test("does not reconnect on intentional close (finish)", async () => {
    const adapter = new ReconnectAdapter();
    const clock = new FakeClock();
    const { host } = setup(adapter, clock);

    await host.handleClientEvent(client({ startedAtAudioMs: 0, type: "start" }));
    await host.handleClientEvent(client({ audioTimeMs: 2200, type: "finish" }));
    await host.drainCommitChain();

    // close() path: no onUnexpectedClose fires, so startCount stays at 1.
    expect(adapter.startCount).toBe(1);
  });

  test("buffers audio during the outage and replays it onto the new stream", async () => {
    const adapter = new ReconnectAdapter();
    const clock = new FakeClock();
    const { host } = setup(adapter, clock);

    await host.handleClientEvent(client({ startedAtAudioMs: 0, type: "start" }));
    await host.handleAudioFrame(audioFrame(400)); // pre-drop, goes to gen-1
    const preDropFrames = adapter.frames.length;

    adapter.triggerUnexpectedClose();
    await flush(); // let reconnectStt start and set reconnecting=true (suspended on backoff)

    // Frames during the outage are buffered, not forwarded yet.
    await host.handleAudioFrame(audioFrame(700));
    await host.handleAudioFrame(audioFrame(900));
    expect(adapter.frames.length).toBe(preDropFrames);

    await pumpReconnect(clock, host);

    // Buffered frames are replayed onto the new stream, in order.
    const replayed = adapter.frames.slice(preDropFrames).map((f) => f.songEndMs);
    expect(replayed).toEqual([700, 900]);
  });

  test("finalizes the dead stream's orphaned pending commit as provider_failed", async () => {
    const adapter = new ReconnectAdapter();
    const clock = new FakeClock();
    // Commit-ack timeout set unreachable so ONLY the reconnect path can resolve
    // the pending commit — proves the orphan is finalized by reconnect, not a timeout.
    const { host } = setup(adapter, clock, { commitAckTimeoutMs: 10_000_000 });

    await host.handleClientEvent(client({ startedAtAudioMs: 0, type: "start" }));
    await host.handleAudioFrame(audioFrame(400));
    // Advance past l1 so the reducer requests a commit; arm a pending commit.
    await host.handleClientEvent(
      client({ audioTimeMs: 1100, playing: true, type: "playback_sync" }),
    );
    await host.drainCommitChain();
    expect(adapter.hasInFlight()).toBe(true);
    expect(host.snapshot().state.pendingCommit).not.toBeNull();

    adapter.triggerUnexpectedClose();
    await pumpReconnect(clock, host);

    // The gen-1 commit can never be acked by gen-2 — it is resolved, not stuck.
    expect(host.snapshot().state.pendingCommit).toBeNull();
    expect(adapter.startCount).toBe(2);
  });

  test("aborts the session after exhausting reconnect attempts", async () => {
    const adapter = new ReconnectAdapter({ failReopens: 99 });
    const clock = new FakeClock();
    const { effectRunner, host } = setup(adapter, clock);

    await host.handleClientEvent(client({ startedAtAudioMs: 0, type: "start" }));
    adapter.triggerUnexpectedClose();
    await pumpReconnect(clock, host);

    expect(host.snapshot().state.status).toBe("aborted");
    expect(effectRunner.transportErrors.some((e) => e.code === "session_aborted")).toBe(true);
  });

  test("aborts the session visibly on a terminal provider error (no reconnect)", async () => {
    const adapter = new ReconnectAdapter();
    const clock = new FakeClock();
    const { effectRunner, host } = setup(adapter, clock);

    await host.handleClientEvent(client({ startedAtAudioMs: 0, type: "start" }));
    expect(adapter.startCount).toBe(1);

    adapter.triggerTerminalError("auth_error");
    await flush();
    await host.drainCommitChain();

    expect(adapter.startCount).toBe(1); // terminal → did NOT reconnect
    expect(host.snapshot().state.status).toBe("aborted");
    expect(effectRunner.transportErrors.some((e) => e.code === "session_aborted")).toBe(true);
  });
});
