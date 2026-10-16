import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, NotFound } from "./errors.ts";
import { ActivityPresentationV1, PersonaIdV1 } from "./personas.ts";

const Id = Schema.NonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.makeFilter((value) =>
    value === value.trim() &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
      ? undefined
      : "Expected a bounded identifier",
  ),
);
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Instant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical instant";
  }),
);
const Day = Schema.String.check(
  Schema.makeFilter((value) =>
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
      ? undefined
      : "Expected a calendar date",
  ),
);
const Timezone = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return undefined;
    } catch {
      return "Expected an IANA timezone";
    }
  }),
);

export const ActivityProgressScopeV1 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("song"), community_id: Id, post_id: Id }),
  Schema.Struct({ kind: Schema.Literal("community"), community_id: Id }),
]);
export type ActivityProgressScopeV1 = Schema.Schema.Type<typeof ActivityProgressScopeV1>;

const Attempt = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("study"), session_id: Id }),
  Schema.Struct({ kind: Schema.Literal("karaoke"), session_id: Id, attempt_id: Id }),
]);
const EarnedDay = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("recorded"),
    signal_id: Id,
    song_day_newly_earned: Schema.Boolean,
    community_day_newly_earned: Schema.Boolean,
  }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
const Decision = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("qualified"),
    qualification_id: Id,
    qualification_policy_version_id: Id,
    qualified_at: Instant,
    streak_day: Day,
    earned_day: EarnedDay,
  }),
  Schema.Struct({
    status: Schema.Literal("not_qualified"),
    reason: Schema.Literal("producer_not_qualified"),
    decided_at: Instant,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal("activity_incomplete"),
  }),
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({
    status: Schema.Literal("unknown"),
    reason: Schema.Literal("historical_decision_unavailable"),
  }),
]);

/** A current private read. Never added to, or substituted for, an old command receipt. */
export const ActivityCompletionV1 = Schema.Struct({
  object: Schema.Literal("activity_completion"),
  community_id: Id,
  post_id: Id,
  persona_id: PersonaIdV1,
  audio_revision: Positive,
  attempt: Attempt,
  timezone: Timezone,
  day_semantics: Schema.Literal("account_pinned_iana_timezone_v1"),
  observed_at: Instant,
  decision: Decision,
}).check(
  Schema.makeFilter((value) => {
    if (value.decision.status !== "qualified") return undefined;
    if (
      value.decision.earned_day.status === "recorded" &&
      value.decision.earned_day.signal_id !== value.decision.qualification_id
    ) {
      return "Earned-day signal must identify its exact qualification";
    }
    const parts = new Map(
      new Intl.DateTimeFormat("en-US", {
        timeZone: value.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(new Date(value.decision.qualified_at))
        .map((part) => [part.type, part.value]),
    );
    return value.decision.streak_day ===
      `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`
      ? undefined
      : "Qualification day must use the accepted session timezone";
  }),
);
export type ActivityCompletionV1 = Schema.Schema.Type<typeof ActivityCompletionV1>;

const DayMark = Schema.Struct({ day: Day, earned: Schema.Boolean });
export const ActivityProgressV1 = Schema.Struct({
  object: Schema.Literal("activity_progress"),
  scope: ActivityProgressScopeV1,
  observed_at: Instant,
  day_semantics: Schema.Literal("account_pinned_iana_timezone_v1"),
  timezone: Timezone,
  timezone_pinned: Schema.Boolean,
  today: Day,
  week: Schema.Struct({
    start_day: Day,
    end_day: Day,
    days: Schema.Array(DayMark).check(Schema.isMinLength(7), Schema.isMaxLength(7)),
  }),
  counting_period: Schema.Literal("all_recorded_qualifications"),
  activity_counts: Schema.Array(
    Schema.Struct({ activity: Schema.Literals(["study", "karaoke"]), qualification_count: Count }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
  streak: Schema.Struct({
    current: Count,
    best: Count,
    total_days: Count,
    started_day: Schema.NullOr(Day),
    last_day: Schema.NullOr(Day),
  }),
  /** Null means no admitted live ranking; it does not mean no private progress. */
  standing: Schema.NullOr(Schema.Struct({ rank: Positive, persona_id: PersonaIdV1 })),
}).check(
  Schema.makeFilter((value) => {
    const start = Date.parse(`${value.week.start_day}T00:00:00.000Z`);
    if (
      new Date(start).getUTCDay() !== 1 ||
      value.week.days.some(
        (mark, index) =>
          mark.day !== new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      ) ||
      value.week.days[6]?.day !== value.week.end_day ||
      value.today < value.week.start_day ||
      value.today > value.week.end_day
    ) {
      return "Expected the seven consecutive days of the observed ISO week";
    }
    if (new Set(value.activity_counts.map((count) => count.activity)).size !== 2) {
      return "Expected each supported activity count exactly once";
    }
    return value.streak.current <= value.streak.best &&
      value.streak.best <= value.streak.total_days &&
      (value.streak.total_days === 0
        ? value.streak.started_day === null && value.streak.last_day === null
        : value.streak.started_day !== null &&
          value.streak.last_day !== null &&
          value.streak.started_day <= value.streak.last_day)
      ? undefined
      : "Inconsistent streak progress";
  }),
);
export type ActivityProgressV1 = Schema.Schema.Type<typeof ActivityProgressV1>;

export const ActivityPresentationStateV1 = Schema.Struct({
  object: Schema.Literal("activity_presentation_state"),
  community_id: Id,
  observed_at: Instant,
  selection: Schema.Union([
    Schema.Struct({ status: Schema.Literal("selected"), presentation: ActivityPresentationV1 }),
    Schema.Struct({ status: Schema.Literals(["unset", "unavailable"]) }),
  ]),
}).check(
  Schema.makeFilter((value) =>
    value.selection.status !== "selected" ||
    value.selection.presentation.community_id === value.community_id
      ? undefined
      : "Presentation must belong to the requested community",
  ),
);
export type ActivityPresentationStateV1 = Schema.Schema.Type<typeof ActivityPresentationStateV1>;

const community = Schema.Struct({ communityId: Id });
const song = Schema.Struct({ communityId: Id, postId: Id });
const study = Schema.Struct({ communityId: Id, sessionId: Id });
const karaoke = Schema.Struct({ communityId: Id, sessionId: Id, attemptId: Id });
const errors = [AuthError, BadRequest, NotFound, InternalError] as const;
export const GetStudyCompletionState = endpoint({
  method: "GET",
  path: "/communities/:communityId/study/v2/sessions/:sessionId/completion",
  auth: Auth.userOrAdmin(),
  cacheControl: "private, no-store",
  request: { path: study },
  response: ActivityCompletionV1,
  errors,
});
export const GetKaraokeCompletionState = endpoint({
  method: "GET",
  path: "/communities/:communityId/karaoke/sessions/:sessionId/attempts/:attemptId/completion",
  auth: Auth.userOrAdmin(),
  cacheControl: "private, no-store",
  request: { path: karaoke },
  response: ActivityCompletionV1,
  errors,
});
export const GetSongActivityProgress = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/rewards/progress",
  auth: Auth.userOrAdmin(),
  cacheControl: "private, no-store",
  request: { path: song },
  response: ActivityProgressV1,
  errors,
});
export const GetCommunityActivityProgress = endpoint({
  method: "GET",
  path: "/communities/:communityId/rewards/progress",
  auth: Auth.userOrAdmin(),
  cacheControl: "private, no-store",
  request: { path: community },
  response: ActivityProgressV1,
  errors,
});
export const GetActivityPresentationPersona = endpoint({
  method: "GET",
  path: "/communities/:communityId/rewards/presentation-persona",
  auth: Auth.userOrAdmin(),
  cacheControl: "private, no-store",
  request: { path: community },
  response: ActivityPresentationStateV1,
  errors,
});

export const activityCompletionRegistry = {
  GetStudyCompletionState,
  GetKaraokeCompletionState,
  GetSongActivityProgress,
  GetCommunityActivityProgress,
  GetActivityPresentationPersona,
} as const;
