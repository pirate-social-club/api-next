import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { ProviderUnavailable } from "./errors.ts";
import { guestBrowserErrorsV1, guestLearningEndpoint } from "./guest-browser-authority.ts";
import {
  GuestDrawingIdV1,
  GuestIdentifierV1,
  GuestInstantV1,
  GuestParticipationResultV1,
  GuestPositiveIntegerV1,
  GuestProofLocatorHeadersV1,
  GuestSha256V1,
} from "./guest-participation.ts";
import { LanguageTagV1 } from "./language.ts";
import {
  StudyAnswerResultV2,
  StudyAvailabilityV2,
  StudyLearnerBandV2,
  StudySessionV2,
  SubmitStudyAnswerV2,
} from "./study-v2.ts";

export const GuestRewardTermsV1 = Schema.Struct({
  community_id: GuestIdentifierV1,
  post_id: GuestIdentifierV1,
  audio_revision: GuestPositiveIntegerV1,
  lyrics_revision: GuestPositiveIntegerV1,
  offer_id: GuestIdentifierV1,
  pool_leg_id: GuestIdentifierV1,
  original_drawing_id: GuestDrawingIdV1,
  qualification_policy_version_id: GuestIdentifierV1,
  policy_hash: GuestSha256V1,
  terms_hash: GuestSha256V1,
  entry_cutoff_at: GuestInstantV1,
  disclosure_version: GuestIdentifierV1,
});
export type GuestRewardTermsV1 = Schema.Schema.Type<typeof GuestRewardTermsV1>;
export const GuestLearningDisclosureV1 = Schema.Struct({
  version: GuestIdentifierV1,
  accepted: Schema.Boolean,
});

/** Preserved checks use only common progress/lesson fields, never persona or object. */
export const GuestStudySessionV1 = StudySessionV2.mapFields(
  ({ persona_id: _persona, ...fields }) => ({
    ...fields,
    object: Schema.Literal("guest_study_session_v1"),
    actor: Schema.Struct({ kind: Schema.Literal("guest") }),
    owner_id: GuestIdentifierV1,
    expires_at: GuestInstantV1,
    reward_mode: Schema.Literals(["practice_only", "megapot_guest_v1"]),
    reward_terms: Schema.NullOr(GuestRewardTermsV1),
    participation: GuestParticipationResultV1,
  }),
  { unsafePreserveChecks: true },
).check(
  Schema.makeFilter((value) => {
    if ((value.reward_mode === "practice_only") !== (value.reward_terms === null))
      return "Practice has no economic terms; rewarded learning fixes its original terms";
    if (value.reward_mode === "practice_only" && value.participation.state !== "practice_only")
      return "Practice cannot report monetary admission";
    if (
      value.reward_terms !== null &&
      (value.community_id !== value.reward_terms.community_id ||
        value.post_id !== value.reward_terms.post_id ||
        value.audio_revision !== value.reward_terms.audio_revision ||
        value.lyrics_revision !== value.reward_terms.lyrics_revision ||
        value.qualification_policy_revision !== value.reward_terms.qualification_policy_version_id)
    )
      return "Reward terms must bind the accepted source";
    if (
      value.reward_terms !== null &&
      value.participation.state === "admitted" &&
      (value.participation.original_drawing_id !== value.reward_terms.original_drawing_id ||
        value.participation.pool_leg_id !== value.reward_terms.pool_leg_id)
    )
      return "Admission retains the accepted original drawing and offer leg";
    if (Date.parse(value.expires_at) - Date.parse(value.created_at) !== 86_400_000)
      return "Study expiry is independent of the one-hour authorization lease";
    return undefined;
  }),
);
export type GuestStudySessionV1 = Schema.Schema.Type<typeof GuestStudySessionV1>;
/** Existing feedback/attempt checks likewise do not inspect account identity. */
export const GuestStudyAnswerResultV1 = StudyAnswerResultV2.mapFields(
  (fields) => ({
    ...fields,
    object: Schema.Literal("guest_study_answer_result_v1"),
    session: GuestStudySessionV1,
    participation: GuestParticipationResultV1,
  }),
  { unsafePreserveChecks: true },
).check(
  Schema.makeFilter((value) =>
    JSON.stringify(value.participation) === JSON.stringify(value.session.participation)
      ? undefined
      : "Answer and session must expose the same participation outcome",
  ),
);
export type GuestStudyAnswerResultV1 = Schema.Schema.Type<typeof GuestStudyAnswerResultV1>;
export const GuestStudyStartOperationV1 = Schema.Union([
  Schema.Struct({ state: Schema.Literal("completed"), session: GuestStudySessionV1 }),
  Schema.Struct({
    state: Schema.Literals(["pending_confirmation", "not_started"]),
    session: Schema.Null,
  }),
]);
export type GuestStudyStartOperationV1 = Schema.Schema.Type<typeof GuestStudyStartOperationV1>;
const [Unavailable, Processing, Ready] = StudyAvailabilityV2.members;
const BoundedLanguage = LanguageTagV1.check(Schema.isMaxLength(64));
/** Public readiness is bounded independently of the retained account-v2 reader. The
 * exercise/band limits follow their closed vocabularies; 128 is this response's language
 * cardinality limit, not a claim that the existing repository query is already capped.
 * Implementations refuse an over-limit projection explicitly; never silently truncate it.
 */
const GuestStudyAvailabilityV1 = Schema.Union([
  Unavailable,
  Processing.mapFields((fields) => ({
    ...fields,
    available_exercise_types: fields.available_exercise_types.check(Schema.isMaxLength(2)),
    pending_exercise_types: fields.pending_exercise_types.check(Schema.isMaxLength(2)),
  })),
  Ready.mapFields((fields) => ({
    ...fields,
    available_exercise_types: fields.available_exercise_types.check(Schema.isMaxLength(2)),
    learning_language: BoundedLanguage,
    target_languages: Schema.Array(BoundedLanguage).check(Schema.isMaxLength(128)),
    learner_bands: fields.learner_bands.check(Schema.isMaxLength(6)),
  })),
]);
export const GuestStudyPreparedContentV1 = Schema.Struct({
  object: Schema.Literal("guest_study_prepared_content_v1"),
  availability: GuestStudyAvailabilityV1,
  disclosure: Schema.Struct({
    version: GuestIdentifierV1,
    text: Schema.NonEmptyString.check(Schema.isMaxLength(4_096)),
  }),
  reward_preview: Schema.NullOr(GuestRewardTermsV1),
});
export type GuestStudyPreparedContentV1 = Schema.Schema.Type<typeof GuestStudyPreparedContentV1>;
export const GetPublicStudyPreparedContentV1 = guestLearningEndpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/study/public",
  auth: Auth.public(),
  request: {
    path: Schema.Struct({ communityId: GuestIdentifierV1, postId: GuestIdentifierV1 }),
    query: Schema.Struct({
      target_language: Schema.optional(LanguageTagV1),
      learner_band: Schema.optional(StudyLearnerBandV2),
    }),
  },
  response: GuestStudyPreparedContentV1,
  errors: guestBrowserErrorsV1,
});
export const StartGuestStudySessionV1 = guestLearningEndpoint({
  method: "POST",
  path: "/communities/:communityId/posts/:postId/study/guest/v1/sessions",
  auth: Auth.browserParticipation({ authority: "learning", operation: "start" }),
  request: {
    path: Schema.Struct({ communityId: GuestIdentifierV1, postId: GuestIdentifierV1 }),
    headers: GuestProofLocatorHeadersV1,
    bodyEncoding: "json",
    maxBodyBytes: 4_096,
    body: Schema.Struct({
      idempotency_key: GuestIdentifierV1,
      expected_owner_id: GuestIdentifierV1,
      target_language: Schema.NullOr(LanguageTagV1),
      learner_band: Schema.NullOr(StudyLearnerBandV2),
      timezone: GuestIdentifierV1,
      reward_mode: Schema.Literals(["practice_only", "megapot_guest_v1"]),
      reward_preview_terms_hash: Schema.NullOr(GuestSha256V1),
      disclosure: GuestLearningDisclosureV1,
    }).check(
      Schema.makeFilter((value) =>
        (value.reward_mode === "practice_only") === (value.reward_preview_terms_hash === null)
          ? undefined
          : "Reward preview hash must match mode",
      ),
    ),
  },
  response: GuestStudySessionV1,
  successStatus: 201,
  errors: guestBrowserErrorsV1,
});
export const GetGuestStudyStartOperationV1 = guestLearningEndpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/study/guest/v1/session-operations/:idempotencyKey",
  auth: Auth.browserParticipation({ authority: "learning", operation: "operation_result" }),
  request: {
    path: Schema.Struct({
      communityId: GuestIdentifierV1,
      postId: GuestIdentifierV1,
      idempotencyKey: GuestIdentifierV1,
    }),
    headers: GuestProofLocatorHeadersV1,
  },
  response: GuestStudyStartOperationV1,
  errors: guestBrowserErrorsV1,
});
export const GetGuestStudySessionV1 = guestLearningEndpoint({
  method: "GET",
  path: "/communities/:communityId/study/guest/v1/sessions/:sessionId",
  auth: Auth.browserParticipation({ authority: "learning", operation: "read" }),
  request: {
    path: Schema.Struct({ communityId: GuestIdentifierV1, sessionId: GuestIdentifierV1 }),
    headers: GuestProofLocatorHeadersV1,
  },
  response: GuestStudySessionV1,
  errors: guestBrowserErrorsV1,
});
export const SubmitGuestStudyAnswerV1 = guestLearningEndpoint({
  method: "POST",
  path: "/communities/:communityId/study/guest/v1/sessions/:sessionId/items/:sessionItemId/answers",
  auth: Auth.browserParticipation({ authority: "learning", operation: "answer" }),
  request: {
    ...SubmitStudyAnswerV2.request,
    headers: Schema.Struct({
      ...SubmitStudyAnswerV2.request.headers.fields,
      ...GuestProofLocatorHeadersV1.fields,
    }),
  },
  response: GuestStudyAnswerResultV1,
  errors: [...guestBrowserErrorsV1, ProviderUnavailable],
});
