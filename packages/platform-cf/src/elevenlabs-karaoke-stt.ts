import type {
  KaraokeClientBinaryFrame,
  KaraokeRecognizedWord,
  KaraokeStreamingSttAdapter,
  KaraokeStreamingSttEvent,
  KaraokeSttAdapterMessage,
  KaraokeSttCommitAck,
} from "@pirate/application/karaoke-runtime";

const DEFAULT_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const DEFAULT_MODEL = "scribe_v2_realtime";
export const elevenLabsKaraokeProviderPolicy = (
  environment: string | undefined,
): Readonly<{
  enableLogging: boolean;
  providerRetention: "not_stored" | "stored";
}> => {
  const enableLogging = environment === "staging";
  return {
    enableLogging,
    providerRetention: enableLogging ? "stored" : "not_stored",
  };
};
const TOKEN_PATH = "/v1/single-use-token/realtime_scribe";
const SAFE_COMMIT_FLOOR_MS = 400;
const COMMIT_DRAIN_TIMEOUT_MS = 1_500;
const SEGMENT_RETENTION_MS = 120_000;
const RETRYABLE_ERRORS = new Set(["rate_limited", "queue_overflow", "resource_exhausted"]);
const PROVIDER_ERRORS = new Set([
  "auth_error",
  "quota_exceeded",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "input_error",
  "error",
]);

type SocketMessage = Readonly<{ data: string | ArrayBuffer }>;
export interface KaraokeSttSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: SocketMessage) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export type KaraokeSttSocketConnect = (input: {
  readonly url: string;
  readonly apiKey: string;
}) => Promise<KaraokeSttSocket>;

export const connectElevenLabsKaraokeSocket: KaraokeSttSocketConnect = async (input) => {
  const upgradeUrl = input.url.replace(/^wss:/iu, "https:").replace(/^ws:/iu, "http:");
  const tokenResponse = await fetch(new URL(TOKEN_PATH, upgradeUrl), {
    method: "POST",
    headers: { "xi-api-key": input.apiKey },
  });
  if (!tokenResponse.ok)
    throw new Error(`elevenlabs_stt_token_mint_failed_${tokenResponse.status}`);
  const tokenDocument = (await tokenResponse.json()) as { readonly token?: unknown };
  if (typeof tokenDocument.token !== "string" || tokenDocument.token.trim() === "") {
    throw new Error("elevenlabs_stt_token_missing");
  }
  const websocketUrl = new URL(upgradeUrl);
  websocketUrl.searchParams.set("token", tokenDocument.token);
  const response = (await fetch(websocketUrl, {
    headers: { Upgrade: "websocket" },
  })) as Response & { readonly webSocket: (WebSocket & { accept(): void }) | null };
  if (response.webSocket === null) {
    throw new Error(`elevenlabs_stt_upgrade_failed_${response.status}`);
  }
  response.webSocket.accept();
  return response.webSocket as unknown as KaraokeSttSocket;
};

type Segment = Readonly<{ streamStartMs: number; streamEndMs: number; songStartMs: number }>;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const base64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

class SttEmitter {
  private sequence: number;
  private audioMs = 0;

  constructor(
    private readonly sessionId: string,
    private readonly attemptId: string,
    initialSequence: number,
    private readonly emit: (message: KaraokeSttAdapterMessage) => Promise<void>,
  ) {
    this.sequence = initialSequence;
  }

  noteAudio(ms: number): void {
    this.audioMs = Math.max(this.audioMs, ms);
  }

  async send(
    type: "stt_partial" | "stt_final",
    transcript: string,
    words: KaraokeRecognizedWord[],
    commit?: KaraokeSttCommitAck,
  ): Promise<void> {
    this.sequence += 1;
    const event: KaraokeStreamingSttEvent = {
      protocolVersion: 1,
      sessionId: this.sessionId,
      attemptId: this.attemptId,
      sequence: this.sequence,
      deliveredAtAudioMs: this.audioMs,
      type,
      text: transcript,
      words,
    };
    await this.emit(commit === undefined ? { event } : { event, commit });
  }
}

export interface ElevenLabsKaraokeSttOptions {
  readonly apiKey: string;
  readonly enableLogging?: boolean;
  readonly model?: string;
  readonly websocketUrl?: string;
  readonly connect?: KaraokeSttSocketConnect;
  readonly onProviderRetentionChanged?: (retention: "not_stored" | "stored") => void;
}

export class ElevenLabsKaraokeSttAdapter implements KaraokeStreamingSttAdapter {
  streamGeneration: string | null = null;
  private socket: KaraokeSttSocket | null = null;
  private emitter: SttEmitter | null = null;
  private segments: Segment[] = [];
  private streamCursorMs = 0;
  private uncommittedBytes = 0;
  private submittedSongFrontierMs = 0;
  private inFlight: { commitId: string; frontierMs: number } | null = null;
  private closed = false;
  private closing = false;
  private sampleRate = 16_000;
  private onUnexpectedClose: (() => void) | null = null;
  private onTerminalError: ((code: string) => void) | null = null;
  private drain: (() => void) | null = null;
  private inbound = Promise.resolve();

  constructor(private readonly options: ElevenLabsKaraokeSttOptions) {}

  async start(input: Parameters<KaraokeStreamingSttAdapter["start"]>[0]): Promise<void> {
    this.closed = false;
    this.closing = false;
    this.segments = [];
    this.streamCursorMs = 0;
    this.uncommittedBytes = 0;
    this.submittedSongFrontierMs = 0;
    this.inFlight = null;
    this.streamGeneration = crypto.randomUUID();
    this.onUnexpectedClose = input.onUnexpectedClose ?? null;
    this.onTerminalError = input.onTerminalError ?? null;
    this.emitter = new SttEmitter(
      input.sessionId,
      input.attemptId,
      input.initialSequence,
      input.onMessage,
    );
    const url = new URL(this.options.websocketUrl ?? DEFAULT_URL);
    url.searchParams.set("model_id", this.options.model ?? DEFAULT_MODEL);
    url.searchParams.set("audio_format", "pcm_16000");
    url.searchParams.set("include_timestamps", "true");
    url.searchParams.set("commit_strategy", "manual");
    url.searchParams.set("enable_logging", String(this.options.enableLogging === true));
    const socket = await (this.options.connect ?? connectElevenLabsKaraokeSocket)({
      url: url.toString(),
      apiKey: this.options.apiKey,
    });
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      this.inbound = this.inbound.then(() => this.handleMessage(event.data)).catch(() => undefined);
    });
    socket.addEventListener("close", () => this.socketDropped());
    socket.addEventListener("error", () => this.socketDropped());
  }

  async sendPcm16(frame: KaraokeClientBinaryFrame): Promise<void> {
    this.sampleRate = frame.sampleRate;
    const durationMs = (frame.pcm16.byteLength / 2 / frame.sampleRate) * 1_000;
    const streamStartMs = this.streamCursorMs;
    this.streamCursorMs += durationMs;
    this.segments.push({
      streamStartMs,
      streamEndMs: this.streamCursorMs,
      songStartMs: frame.songStartMs,
    });
    const cutoff = this.streamCursorMs - SEGMENT_RETENTION_MS;
    this.segments = this.segments.filter((segment) => segment.streamEndMs >= cutoff);
    this.uncommittedBytes += frame.pcm16.byteLength;
    this.submittedSongFrontierMs = Math.max(this.submittedSongFrontierMs, frame.songEndMs);
    this.emitter?.noteAudio(frame.songEndMs);
    this.socket?.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: base64(frame.pcm16),
        sample_rate: frame.sampleRate,
      }),
    );
  }

  async commit(): Promise<{
    commitId: string;
    streamGeneration: string;
    frontierMs: number;
  } | null> {
    if (
      this.socket === null ||
      this.closed ||
      this.inFlight !== null ||
      this.streamGeneration === null ||
      (this.uncommittedBytes / 2 / this.sampleRate) * 1_000 < SAFE_COMMIT_FLOOR_MS
    ) {
      return null;
    }
    const result = {
      commitId: crypto.randomUUID(),
      streamGeneration: this.streamGeneration,
      frontierMs: this.submittedSongFrontierMs,
    };
    this.inFlight = result;
    this.uncommittedBytes = 0;
    this.socket.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: "",
        sample_rate: this.sampleRate,
        commit: true,
      }),
    );
    return result;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.inFlight !== null && !this.closed) {
      await new Promise<void>((resolve) => {
        this.drain = resolve;
        setTimeout(resolve, COMMIT_DRAIN_TIMEOUT_MS);
      });
    }
    const socket = this.socket;
    this.markClosed();
    this.socket = null;
    this.emitter = null;
    this.streamGeneration = null;
    socket?.close(1000, "karaoke_session_ended");
  }

  private socketDropped(): void {
    if (this.closing || this.closed) return;
    const notify = this.onUnexpectedClose;
    this.markClosed();
    notify?.();
  }

  private markClosed(): void {
    this.closed = true;
    this.drain?.();
    this.drain = null;
  }

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string" || this.emitter === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const message = parsed as Record<string, unknown>;
    const type = string(message.message_type) || string(message.type);
    if (type === "warning") {
      const warning = `${string(message.warning)} ${string(message.message)}`;
      if (
        this.options.enableLogging === true ||
        !/zero[ _-]?retention|enable_logging\s*=\s*false/iu.test(warning)
      ) {
        return;
      }
      try {
        this.options.onProviderRetentionChanged?.("stored");
      } finally {
        this.terminate("zero_retention_not_applied");
      }
      return;
    }
    if (PROVIDER_ERRORS.has(type)) {
      if (RETRYABLE_ERRORS.has(type)) this.socketDropped();
      else this.terminate(type);
      return;
    }
    const transcript = string(message.text) || string(message.transcript);
    if (type === "partial_transcript") {
      if (transcript !== "") await this.emitter.send("stt_partial", transcript, []);
      return;
    }
    if (type !== "committed_transcript_with_timestamps") return;
    const inFlight = this.inFlight;
    this.inFlight = null;
    const commit =
      inFlight === null || this.streamGeneration === null
        ? undefined
        : {
            commitId: inFlight.commitId,
            coverageMs: inFlight.frontierMs,
            streamGeneration: this.streamGeneration,
          };
    await this.emitter.send("stt_final", transcript, this.mapWords(message.words), commit);
    this.drain?.();
    this.drain = null;
  }

  private terminate(code: string): void {
    const socket = this.socket;
    this.markClosed();
    this.socket = null;
    socket?.close(1008, code);
    this.onTerminalError?.(code);
  }

  private mapWords(raw: unknown): KaraokeRecognizedWord[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const word = value as Record<string, unknown>;
      if (word.type === "spacing") return [];
      const token = (string(word.text) || string(word.word)).trim();
      const start = finite(word.start) ?? finite(word.start_time);
      const end = finite(word.end) ?? finite(word.end_time);
      if (token === "" || start === null || end === null) return [];
      const direct = finite(word.confidence);
      const logprob = finite(word.logprob);
      const confidence =
        direct === null && logprob === null
          ? null
          : Math.max(0, Math.min(1, direct ?? Math.exp(logprob ?? 0)));
      return [
        {
          text: token,
          startMs: this.songTime(start),
          endMs: this.songTime(end),
          confidence,
          final: true,
          source: "stt" as const,
        },
      ];
    });
  }

  private songTime(seconds: number): number {
    const streamMs = seconds * 1_000;
    const segment =
      [...this.segments].reverse().find((candidate) => streamMs >= candidate.streamStartMs) ??
      this.segments[0];
    return segment === undefined
      ? Math.round(streamMs)
      : Math.round(segment.songStartMs + streamMs - segment.streamStartMs);
  }
}

export class FakeKaraokeSttAdapter implements KaraokeStreamingSttAdapter {
  streamGeneration: string | null = null;
  readonly frames: KaraokeClientBinaryFrame[] = [];
  private onMessage: ((message: KaraokeSttAdapterMessage) => Promise<void>) | null = null;

  async start(input: Parameters<KaraokeStreamingSttAdapter["start"]>[0]): Promise<void> {
    this.streamGeneration = crypto.randomUUID();
    this.onMessage = input.onMessage;
  }
  async sendPcm16(frame: KaraokeClientBinaryFrame): Promise<void> {
    this.frames.push(frame);
  }
  async commit(): Promise<null> {
    return null;
  }
  async close(): Promise<void> {
    this.streamGeneration = null;
  }
  async emit(message: KaraokeSttAdapterMessage): Promise<void> {
    await this.onMessage?.(message);
  }
}
