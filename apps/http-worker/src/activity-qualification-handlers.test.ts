import { describe, expect, test } from "bun:test";
import type { ActivityQualificationStore, StudyItemSourceSetV1 } from "@pirate/application";
import type { ActivityStreakLeaderboardV1, StudySessionV1 } from "@pirate/contracts";
import { Effect } from "effect";
import { makeActivityQualificationHandlers } from "./activity-qualification-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const activeSession: StudySessionV1 = {
  object: "study_session",
  session_id: "study_session_server",
  persona_id: "persona_1",
  community_id: "community_1",
  post_id: "post_1",
  audio_revision: 3,
  lyrics_revision: 2,
  source_revision: 1,
  qualification_policy_version_id: "study_session_first_pass_v2@1",
  status: "active",
  timezone: "UTC",
  streak_day: null,
  items: [
    {
      session_item_id: "study_item_server",
      ordinal: 0,
      source_identity: {
        community_id: "community_1",
        post_id: "post_1",
        audio_revision: 3,
        lyrics_revision: 2,
        source_revision: 1,
        source_item_key: "line-1",
      },
      prompt: { kind: "text_response", text: "Repeat the line" },
      presentation_count: 1,
      answer_count: 0,
      first_pass_outcome: null,
    },
  ],
  progress: {
    qualifying_exercise_count: 1,
    answered_exercise_count: 0,
    first_pass_correct: 0,
    required_correct: 1,
    score_bps: null,
  },
  qualification: null,
  created_at: "2026-08-25T12:00:00.000Z",
  completed_at: null,
};

const source: StudyItemSourceSetV1 = {
  version: "study_item_source_v1",
  song_revision: {
    community_id: "community_1",
    post_id: "post_1",
    audio_revision: 3,
    lyrics_revision: 2,
  },
  source_revision: 1,
  provenance: {
    kind: "accepted_song_lyrics",
    producer_id: "study-producer",
    producer_revision: "prompt-policy-v1",
  },
  items: [
    {
      source_item_key: "line-1",
      prompt: { kind: "text_response", text: "Repeat the line" },
      answer_key: {
        kind: "text_response",
        comparison: "unicode_casefold_whitespace_v1",
        accepted_answers: ["Sail away"],
      },
    },
  ],
};

const unexpected = (): never => {
  throw new Error("unexpected fake-store call");
};

const leaderboard = (accountId: string | null): ActivityStreakLeaderboardV1 => {
  const entry = {
    rank: 1,
    current: 2,
    best: 3,
    started_day: "2026-08-24",
    last_day: "2026-08-25",
    total_days: 3,
    persona: {
      persona_id: "persona_1",
      object: "persona" as const,
      display_name: "Singer",
      avatar_ref: null,
      primary_public_handle: "singer.pirate",
    },
    is_viewer: accountId === "account_1",
  };
  return {
    object: "activity_streak_leaderboard",
    scope: { kind: "song", community_id: "community_1", post_id: "post_1" },
    day_semantics: "account_pinned_iana_timezone_v1",
    entries: [entry],
    viewer_standing: entry.is_viewer ? entry : null,
  };
};

function testWorker() {
  let answerCalls = 0;
  let createdInput: unknown;
  const store: ActivityQualificationStore = {
    prepareStudySessionStart: () =>
      Effect.succeed({
        kind: "ready",
        audioRevision: 3,
        lyricsRevision: 2,
        timezone: "UTC",
      }),
    createStudySession: (input) => {
      createdInput = input;
      return Effect.succeed(activeSession);
    },
    getStudySession: () => Effect.succeed(activeSession),
    submitStudyAnswer: () => {
      answerCalls += 1;
      return unexpected();
    },
    setStreakTimezone: unexpected,
    setPresentationPersona: unexpected,
    getSongLeaderboard: ({ accountId }) => Effect.succeed(leaderboard(accountId)),
    getCommunityLeaderboard: unexpected,
  };
  const ids = ["session", "item"];
  const handlers = makeActivityQualificationHandlers({
    clock: { now: Effect.succeed(Date.parse("2026-08-25T12:00:00.000Z")) },
    ids: {
      next: Effect.sync(() => {
        const id = ids.shift();
        if (id === undefined) throw new Error("identifier sequence exhausted");
        return id;
      }),
    },
    store,
    studyItemSource: { getForAcceptedSongRevision: () => Effect.succeed(source) },
  });
  const worker = createHttpWorker({
    config: { corsOrigin: "https://app.pirate.test" },
    handlers,
    authenticate: () => ({ kind: "user", subject: "account_1" }),
    authorize: () => undefined,
  });
  return {
    worker,
    answerCalls: () => answerCalls,
    createdInput: () => createdInput,
  };
}

describe("activity qualification HTTP handlers", () => {
  test("starts a server-bound session and marks the credential-bearing response no-store", async () => {
    const fixture = testWorker();
    const response = await fixture.worker.request(
      "/communities/community_1/posts/post_1/study/sessions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: "start-1",
          persona_id: "persona_1",
          timezone: "UTC",
        }),
      },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(activeSession);
    expect(fixture.createdInput()).toMatchObject({
      accountId: "account_1",
      sessionId: "study_session_session",
      itemIds: ["study_item_item"],
    });
  });

  test("rejects browser-supplied scores before the answer handler", async () => {
    const fixture = testWorker();
    const response = await fixture.worker.request(
      "/communities/community_1/study/sessions/session_1/items/item_1/answers",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: "answer-1",
          attempt_number: 1,
          answer: { kind: "text_response", text: "Sail away" },
          score_bps: 10_000,
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(fixture.answerCalls()).toBe(0);
  });

  test("keeps optional-user leaderboards no-store and viewer standing credential-private", async () => {
    const fixture = testWorker();
    const path = "/communities/community_1/posts/post_1/rewards/leaderboard";
    const anonymous = await fixture.worker.request(path);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    expect(await anonymous.json()).toMatchObject({ viewer_standing: null });

    const viewer = await fixture.worker.request(path, {
      headers: { authorization: "Bearer test" },
    });
    expect(viewer.status).toBe(200);
    expect(viewer.headers.get("cache-control")).toBe("no-store");
    expect(await viewer.json()).toMatchObject({
      viewer_standing: { is_viewer: true, persona: { persona_id: "persona_1" } },
    });
  });

  test("advertises PUT for streak and presentation preflights", async () => {
    const fixture = testWorker();
    const response = await fixture.worker.request("/rewards/streak-timezone", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.pirate.test",
        "access-control-request-method": "PUT",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
  });
});
