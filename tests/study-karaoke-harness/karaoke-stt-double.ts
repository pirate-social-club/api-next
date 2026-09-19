import type {
  KaraokeClientBinaryFrame,
  KaraokeRecognizedWord,
  KaraokeStreamingSttAdapter,
  KaraokeStreamingSttEvent,
  KaraokeSttAdapterMessage,
} from "@pirate/application";

/**
 * Scripted Karaoke STT provider double for the local Study/Karaoke harness.
 *
 * It implements the same `KaraokeStreamingSttAdapter` seam the production
 * ElevenLabs adapter implements, so the Durable Object protocol, session
 * lifecycle, scoring, persistence and finalization are the real ones. Only the
 * provider transport is replaced.
 *
 * The mode is armed per attempt through the harness control plane (the DO
 * subclass reads it at commit time), and each commit emits recognized words for
 * every not-yet-emitted authority line whose end falls at or before the
 * committed frontier. Word timings for the remaining lines/presentation come
 * from the seeded timing artifact, transformed by the armed mode.
 */
export type KaraokeSttScriptMode =
  | "correct"
  | "wrong_words"
  | "omit_negation"
  | "early"
  | "late"
  | "silence"
  | "provider_error";

export type KaraokeSttScriptLine = Readonly<{
  readonly id: string;
  readonly index: number;
  readonly text: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly words: readonly Readonly<{ text: string; start_ms: number; end_ms: number }>[];
}>;

export type KaraokeSttScriptState = {
  mode: KaraokeSttScriptMode;
  emissions: {
    readonly mode: KaraokeSttScriptMode;
    readonly commitId: string;
    readonly frontierMs: number;
    readonly lineIds: readonly string[];
  }[];
};

const NEGATION_OR_NUMBER =
  /^(?:not|no|never|none|nobody|nothing|without|don't|doesn't|didn't|can't|won't|isn't|aren't|\d+)$/iu;

function transformWords(
  words: readonly Readonly<{ text: string; start_ms: number; end_ms: number }>[],
  mode: KaraokeSttScriptMode,
): KaraokeRecognizedWord[] {
  if (mode === "silence" || mode === "provider_error") return [];
  if (mode === "wrong_words") {
    return words.map((word) => ({
      text: "blah",
      startMs: word.start_ms,
      endMs: word.end_ms,
      confidence: 0.4,
      final: true,
      source: "stt" as const,
    }));
  }
  if (mode === "omit_negation") {
    const kept = words.filter((word) => !NEGATION_OR_NUMBER.test(word.text));
    return kept.map((word) => ({
      text: word.text,
      startMs: word.start_ms,
      endMs: word.end_ms,
      confidence: 0.9,
      final: true,
      source: "stt" as const,
    }));
  }
  const shiftMs = mode === "early" ? -250 : mode === "late" ? 250 : 0;
  return words.map((word) => ({
    text: word.text,
    startMs: Math.max(0, word.start_ms + shiftMs),
    endMs: Math.max(0, word.end_ms + shiftMs),
    confidence: 0.9,
    final: true,
    source: "stt" as const,
  }));
}

export class ScriptedKaraokeSttAdapter implements KaraokeStreamingSttAdapter {
  streamGeneration: string | null = null;

  private sequence = 0;
  private frontierMs = 0;
  private onMessage: ((message: KaraokeSttAdapterMessage) => Promise<void>) | null = null;
  private onTerminalError: ((code: string) => void) | null = null;
  private started = false;
  private pendingCommitId: string | null = null;
  private readonly emittedLineIds = new Set<string>();

  constructor(
    private readonly input: Readonly<{
      readonly lines: readonly KaraokeSttScriptLine[];
      readonly state: KaraokeSttScriptState;
      readonly sessionId: string;
      readonly attemptId: string;
      readonly onEmission?: (emission: KaraokeSttScriptState["emissions"][number]) => void;
    }>,
  ) {}

  async start(startInput: Parameters<KaraokeStreamingSttAdapter["start"]>[0]): Promise<void> {
    this.streamGeneration = crypto.randomUUID();
    this.sequence = startInput.initialSequence;
    this.onMessage = startInput.onMessage;
    this.onTerminalError = startInput.onTerminalError ?? null;
    this.frontierMs = 0;
    this.started = true;
    this.pendingCommitId = null;
    this.emittedLineIds.clear();
    if (this.input.state.mode === "provider_error") {
      // A terminal provider error must abort the session visibly through the
      // real host path: the adapter reports it, the host reduces an abort.
      queueMicrotask(() => this.onTerminalError?.("input_error"));
    }
  }

  async sendPcm16(frame: KaraokeClientBinaryFrame): Promise<void> {
    if (!this.started) return;
    this.frontierMs = Math.max(this.frontierMs, frame.songEndMs);
  }

  async commit(): Promise<{
    commitId: string;
    streamGeneration: string;
    frontierMs: number;
  } | null> {
    if (!this.started || this.streamGeneration === null || this.pendingCommitId !== null) {
      return null;
    }
    if (this.frontierMs <= 0) return null;
    const commitId = crypto.randomUUID();
    this.pendingCommitId = commitId;
    const streamGeneration = this.streamGeneration;
    const frontierMs = this.frontierMs;
    queueMicrotask(() => {
      void this.emitCommitted(commitId, streamGeneration, frontierMs);
    });
    return { commitId, streamGeneration, frontierMs };
  }

  async close(): Promise<void> {
    this.started = false;
    this.streamGeneration = null;
    this.onMessage = null;
    this.onTerminalError = null;
  }

  private async emitCommitted(
    commitId: string,
    streamGeneration: string,
    frontierMs: number,
  ): Promise<void> {
    const emit = this.onMessage;
    if (emit === null || !this.started) return;
    const mode = this.input.state.mode;
    const dueLines = this.input.lines.filter(
      (line) => line.end_ms <= frontierMs && !this.emittedLineIds.has(line.id),
    );
    const words = dueLines.flatMap((line) => transformWords(line.words, mode));
    const text =
      mode === "silence" || mode === "provider_error"
        ? ""
        : dueLines.map((line) => line.text).join(" ");
    this.sequence += 1;
    const event: KaraokeStreamingSttEvent = {
      protocolVersion: 1,
      sessionId: this.input.sessionId,
      attemptId: this.input.attemptId,
      sequence: this.sequence,
      deliveredAtAudioMs: frontierMs,
      type: "stt_final",
      text,
      words,
    };
    if (mode !== "provider_error") {
      for (const line of dueLines) this.emittedLineIds.add(line.id);
    }
    this.pendingCommitId = null;
    const emission = {
      mode,
      commitId,
      frontierMs,
      lineIds: dueLines.map((line) => line.id),
    };
    this.input.state.emissions.push(emission);
    this.input.onEmission?.(emission);
    await emit({
      event,
      commit: { commitId, streamGeneration, coverageMs: frontierMs },
    });
  }
}
