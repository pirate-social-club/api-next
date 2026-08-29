import {
  KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  type KaraokeSessionEffect,
  type KaraokeSessionState,
  type KaraokeStreamingSttEvent,
  type KaraokeTransportError,
} from "../index";
import type {
  KaraokeEffectRunner,
  KaraokeStreamingSttAdapter,
  KaraokeSttAdapterMessage,
  KaraokeSttCommitAck,
} from "../session-host";
import type { KaraokeClientBinaryFrame } from "../transport";

export class FakeKaraokeEffectRunner implements KaraokeEffectRunner {
  readonly effects: KaraokeSessionEffect[] = [];
  readonly relayedSttEvents: KaraokeStreamingSttEvent[] = [];
  readonly relayedStates: KaraokeSessionState[] = [];
  readonly transportErrors: KaraokeTransportError[] = [];

  async runKaraokeEffect(effect: KaraokeSessionEffect, _state: KaraokeSessionState): Promise<void> {
    this.effects.push(effect);
  }

  async relaySttEvent(event: KaraokeStreamingSttEvent, state: KaraokeSessionState): Promise<void> {
    this.relayedSttEvents.push(event);
    this.relayedStates.push(state);
  }

  async reportTransportError(
    error: KaraokeTransportError,
    _state: KaraokeSessionState,
  ): Promise<void> {
    this.transportErrors.push(error);
  }
}

export class FakeKaraokeStreamingSttAdapter implements KaraokeStreamingSttAdapter {
  readonly frames: KaraokeClientBinaryFrame[] = [];
  startCount = 0;
  closeCount = 0;
  streamGeneration: string | null = null;
  /** Sequence seeded by the most recent start() — mirrors a real adapter's emitter. */
  sequence = 0;
  private attemptId = "";
  private sessionId = "";
  private onMessage: ((message: KaraokeSttAdapterMessage) => Promise<void>) | null = null;
  private onUnexpectedClose: (() => void) | null = null;

  async start(input: {
    attemptId: string;
    sessionId: string;
    initialSequence: number;
    onMessage: (message: KaraokeSttAdapterMessage) => Promise<void>;
    onUnexpectedClose?: () => void;
  }): Promise<void> {
    this.startCount += 1;
    this.streamGeneration = `fake-gen-${this.startCount}`;
    this.attemptId = input.attemptId;
    this.sessionId = input.sessionId;
    // Seed from the host's surviving high-water mark on EVERY start, exactly as a
    // real adapter must. A fake that instead carried its own counter across
    // restarts would mask the reset defect this contract exists to prevent.
    this.sequence = input.initialSequence;
    this.onMessage = input.onMessage;
    this.onUnexpectedClose = input.onUnexpectedClose ?? null;
  }

  /** Test hook: simulate the provider stream dropping unexpectedly. */
  triggerUnexpectedClose(): void {
    if (!this.onUnexpectedClose) {
      throw new Error("Fake karaoke STT adapter is not started");
    }
    this.onUnexpectedClose();
  }

  async sendPcm16(frame: KaraokeClientBinaryFrame): Promise<void> {
    this.frames.push(frame);
  }

  // Manual-injection fake: it does not model the provider commit lifecycle.
  async commit(): Promise<{
    commitId: string;
    streamGeneration: string;
    frontierMs: number;
  } | null> {
    return null;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.onMessage = null;
    this.streamGeneration = null;
  }

  async emit(event: KaraokeStreamingSttEvent, commit?: KaraokeSttCommitAck): Promise<void> {
    if (!this.onMessage) {
      throw new Error("Fake karaoke STT adapter is not started");
    }
    await this.onMessage({ commit, event });
  }

  /**
   * Emit with a self-assigned sequence, the way a real adapter's emitter does.
   * Use this (not `emit`) to prove restart continuity: the sequence comes from the
   * seeded counter rather than from the test, so a regressed seeding contract
   * produces a `non_monotonic_sequence` rejection here.
   */
  async emitNext(
    body: Pick<KaraokeStreamingSttEvent, "type" | "text" | "words"> & {
      deliveredAtAudioMs?: number;
    },
    commit?: KaraokeSttCommitAck,
  ): Promise<number> {
    this.sequence += 1;
    await this.emit(
      {
        attemptId: this.attemptId,
        deliveredAtAudioMs: body.deliveredAtAudioMs ?? 0,
        protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
        sequence: this.sequence,
        sessionId: this.sessionId,
        text: body.text,
        type: body.type,
        words: body.words,
      } as KaraokeStreamingSttEvent,
      commit,
    );
    return this.sequence;
  }
}
