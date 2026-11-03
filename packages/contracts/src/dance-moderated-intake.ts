import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, Conflict, InternalError, NotFound, RateLimited } from "./errors.ts";

const Id = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((s) => (s === s.trim() ? undefined : "Noncanonical identifier")),
);
const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const path = Schema.Struct({ communityId: Id, sessionId: Id });
const shared = {
  version: Schema.Literal("dance-moderated-intake-v1"),
  idempotency_key: Id,
  community_id: Id,
};
export const CreateModeratedDanceSessionBody = Schema.Struct({
  ...shared,
  operation: Schema.Literal("create"),
  song_post_id: Id,
  choreography_id: Id,
  choreography_revision: Positive,
  persona_id: Id,
  expected_policy_hash: Hash,
});
export const ConsentModeratedDanceSessionBody = Schema.Struct({
  ...shared,
  operation: Schema.Literal("consent"),
  session_id: Id,
  terms_hash: Hash,
  consent_version: Id,
  consent_hash: Hash,
  retention_hash: Hash,
});
export const ReserveModeratedDanceUploadBody = Schema.Struct({
  ...shared,
  operation: Schema.Literal("reserve"),
  session_id: Id,
  terms_hash: Hash,
  content_type: Schema.Literals(["video/mp4", "video/quicktime"]),
  size_bytes: Positive,
  duration_ms: Positive,
});
export const FinalizeModeratedDanceUploadBody = Schema.Struct({
  ...shared,
  operation: Schema.Literal("finalize"),
  session_id: Id,
  upload_id: Id,
  terms_hash: Hash,
});
export const ModeratedDanceIntakeCommand = Schema.Union([
  CreateModeratedDanceSessionBody,
  ConsentModeratedDanceSessionBody,
  ReserveModeratedDanceUploadBody,
  FinalizeModeratedDanceUploadBody,
]);
export type ModeratedDanceIntakeCommand = typeof ModeratedDanceIntakeCommand.Type;
/** Private projection. Object keys, account IDs, provider jobs and replay hashes
 * are deliberately absent. A recording is never an ordinary Post here. */
export const ModeratedDanceSessionView = Schema.Struct({
  version: Schema.Literal("dance-moderated-session-v1"),
  session_id: Id,
  review_id: Id,
  attempt_id: Id,
  community_id: Id,
  song_post_id: Id,
  choreography_id: Id,
  choreography_revision: Positive,
  terms_hash: Hash,
  policy_hash: Hash,
  consent_version: Id,
  consent_hash: Hash,
  retention_hash: Hash,
  normalization_version: Id,
  normalization_hash: Hash,
  safety_hash: Hash,
  state: Schema.Literals(["created", "consented", "awaiting_upload", "uploaded", "terminal"]),
  created_at_ms: Natural,
  expires_at_ms: Positive,
  body_start_ms: Natural,
  body_end_ms: Positive,
  cue: Schema.Struct({
    kind: Schema.Literals(["hands_on_head", "arms_t", "hands_on_hips", "none"]),
    start_ms: Natural,
    end_ms: Natural,
    hold_ms: Natural,
  }),
  maximum_bytes: Positive,
  upload_id: Schema.NullOr(Id),
  upload_state: Schema.NullOr(
    Schema.Literals(["reserved", "sealing", "sealed", "unknown", "deleted", "held"]),
  ),
  uploaded_at_ms: Schema.NullOr(Natural),
  review_deadline_ms: Schema.NullOr(Positive),
  score_bps: Schema.Null,
}).check(
  Schema.makeFilter((s) =>
    s.cue.kind === "none"
      ? s.cue.start_ms === 0 && s.cue.end_ms === 0 && s.cue.hold_ms === 0 && s.body_start_ms === 0
        ? undefined
        : "No-pose capture must start with the dance"
      : s.cue.start_ms < s.cue.end_ms &&
          s.cue.end_ms <= s.body_start_ms &&
          s.cue.hold_ms > 0 &&
          s.cue.hold_ms <= s.cue.end_ms - s.cue.start_ms
        ? undefined
        : "Invalid captured opening cue",
  ),
);
export type ModeratedDanceSessionView = typeof ModeratedDanceSessionView.Type;
export const ModeratedDanceIntakeReceipt = Schema.Struct({
  version: Schema.Literal("dance-moderated-intake-receipt-v1"),
  receipt_id: Id,
  operation: Schema.Literals(["create", "consent", "reserve", "finalize"]),
  session: ModeratedDanceSessionView,
});
export type ModeratedDanceIntakeReceipt = typeof ModeratedDanceIntakeReceipt.Type;
const errors = [AuthError, BadRequest, Conflict, InternalError, NotFound, RateLimited] as const;
const account = Auth.user({ browserSessionOnly: true });
export const CreateModeratedDanceSession = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/moderated-sessions",
  auth: account,
  request: {
    path: Schema.Struct({ communityId: Id }),
    bodyEncoding: "exact-json",
    body: CreateModeratedDanceSessionBody,
  },
  response: ModeratedDanceIntakeReceipt,
  errors,
});
export const ConsentModeratedDanceSession = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/moderated-sessions/:sessionId/consent",
  auth: account,
  request: { path, bodyEncoding: "exact-json", body: ConsentModeratedDanceSessionBody },
  response: ModeratedDanceIntakeReceipt,
  errors,
});
export const ReserveModeratedDanceUpload = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/moderated-sessions/:sessionId/upload",
  auth: account,
  request: { path, bodyEncoding: "exact-json", body: ReserveModeratedDanceUploadBody },
  response: ModeratedDanceIntakeReceipt,
  errors,
});
export const FinalizeModeratedDanceUpload = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/moderated-sessions/:sessionId/finalize-upload",
  auth: account,
  request: { path, bodyEncoding: "exact-json", body: FinalizeModeratedDanceUploadBody },
  response: ModeratedDanceIntakeReceipt,
  errors,
});
export const GetModeratedDanceSession = endpoint({
  method: "GET",
  path: "/communities/:communityId/dance/moderated-sessions/:sessionId",
  auth: account,
  cacheControl: "private, no-store",
  request: { path },
  response: ModeratedDanceSessionView,
  errors,
});
/** An audience-private capability delivery, never stored in a command receipt.
 * A fresh read rechecks lifecycle/consent/expiry. Its target cannot be chosen. */
export const GetModeratedDanceUploadAccess = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/moderated-sessions/:sessionId/upload-access",
  auth: account,
  cacheControl: "private, no-store",
  request: {
    path,
    bodyEncoding: "exact-json",
    body: Schema.Struct({
      version: Schema.Literal("dance-moderated-upload-access-v1"),
      upload_id: Id,
      terms_hash: Hash,
    }),
  },
  response: Schema.Struct({
    version: Schema.Literal("dance-moderated-upload-access-v1"),
    upload_id: Id,
    url: Schema.NonEmptyString,
    expires_at_ms: Positive,
    content_type: Schema.Literals(["video/mp4", "video/quicktime"]),
    size_bytes: Positive,
    required_headers: Schema.Array(
      Schema.Struct({
        name: Schema.Literals(["content-type", "if-none-match"]),
        value: Schema.NonEmptyString,
      }),
    ),
  }),
  errors,
});
export const moderatedDanceIntakeRegistry = {
  CreateModeratedDanceSession,
  ConsentModeratedDanceSession,
  ReserveModeratedDanceUpload,
  FinalizeModeratedDanceUpload,
  GetModeratedDanceSession,
  GetModeratedDanceUploadAccess,
} as const;

export const ModeratedDancePolicyDisclosure = Schema.Struct({
  version: Schema.Literal("dance-moderated-disclosure-v1"),
  consent_text: Schema.NonEmptyString.check(Schema.isMaxLength(12000)),
  retention_text: Schema.NonEmptyString.check(Schema.isMaxLength(12000)),
  publication_text: Schema.NonEmptyString.check(Schema.isMaxLength(12000)),
  owner_rubric_text: Schema.NonEmptyString.check(Schema.isMaxLength(12000)),
});
export const ModeratedDanceCaptureOptions = Schema.Struct({
  version: Schema.Literal("dance-moderated-capture-options-v1"),
  community_id: Id,
  song_post_id: Id,
  ready: Schema.Boolean,
  unavailable_code: Schema.NullOr(
    Schema.Literals(["policy_unavailable", "processor_unavailable", "reference_unavailable"]),
  ),
  policy: Schema.NullOr(
    Schema.Struct({
      policy_hash: Hash,
      consent_version: Id,
      consent_hash: Hash,
      retention_hash: Hash,
      publication_disclosure_version: Id,
      disclosure: ModeratedDancePolicyDisclosure,
    }),
  ),
  next_cursor: Schema.NullOr(Hash),
  choreographies: Schema.Array(
    Schema.Struct({
      choreography_id: Id,
      revision: Positive,
      reference_post_id: Id,
      segment_id: Id,
      audio_revision: Positive,
      body_duration_ms: Positive,
      canonical_song_start_ms: Natural,
      canonical_song_end_ms: Positive,
      reference_body_start_ms: Natural,
      reference_body_end_ms: Positive,
      reference_terms_hash: Hash,
    }),
  ),
});
export const GetModeratedDanceCaptureOptions = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/dance/moderated-options",
  auth: account,
  cacheControl: "private, no-store",
  request: {
    path: Schema.Struct({ communityId: Id, postId: Id }),
    query: Schema.Struct({ cursor: Schema.optional(Hash) }),
  },
  response: ModeratedDanceCaptureOptions,
  errors,
});
export const CreateModeratedDanceReferenceBody = Schema.Struct({
  version: Schema.Literal("dance-moderated-reference-create-v1"),
  idempotency_key: Id,
  community_id: Id,
  song_post_id: Id,
  reference_post_id: Id,
  persona_id: Id,
});
export const ModeratedDanceReferenceStatus = Schema.Struct({
  version: Schema.Literal("dance-moderated-reference-v1"),
  choreography_id: Id,
  reference_post_id: Id,
  status: Schema.Literals(["pending", "copying", "normalizing", "ready", "unknown", "failed"]),
});
export const CreateModeratedDanceReference = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts/:postId/dance/moderated-references",
  auth: account,
  request: {
    path: Schema.Struct({ communityId: Id, postId: Id }),
    bodyEncoding: "exact-json",
    body: CreateModeratedDanceReferenceBody,
  },
  response: ModeratedDanceReferenceStatus,
  errors,
});

export const GetModeratedDanceReferenceStatus = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/dance/moderated-references/:choreographyId",
  auth: account,
  cacheControl: "private, no-store",
  request: { path: Schema.Struct({ communityId: Id, postId: Id, choreographyId: Id }) },
  response: ModeratedDanceReferenceStatus,
  errors,
});

export const CreateModeratedDanceMediaAccess = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/reviews/:reviewId/media-access",
  auth: account,
  cacheControl: "private, no-store",
  request: {
    path: Schema.Struct({ communityId: Id, reviewId: Id }),
    bodyEncoding: "exact-json",
    body: Schema.Struct({
      version: Schema.Literal("dance-private-media-access-v1"),
      expected_review_revision: Positive,
      audience: Schema.Literals(["dancer", "owner"]),
    }),
  },
  response: Schema.Struct({
    version: Schema.Literal("dance-private-media-access-v1"),
    lease_id: Id,
    expires_at_ms: Positive,
    url: Schema.NonEmptyString,
  }),
  errors,
});
