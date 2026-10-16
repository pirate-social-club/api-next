import { describe, expect, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import { Effect, Layer } from "effect";
import { makeControlPlaneActivityCompletionRepository } from "./activity-completion-repository.ts";

const identity = {
  accountId: "account",
  communityId: "community",
  readAt: "2026-10-16T02:00:00.000Z",
};
const source = {
  session_id: "session",
  attempt_id: null,
  account_id: "account",
  persona_id: "persona",
  community_id: "community",
  post_id: "song",
  audio_revision: 3,
  timezone: "America/New_York",
  status: "completed",
  completed_at: "2026-10-15T23:00:00.000Z",
  completion_reason: null,
  qualification_id: null,
  decision_outcome: null,
  decided_at: null,
  song_first: null,
  community_first: null,
};
const harness = (rows: readonly Record<string, unknown>[]) => {
  const statements: ControlPlaneStatement[] = [];
  const execute: ControlPlaneDb["Service"]["execute"] = (statement) => {
    statements.push(statement);
    return Effect.succeed({ rows, rowCount: rows.length }) as never;
  };
  return {
    statements,
    layer: Layer.succeed(ControlPlaneDb, { execute, withTransaction: (use) => use({ execute }) }),
  };
};
const repository = makeControlPlaneActivityCompletionRepository();
const completionInput = {
  ...identity,
  activity: "study" as const,
  sessionId: "session",
  attemptId: null,
};

describe("authoritative activity reads", () => {
  test("historical absence stays unknown; explicit producer absence is terminal; an active attempt stays pending", async () => {
    for (const [override, status] of [
      [{}, "unknown"],
      [{ decision_outcome: "not_qualified", decided_at: source.completed_at }, "not_qualified"],
      [{ status: "active" }, "pending"],
      [{ status: "cancelled" }, "refused"],
    ] as const) {
      const { layer, statements } = harness([{ ...source, ...override }]);
      const state = await Effect.runPromise(
        repository.getCompletion(completionInput).pipe(Effect.provide(layer)),
      );
      expect(state.decision.status).toBe(status);
      expect(statements).toHaveLength(1);
      expect(statements[0]?.readonly).toBe(true);
      expect(statements[0]?.values).toEqual(["account", "community", "session"]);
    }
  });
  test("earning identifies the first qualification independently for each scope and replays unchanged", async () => {
    const { layer, statements } = harness([
      {
        ...source,
        qualification_id: "q2",
        qualification_policy_version_id: "policy",
        qualified_at: source.completed_at,
        streak_day: "2026-10-15",
        song_first: "q2",
        community_first: "q1",
      },
    ]);
    const read = () =>
      Effect.runPromise(repository.getCompletion(completionInput).pipe(Effect.provide(layer)));
    const first = await read();
    expect(first.decision).toMatchObject({
      status: "qualified",
      earned_day: {
        status: "recorded",
        signal_id: "q2",
        song_day_newly_earned: true,
        community_day_newly_earned: false,
      },
    });
    expect(await read()).toEqual(first);
    expect(statements.every((statement) => statement.readonly)).toBe(true);
  });
  test("Karaoke read binds both attempt and session plus exact qualification identity and lifecycle guards", async () => {
    const { layer, statements } = harness([]);
    await expect(
      Effect.runPromise(
        repository
          .getCompletion({ ...completionInput, activity: "karaoke", attemptId: "attempt" })
          .pipe(Effect.provide(layer)),
      ),
    ).rejects.toMatchObject({ reason: "not-found" });
    expect(statements[0]?.values).toEqual(["account", "community", "session", "attempt"]);
    for (const guard of [
      "q.account_id=s.account_id",
      "q.persona_id=s.persona_id",
      "q.audio_revision=s.audio_revision",
      "q.karaoke_session_id=s.session_id",
      "q.karaoke_attempt_id=s.attempt_id",
      "active_activity_persona",
      "can_account_access_activity_song",
    ]) {
      expect(statements[0]?.text).toContain(guard);
    }
  });
  test("a qualification with missing historic day evidence never invents an earning signal", async () => {
    const { layer } = harness([
      {
        ...source,
        qualification_id: "historical-q",
        qualification_policy_version_id: "policy",
        qualified_at: source.completed_at,
        streak_day: "2026-10-15",
        song_first: "historical-q",
        community_first: null,
      },
    ]);
    const read = await Effect.runPromise(
      repository.getCompletion(completionInput).pipe(Effect.provide(layer)),
    );
    expect(read.decision).toMatchObject({
      status: "qualified",
      earned_day: { status: "unavailable" },
    });
  });
  test("private progress preserves expired history and real zero counts without a public standing", async () => {
    const row = {
      timezone: "America/New_York",
      timezone_pinned: true,
      today: "2026-10-15",
      start_day: "2026-10-12",
      end_day: "2026-10-18",
      current_count: 2,
      best_count: 4,
      total_days: 6,
      started_day: "2026-10-01",
      last_day: "2026-10-02",
      alive: false,
      rank: null,
      standing_persona_id: null,
      days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${12 + i}`, earned: false })),
      study_count: "9",
      karaoke_count: "0",
    };
    const { layer, statements } = harness([row]);
    const progress = await Effect.runPromise(
      repository.getProgress({ ...identity, postId: null }).pipe(Effect.provide(layer)),
    );
    expect(progress.streak).toEqual({
      current: 0,
      best: 4,
      total_days: 6,
      started_day: "2026-10-01",
      last_day: "2026-10-02",
    });
    expect(progress.standing).toBeNull();
    expect(progress.activity_counts).toEqual([
      { activity: "study", qualification_count: 9 },
      { activity: "karaoke", qualification_count: 0 },
    ]);
    expect(statements[0]?.readonly).toBe(true);
  });
  test("presentation lookup works without ranking and hides an ineligible selection", async () => {
    for (const [row, selection] of [
      [{ persona_id: null, updated_at: null, eligible: false }, { status: "unset" }],
      [
        { persona_id: "retired-private-persona", updated_at: source.completed_at, eligible: false },
        { status: "unavailable" },
      ],
      [
        { persona_id: "persona", updated_at: source.completed_at, eligible: true },
        {
          status: "selected",
          presentation: {
            object: "activity_presentation",
            community_id: "community",
            persona_id: "persona",
            updated_at: source.completed_at,
          },
        },
      ],
    ] as const) {
      const { layer } = harness([row]);
      const state = await Effect.runPromise(
        repository.getPresentation(identity).pipe(Effect.provide(layer)),
      );
      expect(state.selection).toEqual(selection);
    }
  });
});
