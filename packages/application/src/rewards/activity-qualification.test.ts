import { describe, expect, test } from "bun:test";
import type { StudySessionV1 } from "@pirate/contracts";
import { Effect } from "effect";
import { Clock, IdGen, StudyItemSource, StudyItemSourceError } from "../ports.ts";
import type { StudyItemSourceSetV1 } from "../study-item-source.ts";
import {
  type ActivityQualificationStore,
  makeActivityQualificationService,
} from "./activity-qualification.ts";

const activeSession: StudySessionV1 = {
  object: "study_session",
  session_id: "study_session_1",
  persona_id: "persona_1",
  community_id: "community_1",
  post_id: "post_1",
  audio_revision: 3,
  lyrics_revision: 2,
  source_revision: 4,
  qualification_policy_version_id: "study_session_first_pass_v2@1",
  status: "active",
  timezone: "UTC",
  streak_day: null,
  items: [
    {
      session_item_id: "study_item_1",
      ordinal: 0,
      source_identity: {
        community_id: "community_1",
        post_id: "post_1",
        audio_revision: 3,
        lyrics_revision: 2,
        source_revision: 4,
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
  source_revision: 4,
  provenance: {
    kind: "accepted_song_lyrics",
    producer_id: "study-producer",
    producer_revision: "prompt-policy-v2",
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

const storeWith = (overrides: Partial<ActivityQualificationStore>): ActivityQualificationStore => ({
  prepareStudySessionStart: unexpected,
  createStudySession: unexpected,
  getStudySession: unexpected,
  submitStudyAnswer: unexpected,
  setStreakTimezone: unexpected,
  setPresentationPersona: unexpected,
  getSongLeaderboard: unexpected,
  getCommunityLeaderboard: unexpected,
  ...overrides,
});

const services = (ids: string[], sourceService: StudyItemSource["Service"]) =>
  [
    Effect.provideService(Clock, { now: Effect.succeed(Date.parse("2026-08-25T12:00:00.000Z")) }),
    Effect.provideService(IdGen, {
      next: Effect.sync(() => {
        const id = ids.shift();
        if (id === undefined) throw new Error("fake id sequence exhausted");
        return id;
      }),
    }),
    Effect.provideService(StudyItemSource, sourceService),
  ] as const;

const startInput = {
  accountId: "account_1",
  communityId: "community_1",
  idempotencyKey: "start_1",
  personaId: "persona_1",
  postId: "post_1",
  requestedTimezone: "UTC",
} as const;

describe("activity qualification application service", () => {
  test("binds a server-only Study source snapshot before creating a session", async () => {
    const created: unknown[] = [];
    const calls: unknown[] = [];
    const service = makeActivityQualificationService(
      storeWith({
        prepareStudySessionStart: () =>
          Effect.succeed({ kind: "ready", audioRevision: 3, lyricsRevision: 2, timezone: "UTC" }),
        createStudySession: (input) => {
          created.push(input);
          return Effect.succeed(activeSession);
        },
      }),
    );
    const sourceService: StudyItemSource["Service"] = {
      getForAcceptedSongRevision: (input) => {
        calls.push(input);
        return Effect.succeed(source);
      },
    };
    const program = service
      .startStudySession(startInput)
      .pipe(...services(["session-raw", "item-raw"], sourceService));

    await expect(Effect.runPromise(program)).resolves.toEqual(activeSession);
    expect(calls).toEqual([
      { communityId: "community_1", postId: "post_1", audioRevision: 3, lyricsRevision: 2 },
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      sessionId: "study_session_session-raw",
      itemIds: ["study_item_item-raw"],
      source,
      sourceSnapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(activeSession)).not.toContain("answer_key");
  });

  test("returns an idempotent replay without resolving or minting another source", async () => {
    let sourceCalls = 0;
    const service = makeActivityQualificationService(
      storeWith({
        prepareStudySessionStart: () =>
          Effect.succeed({ kind: "replayed", session: activeSession }),
      }),
    );
    const sourceService: StudyItemSource["Service"] = {
      getForAcceptedSongRevision: () => {
        sourceCalls += 1;
        return Effect.succeed(source);
      },
    };
    const output = await Effect.runPromise(
      service.startStudySession(startInput).pipe(...services([], sourceService)),
    );
    expect(output).toEqual(activeSession);
    expect(sourceCalls).toBe(0);
  });

  test("maps typed source failure to a closed public rejection", async () => {
    const service = makeActivityQualificationService(
      storeWith({
        prepareStudySessionStart: () =>
          Effect.succeed({ kind: "ready", audioRevision: 3, lyricsRevision: 2, timezone: "UTC" }),
      }),
    );
    const sourceService: StudyItemSource["Service"] = {
      getForAcceptedSongRevision: () =>
        Effect.fail(new StudyItemSourceError({ reason: "unavailable" })),
    };
    await expect(
      Effect.runPromise(service.startStudySession(startInput).pipe(...services([], sourceService))),
    ).rejects.toMatchObject({
      _tag: "ActivityQualificationRejected",
      reason: "source-unavailable",
    });
  });

  test("creates answer and qualification identities only on the server", async () => {
    const submissions: unknown[] = [];
    const service = makeActivityQualificationService(
      storeWith({
        submitStudyAnswer: (input) => {
          submissions.push(input);
          return Effect.succeed({
            object: "study_answer_result",
            session_item_id: "study_item_1",
            attempt_number: 1,
            outcome: "correct",
            first_pass: true,
            session: activeSession,
          });
        },
      }),
    );
    const sourceService: StudyItemSource["Service"] = {
      getForAcceptedSongRevision: () => Effect.succeed(source),
    };
    await Effect.runPromise(
      service
        .submitStudyAnswer({
          accountId: "account_1",
          answer: { kind: "text_response", text: "Sail away" },
          attemptNumber: 1,
          communityId: "community_1",
          idempotencyKey: "answer_1",
          sessionId: "study_session_1",
          sessionItemId: "study_item_1",
        })
        .pipe(...services(["answer-raw", "qualification-raw"], sourceService)),
    );
    expect(submissions[0]).toMatchObject({
      answerId: "study_answer_answer-raw",
      qualificationId: "qualification_qualification-raw",
      answeredAt: "2026-08-25T12:00:00.000Z",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });
});
