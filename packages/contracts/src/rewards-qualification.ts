import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, Conflict, InternalError, NotFound, RateLimited } from "./errors.ts";
import { PersonaIdV1, PublicPersonaV1 } from "./personas.ts";

const BoundedIdentifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value) =>
    value === value.trim() &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
      ? undefined
      : "Expected a bounded identifier",
  ),
);
const BoundedText = Schema.NonEmptyString.check(Schema.isMaxLength(4_096));
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const NonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const BasisPoints = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }));
const CanonicalDate = Schema.String.check(
  Schema.makeFilter((value) =>
    /^\d{4}-\d{2}-\d{2}$/u.test(value) ? undefined : "Expected a canonical calendar date",
  ),
);
const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);
const IanaTimezone = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
      return undefined;
    } catch {
      return "Expected an IANA timezone";
    }
  }),
);

const studyRequiredCorrect = (exerciseCount: number): number =>
  Math.max(1, Math.ceil((7 * exerciseCount) / 10));

const studyScoreBps = (correct: number, exerciseCount: number): number =>
  Math.floor((10_000 * correct) / exerciseCount);

const calendarDateInTimezone = (instant: string, timezone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const byType = new Map(parts.map(({ type, value }) => [type, value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
};

/** Dance stays reserved in storage and is absent from every slice-2 command. */
export const QualifyingActivityV1 = Schema.Literals(["study", "karaoke"]);
export type QualifyingActivityV1 = Schema.Schema.Type<typeof QualifyingActivityV1>;

export const ActivityRegistryEntryV1 = Schema.Struct({
  activity: QualifyingActivityV1,
  status: Schema.Literal("active"),
  producer_version: BoundedIdentifier,
});
export type ActivityRegistryEntryV1 = Schema.Schema.Type<typeof ActivityRegistryEntryV1>;

export const StudyQualificationPolicyV1 = Schema.Struct({
  kind: Schema.Literal("study_session_first_pass_v2"),
  qualification_policy_version_id: BoundedIdentifier,
  required_correct_bps: Schema.Literal(7_000),
});
export const KaraokeQualificationPolicyV1 = Schema.Struct({
  kind: Schema.Literal("karaoke_qualification_v1"),
  qualification_policy_version_id: BoundedIdentifier,
  minimum_scored_line_count: Schema.Literal(5),
  minimum_coverage_bps: Schema.Literal(8_500),
  minimum_final_score_bps: Schema.Literal(7_000),
});
export const QualificationPolicyV1 = Schema.Union([
  StudyQualificationPolicyV1,
  KaraokeQualificationPolicyV1,
]);
export type QualificationPolicyV1 = Schema.Schema.Type<typeof QualificationPolicyV1>;

export const ActivityAttemptRefV1 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("study"), session_id: BoundedIdentifier }),
  Schema.Struct({
    kind: Schema.Literal("karaoke"),
    session_id: BoundedIdentifier,
    attempt_id: BoundedIdentifier,
  }),
]);
export type ActivityAttemptRefV1 = Schema.Schema.Type<typeof ActivityAttemptRefV1>;

export const StudyQualificationEvidenceV1 = Schema.Struct({
  kind: Schema.Literal("study_session_first_pass_v2"),
  qualifying_exercise_count: PositiveInteger,
  first_pass_correct: NonNegativeInteger,
  required_correct: PositiveInteger,
}).check(
  Schema.makeFilter(({ qualifying_exercise_count, first_pass_correct, required_correct }) =>
    first_pass_correct <= qualifying_exercise_count &&
    required_correct === studyRequiredCorrect(qualifying_exercise_count) &&
    first_pass_correct >= required_correct
      ? undefined
      : "Study qualification evidence must satisfy the frozen first-pass policy",
  ),
);
export const KaraokeQualificationEvidenceV1 = Schema.Struct({
  kind: Schema.Literal("karaoke_qualification_v1"),
  scored_line_count: PositiveInteger,
  line_count: PositiveInteger,
  coverage_bps: BasisPoints,
  final_score_bps: BasisPoints,
  scoring_version: PositiveInteger,
  scoring_provider: BoundedIdentifier,
  karaoke_revision_id: BoundedIdentifier,
}).check(
  Schema.makeFilter(({ scored_line_count, line_count, coverage_bps, final_score_bps }) =>
    scored_line_count <= line_count &&
    scored_line_count >= 5 &&
    coverage_bps >= 8_500 &&
    final_score_bps >= 7_000
      ? undefined
      : "Karaoke qualification evidence must satisfy the frozen score policy",
  ),
);
export const ActivityQualificationEvidenceV1 = Schema.Union([
  StudyQualificationEvidenceV1,
  KaraokeQualificationEvidenceV1,
]);
export type ActivityQualificationEvidenceV1 = Schema.Schema.Type<
  typeof ActivityQualificationEvidenceV1
>;

/** Private account identity is deliberately absent from this projection. */
export const ActivityQualificationV1 = Schema.Struct({
  object: Schema.Literal("activity_qualification"),
  qualification_id: BoundedIdentifier,
  persona_id: PersonaIdV1,
  community_id: BoundedIdentifier,
  post_id: BoundedIdentifier,
  audio_revision: PositiveInteger,
  activity: QualifyingActivityV1,
  attempt_ref: ActivityAttemptRefV1,
  score_bps: BasisPoints,
  qualification_policy_version_id: BoundedIdentifier,
  qualified_at: CanonicalInstant,
  reward_period_key: CanonicalDate,
  streak_day: CanonicalDate,
  evidence_summary: ActivityQualificationEvidenceV1,
}).check(
  Schema.makeFilter((qualification) => {
    if (qualification.reward_period_key !== qualification.qualified_at.slice(0, 10)) {
      return "Qualification reward period must be the UTC qualification date";
    }
    if (
      qualification.activity !== qualification.attempt_ref.kind ||
      (qualification.activity === "study" &&
        qualification.evidence_summary.kind !== "study_session_first_pass_v2") ||
      (qualification.activity === "karaoke" &&
        qualification.evidence_summary.kind !== "karaoke_qualification_v1")
    ) {
      return "Qualification activity, attempt, and evidence kinds must agree";
    }
    if (qualification.evidence_summary.kind === "study_session_first_pass_v2") {
      return qualification.score_bps ===
        studyScoreBps(
          qualification.evidence_summary.first_pass_correct,
          qualification.evidence_summary.qualifying_exercise_count,
        )
        ? undefined
        : "Study qualification score must be derived from exact evidence counts";
    }
    return qualification.score_bps === qualification.evidence_summary.final_score_bps
      ? undefined
      : "Karaoke qualification score must equal the frozen final score";
  }),
);
export type ActivityQualificationV1 = Schema.Schema.Type<typeof ActivityQualificationV1>;

const isCanonicalStudyQualification = (
  qualification: ActivityQualificationV1,
  session: {
    readonly session_id: string;
    readonly persona_id: string;
    readonly community_id: string;
    readonly post_id: string;
    readonly audio_revision: number;
    readonly qualification_policy_version_id: string;
    readonly streak_day: string;
    readonly completed_at: string;
    readonly progress: {
      readonly qualifying_exercise_count: number;
      readonly first_pass_correct: number;
      readonly required_correct: number;
      readonly score_bps: number | null;
    };
  },
): boolean =>
  qualification.activity === "study" &&
  qualification.attempt_ref.kind === "study" &&
  qualification.evidence_summary.kind === "study_session_first_pass_v2" &&
  qualification.attempt_ref.session_id === session.session_id &&
  qualification.persona_id === session.persona_id &&
  qualification.community_id === session.community_id &&
  qualification.post_id === session.post_id &&
  qualification.audio_revision === session.audio_revision &&
  qualification.qualification_policy_version_id === session.qualification_policy_version_id &&
  qualification.qualified_at === session.completed_at &&
  qualification.streak_day === session.streak_day &&
  qualification.score_bps === session.progress.score_bps &&
  qualification.evidence_summary.qualifying_exercise_count ===
    session.progress.qualifying_exercise_count &&
  qualification.evidence_summary.first_pass_correct === session.progress.first_pass_correct &&
  qualification.evidence_summary.required_correct === session.progress.required_correct;

export const StudySourceIdentityV1 = Schema.Struct({
  community_id: BoundedIdentifier,
  post_id: BoundedIdentifier,
  audio_revision: PositiveInteger,
  lyrics_revision: PositiveInteger,
  source_revision: PositiveInteger,
  source_item_key: BoundedIdentifier,
});
export type StudySourceIdentityV1 = Schema.Schema.Type<typeof StudySourceIdentityV1>;

export const StudyPromptChoiceV1 = Schema.Struct({
  choice_key: BoundedIdentifier,
  text: BoundedText,
});
const StudyPromptChoicesV1 = Schema.NonEmptyArray(StudyPromptChoiceV1).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(12),
  Schema.makeFilter((choices) =>
    new Set(choices.map(({ choice_key }) => choice_key)).size === choices.length
      ? undefined
      : "Study prompt choice keys must be unique",
  ),
);
export const StudyPromptV1 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text_response"), text: BoundedText }),
  Schema.Struct({
    kind: Schema.Literal("single_select"),
    text: BoundedText,
    choices: StudyPromptChoicesV1,
  }),
]);
export type StudyPromptV1 = Schema.Schema.Type<typeof StudyPromptV1>;

export const StudySessionItemV1 = Schema.Struct({
  session_item_id: BoundedIdentifier,
  ordinal: NonNegativeInteger,
  source_identity: StudySourceIdentityV1,
  prompt: StudyPromptV1,
  presentation_count: PositiveInteger,
  answer_count: NonNegativeInteger,
  first_pass_outcome: Schema.NullOr(Schema.Literals(["correct", "incorrect"])),
}).check(
  Schema.makeFilter(({ answer_count, first_pass_outcome }) =>
    (answer_count === 0 && first_pass_outcome === null) ||
    (answer_count > 0 && first_pass_outcome !== null)
      ? undefined
      : "Study item answer count and first-pass outcome must agree",
  ),
);
export type StudySessionItemV1 = Schema.Schema.Type<typeof StudySessionItemV1>;

export const StudySessionProgressV1 = Schema.Struct({
  qualifying_exercise_count: PositiveInteger,
  answered_exercise_count: NonNegativeInteger,
  first_pass_correct: NonNegativeInteger,
  required_correct: PositiveInteger,
  score_bps: Schema.NullOr(BasisPoints),
}).check(
  Schema.makeFilter(
    ({
      qualifying_exercise_count,
      answered_exercise_count,
      first_pass_correct,
      required_correct,
    }) =>
      answered_exercise_count <= qualifying_exercise_count &&
      first_pass_correct <= answered_exercise_count &&
      required_correct <= qualifying_exercise_count
        ? undefined
        : "Study session progress counts are inconsistent",
  ),
);

export const StudySessionV1 = Schema.Struct({
  object: Schema.Literal("study_session"),
  session_id: BoundedIdentifier,
  persona_id: PersonaIdV1,
  community_id: BoundedIdentifier,
  post_id: BoundedIdentifier,
  audio_revision: PositiveInteger,
  lyrics_revision: PositiveInteger,
  source_revision: PositiveInteger,
  qualification_policy_version_id: BoundedIdentifier,
  status: Schema.Literals(["active", "completed"]),
  timezone: IanaTimezone,
  streak_day: CanonicalDate,
  items: Schema.NonEmptyArray(StudySessionItemV1).check(Schema.isMaxLength(64)),
  progress: StudySessionProgressV1,
  qualification: Schema.NullOr(ActivityQualificationV1),
  created_at: CanonicalInstant,
  completed_at: Schema.NullOr(CanonicalInstant),
}).check(
  Schema.makeFilter((session) => {
    const itemIds = new Set<string>();
    const sourceKeys = new Set<string>();
    for (const [index, item] of session.items.entries()) {
      if (
        itemIds.has(item.session_item_id) ||
        sourceKeys.has(item.source_identity.source_item_key)
      ) {
        return "Study session item and source identities must be unique";
      }
      itemIds.add(item.session_item_id);
      sourceKeys.add(item.source_identity.source_item_key);
      if (item.ordinal !== index) return "Study session item ordinals must be contiguous";
      if (
        item.source_identity.community_id !== session.community_id ||
        item.source_identity.post_id !== session.post_id ||
        item.source_identity.audio_revision !== session.audio_revision ||
        item.source_identity.lyrics_revision !== session.lyrics_revision ||
        item.source_identity.source_revision !== session.source_revision
      ) {
        return "Study session items must share the frozen source binding";
      }
    }

    const answered = session.items.filter(({ answer_count }) => answer_count > 0).length;
    const firstPassCorrect = session.items.filter(
      ({ first_pass_outcome }) => first_pass_outcome === "correct",
    ).length;
    const exerciseCount = session.items.length;
    const requiredCorrect = studyRequiredCorrect(exerciseCount);
    if (
      session.progress.qualifying_exercise_count !== exerciseCount ||
      session.progress.answered_exercise_count !== answered ||
      session.progress.first_pass_correct !== firstPassCorrect ||
      session.progress.required_correct !== requiredCorrect
    ) {
      return "Study session progress must be derived from its frozen items";
    }

    if (session.status === "active") {
      return session.completed_at === null &&
        session.progress.score_bps === null &&
        session.qualification === null
        ? undefined
        : "An active Study session cannot carry terminal output";
    }

    const scoreBps = studyScoreBps(firstPassCorrect, exerciseCount);
    if (
      session.completed_at === null ||
      answered !== exerciseCount ||
      session.progress.score_bps !== scoreBps ||
      session.streak_day !== calendarDateInTimezone(session.completed_at, session.timezone)
    ) {
      return "A completed Study session must carry fully derived terminal progress";
    }
    const qualified = firstPassCorrect >= requiredCorrect;
    if (!qualified) {
      return session.qualification === null
        ? undefined
        : "A below-threshold Study session cannot carry a qualification";
    }
    return session.qualification !== null &&
      isCanonicalStudyQualification(session.qualification, {
        session_id: session.session_id,
        persona_id: session.persona_id,
        community_id: session.community_id,
        post_id: session.post_id,
        audio_revision: session.audio_revision,
        qualification_policy_version_id: session.qualification_policy_version_id,
        streak_day: session.streak_day,
        completed_at: session.completed_at,
        progress: session.progress,
      })
      ? undefined
      : "A qualifying Study session must carry its exact derived qualification";
  }),
);
export type StudySessionV1 = Schema.Schema.Type<typeof StudySessionV1>;

export const StudyAnswerSubmissionV1 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text_response"), text: BoundedText }),
  Schema.Struct({ kind: Schema.Literal("single_select"), choice_key: BoundedIdentifier }),
]);
export type StudyAnswerSubmissionV1 = Schema.Schema.Type<typeof StudyAnswerSubmissionV1>;

export const StudyAnswerResultV1 = Schema.Struct({
  object: Schema.Literal("study_answer_result"),
  session_item_id: BoundedIdentifier,
  attempt_number: PositiveInteger,
  outcome: Schema.Literals(["correct", "incorrect"]),
  first_pass: Schema.Boolean,
  session: StudySessionV1,
});
export type StudyAnswerResultV1 = Schema.Schema.Type<typeof StudyAnswerResultV1>;

export const AccountStreakClockV1 = Schema.Struct({
  object: Schema.Literal("account_streak_clock"),
  timezone: IanaTimezone,
  timezone_updated_at: CanonicalInstant,
  next_change_allowed_at: CanonicalInstant,
});
export type AccountStreakClockV1 = Schema.Schema.Type<typeof AccountStreakClockV1>;

export const ActivityPresentationV1 = Schema.Struct({
  object: Schema.Literal("activity_presentation"),
  community_id: BoundedIdentifier,
  persona_id: PersonaIdV1,
  updated_at: CanonicalInstant,
});
export type ActivityPresentationV1 = Schema.Schema.Type<typeof ActivityPresentationV1>;

export const ActivityStreakLeaderboardEntryV1 = Schema.Struct({
  rank: PositiveInteger,
  current: PositiveInteger,
  best: PositiveInteger,
  started_day: CanonicalDate,
  last_day: CanonicalDate,
  total_days: PositiveInteger,
  persona: PublicPersonaV1,
  is_viewer: Schema.Boolean,
}).check(
  Schema.makeFilter((entry) =>
    entry.current <= entry.best &&
    entry.best <= entry.total_days &&
    entry.started_day <= entry.last_day
      ? undefined
      : "Activity streak counters and dates must be coherent",
  ),
);
export type ActivityStreakLeaderboardEntryV1 = Schema.Schema.Type<
  typeof ActivityStreakLeaderboardEntryV1
>;

export const ActivityStreakLeaderboardV1 = Schema.Struct({
  object: Schema.Literal("activity_streak_leaderboard"),
  scope: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("song"),
      community_id: BoundedIdentifier,
      post_id: BoundedIdentifier,
    }),
    Schema.Struct({ kind: Schema.Literal("community"), community_id: BoundedIdentifier }),
  ]),
  day_semantics: Schema.Literal("account_pinned_iana_timezone_v1"),
  entries: Schema.Array(ActivityStreakLeaderboardEntryV1).check(Schema.isMaxLength(100)),
  viewer_standing: Schema.NullOr(ActivityStreakLeaderboardEntryV1),
}).check(
  Schema.makeFilter(({ entries, viewer_standing }) => {
    if (new Set(entries.map(({ persona }) => persona.persona_id)).size !== entries.length) {
      return "Leaderboard personas must be unique";
    }
    if (viewer_standing !== null && !viewer_standing.is_viewer) {
      return "Viewer standing must identify the authenticated viewer";
    }
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (previous === undefined || current === undefined) continue;
      const inOrder =
        previous.current > current.current ||
        (previous.current === current.current && previous.best > current.best) ||
        (previous.current === current.current &&
          previous.best === current.best &&
          previous.started_day < current.started_day) ||
        (previous.current === current.current &&
          previous.best === current.best &&
          previous.started_day === current.started_day &&
          previous.persona.persona_id < current.persona.persona_id);
      if (!inOrder) return "Leaderboard entries must use the frozen deterministic order";
    }
    return undefined;
  }),
);
export type ActivityStreakLeaderboardV1 = Schema.Schema.Type<typeof ActivityStreakLeaderboardV1>;

const CommunityPostPath = Schema.Struct({
  communityId: BoundedIdentifier,
  postId: BoundedIdentifier,
});
const StudySessionPath = Schema.Struct({
  communityId: BoundedIdentifier,
  sessionId: BoundedIdentifier,
});
const StudySessionItemPath = Schema.Struct({
  communityId: BoundedIdentifier,
  sessionId: BoundedIdentifier,
  sessionItemId: BoundedIdentifier,
});
const CommunityPath = Schema.Struct({ communityId: BoundedIdentifier });
const LeaderboardQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.String.check(
      Schema.makeFilter((value) =>
        /^(?:[1-9]|[1-9][0-9]|100)$/u.test(value)
          ? undefined
          : "Expected a leaderboard limit from 1 through 100",
      ),
    ),
  ),
});

export const StartStudySession = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts/:postId/study/sessions",
  auth: Auth.userOrAdmin(),
  request: {
    path: CommunityPostPath,
    body: Schema.Struct({
      idempotency_key: BoundedIdentifier,
      persona_id: PersonaIdV1,
      timezone: Schema.optional(IanaTimezone),
    }),
  },
  response: StudySessionV1,
  successStatus: 201,
  errors: [AuthError, BadRequest, Conflict, NotFound, RateLimited, InternalError],
});

export const GetStudySession = endpoint({
  method: "GET",
  path: "/communities/:communityId/study/sessions/:sessionId",
  auth: Auth.userOrAdmin(),
  request: { path: StudySessionPath },
  response: StudySessionV1,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const SubmitStudyAnswer = endpoint({
  method: "POST",
  path: "/communities/:communityId/study/sessions/:sessionId/items/:sessionItemId/answers",
  auth: Auth.userOrAdmin(),
  request: {
    path: StudySessionItemPath,
    body: Schema.Struct({
      idempotency_key: BoundedIdentifier,
      attempt_number: PositiveInteger,
      answer: StudyAnswerSubmissionV1,
    }),
  },
  response: StudyAnswerResultV1,
  errors: [AuthError, BadRequest, Conflict, NotFound, RateLimited, InternalError],
});

export const SetAccountStreakTimezone = endpoint({
  method: "PUT",
  path: "/rewards/streak-timezone",
  auth: Auth.userOrAdmin(),
  request: {
    body: Schema.Struct({ idempotency_key: BoundedIdentifier, timezone: IanaTimezone }),
  },
  response: AccountStreakClockV1,
  errors: [AuthError, BadRequest, Conflict, RateLimited, InternalError],
});

export const SetActivityPresentationPersona = endpoint({
  method: "PUT",
  path: "/communities/:communityId/rewards/presentation-persona",
  auth: Auth.userOrAdmin(),
  request: {
    path: CommunityPath,
    body: Schema.Struct({ idempotency_key: BoundedIdentifier, persona_id: PersonaIdV1 }),
  },
  response: ActivityPresentationV1,
  errors: [AuthError, BadRequest, Conflict, NotFound, InternalError],
});

export const GetSongActivityLeaderboard = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/rewards/leaderboard",
  auth: Auth.user({ optionalUser: true }),
  request: { path: CommunityPostPath, query: LeaderboardQuery },
  response: ActivityStreakLeaderboardV1,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const GetCommunityActivityLeaderboard = endpoint({
  method: "GET",
  path: "/communities/:communityId/rewards/leaderboard",
  auth: Auth.user({ optionalUser: true }),
  request: { path: CommunityPath, query: LeaderboardQuery },
  response: ActivityStreakLeaderboardV1,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});
