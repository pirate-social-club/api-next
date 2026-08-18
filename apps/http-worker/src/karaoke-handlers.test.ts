import { describe, expect, it } from "bun:test";
import type { KaraokeAttempt, KaraokeSession, KaraokeSongLeaderboard } from "@pirate/contracts";
import { makeKaraokeHandlers } from "./karaoke-handlers.ts";
import type { DecodedRequest } from "./transport.ts";

const session: KaraokeSession = {
  attempt: "attempt-1",
  id: "session-1",
  object: "karaoke_session",
  protocol_version: 1,
  scoring_policy: { kind: "disabled" },
  session_expires_at: 2,
  token_expires_at: 1,
  websocket_url: "wss://example.test/karaoke",
};

const leaderboard: KaraokeSongLeaderboard = {
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
};

const attempt: KaraokeAttempt = {
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
};

const request = (overrides: Partial<DecodedRequest> = {}): DecodedRequest => ({
  body: { timezone: "UTC" },
  headers: { "idempotency-key": "idem-1" },
  params: { communityId: "community-1", postId: "post-1" },
  principal: { kind: "user", subject: "user-1" },
  query: {},
  ...overrides,
});

describe("karaoke HTTP handlers", () => {
  it("creates an attempt through the injected use-case port", async () => {
    const calls: unknown[] = [];
    const handlers = makeKaraokeHandlers({
      createAttempt: async (input) => {
        calls.push(input);
        return session;
      },
      getAttempt: async () => attempt,
      getLeaderboard: async () => leaderboard,
    });

    const result = await handlers.CreateKaraokeAttempt(request());
    expect(calls).toEqual([
      {
        communityId: "community-1",
        idempotencyKey: "idem-1",
        postId: "post-1",
        timezone: "UTC",
        userId: "user-1",
      },
    ]);
    expect(result).toMatchObject({ body: session, status: 201 });
  });

  it("passes authenticated attempt and bounded leaderboard queries through", async () => {
    const calls: unknown[] = [];
    const handlers = makeKaraokeHandlers({
      createAttempt: async () => session,
      getAttempt: async (input) => {
        calls.push(input);
        return attempt;
      },
      getLeaderboard: async (input) => {
        calls.push(input);
        return leaderboard;
      },
    });

    await handlers.GetKaraokeAttempt(
      request({
        params: { attemptId: "attempt-1", communityId: "community-1" },
      }),
    );
    await handlers.GetKaraokeLeaderboard(
      request({
        query: { limit: "25" },
      }),
    );
    expect(calls).toEqual([
      { attemptId: "attempt-1", communityId: "community-1", userId: "user-1" },
      { communityId: "community-1", limit: 25, postId: "post-1", userId: "user-1" },
    ]);
  });

  it("rejects invalid leaderboard limits before calling storage", async () => {
    let called = false;
    const handlers = makeKaraokeHandlers({
      createAttempt: async () => session,
      getAttempt: async () => attempt,
      getLeaderboard: async () => {
        called = true;
        return leaderboard;
      },
    });

    await expect(
      handlers.GetKaraokeLeaderboard(request({ query: { limit: "101" } })),
    ).rejects.toMatchObject({
      _tag: "BadRequest",
    });
    expect(called).toBe(false);
  });

  it("rejects unauthenticated attempt reads before calling storage", async () => {
    let called = false;
    const handlers = makeKaraokeHandlers({
      createAttempt: async () => session,
      getAttempt: async () => {
        called = true;
        return attempt;
      },
      getLeaderboard: async () => leaderboard,
    });

    await expect(
      handlers.GetKaraokeAttempt(
        request({
          params: { attemptId: "attempt-1", communityId: "community-1" },
          principal: null,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "AuthError" });
    expect(called).toBe(false);
  });

  it("returns not found when the attempt port has no result", async () => {
    const handlers = makeKaraokeHandlers({
      createAttempt: async () => session,
      getAttempt: async () => null,
      getLeaderboard: async () => leaderboard,
    });

    await expect(
      handlers.GetKaraokeAttempt(
        request({
          params: { attemptId: "missing-attempt", communityId: "community-1" },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "NotFound" });
  });

  it("rejects missing or blank idempotency keys before creating an attempt", async () => {
    let called = false;
    const handlers = makeKaraokeHandlers({
      createAttempt: async () => {
        called = true;
        return session;
      },
      getAttempt: async () => attempt,
      getLeaderboard: async () => leaderboard,
    });

    for (const headers of [{}, { "idempotency-key": "   " }]) {
      await expect(handlers.CreateKaraokeAttempt(request({ headers }))).rejects.toMatchObject({
        _tag: "BadRequest",
      });
    }
    expect(called).toBe(false);
  });
});
