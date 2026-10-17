import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ActivityCompletionV1,
  ActivityProgressV1,
  activityCompletionRegistry,
} from "./activity-completion.ts";
import { generateClient, generateOpenApi } from "./codegen.ts";

const completion = {
  object: "activity_completion",
  community_id: "community",
  post_id: "song",
  persona_id: "persona",
  audio_revision: 3,
  attempt: { kind: "study", session_id: "session" },
  timezone: "America/New_York",
  day_semantics: "account_pinned_iana_timezone_v1",
  observed_at: "2026-10-16T02:00:00.000Z",
  decision: { status: "unknown", reason: "historical_decision_unavailable" },
} satisfies ActivityCompletionV1;
const progress = {
  object: "activity_progress",
  scope: { kind: "community", community_id: "community" },
  day_semantics: "account_pinned_iana_timezone_v1",
  observed_at: "2026-10-16T02:00:00.000Z",
  timezone: "America/New_York",
  timezone_pinned: true,
  today: "2026-10-15",
  week: {
    start_day: "2026-10-12",
    end_day: "2026-10-18",
    days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${12 + i}`, earned: false })),
  },
  counting_period: "all_recorded_qualifications",
  activity_counts: [
    { activity: "study", qualification_count: 0 },
    { activity: "karaoke", qualification_count: 0 },
  ],
  streak: { current: 0, best: 0, total_days: 0, started_day: null, last_day: null },
  standing: null,
};

describe("private activity completion contracts", () => {
  test("distinguishes unknown, pending, refused, terminal miss and a qualification-bound earning", () => {
    const decisions: ReadonlyArray<ActivityCompletionV1["decision"]> = [
      completion.decision,
      { status: "pending" },
      { status: "refused", reason: "activity_incomplete" },
      {
        status: "not_qualified",
        reason: "producer_not_qualified",
        decided_at: "2026-10-15T23:00:00.000Z",
      },
      {
        status: "qualified",
        qualification_id: "qualification",
        qualification_policy_version_id: "policy",
        qualified_at: "2026-10-15T23:00:00.000Z",
        streak_day: "2026-10-15",
        earned_day: {
          status: "recorded",
          signal_id: "qualification",
          song_day_newly_earned: true,
          community_day_newly_earned: false,
        },
      },
    ];
    for (const decision of decisions)
      expect(decision).toEqual(
        Schema.decodeUnknownSync(ActivityCompletionV1)({ ...completion, decision }).decision,
      );
    expect(() =>
      Schema.decodeUnknownSync(ActivityCompletionV1)({
        ...completion,
        decision: { status: "qualified", score_bps: 10_000, rank: 1 },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ActivityCompletionV1)({
        ...completion,
        decision: {
          status: "qualified",
          qualification_id: "exact-q",
          qualification_policy_version_id: "policy",
          qualified_at: "2026-10-15T23:00:00.000Z",
          streak_day: "2026-10-15",
          earned_day: {
            status: "recorded",
            signal_id: "other-q",
            song_day_newly_earned: true,
            community_day_newly_earned: true,
          },
        },
      }),
    ).toThrow();
  });
  test("accepts zero private progress and no standing; refuses fabricated calendar/count shapes", () => {
    expect(Schema.decodeUnknownSync(ActivityProgressV1)(progress).standing).toBeNull();
    for (const week of [
      { ...progress.week, days: progress.week.days.slice(0, 6) },
      { ...progress.week, days: progress.week.days.map(() => progress.week.days[0]) },
      { ...progress.week, end_day: "2026-10-19" },
      { ...progress.week, start_day: "2026-02-30" },
    ])
      expect(() => Schema.decodeUnknownSync(ActivityProgressV1)({ ...progress, week })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ActivityProgressV1)({
        ...progress,
        activity_counts: [progress.activity_counts[0], progress.activity_counts[0]],
      }),
    ).toThrow();
  });
  test("generates five authenticated no-store reads without private evidence or money fields", () => {
    const client = generateClient(activityCompletionRegistry);
    const openapi = JSON.stringify(generateOpenApi(activityCompletionRegistry));
    for (const [operation, contract] of Object.entries(activityCompletionRegistry)) {
      expect(client).toContain(operation);
      expect(contract.method).toBe("GET");
      expect(contract.cacheControl).toBe("private, no-store");
      expect(contract.auth.policy.kind).toBe("userOrAdmin");
    }
    for (const field of [
      "account_id",
      "wallet",
      "evidence_summary",
      "score_bps",
      "answer_text",
      "audio_ref",
    ]) {
      expect(openapi).not.toContain(`"${field}"`);
    }
    expect(() =>
      Schema.decodeUnknownSync(ActivityCompletionV1, { onExcessProperty: "error" })({
        ...completion,
        account_id: "secret",
      }),
    ).toThrow();
  });
});
