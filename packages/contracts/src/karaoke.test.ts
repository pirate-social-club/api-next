import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  KaraokeAttempt,
  KaraokeAttemptCreate,
  type KaraokeClientEvent,
  KaraokeScoringPolicy,
  KaraokeSession,
  KaraokeSongLeaderboard,
} from "./karaoke.ts";

describe("karaoke contracts", () => {
  it("requires the not_stored retention policy for enabled scoring", () => {
    const decode = Schema.decodeUnknownSync(KaraokeScoringPolicy);
    expect(
      decode({ kind: "enabled", model: "model", provider: "openai", retention: "not_stored" }),
    ).toEqual({
      kind: "enabled",
      model: "model",
      provider: "openai",
      retention: "not_stored",
    });
    expect(() =>
      decode({ kind: "enabled", model: "model", provider: "openai", retention: "stored" }),
    ).toThrow();
  });

  it("decodes attempt/session/leaderboard shapes without audio fields", () => {
    const decodeSession = Schema.decodeUnknownSync(KaraokeSession);
    const decodeAttempt = Schema.decodeUnknownSync(KaraokeAttempt);
    const decodeCreate = Schema.decodeUnknownSync(KaraokeAttemptCreate);
    const decodeLeaderboard = Schema.decodeUnknownSync(KaraokeSongLeaderboard);

    expect(decodeCreate({ persona_id: "persona-1", timezone: "UTC" })).toEqual({
      persona_id: "persona-1",
      timezone: "UTC",
    });
    expect(decodeCreate({ timezone: "UTC" })).toEqual({ timezone: "UTC" });
    expect(
      decodeSession({
        attempt: "attempt-1",
        id: "session-1",
        object: "karaoke_session",
        persona_id: "persona-1",
        protocol_version: 1,
        scoring_policy: { kind: "disabled" },
        session_expires_at: 2,
        token_expires_at: 1,
        websocket_url: "wss://example.test/karaoke",
      }).object,
    ).toBe("karaoke_session");
    expect(
      decodeAttempt({
        activity_date: "2026-08-18",
        attempt_id: "attempt-1",
        community_id: "community-1",
        completed_at: "2026-08-18T00:00:00.000Z",
        completion_reason: "completed",
        created_at: "2026-08-18T00:00:00.000Z",
        final_score: 9000,
        id: "row-1",
        karaoke_revision_id: "revision-1",
        line_count: 10,
        low_confidence_line_count: 0,
        lyrics_score: 9200,
        no_recognition_line_count: 0,
        object: "karaoke_attempt",
        persona_id: "persona-1",
        post_id: "post-1",
        rank_eligible: true,
        scored_line_count: 10,
        scoring_model: "model",
        scoring_provider: "openai",
        scoring_version: 5,
        session_id: "session-1",
        timing_score: 8800,
        timing_trend: "on_time",
        uncertain_line_count: 0,
      }).object,
    ).toBe("karaoke_attempt");
    expect(
      decodeLeaderboard({
        community_id: "community-1",
        entries: [],
        karaoke_revision_id: "revision-1",
        object: "karaoke_song_leaderboard",
        post_id: "post-1",
        scope: "all_time",
        scoring_model: "model",
        scoring_provider: "openai",
        scoring_version: 5,
        total_ranked: 0,
        viewer_best_reached_at: null,
        viewer_best_score: null,
        viewer_eligible_attempt_count: 0,
        viewer_rank: null,
        viewer_top_percent: null,
      }).object,
    ).toBe("karaoke_song_leaderboard");
  });

  it("keeps the client event union aligned to the runtime protocol", () => {
    const clientEvent: KaraokeClientEvent = {
      attemptId: "attempt-1",
      audioTimeMs: 1200,
      playing: true,
      protocolVersion: 1,
      sequence: 1,
      sessionId: "session-1",
      type: "playback_sync",
    };
    expect(clientEvent.type).toBe("playback_sync");
  });
});
