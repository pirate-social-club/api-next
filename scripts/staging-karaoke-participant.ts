import { encodeKaraokeBinaryFrame } from "@pirate/application/karaoke-runtime";
import type { KaraokeAttempt, KaraokeReadiness, KaraokeSession } from "@pirate/contracts";
import { Schema } from "effect";

type Ready = Extract<KaraokeReadiness, { state: "ready" }>;
type Socket = Readonly<{ send(data: string | ArrayBuffer): void; close(): void }>;
export type KaraokeAttemptIdentity = Readonly<{ session_id: string; attempt_id: string }>;
export class StagingKaraokeParticipantFailed extends Error {
  constructor(
    readonly reason: string,
    readonly attempt: KaraokeAttemptIdentity | null = null,
  ) {
    super(`Karaoke participant failed: ${reason}.`);
  }
}

const Event = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  sessionId: Schema.String,
  attemptId: Schema.String,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  eventId: Schema.NonEmptyString,
  type: Schema.Literals([
    "stt_partial",
    "stt_final",
    "line_score",
    "summary",
    "provider_retention_changed",
    "session_error",
  ]),
  provider_retention: Schema.optional(Schema.Literal("stored")),
});

export function validateKaraokeSocket(session: KaraokeSession, now: number): string {
  let url: URL;
  try {
    url = new URL(session.websocket_url);
  } catch {
    throw new StagingKaraokeParticipantFailed("invalid_socket");
  }
  if (
    url.protocol !== "wss:" ||
    url.host !== "api-next-staging.pirate.sc" ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `/karaoke/realtime/${encodeURIComponent(session.id)}` ||
    [...url.searchParams.keys()].length !== 1 ||
    url.searchParams.getAll("token").length !== 1 ||
    !url.searchParams.get("token") ||
    session.token_expires_at <= now + 1000 ||
    session.session_expires_at <= now
  ) {
    throw new StagingKaraokeParticipantFailed("invalid_socket");
  }
  return url.toString();
}

export async function openKaraokeSocket(
  url: string,
  onMessage: (data: unknown) => void,
  onClose: () => void,
): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let opened = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new StagingKaraokeParticipantFailed("connect_timeout"));
    }, 10000);
    socket.addEventListener("message", (event) => onMessage(event.data));
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      onClose();
      if (!opened) reject(new StagingKaraokeParticipantFailed("connect_closed"));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      onClose();
      socket.close();
      if (!opened) reject(new StagingKaraokeParticipantFailed("connect_failed"));
    });
    socket.addEventListener("open", () => {
      opened = true;
      clearTimeout(timer);
      resolve({ send: (data) => socket.send(data), close: () => socket.close() });
    });
  });
}

export type StagingKaraokePorts = Readonly<{
  createAttempt: () => Promise<KaraokeSession>;
  getAttempt: (attemptId: string) => Promise<KaraokeAttempt | null>;
  recordAttempt: (identity: KaraokeAttemptIdentity) => Promise<void>;
  openSocket: typeof openKaraokeSocket;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
}>;

export function assertPersistedKaraokeAttempt(
  attempt: KaraokeAttempt,
  input: {
    communityId: string;
    postId: string;
    personaId: string;
    readiness: Ready;
  },
  identity: KaraokeAttemptIdentity,
): void {
  if (
    attempt.session_id !== identity.session_id ||
    attempt.attempt_id !== identity.attempt_id ||
    attempt.persona_id !== input.personaId ||
    attempt.community_id !== input.communityId ||
    attempt.post_id !== input.postId ||
    attempt.karaoke_revision_id !== input.readiness.karaoke_revision_id ||
    attempt.completion_reason !== "completed" ||
    !attempt.rank_eligible ||
    attempt.final_score < 7000 ||
    attempt.scored_line_count < 5 ||
    attempt.line_count <= 0 ||
    Math.floor((10000 * attempt.scored_line_count) / attempt.line_count) < 8500
  ) {
    throw new StagingKaraokeParticipantFailed("persisted_attempt_not_qualified", identity);
  }
}

/** Streams reviewed vocal PCM through the real provider; never manufactures STT or scores. */
export async function runStagingKaraokeParticipant(
  input: {
    communityId: string;
    postId: string;
    personaId: string;
    readiness: Ready;
    pcm16: ArrayBuffer;
    durationMs: number;
    allowStoredRetention: boolean;
    deadlineMs: number;
    previousAttempt?: KaraokeAttemptIdentity;
  },
  ports: StagingKaraokePorts,
) {
  const { readiness, durationMs } = input;
  if (
    readiness.community_id !== input.communityId ||
    readiness.post_id !== input.postId ||
    readiness.playback_kind !== "full_mix" ||
    readiness.karaoke_lines.length < 5 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > 600000 ||
    input.pcm16.byteLength !== durationMs * 32 ||
    readiness.karaoke_lines.some(
      (line, index, lines) =>
        line.index !== index ||
        line.start_ms < 0 ||
        line.end_ms <= line.start_ms ||
        line.end_ms > durationMs ||
        (index > 0 && line.end_ms < (lines[index - 1]?.end_ms ?? 0)),
    ) ||
    input.deadlineMs <= ports.now() + durationMs + 30000
  ) {
    throw new StagingKaraokeParticipantFailed("invalid_audio_or_window");
  }
  if (input.previousAttempt) {
    const persisted = await ports.getAttempt(input.previousAttempt.attempt_id);
    if (!persisted)
      throw new StagingKaraokeParticipantFailed(
        "previous_attempt_unresolved",
        input.previousAttempt,
      );
    assertPersistedKaraokeAttempt(persisted, input, input.previousAttempt);
    return { attempt: persisted, replay: true, provider_retention: "previously_recorded" as const };
  }
  const session = await ports.createAttempt();
  const identity = { session_id: session.id, attempt_id: session.attempt };
  await ports.recordAttempt(identity);
  let socket: Socket | undefined;
  let sequence = 0;
  let finishSent = false;
  let closed = false;
  let summary = false;
  let failure: string | null = null;
  let serverSequence = -1;
  let retention: "not_stored" | "stored" = "not_stored";
  const eventIds = new Set<string>();
  const send = (event: Readonly<Record<string, unknown>>) =>
    socket?.send(
      JSON.stringify({
        protocolVersion: 1,
        sessionId: session.id,
        attemptId: session.attempt,
        sequence: sequence++,
        ...event,
      }),
    );
  try {
    if (
      session.protocol_version !== 1 ||
      session.persona_id !== input.personaId ||
      session.scoring_policy.kind !== "enabled" ||
      session.session_expires_at < ports.now() + durationMs + 30000
    ) {
      throw new StagingKaraokeParticipantFailed("scoring_or_session_unavailable", identity);
    }
    retention = session.scoring_policy.provider_retention;
    if (retention === "stored" && !input.allowStoredRetention) {
      throw new StagingKaraokeParticipantFailed("retention_not_approved", identity);
    }
    socket = await ports.openSocket(
      validateKaraokeSocket(session, ports.now()),
      (raw) => {
        try {
          if (typeof raw !== "string") throw new Error("not text");
          const event = Schema.decodeUnknownSync(Event)(JSON.parse(raw));
          if (
            event.sessionId !== session.id ||
            event.attemptId !== session.attempt ||
            event.sequence <= serverSequence ||
            eventIds.has(event.eventId)
          )
            throw new Error("identity/order");
          serverSequence = event.sequence;
          eventIds.add(event.eventId);
          if (event.type === "session_error") failure = "provider_or_session_error";
          if (event.type === "summary") summary = true;
          if (event.type === "provider_retention_changed") {
            if (event.provider_retention !== "stored") throw new Error("retention");
            retention = "stored";
            if (!input.allowStoredRetention) failure = "retention_not_approved";
          }
        } catch {
          failure = "invalid_server_event";
        }
      },
      () => {
        closed = true;
      },
    );
    send({ type: "start", postId: input.postId, startedAtAudioMs: 0 });
    let lineIndex = 0;
    const startedAt = ports.now();
    for (let start = 0, chunkId = 1; start < durationMs; start += 100, chunkId++) {
      if (failure || closed || ports.now() >= input.deadlineMs)
        throw new StagingKaraokeParticipantFailed(failure ?? "transport_interrupted", identity);
      const end = Math.min(start + 100, durationMs);
      await ports.sleep(Math.max(0, startedAt + end - ports.now()));
      if (failure || closed || ports.now() >= input.deadlineMs)
        throw new StagingKaraokeParticipantFailed(failure ?? "transport_interrupted", identity);
      socket.send(
        encodeKaraokeBinaryFrame({
          type: "audio_chunk",
          protocolVersion: 1,
          sessionId: session.id,
          attemptId: session.attempt,
          sequence: sequence++,
          chunkId,
          sampleRate: 16000,
          songStartMs: start,
          songEndMs: end,
          pcm16: input.pcm16.slice(start * 32, end * 32),
        }),
      );
      send({ type: "playback_sync", audioTimeMs: end, playing: true });
      while (lineIndex < readiness.karaoke_lines.length) {
        const line = readiness.karaoke_lines[lineIndex];
        if (!line || line.end_ms > end) break;
        send({
          type: "line_boundary",
          audioTimeMs: line.end_ms,
          lineId: line.id,
          lineIndex: line.index,
          scoredLineIndex: lineIndex,
        });
        lineIndex++;
      }
    }
    send({ type: "finish", audioTimeMs: durationMs });
    finishSent = true;
    const deadline = Math.min(session.session_expires_at, input.deadlineMs, ports.now() + 60000);
    for (let poll = 0; poll < 60 && ports.now() < deadline; poll++) {
      if (failure) throw new StagingKaraokeParticipantFailed(failure, identity);
      const persisted = await ports.getAttempt(session.attempt);
      if (persisted) {
        assertPersistedKaraokeAttempt(persisted, input, identity);
        return {
          attempt: persisted,
          replay: false,
          provider_retention: retention,
          summary_observed: summary,
        };
      }
      await ports.sleep(1000);
    }
    throw new StagingKaraokeParticipantFailed("finalization_unresolved", identity);
  } catch (error) {
    if (socket && !finishSent && !closed) {
      try {
        send({ type: "abort", code: "rehearsal_stopped" });
      } catch {
        /* Preserve the original failure and attempt identity. */
      }
    }
    throw error instanceof StagingKaraokeParticipantFailed
      ? error
      : new StagingKaraokeParticipantFailed("transport_or_persistence_failed", identity);
  } finally {
    socket?.close();
  }
}
