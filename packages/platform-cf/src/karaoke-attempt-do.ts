// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workers exists only in the Workers runtime
// @ts-ignore cloudflare:workers exists only in the Workers runtime
import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import {
  buildKaraokeScoringDiagnostics,
  createKaraokeSessionState,
  decodeKaraokeBinaryFrame,
  deserializeKaraokeSessionSnapshot,
  type KaraokeClientEvent,
  KaraokeCommandRejected,
  type KaraokeEffectRunner,
  type KaraokeLineScore,
  type KaraokeRecordingResult,
  type KaraokeRuntimeGateway,
  type KaraokeServerEvent,
  type KaraokeSessionAuthority,
  KaraokeSessionHost,
  type KaraokeSessionState,
  type KaraokeStreamingSttAdapter,
  type KaraokeStreamingSttEvent,
  type KaraokeTransportError,
  serializeKaraokeSessionSnapshot,
} from "@pirate/application";
import { Effect } from "effect";
import {
  ElevenLabsKaraokeSttAdapter,
  elevenLabsSpeechProviderPolicy,
} from "./elevenlabs-karaoke-stt.ts";
import { makeControlPlaneKaraokeStore } from "./karaoke-repository.ts";
import { type HyperdriveConnection, makeHyperdriveControlPlaneLayer } from "./postgres.ts";

const TOKEN_TTL_MS = 5 * 60 * 1_000;
const R2_PART_BYTES = 5 * 1024 * 1024;
const MAX_SESSION_MS = 30 * 60 * 1_000;

type Row = Readonly<Record<string, unknown>>;
type Sql = {
  exec<A extends Row = Row>(
    query: string,
    ...bindings: readonly unknown[]
  ): {
    one(): A;
    toArray(): A[];
  };
};
type KaraokeWebSocket = WebSocket & {
  serializeAttachment(value: unknown): void;
};
type KaraokeDurableObjectState = {
  readonly storage: {
    readonly sql: unknown;
    setAlarm(scheduledTime: number | Date): Promise<void>;
  };
  acceptWebSocket(socket: WebSocket): void;
  blockConcurrencyWhile<A>(callback: () => Promise<A>): void;
  getWebSockets(): WebSocket[];
};
type KaraokeR2UploadedPart = Readonly<{
  etag: string;
  partNumber: number;
}>;
type KaraokeR2MultipartUpload = {
  readonly uploadId: string;
  abort(): Promise<void>;
  complete(parts: KaraokeR2UploadedPart[]): Promise<unknown>;
  uploadPart(partNumber: number, value: Uint8Array): Promise<KaraokeR2UploadedPart>;
};
type KaraokeR2Bucket = {
  createMultipartUpload(
    key: string,
    options: Readonly<{
      customMetadata: Readonly<Record<string, string>>;
      httpMetadata: Readonly<{ contentType: string }>;
    }>,
  ): Promise<KaraokeR2MultipartUpload>;
  get(key: string): Promise<Readonly<{
    body: ReadableStream<Uint8Array>;
    size: number;
  }> | null>;
  resumeMultipartUpload(key: string, uploadId: string): KaraokeR2MultipartUpload;
};

declare const WebSocketPair: {
  new (): { readonly 0: KaraokeWebSocket; readonly 1: KaraokeWebSocket };
};

export interface KaraokeAttemptDoBindings {
  readonly API_NEXT_ENV?: string;
  readonly CONTROL_PLANE: HyperdriveConnection;
  readonly ELEVENLABS_ENABLE_LOGGING?: string;
  readonly ELEVENLABS_API_KEY?: string;
  readonly LEARNER_AUDIO?: KaraokeR2Bucket;
}

export interface KaraokeAttemptDoStub {
  readonly initialize: KaraokeRuntimeGateway["initialize"] extends (
    authority: infer A,
  ) => Effect.Effect<infer B, unknown>
    ? (authority: A) => Promise<B>
    : never;
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface KaraokeAttemptDoNamespace {
  readonly getByName: (name: string) => KaraokeAttemptDoStub;
}

type ArchiveState = Readonly<{
  uploadId: string | null;
  objectKey: string;
  nextPart: number;
  parts: readonly KaraokeR2UploadedPart[];
  byteSize: number;
  durationMs: number;
  result: Extract<KaraokeRecordingResult, { state: "stored" }> | null;
  state: "pending" | "stored" | "failed";
}>;

type Outbox = Readonly<{
  completedAt: string;
  completionReason: "completed" | "session_error" | "provider_unavailable" | "abandoned";
  diagnostics: unknown;
  qualificationId: string;
  summary: NonNullable<KaraokeSessionState["summary"]>;
}>;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const sqlJson = <A>(value: unknown): A =>
  JSON.parse(typeof value === "string" ? value : String(value)) as A;
const one = (sql: Sql, query: string, ...bindings: unknown[]): Row | null =>
  (sql.exec<Row>(query, ...bindings).toArray()[0] as Row | undefined) ?? null;
const bytesToHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const digestToken = async (token: string): Promise<string> =>
  bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
const token = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const zeroSummary = (
  authority: KaraokeSessionAuthority,
): NonNullable<KaraokeSessionState["summary"]> => ({
  finalScore: 0,
  lyricsScore: 0,
  timingScore: null,
  confidenceMean: null,
  lineCount: authority.lines.length,
  scoredLineCount: 0,
  noRecognitionLineCount: authority.lines.length,
  uncertainLineCount: authority.lines.length,
  phoneticUnavailableLineCount: authority.lines.length,
  lowConfidenceLineCount: 0,
  timingTrend: "on_time",
  timingCalibration: {
    state: "uncalibrated",
    reason: "insufficient_evidence",
    offsetMs: 0,
    rawOffsetMs: 0,
    residualSpreadMs: 0,
    measuredLineCount: 0,
    matchedWordCount: 0,
  },
  strongestLines: [],
  weakestLines: [],
  missedWords: [],
  lineDiagnostics: [],
});

const transcriptFreeSummary = (
  summary: NonNullable<KaraokeSessionState["summary"]>,
): NonNullable<KaraokeSessionState["summary"]> => ({
  ...summary,
  strongestLines: [],
  weakestLines: [],
  missedWords: [],
  lineDiagnostics: [],
});

class RuntimeEffects implements KaraokeEffectRunner {
  constructor(private readonly owner: KaraokeAttemptDO) {}

  async runKaraokeEffect(
    effect: Parameters<KaraokeEffectRunner["runKaraokeEffect"]>[0],
    state: KaraokeSessionState,
  ) {
    if (effect.type === "emit_line_score")
      this.owner.broadcast("line_score", { result: effect.score });
    if (effect.type === "emit_summary") {
      this.owner.broadcast("summary", { summary: effect.summary });
      await this.owner.enqueueFinalization("completed", effect.summary, state.finalizedLineScores);
    }
    await this.owner.persistHost();
  }

  async relaySttEvent(event: KaraokeStreamingSttEvent): Promise<void> {
    this.owner.broadcast(event.type, { text: event.text, words: event.words });
  }

  async reportTransportError(
    error: KaraokeTransportError,
    state: KaraokeSessionState,
  ): Promise<void> {
    this.owner.noteTransportError(error);
    this.owner.broadcast("session_error", { code: error.code });
    if (state.status === "aborted") {
      const reason = /elevenlabs|provider|reconnect|stt/iu.test(error.message)
        ? "provider_unavailable"
        : "session_error";
      await this.owner.enqueueFinalization(reason, zeroSummary(this.owner.authority()));
    }
  }
}

export class KaraokeAttemptDO extends DurableObject<KaraokeAttemptDoBindings> {
  private host: KaraokeSessionHost | null = null;
  private adapter: KaraokeStreamingSttAdapter | null = null;
  private serverSequence = 0;
  private readonly sql: Sql;
  private readonly runtimeCtx: KaraokeDurableObjectState;
  private readonly runtimeEnv: KaraokeAttemptDoBindings;

  constructor(ctx: KaraokeDurableObjectState, env: KaraokeAttemptDoBindings) {
    super(ctx as never, env);
    this.runtimeCtx = ctx;
    this.runtimeEnv = env;
    this.sql = ctx.storage.sql as Sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS karaoke_session (
        id INTEGER PRIMARY KEY CHECK (id=1), authority_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL, server_sequence INTEGER NOT NULL,
        terminal INTEGER NOT NULL DEFAULT 0
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS karaoke_token (
        digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS karaoke_audio_chunk (
        frame_sequence INTEGER PRIMARY KEY, payload BLOB NOT NULL, byte_size INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS karaoke_archive (
        id INTEGER PRIMARY KEY CHECK (id=1), upload_id TEXT, object_key TEXT NOT NULL,
        next_part INTEGER NOT NULL, parts_json TEXT NOT NULL, byte_size INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL, state TEXT NOT NULL, result_json TEXT
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS karaoke_outbox (
        id INTEGER PRIMARY KEY CHECK (id=1), payload_json TEXT NOT NULL,
        score_state TEXT NOT NULL, recording_state TEXT NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS karaoke_transport (
        id INTEGER PRIMARY KEY CHECK (id=1), reconnect_count INTEGER NOT NULL DEFAULT 0,
        pause_count INTEGER NOT NULL DEFAULT 0, seek_count INTEGER NOT NULL DEFAULT 0,
        epoch_count INTEGER NOT NULL DEFAULT 0, dropped_frame_count INTEGER NOT NULL DEFAULT 0,
        late_frame_count INTEGER NOT NULL DEFAULT 0, commit_latencies_json TEXT NOT NULL DEFAULT '[]'
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS karaoke_provider_retention (
        id INTEGER PRIMARY KEY CHECK (id=1),
        retention TEXT NOT NULL CHECK (retention IN ('not_stored','stored'))
      )`);
      this.sql.exec(
        "INSERT OR IGNORE INTO karaoke_provider_retention (id,retention) VALUES (1,?)",
        this.providerPolicy().providerRetention,
      );
      this.recordProviderRetention(this.providerPolicy().providerRetention);
    });
  }

  async initialize(authority: KaraokeSessionAuthority): Promise<{
    providerRetention: "not_stored" | "stored";
    token: string;
    tokenExpiresAt: number;
  }> {
    if (
      this.runtimeEnv.ELEVENLABS_API_KEY === undefined ||
      this.runtimeEnv.ELEVENLABS_API_KEY.trim() === ""
    ) {
      throw new Error("karaoke_provider_unavailable");
    }
    const existing = one(
      this.sql,
      "SELECT authority_json,terminal FROM karaoke_session WHERE id=1",
    );
    if (existing === null) {
      const state = createKaraokeSessionState({
        sessionId: authority.sessionId,
        attemptId: authority.attemptId,
        lines: authority.lines.map((line) => ({
          lineId: line.id,
          lineIndex: line.index,
          scoredLineIndex: line.index,
          text: line.text,
          startMs: line.start_ms,
          endMs: line.end_ms,
          words: line.words.map((word) => ({
            text: word.text,
            startMs: word.start_ms,
            endMs: word.end_ms,
          })),
        })),
        scoringPolicy: {
          kind: "enabled",
          provider: "elevenlabs",
          model: "scribe_v2_realtime",
          retention: this.providerPolicy().providerRetention,
        },
      });
      const snapshot = serializeKaraokeSessionSnapshot({
        state,
        lastClientSequence: null,
        lastSttSequence: null,
        serverSequence: 0,
      });
      this.sql.exec(
        "INSERT INTO karaoke_session (id,authority_json,snapshot_json,server_sequence) VALUES (1,?,?,0)",
        JSON.stringify(authority),
        JSON.stringify(snapshot),
      );
      this.sql.exec(
        `INSERT INTO karaoke_archive
          (id,upload_id,object_key,next_part,parts_json,byte_size,duration_ms,state)
         VALUES (1,NULL,?,1,'[]',0,0,'pending')`,
        `karaoke/${authority.accountId}/${authority.attemptId}.pcm`,
      );
      this.sql.exec("INSERT INTO karaoke_transport (id,epoch_count) VALUES (1,0)");
      await this.runtimeCtx.storage.setAlarm(
        Math.min(Date.parse(authority.expiresAt), Date.now() + MAX_SESSION_MS),
      );
    } else if (Number(existing.terminal) === 1) {
      throw new Error("karaoke_session_terminal");
    } else if (canonicalJson(sqlJson(existing.authority_json)) !== canonicalJson(authority)) {
      throw new Error("karaoke_session_identity_mismatch");
    }
    const credential = token();
    const tokenExpiresAt = Math.min(Date.now() + TOKEN_TTL_MS, Date.parse(authority.expiresAt));
    this.sql.exec("DELETE FROM karaoke_token WHERE expires_at <= ?", Date.now());
    this.sql.exec(
      "INSERT INTO karaoke_token (digest,expires_at,used) VALUES (?,?,0)",
      await digestToken(credential),
      tokenExpiresAt,
    );
    return {
      providerRetention: this.providerRetention(),
      token: credential,
      tokenExpiresAt,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const authority = this.authority();
    const session = one(this.sql, "SELECT terminal FROM karaoke_session WHERE id=1");
    if (Number(session?.terminal ?? 0) === 1) return new Response("Completed", { status: 410 });
    if (Date.now() >= Date.parse(authority.expiresAt))
      return new Response("Expired", { status: 410 });
    const supplied = new URL(request.url).searchParams.get("token");
    if (supplied === null) return new Response("Unauthorized", { status: 401 });
    const row = one(
      this.sql,
      "UPDATE karaoke_token SET used=1 WHERE digest=? AND used=0 AND expires_at>? RETURNING digest",
      await digestToken(supplied),
      Date.now(),
    );
    if (row === null) return new Response("Unauthorized", { status: 401 });
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ sessionId: authority.sessionId, epoch: Date.now() });
    this.runtimeCtx.acceptWebSocket(pair[1]);
    const transport = one(this.sql, "SELECT epoch_count FROM karaoke_transport WHERE id=1");
    this.sql.exec(
      "UPDATE karaoke_transport SET reconnect_count=reconnect_count+?, epoch_count=epoch_count+1 WHERE id=1",
      Number(transport?.epoch_count ?? 0) > 0 ? 1 : 0,
    );
    await this.ensureHost();
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
    } as ResponseInit & { webSocket: WebSocket });
  }

  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const host = await this.ensureHost();
    if (typeof message === "string") {
      let event: KaraokeClientEvent;
      try {
        event = JSON.parse(message) as KaraokeClientEvent;
      } catch {
        this.broadcast("session_error", { code: "invalid_event_payload" });
        return;
      }
      const error = await host.handleClientEvent(event);
      if (error === null && event.type === "pause")
        this.sql.exec("UPDATE karaoke_transport SET pause_count=pause_count+1 WHERE id=1");
      if (error === null && event.type === "seek")
        this.sql.exec("UPDATE karaoke_transport SET seek_count=seek_count+1 WHERE id=1");
      await this.persistHost();
      return;
    }
    const authority = this.authority();
    const decoded = decodeKaraokeBinaryFrame(message, {
      sessionId: authority.sessionId,
      attemptId: authority.attemptId,
    });
    if (decoded.error !== undefined) {
      this.noteTransportError(decoded.error);
      this.broadcast("session_error", { code: decoded.error.code });
      return;
    }
    const error = await host.handleAudioFrame(decoded.frame);
    if (error === null) {
      try {
        await this.archiveFrame(
          decoded.frame.sequence,
          decoded.frame.pcm16,
          decoded.frame.songEndMs,
        );
      } catch {
        this.sql.exec("UPDATE karaoke_archive SET state='failed' WHERE id=1");
      }
    }
    await this.persistHost();
  }

  async webSocketClose(): Promise<void> {
    await this.persistHost();
  }

  async webSocketError(): Promise<void> {
    await this.persistHost();
  }

  async alarm(): Promise<void> {
    const authority = this.authority();
    const outbox = one(this.sql, "SELECT id FROM karaoke_outbox WHERE id=1");
    if (outbox === null && Date.now() >= Date.parse(authority.expiresAt)) {
      await this.enqueueFinalization("abandoned", zeroSummary(authority));
    }
    await this.flushOutbox();
  }

  authority(): KaraokeSessionAuthority {
    const row = one(this.sql, "SELECT authority_json FROM karaoke_session WHERE id=1");
    if (row === null) throw new Error("karaoke_session_uninitialized");
    return sqlJson(row.authority_json);
  }

  broadcast<Type extends KaraokeServerEvent["type"]>(
    type: Type,
    body: Omit<
      Extract<KaraokeServerEvent, { type: Type }>,
      "attemptId" | "eventId" | "protocolVersion" | "sequence" | "sessionId" | "type"
    >,
  ): void {
    const authority = this.authority();
    this.serverSequence += 1;
    const event = JSON.stringify({
      protocolVersion: 1,
      sessionId: authority.sessionId,
      attemptId: authority.attemptId,
      sequence: this.serverSequence,
      eventId: `karaoke_event_${this.serverSequence}`,
      type,
      ...body,
    });
    for (const socket of this.runtimeCtx.getWebSockets()) {
      try {
        socket.send(event);
      } catch {
        // A later reconnect receives the persisted aggregate; no transcript is retained for replay.
      }
    }
  }

  noteTransportError(error: KaraokeTransportError): void {
    if (error.code === "non_monotonic_sequence") {
      this.sql.exec("UPDATE karaoke_transport SET late_frame_count=late_frame_count+1 WHERE id=1");
    }
  }

  async persistHost(): Promise<void> {
    if (this.host === null) return;
    const snapshot = serializeKaraokeSessionSnapshot({
      ...this.host.snapshot(),
      serverSequence: this.serverSequence,
    });
    this.sql.exec(
      "UPDATE karaoke_session SET snapshot_json=?, server_sequence=? WHERE id=1",
      JSON.stringify(snapshot),
      this.serverSequence,
    );
  }

  async enqueueFinalization(
    completionReason: Outbox["completionReason"],
    summary: Outbox["summary"],
    scores: readonly KaraokeLineScore[] = [],
  ): Promise<void> {
    const authority = this.authority();
    const payload: Outbox = {
      completedAt: new Date().toISOString(),
      completionReason,
      summary: transcriptFreeSummary(summary),
      diagnostics: buildKaraokeScoringDiagnostics(authority, summary, scores),
      qualificationId: `qualification_${crypto.randomUUID()}`,
    };
    this.sql.exec(
      `INSERT OR IGNORE INTO karaoke_outbox
        (id,payload_json,score_state,recording_state) VALUES (1,?,'pending','pending')`,
      JSON.stringify(payload),
    );
    this.sql.exec("DELETE FROM karaoke_token");
    this.sql.exec("UPDATE karaoke_session SET snapshot_json='{}',terminal=1 WHERE id=1");
    this.host = null;
    await this.runtimeCtx.storage.setAlarm(Date.now());
  }

  private async ensureHost(): Promise<KaraokeSessionHost> {
    if (this.host !== null) return this.host;
    const row = one(
      this.sql,
      "SELECT snapshot_json,server_sequence FROM karaoke_session WHERE id=1",
    );
    if (row === null) throw new Error("karaoke_session_uninitialized");
    const snapshot = deserializeKaraokeSessionSnapshot(sqlJson(row.snapshot_json));
    this.serverSequence = Number(row.server_sequence);
    const key = this.runtimeEnv.ELEVENLABS_API_KEY;
    if (key === undefined || key.trim() === "") throw new Error("karaoke_provider_unavailable");
    this.adapter = new ElevenLabsKaraokeSttAdapter({
      apiKey: key,
      enableLogging: this.providerPolicy().enableLogging,
      onProviderRetentionChanged: (retention) => this.recordProviderRetention(retention),
    });
    this.host = new KaraokeSessionHost(snapshot.state, new RuntimeEffects(this), this.adapter, {
      restore: snapshot,
      persist: () => this.persistHost(),
      onTransportGuardFailure: (diagnostic) => {
        if (diagnostic.code === "non_monotonic_sequence") {
          this.sql.exec(
            "UPDATE karaoke_transport SET late_frame_count=late_frame_count+1 WHERE id=1",
          );
        }
      },
      onReconnectBufferDrop: () => {
        this.sql.exec(
          "UPDATE karaoke_transport SET dropped_frame_count=dropped_frame_count+1 WHERE id=1",
        );
      },
      onCommitSettled: (latencyMs) => {
        const row = one(this.sql, "SELECT commit_latencies_json FROM karaoke_transport WHERE id=1");
        const values = sqlJson<number[]>(row?.commit_latencies_json ?? "[]");
        values.push(Math.round(latencyMs));
        this.sql.exec(
          "UPDATE karaoke_transport SET commit_latencies_json=? WHERE id=1",
          JSON.stringify(values.slice(-100)),
        );
      },
    });
    await this.host.resumeSttIfRecording();
    await this.host.invalidateOrphanedPendingCommit(this.adapter.streamGeneration);
    return this.host;
  }

  private archive(): ArchiveState {
    const row = one(this.sql, "SELECT * FROM karaoke_archive WHERE id=1");
    if (row === null) throw new Error("karaoke_archive_uninitialized");
    return {
      uploadId: row.upload_id === null ? null : String(row.upload_id),
      objectKey: String(row.object_key),
      nextPart: Number(row.next_part),
      parts: sqlJson(row.parts_json),
      byteSize: Number(row.byte_size),
      durationMs: Number(row.duration_ms),
      result: row.result_json === null ? null : sqlJson(row.result_json),
      state: String(row.state) as ArchiveState["state"],
    };
  }

  private async archiveFrame(
    frameSequence: number,
    pcm: ArrayBuffer,
    songEndMs: number,
  ): Promise<void> {
    const archive = this.archive();
    if (archive.state !== "pending") return;
    const inserted = this.sql.exec(
      "INSERT OR IGNORE INTO karaoke_audio_chunk (frame_sequence,payload,byte_size) VALUES (?,?,?) RETURNING frame_sequence",
      frameSequence,
      pcm,
      pcm.byteLength,
    );
    if (inserted.toArray().length === 0) return;
    this.sql.exec(
      "UPDATE karaoke_archive SET byte_size=byte_size+?, duration_ms=max(duration_ms,?) WHERE id=1",
      pcm.byteLength,
      songEndMs,
    );
    const pending = one(
      this.sql,
      "SELECT coalesce(sum(byte_size),0) AS bytes FROM karaoke_audio_chunk",
    );
    if (Number(pending?.bytes ?? 0) >= R2_PART_BYTES) await this.uploadPending(false);
  }

  private async uploadPending(final: boolean): Promise<void> {
    const bucket = this.runtimeEnv.LEARNER_AUDIO;
    if (bucket === undefined) throw new Error("karaoke_archive_bucket_unavailable");
    let archive = this.archive();
    const chunks = this.sql
      .exec<{ frame_sequence: number; payload: ArrayBuffer }>(
        "SELECT frame_sequence,payload FROM karaoke_audio_chunk ORDER BY frame_sequence",
      )
      .toArray();
    const total = chunks.reduce((sum, chunk) => sum + chunk.payload.byteLength, 0);
    if (total === 0 || (!final && total < R2_PART_BYTES)) return;
    const upload =
      archive.uploadId === null
        ? await bucket.createMultipartUpload(archive.objectKey, {
            httpMetadata: { contentType: "audio/L16;rate=16000;channels=1" },
            customMetadata: { source: "karaoke_scored_pcm_v1" },
          })
        : bucket.resumeMultipartUpload(archive.objectKey, archive.uploadId);
    if (archive.uploadId === null) {
      archive = { ...archive, uploadId: upload.uploadId };
      this.sql.exec("UPDATE karaoke_archive SET upload_id=? WHERE id=1", upload.uploadId);
    }
    const payload = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(new Uint8Array(chunk.payload), offset);
      offset += chunk.payload.byteLength;
    }
    const part = await upload.uploadPart(archive.nextPart, payload);
    const parts = [...archive.parts, part];
    this.sql.exec(
      "UPDATE karaoke_archive SET next_part=?,parts_json=? WHERE id=1",
      archive.nextPart + 1,
      JSON.stringify(parts),
    );
    this.sql.exec("DELETE FROM karaoke_audio_chunk");
  }

  private async finishArchive(): Promise<KaraokeRecordingResult> {
    const bucket = this.runtimeEnv.LEARNER_AUDIO;
    if (bucket === undefined) return { state: "failed", failureKind: "multipart_failed" };
    try {
      const previous = this.archive();
      if (previous.state === "failed") {
        if (previous.uploadId !== null) {
          try {
            await bucket.resumeMultipartUpload(previous.objectKey, previous.uploadId).abort();
          } catch {
            // Recording failure remains independent from score finalization.
          }
        }
        return { state: "failed", failureKind: "multipart_failed" };
      }
      if (previous.state === "stored" && previous.result !== null) return previous.result;
      if (previous.state === "stored")
        return await this.persistStoredArchiveResult(bucket, previous);
      await this.uploadPending(true);
      const archive = this.archive();
      if (archive.uploadId === null || archive.parts.length === 0) {
        return { state: "failed", failureKind: "multipart_aborted" };
      }
      await bucket
        .resumeMultipartUpload(archive.objectKey, archive.uploadId)
        .complete([...archive.parts]);
      return await this.persistStoredArchiveResult(bucket, archive);
    } catch {
      const archive = this.archive();
      try {
        const recovered = await this.storedArchiveResult(bucket, archive);
        if (recovered.state === "stored") {
          this.storeArchiveResult(recovered);
          return recovered;
        }
      } catch {
        // If R2 cannot confirm the object, the open multipart upload is aborted below.
      }
      if (archive.uploadId !== null) {
        try {
          await bucket.resumeMultipartUpload(archive.objectKey, archive.uploadId).abort();
        } catch {
          // The failed state is still reconciled even if R2 abort also fails.
        }
      }
      this.sql.exec("UPDATE karaoke_archive SET state='failed' WHERE id=1");
      return { state: "failed", failureKind: "multipart_failed" };
    }
  }

  private async storedArchiveResult(
    bucket: KaraokeR2Bucket,
    archive: ArchiveState,
  ): Promise<KaraokeRecordingResult> {
    const stored = await bucket.get(archive.objectKey);
    if (stored === null) return { state: "failed", failureKind: "reconciliation_failed" };
    const hash = createHash("sha256");
    const reader = stored.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      hash.update(next.value);
    }
    return {
      state: "stored",
      objectRef: archive.objectKey,
      contentSha256: hash.digest("hex"),
      byteSize: stored.size,
      durationMs: Math.max(1, archive.durationMs),
    };
  }

  private storeArchiveResult(result: Extract<KaraokeRecordingResult, { state: "stored" }>): void {
    this.sql.exec(
      "UPDATE karaoke_archive SET state='stored',result_json=? WHERE id=1",
      JSON.stringify(result),
    );
  }

  private async persistStoredArchiveResult(
    bucket: KaraokeR2Bucket,
    archive: ArchiveState,
  ): Promise<KaraokeRecordingResult> {
    const result = await this.storedArchiveResult(bucket, archive);
    if (result.state === "stored") this.storeArchiveResult(result);
    return result;
  }

  private transportFacts() {
    const row = one(this.sql, "SELECT * FROM karaoke_transport WHERE id=1");
    const latencies = sqlJson<number[]>(row?.commit_latencies_json ?? "[]").sort(
      (left, right) => left - right,
    );
    const percentile = (value: number): number | null =>
      latencies.length === 0
        ? null
        : (latencies[Math.ceil((latencies.length - 1) * value)] ?? null);
    return {
      schema_version: 1 as const,
      reconnect_count: Number(row?.reconnect_count ?? 0),
      pause_count: Number(row?.pause_count ?? 0),
      seek_count: Number(row?.seek_count ?? 0),
      epoch_count: Number(row?.epoch_count ?? 0),
      dropped_frame_count: Number(row?.dropped_frame_count ?? 0),
      late_frame_count: Number(row?.late_frame_count ?? 0),
      mic_sample_rate: 16_000 as const,
      provider_commit_latency_p50_ms: percentile(0.5),
      provider_commit_latency_p95_ms: percentile(0.95),
    };
  }

  private providerRetention(): "not_stored" | "stored" {
    const row = one(this.sql, "SELECT retention FROM karaoke_provider_retention WHERE id=1");
    if (row?.retention === "not_stored" || row?.retention === "stored") return row.retention;
    throw new Error("karaoke_provider_retention_unavailable");
  }

  private providerPolicy() {
    return elevenLabsSpeechProviderPolicy(
      this.runtimeEnv.API_NEXT_ENV,
      this.runtimeEnv.ELEVENLABS_ENABLE_LOGGING,
    );
  }

  private recordProviderRetention(retention: "not_stored" | "stored"): void {
    if (retention !== "stored") return;
    const changed = this.sql
      .exec(
        `UPDATE karaoke_provider_retention
            SET retention='stored'
          WHERE id=1 AND retention='not_stored'
        RETURNING retention`,
      )
      .toArray();
    if (changed.length === 0) return;
    if (one(this.sql, "SELECT id FROM karaoke_session WHERE id=1") === null) return;
    this.broadcast("provider_retention_changed", { provider_retention: "stored" });
  }

  private async flushOutbox(): Promise<void> {
    const row = one(this.sql, "SELECT * FROM karaoke_outbox WHERE id=1");
    if (row === null) return;
    const payload = sqlJson<Outbox>(row.payload_json);
    const authority = this.authority();
    const store = makeControlPlaneKaraokeStore(
      makeHyperdriveControlPlaneLayer(this.runtimeEnv.CONTROL_PLANE),
    );
    let retry = false;
    if (row.score_state === "pending") {
      try {
        await Effect.runPromise(
          store.finalizeAttempt({
            authority,
            completedAt: payload.completedAt,
            completionReason: payload.completionReason,
            diagnostics: payload.diagnostics,
            qualificationId: payload.qualificationId,
            summary: payload.summary,
            transportFacts: this.transportFacts(),
          }),
        );
        this.sql.exec("UPDATE karaoke_outbox SET score_state='stored' WHERE id=1");
      } catch {
        retry = true;
      }
    }
    if (row.recording_state === "pending") {
      const result = await this.finishArchive();
      try {
        await Effect.runPromise(
          store.reconcileRecording({
            accountId: authority.accountId,
            artifactId: authority.artifactId,
            attemptId: authority.attemptId,
            reconciledAt: new Date().toISOString(),
            providerRetention: this.providerRetention(),
            result,
            sessionId: authority.sessionId,
          }),
        );
        this.sql.exec("UPDATE karaoke_outbox SET recording_state='stored' WHERE id=1");
      } catch {
        retry = true;
      }
    }
    const current = one(
      this.sql,
      "SELECT score_state,recording_state FROM karaoke_outbox WHERE id=1",
    );
    if (current?.score_state === "stored" && current.recording_state === "stored") {
      this.sql.exec("DELETE FROM karaoke_audio_chunk");
      return;
    }
    if (retry) await this.runtimeCtx.storage.setAlarm(Date.now() + 30_000);
  }
}

export const makeDurableObjectKaraokeRuntimeGateway = (
  namespace: KaraokeAttemptDoNamespace,
): KaraokeRuntimeGateway => ({
  initialize: (authority) =>
    Effect.tryPromise({
      try: () => namespace.getByName(authority.sessionId).initialize(authority),
      catch: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("karaoke_session_terminal")) {
          return new KaraokeCommandRejected({ reason: "session-expired" });
        }
        if (message.includes("karaoke_session_identity_mismatch")) {
          return new KaraokeCommandRejected({ reason: "idempotency-conflict" });
        }
        return new KaraokeCommandRejected({ reason: "provider-unavailable" });
      },
    }),
});
