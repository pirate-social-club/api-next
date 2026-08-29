import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RateLimited,
  RetryableConflict,
} from "./errors.ts";
import { LanguageTagV1 } from "./language.ts";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Text = Schema.NonEmptyString.check(Schema.isMaxLength(4_096));
const BoundedTranscript = Schema.String.check(Schema.isMaxLength(4_096));
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);

export const StudyExerciseTypeV2 = Schema.Literals(["say_it_back", "translation_choice"]);
export type StudyExerciseTypeV2 = Schema.Schema.Type<typeof StudyExerciseTypeV2>;

export const StudyLearnerBandV2 = Schema.Literals(["A1", "A2", "B1", "B2", "C1", "C2"]);
export type StudyLearnerBandV2 = Schema.Schema.Type<typeof StudyLearnerBandV2>;

export const StudyLanguageRolesV2 = Schema.Struct({
  learning_language: LanguageTagV1,
  target_language: Schema.NullOr(LanguageTagV1),
}).check(
  Schema.makeFilter(({ learning_language, target_language }) =>
    learning_language === "en" && target_language !== learning_language
      ? undefined
      : "Study v2 learns English and requires a distinct helper language when present",
  ),
);

export const StudyLineBindingV2 = Schema.Struct({
  post_id: Identifier,
  audio_revision: PositiveInteger,
  lyrics_revision: PositiveInteger,
  lyric_line_id: Identifier,
  study_unit_id: Identifier,
  line_version: PositiveInteger,
  line_source_hash: Identifier,
});

const Choice = Schema.Struct({ choice_key: Identifier, text: Text });
const Choices = Schema.Array(Choice).check(
  Schema.isMinLength(4),
  Schema.isMaxLength(4),
  Schema.makeFilter((choices) =>
    new Set(choices.map(({ choice_key }) => choice_key)).size === choices.length
      ? undefined
      : "Study choice keys must be unique",
  ),
);

export const StudyPresentationV2 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("say_it_back"),
    reference_text: Text,
    capture: Schema.Literal("microphone_audio"),
  }),
  Schema.Struct({
    kind: Schema.Literal("translation_choice"),
    source_text: Text,
    question: Text,
    choices: Choices,
    capture: Schema.Literal("choice_selection"),
  }),
]);
export type StudyPresentationV2 = Schema.Schema.Type<typeof StudyPresentationV2>;

export const StudySessionItemV2 = Schema.Struct({
  object: Schema.Literal("study_session_item_v2"),
  session_item_id: Identifier,
  ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
  exercise_review_key: Identifier,
  exercise_version_id: Identifier,
  exercise_type: StudyExerciseTypeV2,
  exercise_variant: Identifier,
  line: StudyLineBindingV2,
  languages: StudyLanguageRolesV2,
  learner_band: Schema.NullOr(StudyLearnerBandV2),
  language_profile_revision: Schema.NullOr(PositiveInteger),
  presentation: StudyPresentationV2,
  answer_visibility: Schema.Literals(["always_visible", "secret_until_spent"]),
  feedback_release: Schema.Literals(["every_graded_attempt", "spent_only"]),
  grader_policy_revision: Identifier,
  feedback_policy_revision: Identifier,
  quality_policy_revision: Identifier,
  maximum_attempts: PositiveInteger,
}).check(
  Schema.makeFilter((item) => {
    if (item.exercise_type !== item.presentation.kind) {
      return "Study exercise type and presentation kind must match";
    }
    if (item.exercise_type === "say_it_back") {
      return item.languages.target_language === null &&
        item.learner_band === null &&
        item.answer_visibility === "always_visible" &&
        item.feedback_release === "every_graded_attempt"
        ? undefined
        : "Say-it-back requires source-only languages and feedback on every graded attempt";
    }
    return item.languages.target_language !== null &&
      item.learner_band !== null &&
      item.answer_visibility === "secret_until_spent" &&
      item.feedback_release === "spent_only"
      ? undefined
      : "Translation choice requires a helper language and spent-only answer disclosure";
  }),
);
export type StudySessionItemV2 = Schema.Schema.Type<typeof StudySessionItemV2>;

export const StudyAnswerSubmissionV2 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("single_select"), choice_key: Identifier }),
]);
export type StudyAnswerSubmissionV2 = Schema.Schema.Type<typeof StudyAnswerSubmissionV2>;

const StudyProgressV2 = Schema.Struct({
  qualifying_exercise_count: PositiveInteger,
  answered_exercise_count: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  first_pass_correct: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  required_correct: PositiveInteger,
  score_bps: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))),
});

export const StudyLessonV2 = Schema.Struct({
  current: Schema.NullOr(
    Schema.Struct({
      session_item_id: Identifier,
      presentation_number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
      is_reappearance: Schema.Boolean,
      presented_at: CanonicalInstant,
    }),
  ),
  resolved_card_count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  total_card_count: Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: 10 })),
  presentation_count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
  presentation_cap: Schema.Int.check(Schema.isBetween({ minimum: 12, maximum: 20 })),
  completion_reason: Schema.NullOr(Schema.Literals(["all_resolved", "presentation_budget"])),
});
export type StudyLessonV2 = Schema.Schema.Type<typeof StudyLessonV2>;

export const StudySessionV2 = Schema.Struct({
  object: Schema.Literal("study_session_v2"),
  session_id: Identifier,
  persona_id: Identifier,
  community_id: Identifier,
  post_id: Identifier,
  audio_revision: PositiveInteger,
  lyrics_revision: PositiveInteger,
  languages: StudyLanguageRolesV2,
  learner_band: Schema.NullOr(StudyLearnerBandV2),
  study_profile_revision: PositiveInteger,
  language_profile_revision: Schema.NullOr(PositiveInteger),
  source_set_revision: PositiveInteger,
  selection_policy_revision: Identifier,
  qualification_policy_revision: Identifier,
  timezone: Identifier,
  status: Schema.Literals(["active", "completed"]),
  items: Schema.Array(StudySessionItemV2).check(Schema.isMinLength(4), Schema.isMaxLength(10)),
  progress: StudyProgressV2,
  lesson: StudyLessonV2,
  created_at: CanonicalInstant,
  completed_at: Schema.NullOr(CanonicalInstant),
}).check(
  Schema.makeFilter((session) => {
    const count = session.items.length;
    const uniqueItems = new Set(session.items.map(({ session_item_id }) => session_item_id));
    const uniqueReviews = new Set(
      session.items.map(({ exercise_review_key }) => exercise_review_key),
    );
    if (uniqueItems.size !== count || uniqueReviews.size !== count) {
      return "Study session item and review identities must be unique";
    }
    if (
      session.progress.qualifying_exercise_count !== count ||
      session.progress.answered_exercise_count > count ||
      session.progress.first_pass_correct > session.progress.answered_exercise_count ||
      session.progress.required_correct !== Math.max(1, Math.ceil((7 * count) / 10))
    ) {
      return "Study session progress must use the frozen qualification arithmetic";
    }
    if (
      session.lesson.total_card_count !== count ||
      session.lesson.resolved_card_count > count ||
      session.lesson.presentation_cap !== Math.min(20, 3 * count) ||
      session.lesson.presentation_count > session.lesson.presentation_cap
    ) {
      return "Study lesson state must respect card and presentation bounds";
    }
    if (
      session.status === "active"
        ? session.lesson.current === null || session.lesson.completion_reason !== null
        : session.lesson.current !== null || session.lesson.completion_reason === null
    ) {
      return "Study lesson current card must match session completion";
    }
    return (session.status === "active") === (session.completed_at === null)
      ? undefined
      : "Study session completion fields must match status";
  }),
);
export type StudySessionV2 = Schema.Schema.Type<typeof StudySessionV2>;

const TokenSpan = Schema.Struct({
  token: Text,
  position: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});

export const StudyFeedbackV2 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("transcript_diff"),
    heard_transcript: BoundedTranscript,
    matched: Schema.Array(TokenSpan).check(Schema.isMaxLength(256)),
    missing: Schema.Array(TokenSpan).check(Schema.isMaxLength(256)),
    extra: Schema.Array(Text).check(Schema.isMaxLength(256)),
    substituted: Schema.Array(Schema.Struct({ expected: TokenSpan, heard: Text })).check(
      Schema.isMaxLength(256),
    ),
    policy_revision: Identifier,
  }),
  Schema.Struct({
    kind: Schema.Literal("choice_reveal"),
    correct_choice_key: Identifier,
    correct_text: Text,
    explanation: Schema.optional(Text),
  }),
]);
export type StudyFeedbackV2 = Schema.Schema.Type<typeof StudyFeedbackV2>;

export const StudyAnswerResultV2 = Schema.Struct({
  object: Schema.Literal("study_answer_result_v2"),
  session_item_id: Identifier,
  attempt_number: PositiveInteger,
  exercise_type: StudyExerciseTypeV2,
  outcome: Schema.Literals(["correct", "incorrect"]),
  first_pass: Schema.Boolean,
  attempt_state: Schema.Literals(["retryable", "spent"]),
  feedback: StudyFeedbackV2,
  session: StudySessionV2,
}).check(
  Schema.makeFilter((result) => {
    if (result.exercise_type === "say_it_back") {
      return result.feedback.kind === "transcript_diff"
        ? undefined
        : "Say-it-back requires transcript feedback";
    }
    if (result.attempt_state === "retryable") {
      return result.outcome === "incorrect" && result.feedback.kind === "none"
        ? undefined
        : "Retryable secret-answer misses cannot reveal feedback";
    }
    if (result.outcome === "correct" && result.attempt_state !== "spent") {
      return "A correct Study answer must spend the presentation";
    }
    return result.feedback.kind === "choice_reveal"
      ? undefined
      : "Spent Study feedback must match the exercise type";
  }),
);
export type StudyAnswerResultV2 = Schema.Schema.Type<typeof StudyAnswerResultV2>;

export const StudyAvailabilityV2 = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "not_a_song",
      "lyrics_not_accepted",
      "learning_language_unsupported",
      "insufficient_exercises",
      "policy_blocked",
    ]),
  }),
  Schema.Struct({
    state: Schema.Literal("processing"),
    available_exercise_types: Schema.Array(StudyExerciseTypeV2),
    pending_exercise_types: Schema.Array(StudyExerciseTypeV2),
  }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    available_exercise_types: Schema.NonEmptyArray(StudyExerciseTypeV2),
    learning_language: LanguageTagV1,
    target_languages: Schema.Array(LanguageTagV1),
    learner_bands: Schema.Array(StudyLearnerBandV2),
  }),
]);
export type StudyAvailabilityV2 = Schema.Schema.Type<typeof StudyAvailabilityV2>;

const CommunityPostPath = Schema.Struct({ communityId: Identifier, postId: Identifier });
const StudySessionPath = Schema.Struct({ communityId: Identifier, sessionId: Identifier });
const StudySessionItemPath = Schema.Struct({
  communityId: Identifier,
  sessionId: Identifier,
  sessionItemId: Identifier,
});

export const GetStudyAvailabilityV2 = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/study/v2",
  auth: Auth.userOrAdmin(),
  request: { path: CommunityPostPath },
  response: StudyAvailabilityV2,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const StartStudySessionV2 = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts/:postId/study/v2/sessions",
  auth: Auth.userOrAdmin(),
  request: {
    path: CommunityPostPath,
    body: Schema.Struct({
      idempotency_key: Identifier,
      persona_id: Identifier,
      target_language: Schema.NullOr(LanguageTagV1),
      learner_band: Schema.NullOr(StudyLearnerBandV2),
      timezone: Identifier,
    }),
  },
  response: StudySessionV2,
  successStatus: 201,
  errors: [AuthError, BadRequest, Conflict, NotFound, RateLimited, InternalError],
});

export const GetStudySessionV2 = endpoint({
  method: "GET",
  path: "/communities/:communityId/study/v2/sessions/:sessionId",
  auth: Auth.userOrAdmin(),
  request: { path: StudySessionPath },
  response: StudySessionV2,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const SubmitStudyAnswerV2 = endpoint({
  method: "POST",
  path: "/communities/:communityId/study/v2/sessions/:sessionId/items/:sessionItemId/answers",
  auth: Auth.userOrAdmin(),
  request: {
    path: StudySessionItemPath,
    headers: Schema.Struct({
      "content-type": Schema.Literals([
        "application/json",
        "audio/webm",
        "audio/ogg",
        "audio/mp4",
        "audio/wav",
      ]),
      "idempotency-key": Identifier,
      "x-study-attempt-number": Schema.String.check(Schema.isPattern(/^[1-3]$/)),
      "x-audio-duration-ms": Schema.optional(
        Schema.String.check(Schema.isPattern(/^(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|60000)$/)),
      ),
    }),
    body: StudyAnswerSubmissionV2,
    maxBodyBytes: 4_096,
    rawBodyContentTypes: ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"],
    rawBodyMaxBytes: 524_288,
  },
  response: StudyAnswerResultV2,
  errors: [
    AuthError,
    BadRequest,
    Conflict,
    RetryableConflict,
    NotFound,
    ProviderUnavailable,
    RateLimited,
    InternalError,
  ],
});
