import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  GuestConflict,
  GuestPendingConflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RateLimited,
} from "./errors.ts";
import { guestBrowserErrorsV1 } from "./guest-browser-authority.ts";
import {
  GuestIdentifierV1,
  GuestParticipationResultV1,
  GuestSha256V1,
} from "./guest-participation.ts";
import { GuestRewardTermsV1, GuestStudyPreparedContentV1 } from "./guest-study.ts";
import { LanguageTagV1 } from "./language.ts";
import {
  GetStudySessionV2,
  StartStudySessionV2,
  StudyAnswerResultV2,
  StudyLearnerBandV2,
  StudySessionV2,
  SubmitStudyAnswerV2,
} from "./study-v2.ts";

/** The full preview hash is issued by the server. It is not the offer-leg hash
 * in reward_terms.terms_hash, and browsers never serialize PostgreSQL JSONB.
 * The original 118 public response remains closed and practice-only.
 */
export const GuestStudyPreparedContentV2 = GuestStudyPreparedContentV1.mapFields((fields) => ({
  ...fields,
  object: Schema.Literal("guest_study_prepared_content_v2"),
  reward_preview_terms_hash: Schema.NullOr(GuestSha256V1),
})).check(
  Schema.makeFilter((value) =>
    (value.reward_preview === null) === (value.reward_preview_terms_hash === null)
      ? undefined
      : "A rewarded preview and its server-issued hash must be present together",
  ),
);
export type GuestStudyPreparedContentV2 = Schema.Schema.Type<typeof GuestStudyPreparedContentV2>;

const RewardedParticipation = GuestParticipationResultV1.check(
  Schema.makeFilter((value) =>
    value.state === "practice_only"
      ? "A captured rewarded activity cannot become practice"
      : undefined,
  ),
);
function sourceMismatch(
  session: Schema.Schema.Type<typeof StudySessionV2>,
  terms: Schema.Schema.Type<typeof GuestRewardTermsV1>,
  participation: Schema.Schema.Type<typeof GuestParticipationResultV1>,
): string | undefined {
  if (
    session.community_id !== terms.community_id ||
    session.post_id !== terms.post_id ||
    session.audio_revision !== terms.audio_revision ||
    session.lyrics_revision !== terms.lyrics_revision ||
    session.qualification_policy_revision !== terms.qualification_policy_version_id
  )
    return "Immutable reward terms must bind the original activity source";
  if (
    participation.state === "admitted" &&
    (session.status !== "completed" ||
      session.progress.first_pass_correct < session.progress.required_correct)
  )
    return "Admission requires the original completed qualifying lesson";
  if (
    participation.state === "admitted" &&
    (participation.original_drawing_id !== terms.original_drawing_id ||
      participation.pool_leg_id !== terms.pool_leg_id)
  )
    return "Admission must retain the original drawing and offer leg";
  return undefined;
}
export const OwnerAccountStudySessionV1 = Schema.Struct({
  object: Schema.Literal("owner_account_study_session_v1"),
  session: StudySessionV2,
  reward_terms: GuestRewardTermsV1,
  participation: RewardedParticipation,
}).check(
  Schema.makeFilter((value) =>
    sourceMismatch(value.session, value.reward_terms, value.participation),
  ),
);
export type OwnerAccountStudySessionV1 = Schema.Schema.Type<typeof OwnerAccountStudySessionV1>;
export const OwnerAccountStudyStartOperationV1 = Schema.Union([
  Schema.Struct({ state: Schema.Literal("completed"), result: OwnerAccountStudySessionV1 }),
  Schema.Struct({
    state: Schema.Literals(["pending_confirmation", "not_started"]),
    result: Schema.Null,
  }),
]);
export type OwnerAccountStudyStartOperationV1 = Schema.Schema.Type<
  typeof OwnerAccountStudyStartOperationV1
>;

export const OwnerAccountStudyAnswerResultV1 = Schema.Struct({
  object: Schema.Literal("owner_account_study_answer_result_v1"),
  answer: StudyAnswerResultV2,
  reward_terms: GuestRewardTermsV1,
  participation: RewardedParticipation,
}).check(
  Schema.makeFilter((value) =>
    sourceMismatch(value.answer.session, value.reward_terms, value.participation),
  ),
);
export type OwnerAccountStudyAnswerResultV1 = Schema.Schema.Type<
  typeof OwnerAccountStudyAnswerResultV1
>;

const postPath = Schema.Struct({ communityId: GuestIdentifierV1, postId: GuestIdentifierV1 });
const publicQuery = Schema.Struct({
  target_language: Schema.optional(LanguageTagV1),
  learner_band: Schema.optional(StudyLearnerBandV2),
});
const accountErrors = [
  AuthError,
  BadRequest,
  GuestConflict,
  GuestPendingConflict,
  NotFound,
  RateLimited,
  InternalError,
  ProviderUnavailable,
] as const;
/** These declarations belong to the complete accounting successor. Concrete
 * handlers and native readiness are required before registration/acceptance.
 */
export const GetPublicGuestStudyPreparedContentV2 = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/study/public/v2",
  auth: Auth.public(),
  request: { path: postPath, query: publicQuery },
  response: GuestStudyPreparedContentV2,
  cacheControl: "private, no-store",
  errors: guestBrowserErrorsV1,
});
export const GetAccountStudyRewardPreviewV1 = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/study/owner/v1/preview",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    path: postPath,
    query: Schema.Struct({ persona_id: GuestIdentifierV1, ...publicQuery.fields }),
  },
  response: Schema.Struct({
    reward_terms: GuestRewardTermsV1,
    reward_preview_terms_hash: GuestSha256V1,
  }),
  cacheControl: "private, no-store",
  errors: accountErrors,
});
export const StartOwnerAccountStudySessionV1 = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts/:postId/study/owner/v1/sessions",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    path: postPath,
    bodyEncoding: "json",
    maxBodyBytes: 4_096,
    body: Schema.Struct({
      ...StartStudySessionV2.request.body.fields,
      idempotency_key: GuestIdentifierV1,
      reward_preview_terms_hash: GuestSha256V1,
      disclosure: Schema.Struct({ version: GuestIdentifierV1, accepted: Schema.Literal(true) }),
    }),
  },
  response: OwnerAccountStudySessionV1,
  successStatus: 201,
  cacheControl: "private, no-store",
  errors: accountErrors,
});
export const GetOwnerAccountStudySessionV1 = endpoint({
  method: "GET",
  path: "/communities/:communityId/study/owner/v1/sessions/:sessionId",
  auth: Auth.user({ browserSessionOnly: true }),
  request: GetStudySessionV2.request,
  response: OwnerAccountStudySessionV1,
  cacheControl: "private, no-store",
  errors: accountErrors,
});
export const GetOwnerAccountStudyStartOperationV1 = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/study/owner/v1/session-operations/:idempotencyKey",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    path: Schema.Struct({ ...postPath.fields, idempotencyKey: GuestIdentifierV1 }),
  },
  response: OwnerAccountStudyStartOperationV1,
  cacheControl: "private, no-store",
  errors: accountErrors,
});
export const SubmitOwnerAccountStudyAnswerV1 = endpoint({
  method: "POST",
  path: "/communities/:communityId/study/owner/v1/sessions/:sessionId/items/:sessionItemId/answers",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    ...SubmitStudyAnswerV2.request,
    headers: SubmitStudyAnswerV2.request.headers.mapFields((fields) => ({
      ...fields,
      "idempotency-key": GuestIdentifierV1,
    })),
  },
  response: OwnerAccountStudyAnswerResultV1,
  cacheControl: "private, no-store",
  errors: accountErrors,
});
