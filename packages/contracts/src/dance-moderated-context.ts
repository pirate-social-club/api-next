import { Schema } from "effect";
import { Auth } from "./auth.ts";
import {
  ModeratedDancePolicyDisclosure,
  ModeratedDanceSessionView,
} from "./dance-moderated-intake.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, InternalError, NotFound } from "./errors.ts";
import {
  AddressV2,
  ChainV2,
  CommittedTargetV2,
  HashV2,
  IdV2,
  QualificationBindingV2,
  RevisionV2,
  TermsV2,
} from "./rewards-song-contributions-v2.ts";

const Natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/** Original funded terms, never a lookup of the currently open song pot. The
 * current shared-song protocol captures at most one Dance objective. */
export const ModeratedDanceCapturedObjective = Schema.Struct({
  target: CommittedTargetV2,
  terms: TermsV2,
  binding: QualificationBindingV2,
  chain_id: ChainV2,
  token_address: AddressV2,
  token_decimals: Schema.Literal(6),
}).check(
  Schema.makeFilter((o) =>
    o.binding.activity === "dance" ? undefined : "Expected the captured Dance objective",
  ),
);

export const ModeratedDanceCaptureReference = Schema.Struct({
  reference_post_id: IdV2,
  video_render_revision: IdV2,
  reference_terms_hash: HashV2,
  canonical_song_start_ms: Natural,
  canonical_song_end_ms: RevisionV2,
  reference_body_start_ms: Natural,
  reference_body_end_ms: RevisionV2,
});

export const ModeratedDanceCaptureContext = Schema.Struct({
  version: Schema.Literal("dance-moderated-capture-context-v1"),
  session: ModeratedDanceSessionView,
  persona_id: IdV2,
  audio_revision: RevisionV2,
  segment_id: IdV2,
  reference: ModeratedDanceCaptureReference,
  reward_mode: Schema.Literals(["practice", "reward_eligible"]),
  /** Runtime switch only. True is not qualification, availability or payment. */
  rewards_enabled: Schema.Boolean,
  captured_policy: Schema.Struct({
    admission: Schema.Literals(["shadow", "streak_admitted", "money_admitted"]),
    admission_version: IdV2,
    admission_hash: HashV2,
    qualification_policy_version_id: IdV2,
    qualification_policy_hash: HashV2,
    producer_id: IdV2,
    publication_disclosure_version: IdV2,
    rubric_version: IdV2,
    rubric_hash: HashV2,
  }),
  disclosure: ModeratedDancePolicyDisclosure,
  objectives: Schema.Array(ModeratedDanceCapturedObjective).check(Schema.isMaxLength(1)),
});
export type ModeratedDanceCaptureContext = typeof ModeratedDanceCaptureContext.Type;

export const ModeratedDanceOwnerRubric = Schema.Struct({
  version: Schema.Literal("dance-moderated-owner-rubric-v1"),
  community_id: IdV2,
  review_id: IdV2,
  review_revision: RevisionV2,
  session_terms_hash: HashV2,
  policy_hash: HashV2,
  rubric_version: IdV2,
  rubric_hash: HashV2,
  rubric_text: Schema.NonEmptyString.check(Schema.isMaxLength(12000)),
  attestation_version: Schema.Literal("dance-owner-verdict-attestation-v1"),
});
export type ModeratedDanceOwnerRubric = typeof ModeratedDanceOwnerRubric.Type;

const auth = Auth.user({ browserSessionOnly: true });
const errors = [AuthError, NotFound, InternalError] as const;
export const GetModeratedDanceCaptureContext = endpoint({
  method: "GET",
  path: "/communities/:communityId/dance/moderated-sessions/:sessionId/capture-context",
  auth,
  cacheControl: "private, no-store",
  request: { path: Schema.Struct({ communityId: IdV2, sessionId: IdV2 }) },
  response: ModeratedDanceCaptureContext,
  errors,
});
export const GetModeratedDanceOwnerRubric = endpoint({
  method: "GET",
  path: "/communities/:communityId/dance/owner-reviews/:reviewId/rubric",
  auth,
  cacheControl: "private, no-store",
  request: { path: Schema.Struct({ communityId: IdV2, reviewId: IdV2 }) },
  response: ModeratedDanceOwnerRubric,
  errors,
});
export const moderatedDanceContextRegistry = {
  GetModeratedDanceCaptureContext,
  GetModeratedDanceOwnerRubric,
} as const;
