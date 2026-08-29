import { describe, expect, test } from "bun:test";
import type { KaraokeSttAdapterMessage } from "@pirate/application/karaoke-runtime";
import {
  connectElevenLabsKaraokeSocket,
  ElevenLabsKaraokeSttAdapter,
  type KaraokeSttSocket,
} from "./elevenlabs-karaoke-stt.ts";

class FakeSocket implements KaraokeSttSocket {
  readonly sent: string[] = [];
  closed = false;
  private message: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private errorListener: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(
    type: "message" | "close" | "error",
    listener: ((event: { data: string | ArrayBuffer }) => void) | (() => void),
  ): void {
    if (type === "message")
      this.message = listener as (event: { data: string | ArrayBuffer }) => void;
    if (type === "close") this.closeListener = listener as () => void;
    if (type === "error") this.errorListener = listener as () => void;
  }
  emit(value: unknown): void {
    this.message?.({ data: JSON.stringify(value) });
  }
  drop(): void {
    this.closeListener?.();
  }
  error(): void {
    this.errorListener?.();
  }
}

const frame = (bytes: number, songStartMs = 1_000) => ({
  attemptId: "attempt-1",
  chunkId: 1,
  pcm16: new ArrayBuffer(bytes),
  protocolVersion: 1 as const,
  sampleRate: 16_000 as const,
  sequence: 2,
  sessionId: "session-1",
  songEndMs: songStartMs + bytes / 32,
  songStartMs,
  type: "audio_chunk" as const,
});

describe("ElevenLabs Karaoke realtime adapter", () => {
  test("requests manual timestamped zero-log scoring and enforces the safe commit floor", async () => {
    const socket = new FakeSocket();
    let connectedUrl = "";
    const messages: KaraokeSttAdapterMessage[] = [];
    const adapter = new ElevenLabsKaraokeSttAdapter({
      apiKey: "secret",
      connect: async ({ url }) => {
        connectedUrl = url;
        return socket;
      },
    });
    await adapter.start({
      attemptId: "attempt-1",
      sessionId: "session-1",
      initialSequence: 7,
      onMessage: async (message) => {
        messages.push(message);
      },
    });
    const url = new URL(connectedUrl);
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("commit_strategy")).toBe("manual");
    expect(url.searchParams.get("include_timestamps")).toBe("true");
    expect(url.searchParams.get("disable_logging")).toBe("true");

    await adapter.sendPcm16(frame(12_000));
    expect(await adapter.commit()).toBeNull();
    await adapter.sendPcm16(frame(2_000, 1_375));
    const commit = await adapter.commit();
    expect(commit).not.toBeNull();
    if (commit === null) throw new Error("expected_commit");
    const streamGeneration = adapter.streamGeneration;
    expect(streamGeneration).not.toBeNull();
    if (streamGeneration === null) throw new Error("expected_stream_generation");
    expect(commit.streamGeneration).toBe(streamGeneration);
    expect(socket.sent).toHaveLength(3);

    socket.emit({
      message_type: "committed_transcript_with_timestamps",
      text: "hello world",
      words: [
        { type: "word", text: "hello", start: 0.1, end: 0.2, logprob: -0.1 },
        { type: "spacing", text: " " },
        { type: "word", text: "world", start: 0.45, end: 0.55, confidence: 0.9 },
      ],
    });
    await Bun.sleep(0);
    expect(messages[0]?.event.sequence).toBe(8);
    expect(messages[0]?.commit?.commitId).toBe(commit?.commitId);
    expect(messages[0]?.event.words.map((word) => word.startMs)).toEqual([1_100, 1_450]);
  });

  test("separates retryable drops from terminal provider failures", async () => {
    const retrySocket = new FakeSocket();
    let dropped = 0;
    const retry = new ElevenLabsKaraokeSttAdapter({
      apiKey: "secret",
      connect: async () => retrySocket,
    });
    await retry.start({
      attemptId: "attempt-1",
      sessionId: "session-1",
      initialSequence: 0,
      onMessage: async () => undefined,
      onUnexpectedClose: () => {
        dropped += 1;
      },
    });
    retrySocket.emit({ message_type: "rate_limited" });
    await Bun.sleep(0);
    expect(dropped).toBe(1);

    const terminalSocket = new FakeSocket();
    let terminal = "";
    const terminalAdapter = new ElevenLabsKaraokeSttAdapter({
      apiKey: "secret",
      connect: async () => terminalSocket,
    });
    await terminalAdapter.start({
      attemptId: "attempt-1",
      sessionId: "session-1",
      initialSequence: 0,
      onMessage: async () => undefined,
      onTerminalError: (code) => {
        terminal = code;
      },
    });
    terminalSocket.emit({ message_type: "auth_error" });
    await Bun.sleep(0);
    expect(terminal).toBe("auth_error");
  });

  test("mints a fresh single-use token before the outbound upgrade", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    try {
      globalThis.fetch = (async (input, init) => {
        const request = new Request(input instanceof Request ? input.url : String(input), init);
        requests.push(request);
        if (requests.length === 1) return Response.json({ token: "single-use" });
        return { status: 101, webSocket: { accept: () => undefined } } as unknown as Response;
      }) as typeof fetch;
      await connectElevenLabsKaraokeSocket({
        apiKey: "provider-key",
        url: "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime",
      });
      expect(requests[0]?.url).toBe(
        "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      );
      expect(requests[0]?.headers.get("xi-api-key")).toBe("provider-key");
      expect(new URL(requests[1]?.url ?? "").searchParams.get("token")).toBe("single-use");
      expect(requests[1]?.headers.get("upgrade")).toBe("websocket");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
