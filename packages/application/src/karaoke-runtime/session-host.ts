import {
  type KaraokeSessionEffect,
  type KaraokeSessionEvent,
  type KaraokeSessionState,
  reduceKaraokeSession,
} from "./session";
import {
  type KaraokeClientBinaryFrame,
  type KaraokeClientEvent,
  type KaraokeStreamingSttEvent,
  type KaraokeTransportError,
  validateKaraokeTransportEnvelope,
} from "./transport";

export interface KaraokeEffectRunner {
  runKaraokeEffect(effect: KaraokeSessionEffect, state: KaraokeSessionState): Promise<void>;
  relaySttEvent(event: KaraokeStreamingSttEvent, state: KaraokeSessionState): Promise<void>;
  reportTransportError(error: KaraokeTransportError, state: KaraokeSessionState): Promise<void>;
}

/** Correlation metadata attached to a committed final (never relayed to clients). */
export interface KaraokeSttCommitAck {
  commitId: string;
  streamGeneration: string;
  coverageMs: number;
}

/**
 * Internal adapter → host message. `event` is the client-relayable transcript;
 * `commit` (present only on committed finals) carries the correlation metadata
 * the host uses for the watermark/second-gate. Keeping commit metadata off the
 * transport event guarantees it never leaks to clients.
 */
export interface KaraokeSttAdapterMessage {
  event: KaraokeStreamingSttEvent;
  commit?: KaraokeSttCommitAck | undefined;
}

export interface KaraokeStreamingSttAdapter {
  /** Opaque id for the current provider stream; null before start()/after close(). */
  readonly streamGeneration: string | null;
  start(input: {
    attemptId: string;
    sessionId: string;
    /**
     * Sequence the adapter's STT envelope counter must resume FROM: the first
     * event it emits is `initialSequence + 1`. The host rejects non-monotonic STT
     * sequences and does not advance `lastSttSequence` on rejection, so an adapter
     * that restarts its counter at 0 has every event refused until it climbs back
     * past the pre-restart high-water mark. Both restart paths (same-host provider
     * reconnect, fresh-DO restore) MUST pass the host's surviving counter.
     */
    initialSequence: number;
    onMessage: (message: KaraokeSttAdapterMessage) => Promise<void>;
    /**
     * Fired when the provider stream drops unexpectedly (network close/error, or
     * a transient provider error the adapter treats as a drop), NOT on intentional
     * close() or a terminal provider error. The host uses this to drive reconnect.
     */
    onUnexpectedClose?: () => void;
    /**
     * Fired on a TERMINAL provider error (auth/quota/input/time-limit) that a
     * reconnect cannot fix. The host aborts the session visibly so the user sees a
     * real error rather than silent, un-scored lines. Absent on adapters that
     * cannot distinguish terminal errors.
     */
    onTerminalError?: (code: string) => void;
  }): Promise<void>;
  sendPcm16(frame: KaraokeClientBinaryFrame): Promise<void>;
  /**
   * Request an explicit commit of audio submitted so far. Returns the commit's
   * correlation handle, or null when refused (below the provider audio floor or a
   * commit is already in flight). Refusal must NOT tear down the stream.
   */
  commit(): Promise<{ commitId: string; streamGeneration: string; frontierMs: number } | null>;
  close(): Promise<void>;
}

export interface KaraokeSessionHostSnapshot {
  state: KaraokeSessionState;
  lastClientSequence: number | null;
  lastSttSequence: number | null;
}

export interface KaraokeSessionHostRestoreOptions {
  lastClientSequence?: number | null;
  lastSttSequence?: number | null;
}

/**
 * Diagnostic record for a rejected transport envelope, emitted at the guard so the
 * host reports the numbers a rejection turns on. SERVER-SIDE ONLY: this never
 * reaches the client envelope, which carries `code` alone.
 *
 * Exists because a rejection is otherwise invisible — the guard's verdict is the
 * whole story, and `previousSequence` vs `incomingSequence` is what distinguishes
 * a counter RESET (incoming far below previous, e.g. 1 vs 87) from an ordinary
 * late/duplicate frame (incoming just below previous).
 */
export interface KaraokeTransportGuardDiagnostic {
  /** Which monotonic guard rejected: inbound client traffic, or the STT stream. */
  channel: "client" | "stt";
  code: KaraokeTransportError["code"];
  /** Sequence on the rejected envelope. */
  incomingSequence: number | null;
  /** The guard's high-water mark at rejection time (null before the first accept). */
  previousSequence: number | null;
  /** Provider stream id, so a rejection can be tied to a specific STT restart. */
  sttStreamGeneration: string | null;
  sessionId: string;
  attemptId: string;
}

export interface KaraokeSessionHostOptions {
  restore?: KaraokeSessionHostRestoreOptions;
  /**
   * Invoked once per rejected transport envelope. The host supplies only what it
   * owns; the embedder enriches with runtime-level context (host lifecycle, socket
   * identity) and performs the actual logging. Kept as a sink rather than a
   * `console` call so this package stays runtime-agnostic and emits exactly one
   * structured event per rejection.
   */
  onTransportGuardFailure?: (diagnostic: KaraokeTransportGuardDiagnostic) => void | Promise<void>;
  /** Called when the bounded reconnect buffer evicts its oldest audio frame. */
  onReconnectBufferDrop?: () => void | Promise<void>;
  /** Called when the provider acknowledges an explicit commit. */
  onCommitSettled?: (latencyMs: number) => void | Promise<void>;
  /** Epoch ms source (default Date.now). */
  now?: () => number;
  /** Timer hooks (default global setTimeout/clearTimeout) — injectable for tests. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called after every pending-commit transition so the DO can persist. */
  persist?: () => Promise<void>;
  /** How long to wait for a commit's ack before declaring it timed out. */
  commitAckTimeoutMs?: number;
}

const DEFAULT_COMMIT_ACK_TIMEOUT_MS = 2_000;

// Reconnect policy for an unexpectedly-dropped provider stream. Bounded so a
// permanently unreachable provider eventually aborts rather than looping.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_BASE_MS = 250;
const RECONNECT_BACKOFF_CAP_MS = 2_000;
// While reconnecting, inbound audio frames are buffered (not dropped) and
// replayed onto the fresh stream. Bounded so a long outage can't grow memory
// without limit; the oldest frames are dropped first (a small audio gap).
const MAX_RECONNECT_BUFFER_FRAMES = 600;

function reconnectBackoffMs(attempt: number): number {
  return Math.min(RECONNECT_BACKOFF_BASE_MS * 2 ** (attempt - 1), RECONNECT_BACKOFF_CAP_MS);
}

function clientEventToSessionEvent(
  state: KaraokeSessionState,
  event: KaraokeClientEvent,
): KaraokeSessionEvent | KaraokeTransportError {
  switch (event.type) {
    case "start":
      return { audioTimeMs: event.startedAtAudioMs, type: "start" };
    case "playback_sync":
      return { audioTimeMs: event.audioTimeMs, playing: event.playing, type: "playback_sync" };
    case "pause":
    case "resume":
    case "seek":
    case "finish":
      return { audioTimeMs: event.audioTimeMs, type: event.type };
    case "abort":
      return { code: event.code, type: "abort" };
    case "line_boundary": {
      const line = state.lines.find((candidate) => candidate.lineId === event.lineId);
      if (
        !line ||
        line.lineIndex !== event.lineIndex ||
        line.scoredLineIndex !== event.scoredLineIndex
      ) {
        return {
          code: "line_identity_mismatch",
          message: `Invalid karaoke line identity: ${event.lineId}`,
          sequence: event.sequence,
        };
      }
      return { audioTimeMs: event.audioTimeMs, lineId: event.lineId, type: "line_boundary" };
    }
  }
}

function isTransportError(
  value: KaraokeSessionEvent | KaraokeTransportError,
): value is KaraokeTransportError {
  return "message" in value;
}

export class KaraokeSessionHost {
  private state: KaraokeSessionState;
  private lastClientSequence: number | null;
  private lastSttSequence: number | null;
  private sttStarted = false;

  // Single serialized chain for all commit lifecycle work (scheduling, acks,
  // timeouts, finish drain) so an ack and a timeout can never concurrently
  // reduce the same pending commit.
  private commitChain: Promise<void> = Promise.resolve();
  private commitTimer: unknown = null;
  private pendingFinish: { audioTimeMs: number } | null = null;

  // Reconnect state. While `reconnecting`, handleAudioFrame buffers frames into
  // `reconnectBuffer` (bounded) instead of forwarding to the dead adapter; they
  // are replayed onto the fresh stream once it is ready.
  private reconnecting = false;
  private reconnectBuffer: KaraokeClientBinaryFrame[] = [];

  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly persist: () => Promise<void>;
  private readonly onTransportGuardFailure:
    | ((diagnostic: KaraokeTransportGuardDiagnostic) => void | Promise<void>)
    | undefined;
  private readonly onReconnectBufferDrop: (() => void | Promise<void>) | undefined;
  private readonly onCommitSettled: ((latencyMs: number) => void | Promise<void>) | undefined;
  private readonly commitAckTimeoutMs: number;

  constructor(
    initialState: KaraokeSessionState,
    private readonly effectRunner: KaraokeEffectRunner,
    private readonly sttAdapter: KaraokeStreamingSttAdapter,
    options: KaraokeSessionHostOptions = {},
  ) {
    this.state = initialState;
    this.lastClientSequence = options.restore?.lastClientSequence ?? null;
    this.lastSttSequence = options.restore?.lastSttSequence ?? null;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.persist = options.persist ?? (async () => undefined);
    this.onTransportGuardFailure = options.onTransportGuardFailure;
    this.onReconnectBufferDrop = options.onReconnectBufferDrop;
    this.onCommitSettled = options.onCommitSettled;
    this.commitAckTimeoutMs = options.commitAckTimeoutMs ?? DEFAULT_COMMIT_ACK_TIMEOUT_MS;
  }

  /** Awaits the serialized commit chain to settle — for deterministic tests. */
  async drainCommitChain(): Promise<void> {
    // Await repeatedly: a chain task may enqueue further tasks (commit → ack).
    for (let i = 0; i < 50; i += 1) {
      const settled = this.commitChain;
      await settled;
      if (settled === this.commitChain) return;
    }
  }

  private enqueueCommitTask(task: () => Promise<void>): void {
    this.commitChain = this.commitChain.then(task).catch(() => undefined);
  }

  /**
   * Report a rejected envelope exactly once, at the guard. Never throws into the
   * transport path: diagnostics must not be able to break scoring.
   */
  private async reportGuardFailure(
    channel: "client" | "stt",
    error: KaraokeTransportError,
    previousSequence: number | null,
  ): Promise<void> {
    if (!this.onTransportGuardFailure) return;
    try {
      await this.onTransportGuardFailure({
        attemptId: this.state.attemptId,
        channel,
        code: error.code,
        incomingSequence: error.sequence ?? null,
        previousSequence,
        sessionId: this.state.sessionId,
        sttStreamGeneration: this.sttAdapter.streamGeneration,
      });
    } catch {
      // best-effort: a failing diagnostics sink must never affect the session
    }
  }

  snapshot(): KaraokeSessionHostSnapshot {
    return {
      lastClientSequence: this.lastClientSequence,
      lastSttSequence: this.lastSttSequence,
      state: this.state,
    };
  }

  async handleClientEvent(event: KaraokeClientEvent): Promise<KaraokeTransportError | null> {
    const envelopeError = validateKaraokeTransportEnvelope({
      attemptId: this.state.attemptId,
      event,
      lastSequence: this.lastClientSequence,
      sessionId: this.state.sessionId,
    });
    if (envelopeError) {
      await this.reportGuardFailure("client", envelopeError, this.lastClientSequence);
      await this.effectRunner.reportTransportError(envelopeError, this.state);
      return envelopeError;
    }

    const sessionEvent = clientEventToSessionEvent(this.state, event);
    if (isTransportError(sessionEvent)) {
      await this.effectRunner.reportTransportError(sessionEvent, this.state);
      return sessionEvent;
    }

    this.lastClientSequence = event.sequence;

    // Finish drains the in-flight commit (or attempts a terminal one) before the
    // session is summarized — run it on the serialized chain so it composes with
    // acks/timeouts. The summary is broadcast asynchronously when the drain ends.
    if (sessionEvent.type === "finish") {
      this.enqueueCommitTask(() => this.beginFinish(sessionEvent.audioTimeMs));
      return null;
    }

    await this.reduce(sessionEvent);

    // A seek abandons any in-flight commit (the reducer drops a now-incompatible
    // pending commit); cancel its timer so it cannot fire against a new commit.
    if (sessionEvent.type === "seek" && this.state.pendingCommit === null) {
      this.clearCommitTimer();
    }

    if (event.type === "start" && this.state.status === "recording") {
      const sttError = await this.startStt(event.sequence);
      if (sttError) return sttError;
    }

    return null;
  }

  /**
   * Restarts the STT adapter after a hibernation restore when the session is
   * already recording. Without this, a restored recording session has
   * sttStarted=false and subsequent audio frames reach an unstarted adapter and
   * are silently dropped.
   */
  async resumeSttIfRecording(): Promise<KaraokeTransportError | null> {
    if (this.state.status !== "recording" || this.sttStarted) return null;
    return await this.startStt(undefined);
  }

  private async startStt(
    sequence: number | undefined,
    options: { abortOnFailure?: boolean } = {},
  ): Promise<KaraokeTransportError | null> {
    if (this.sttStarted) return null;
    this.sttStarted = true;
    try {
      await this.sttAdapter.start({
        attemptId: this.state.attemptId,
        // Resume the STT envelope counter from the surviving high-water mark.
        // This is the ONLY start() call site, so it covers the initial start, the
        // provider-reconnect path (reconnectStt) and the restore path
        // (resumeSttIfRecording) alike.
        initialSequence: this.lastSttSequence ?? 0,
        onMessage: async (message) => {
          // Serialize message handling (incl. commit acks) on the commit chain.
          this.enqueueCommitTask(() => this.processAdapterMessage(message));
        },
        onTerminalError: (code) => this.onSttTerminalError(code),
        onUnexpectedClose: () => this.onSttUnexpectedClose(),
        sessionId: this.state.sessionId,
      });
      return null;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? "stt_adapter_start_failed";
      const message = error instanceof Error ? error.message : String(error);
      this.sttStarted = false;
      if (options.abortOnFailure === false) {
        // Reconnect path: the caller retries with backoff and aborts only after
        // exhausting attempts, so a single failed re-open must not tear down the
        // session here.
        return { code: "session_aborted", message, sequence };
      }
      await this.reduce({ code, type: "abort" });
      const transportError: KaraokeTransportError = {
        code: "session_aborted",
        message,
        sequence,
      };
      await this.effectRunner.reportTransportError(transportError, this.state);
      return transportError;
    }
  }

  /**
   * Invoked by the adapter when its provider stream drops unexpectedly (network
   * close/error, never an intentional close). Schedules reconnect on the
   * serialized commit chain so it composes with commit acks/timeouts; a
   * re-entrant call while already reconnecting is ignored.
   */
  private onSttUnexpectedClose(): void {
    if (this.reconnecting) return;
    if (this.state.status !== "recording") return;
    this.enqueueCommitTask(() => this.reconnectStt());
  }

  /**
   * Invoked by the adapter on a TERMINAL provider error (auth/quota/input/
   * time-limit) — a reconnect cannot fix it, so abort the session visibly on the
   * serialized commit chain. The client sees a real session_error rather than the
   * song continuing with silently un-scored lines. Ignored if not recording.
   */
  private onSttTerminalError(code: string): void {
    if (this.state.status !== "recording") return;
    this.enqueueCommitTask(async () => {
      if (this.state.status !== "recording") return;
      await this.reduce({ code: `stt_${code}`, type: "abort" });
      await this.effectRunner.reportTransportError(
        { code: "session_aborted", message: `STT provider error: ${code}`, sequence: undefined },
        this.state,
      );
    });
  }

  /**
   * Re-open the provider stream after an unexpected drop. Bounded backoff; the
   * dead stream's in-flight commit can never be acknowledged by the fresh stream
   * (new generation), so it is finalized as provider_failed once the new stream
   * is up. Audio buffered during the outage is replayed onto the new stream.
   */
  private async reconnectStt(): Promise<void> {
    if (this.reconnecting) return;
    if (this.state.status !== "recording") return;
    this.reconnecting = true;
    // sttStarted is still true for the dead stream; clear it so startStt re-runs.
    this.sttStarted = false;
    try {
      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
        await this.delay(reconnectBackoffMs(attempt));
        // The session may have ended/aborted while we were backing off.
        if (this.state.status !== "recording") return;
        const error = await this.startStt(undefined, { abortOnFailure: false });
        if (!error) {
          // Fresh stream is up (new generation). Orphan the dead stream's pending
          // commit, then replay any audio captured during the outage.
          await this.invalidateOrphanedPendingCommit(this.sttAdapter.streamGeneration);
          await this.flushReconnectBuffer();
          return;
        }
      }
      // Exhausted: the provider is unreachable — abort the session deterministically.
      await this.reduce({ code: "stt_reconnect_failed", type: "abort" });
      await this.effectRunner.reportTransportError(
        { code: "session_aborted", message: "STT reconnect failed", sequence: undefined },
        this.state,
      );
    } finally {
      this.reconnecting = false;
      // On success the buffer was drained; on give-up drop whatever remains.
      this.reconnectBuffer = [];
    }
  }

  /**
   * Replay buffered frames onto the fresh stream. `reconnecting` stays true for
   * the duration so frames arriving mid-flush keep ordering (they append and are
   * picked up by the loop); the flag is cleared by reconnectStt's finally once
   * the buffer has fully drained.
   */
  private async flushReconnectBuffer(): Promise<void> {
    while (this.reconnectBuffer.length > 0) {
      const frame = this.reconnectBuffer.shift();
      if (frame === undefined) break;
      await this.sttAdapter.sendPcm16(frame);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimer(() => resolve(), ms);
    });
  }

  async handleAudioFrame(frame: KaraokeClientBinaryFrame): Promise<KaraokeTransportError | null> {
    const envelopeError = validateKaraokeTransportEnvelope({
      attemptId: this.state.attemptId,
      event: frame,
      lastSequence: this.lastClientSequence,
      sessionId: this.state.sessionId,
    });
    if (envelopeError) {
      await this.reportGuardFailure("client", envelopeError, this.lastClientSequence);
      await this.effectRunner.reportTransportError(envelopeError, this.state);
      return envelopeError;
    }

    if (this.state.status !== "recording") {
      const statusError: KaraokeTransportError = {
        code: "session_not_recording",
        message: `Cannot accept karaoke audio while session status is ${this.state.status}`,
        sequence: frame.sequence,
      };
      await this.effectRunner.reportTransportError(statusError, this.state);
      return statusError;
    }

    this.lastClientSequence = frame.sequence;
    if (this.reconnecting) {
      // Provider stream is mid-reconnect — buffer instead of dropping; the frames
      // are replayed onto the fresh stream by flushReconnectBuffer once it is up.
      // Bounded: drop the oldest frame on overflow (a small leading audio gap).
      this.reconnectBuffer.push(frame);
      if (this.reconnectBuffer.length > MAX_RECONNECT_BUFFER_FRAMES) {
        this.reconnectBuffer.shift();
        await this.onReconnectBufferDrop?.();
      }
      return null;
    }
    await this.sttAdapter.sendPcm16(frame);
    return null;
  }

  /**
   * Entry point for adapter messages. Relays/reduces the transcript via
   * handleSttEvent; the commit correlation metadata (message.commit) drives the
   * watermark/second-gate, wired in a later step. Kept separate from
   * handleSttEvent so direct STT-event injection (tests, /internal/stt) is intact.
   */
  async handleSttMessage(message: KaraokeSttAdapterMessage): Promise<KaraokeTransportError | null> {
    return await this.handleSttEvent(message.event, message.commit);
  }

  async handleSttEvent(
    event: KaraokeStreamingSttEvent,
    commit?: KaraokeSttCommitAck,
  ): Promise<KaraokeTransportError | null> {
    const envelopeError = validateKaraokeTransportEnvelope({
      attemptId: this.state.attemptId,
      event,
      lastSequence: this.lastSttSequence,
      sessionId: this.state.sessionId,
    });
    if (envelopeError) {
      await this.reportGuardFailure("stt", envelopeError, this.lastSttSequence);
      await this.effectRunner.reportTransportError(envelopeError, this.state);
      return envelopeError;
    }

    // Carry the commit correlation metadata into the reducer only on finals so it
    // can advance the watermark; the relayed client transcript stays metadata-free.
    const reductionEvent: KaraokeSessionEvent =
      event.type === "stt_final" && commit
        ? {
            commitId: commit.commitId,
            coverageMs: commit.coverageMs,
            streamGeneration: commit.streamGeneration,
            type: "stt_final",
            words: event.words,
          }
        : { type: event.type, words: event.words };
    const reduction = reduceKaraokeSession(this.state, reductionEvent);
    this.state = reduction.state;
    this.lastSttSequence = event.sequence;
    await this.effectRunner.relaySttEvent(event, this.state);
    await this.runEffects(reduction.effects);
    return null;
  }

  private async reduce(event: KaraokeSessionEvent): Promise<void> {
    const reduction = reduceKaraokeSession(this.state, event);
    this.state = reduction.state;
    await this.runEffects(reduction.effects);
  }

  private async runEffects(effects: readonly KaraokeSessionEffect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.type === "request_stt_commit") {
        // The reducer asks for a commit to advance the watermark; schedule it on
        // the serialized chain (coalesced — see scheduleCommit). The adapter
        // captures its own committed frontier, so only the affected lineIds matter.
        const lineIds = effect.lineIds;
        this.enqueueCommitTask(() => this.scheduleCommit(lineIds));
        continue;
      }
      if (effect.type === "close_stt_stream" && this.sttStarted) {
        await this.effectRunner.runKaraokeEffect(effect, this.state);
        await this.sttAdapter.close();
        this.sttStarted = false;
        continue;
      }
      await this.effectRunner.runKaraokeEffect(effect, this.state);
    }
  }

  // --- Commit scheduler (all methods run on the serialized commit chain) -------

  private async scheduleCommit(lineIds: readonly string[]): Promise<void> {
    // Coalesce: at most one commit in flight. Re-checked here (not at enqueue
    // time) so a burst of request_stt_commit effects produces a single adapter call.
    if (this.state.pendingCommit !== null) return;
    if (this.state.status !== "recording" && this.state.status !== "finalizing") return;
    const handle = await this.sttAdapter.commit();
    if (!handle) return; // refused (below floor / already in flight) — retry on the next request; no synthetic failure
    await this.applyCommitSent(handle, [...lineIds]);
  }

  private async applyCommitSent(
    handle: { commitId: string; streamGeneration: string; frontierMs: number },
    lineIds: string[],
  ): Promise<void> {
    await this.reduce({
      commitId: handle.commitId,
      frontierMs: handle.frontierMs,
      lineIds,
      requestedAtEpochMs: this.now(),
      streamGeneration: handle.streamGeneration,
      type: "commit_sent",
    });
    await this.persist();
    this.armCommitTimer(handle.commitId, handle.streamGeneration);
  }

  private armCommitTimer(commitId: string, streamGeneration: string): void {
    this.clearCommitTimer();
    this.commitTimer = this.setTimer(() => {
      this.enqueueCommitTask(() => this.handleCommitTimeout(commitId, streamGeneration));
    }, this.commitAckTimeoutMs);
  }

  private clearCommitTimer(): void {
    if (this.commitTimer !== null) {
      this.clearTimer(this.commitTimer);
      this.commitTimer = null;
    }
  }

  private async handleCommitTimeout(commitId: string, streamGeneration: string): Promise<void> {
    const pending = this.state.pendingCommit;
    // No-op if the ack already won the race (pending cleared or replaced).
    if (!pending || pending.commitId !== commitId || pending.streamGeneration !== streamGeneration)
      return;
    await this.reduce({ commitId, reason: "timeout", streamGeneration, type: "commit_failed" });
    await this.persist();
    await this.maybeFinishAfterResolve();
  }

  private async processAdapterMessage(message: KaraokeSttAdapterMessage): Promise<void> {
    const pending = this.state.pendingCommit;
    await this.handleSttMessage(message);
    if (message.commit) {
      if (
        pending !== null &&
        pending.commitId === message.commit.commitId &&
        pending.streamGeneration === message.commit.streamGeneration
      ) {
        await this.onCommitSettled?.(Math.max(0, this.now() - pending.requestedAtEpochMs));
      }
      // A commit was acknowledged (or dropped as stale) — cancel its timer and
      // settle any finish that was waiting on it.
      this.clearCommitTimer();
      await this.persist();
      await this.maybeFinishAfterResolve();
    }
  }

  private async beginFinish(audioTimeMs: number): Promise<void> {
    if (this.state.status === "finalized" || this.state.status === "aborted") return;
    // Reuse an in-flight commit; otherwise attempt a terminal commit of the tail.
    // A refused (below-floor) terminal commit is fine — the reducer's terminal
    // sweep finalizes the rest; no synthetic provider_failed is invented.
    if (this.state.pendingCommit === null) {
      const handle = await this.sttAdapter.commit();
      if (handle) {
        await this.applyCommitSent(handle, []);
      }
    }
    await this.reduce({ audioTimeMs, type: "finish" });
    await this.persist();
    if (this.state.pendingCommit !== null) {
      // Drain: the ack or the commit timeout will complete the finish.
      this.pendingFinish = { audioTimeMs };
    }
  }

  /**
   * On restore, a pending commit persisted by an evicted stream can never be
   * acknowledged — its provider stream is gone. Finalize it as `provider_failed`
   * (recognition infrastructure was lost, NOT the singer missing the line) when
   * its generation differs from the freshly started stream. In-memory commit
   * timers do not survive eviction, so this is the durable resolution of that
   * pending commit rather than re-arming a timer.
   */
  async invalidateOrphanedPendingCommit(currentStreamGeneration: string | null): Promise<void> {
    const pending = this.state.pendingCommit;
    if (!pending) return;
    if (currentStreamGeneration !== null && pending.streamGeneration === currentStreamGeneration)
      return;
    await this.reduce({
      commitId: pending.commitId,
      reason: "provider_failed",
      streamGeneration: pending.streamGeneration,
      type: "commit_failed",
    });
    await this.persist();
  }

  private async maybeFinishAfterResolve(): Promise<void> {
    const finish = this.pendingFinish;
    if (!finish || this.state.pendingCommit !== null) return;
    this.pendingFinish = null;
    await this.reduce({ audioTimeMs: finish.audioTimeMs, type: "finish" });
    await this.persist();
  }
}
