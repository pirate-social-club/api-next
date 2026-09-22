import { describe, expect, test } from "bun:test";
import type { KaraokeAttempt, KaraokeReadiness, KaraokeSession } from "@pirate/contracts";
import {
  runStagingKaraokeParticipant,
  type StagingKaraokePorts,
  validateKaraokeSocket,
} from "./staging-karaoke-participant.ts";

const line = (index: number) => ({
  id: `line-${index}`,
  index,
  kind: "lyric" as const,
  text: "line",
  start_ms: index * 100,
  end_ms: (index + 1) * 100,
  words: [{ text: "line", start_ms: index * 100, end_ms: (index + 1) * 100 }] as const,
});
const readiness: Extract<KaraokeReadiness, { state: "ready" }> = {
  state: "ready",
  object: "song_karaoke_payload",
  community_id: "community",
  post_id: "song",
  title: "Fixture",
  karaoke_revision_id: "revision",
  playback_audio: { kind: "full_mix", ref: "fixture" },
  playback_kind: "full_mix",
  karaoke_lines: [line(0), ...[1, 2, 3, 4].map(line)],
};
const session: KaraokeSession = {
  id: "session",
  object: "karaoke_session",
  attempt: "attempt",
  persona_id: "persona",
  protocol_version: 1,
  websocket_url: "wss://api-next-staging.pirate.sc/karaoke/realtime/session?token=private",
  token_expires_at: 10000,
  session_expires_at: 100000,
  scoring_policy: {
    kind: "enabled",
    provider: "elevenlabs",
    model: "fixture",
    provider_retention: "not_stored",
    platform_retention: "private_learning",
  },
};
const attempt: KaraokeAttempt = {
  id: "attempt",
  object: "karaoke_attempt",
  session_id: "session",
  attempt_id: "attempt",
  persona_id: "persona",
  post_id: "song",
  community_id: "community",
  karaoke_revision_id: "revision",
  scoring_version: 1,
  scoring_provider: "elevenlabs",
  scoring_model: "fixture",
  final_score: 7000,
  lyrics_score: 7000,
  timing_score: null,
  timing_trend: "on_time",
  scored_line_count: 5,
  line_count: 5,
  uncertain_line_count: 0,
  no_recognition_line_count: 0,
  low_confidence_line_count: 0,
  completion_reason: "completed",
  rank_eligible: true,
  activity_date: "2026-09-21",
  completed_at: "2026-09-21T10:00:00Z",
  created_at: "2026-09-21T10:00:00Z",
  recording_state: "stored",
};
const input = () => ({
  communityId: "community",
  postId: "song",
  personaId: "persona",
  readiness,
  pcm16: new ArrayBuffer(16000),
  durationMs: 500,
  allowStoredRetention: false,
  deadlineMs: 90000,
});
function harness() {
  let now = 0;
  let created = 0;
  let saved = false;
  let closed = false;
  let listener: (data: unknown) => void = () => {};
  const sent: (string | ArrayBuffer)[] = [];
  const ports: StagingKaraokePorts = {
    createAttempt: async () => {
      created++;
      return session;
    },
    getAttempt: async () => attempt,
    recordAttempt: async () => {
      saved = true;
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    openSocket: async (_url, onMessage) => {
      expect(saved).toBe(true);
      listener = onMessage;
      return {
        send: (data) => sent.push(data),
        close: () => {
          closed = true;
        },
      };
    },
  };
  return {
    ports,
    sent,
    emit: (type: string) =>
      listener(
        JSON.stringify({
          protocolVersion: 1,
          sessionId: "session",
          attemptId: "attempt",
          sequence: 0,
          eventId: "event",
          type,
        }),
      ),
    state: () => ({ now, created, saved, closed }),
  };
}
describe("staging Karaoke participant transport", () => {
  test("journals identity before connect, paces PCM, finishes, and requires persisted score", async () => {
    const h = harness();
    expect(await runStagingKaraokeParticipant(input(), h.ports)).toMatchObject({
      replay: false,
      attempt: { final_score: 7000 },
    });
    expect(h.state()).toEqual({ now: 500, created: 1, saved: true, closed: true });
    expect(h.sent.filter((event) => event instanceof ArrayBuffer)).toHaveLength(5);
    const events = h.sent
      .filter((event): event is string => typeof event === "string")
      .map((event) => JSON.parse(event));
    expect(events[0]).toMatchObject({ type: "start", sequence: 0 });
    expect(events.at(-1)).toMatchObject({ type: "finish", sequence: 16 });
    expect(events.filter((event) => event.type === "line_boundary")).toHaveLength(5);
  });
  test("rejects score or revision mismatch even when transport completes", async () => {
    for (const changed of [
      { ...attempt, final_score: 6999 },
      { ...attempt, scored_line_count: 4 },
      { ...attempt, karaoke_revision_id: "wrong" },
    ]) {
      const h = harness();
      await expect(
        runStagingKaraokeParticipant(input(), { ...h.ports, getAttempt: async () => changed }),
      ).rejects.toThrow("not_qualified");
      expect(h.state().closed).toBe(true);
    }
  });
  test("resume reads a persisted attempt, never reuses token or reserves again", async () => {
    const h = harness();
    const previousAttempt = { session_id: "session", attempt_id: "attempt" };
    expect(
      await runStagingKaraokeParticipant({ ...input(), previousAttempt }, h.ports),
    ).toMatchObject({ replay: true });
    expect(h.state().created).toBe(0);
    await expect(
      runStagingKaraokeParticipant(
        { ...input(), previousAttempt },
        { ...h.ports, getAttempt: async () => null },
      ),
    ).rejects.toThrow("previous_attempt_unresolved");
    expect(h.state().created).toBe(0);
  });
  test("a summary without persisted finalization remains unresolved", async () => {
    const h = harness();
    const sleep = h.ports.sleep;
    await expect(
      runStagingKaraokeParticipant(input(), {
        ...h.ports,
        getAttempt: async () => null,
        sleep: async (ms) => {
          await sleep(ms);
          if (h.state().now === 100) h.emit("summary");
        },
      }),
    ).rejects.toThrow("finalization_unresolved");
    expect(h.state().created).toBe(1);
  });
  test("provider error aborts and does not retry", async () => {
    const h = harness();
    const sleep = h.ports.sleep;
    await expect(
      runStagingKaraokeParticipant(input(), {
        ...h.ports,
        sleep: async (ms) => {
          await sleep(ms);
          h.emit("session_error");
        },
      }),
    ).rejects.toThrow("provider_or_session_error");
    expect(h.state()).toMatchObject({ created: 1, closed: true });
    expect(JSON.parse(String(h.sent.at(-1))).type).toBe("abort");
  });
  test("rejects retention without consent and invalid socket URLs", async () => {
    const h = harness();
    await expect(
      runStagingKaraokeParticipant(input(), {
        ...h.ports,
        createAttempt: async () => ({
          ...session,
          scoring_policy: {
            kind: "enabled",
            provider: "elevenlabs",
            model: "fixture",
            provider_retention: "stored",
            platform_retention: "private_learning",
          },
        }),
      }),
    ).rejects.toThrow("retention_not_approved");
    for (const websocket_url of [
      "wss://elsewhere.invalid/karaoke/realtime/session?token=private",
      `${session.websocket_url}&token=other`,
      `${session.websocket_url}#fragment`,
    ])
      expect(() => validateKaraokeSocket({ ...session, websocket_url }, 0)).toThrow(
        "invalid_socket",
      );
    expect(() => validateKaraokeSocket({ ...session, token_expires_at: 1 }, 0)).toThrow(
      "invalid_socket",
    );
  });
});
