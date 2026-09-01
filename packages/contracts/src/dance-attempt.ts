import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, Conflict, InternalError, NotFound, RateLimited } from "./errors.ts";
import { PersonaIdV1 } from "./personas.ts";

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
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const NonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const BasisPoints = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }));
const CanonicalPositiveInteger = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]{0,15}$/u),
  Schema.makeFilter((value) =>
    Number.isSafeInteger(Number(value)) ? undefined : "Expected a safe positive integer",
  ),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);
const SignedUploadUrl = Schema.NonEmptyString.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? undefined : "Expected an HTTPS upload URL";
    } catch {
      return "Expected an HTTPS upload URL";
    }
  }),
);

export const DanceSessionStateV1 = Schema.Literals([
  "created",
  "consented",
  "awaiting_upload",
  "uploaded",
  "grading_pending",
  "completed",
  "rejected",
  "processing_failed",
  "expired",
  "abandoned",
]);
export type DanceSessionStateV1 = Schema.Schema.Type<typeof DanceSessionStateV1>;

export const DanceStartCueKindV1 = Schema.Literals(["hands_on_head", "arms_t", "hands_on_hips"]);
export type DanceStartCueKindV1 = Schema.Schema.Type<typeof DanceStartCueKindV1>;

export const DanceStartCueV1 = Schema.Struct({
  kind: DanceStartCueKindV1,
  hold_ms: PositiveInteger,
  observation_start_ms: NonNegativeInteger,
  observation_end_ms: PositiveInteger,
}).check(
  Schema.makeFilter(({ hold_ms, observation_start_ms, observation_end_ms }) => {
    const windowMs = observation_end_ms - observation_start_ms;
    return observation_end_ms > observation_start_ms && hold_ms <= windowMs
      ? undefined
      : "Dance cue hold must fit inside its observation window";
  }),
);
export type DanceStartCueV1 = Schema.Schema.Type<typeof DanceStartCueV1>;

export const DanceShadowPolicySnapshotV1 = Schema.Struct({
  qualification_policy_version_id: BoundedIdentifier,
  calibration_version_id: BoundedIdentifier,
  calibration_checksum: Sha256,
  captured_admission_state: Schema.Literal("shadow"),
  platform_floor_bps: BasisPoints,
  pose_model_version: BoundedIdentifier,
  feature_schema_version: BoundedIdentifier,
  scorer_contract_version: BoundedIdentifier,
  mirror_policy_version: BoundedIdentifier,
  cue_policy_version: BoundedIdentifier,
  fingerprint_policy_version: BoundedIdentifier,
  integrity_policy_version: BoundedIdentifier,
  grader_adapter_version: BoundedIdentifier,
});
export type DanceShadowPolicySnapshotV1 = Schema.Schema.Type<typeof DanceShadowPolicySnapshotV1>;

export const DanceAttemptEvidenceSummaryV1 = Schema.Struct({
  schema_version: Schema.Literal(1),
  usable_coverage_bps: BasisPoints,
  selected_mirror: Schema.Literals(["original", "mirrored"]),
  meaningful_motion_accepted: Schema.Boolean,
  replay_outcome: Schema.Literals(["unique", "duplicate", "rejected"]),
  subject_continuity: Schema.Literal("stable"),
});
export type DanceAttemptEvidenceSummaryV1 = Schema.Schema.Type<
  typeof DanceAttemptEvidenceSummaryV1
>;

export const DanceAttemptTerminalResultV1 = Schema.Struct({
  object: Schema.Literal("dance_attempt_result"),
  attempt_id: BoundedIdentifier,
  grade_outcome: Schema.Literals(["scored", "rejected", "failed"]),
  qualification_outcome: Schema.Literal("suppressed_shadow"),
  score_bps: Schema.NullOr(BasisPoints),
  rejection_code: Schema.NullOr(BoundedIdentifier),
  scored_window_start_ms: NonNegativeInteger,
  scored_window_end_ms: PositiveInteger,
  scored_duration_ms: PositiveInteger,
  evidence_summary: Schema.NullOr(DanceAttemptEvidenceSummaryV1),
  completed_at: CanonicalInstant,
}).check(
  Schema.makeFilter((result) => {
    if (
      result.scored_window_end_ms <= result.scored_window_start_ms ||
      result.scored_duration_ms !== result.scored_window_end_ms - result.scored_window_start_ms ||
      result.scored_duration_ms < 6_000 ||
      result.scored_duration_ms > 30_000
    ) {
      return "Dance terminal evidence must retain an exact 6-30 second scored window";
    }
    if (result.grade_outcome === "scored") {
      return result.score_bps !== null &&
        result.rejection_code === null &&
        result.evidence_summary !== null
        ? undefined
        : "A scored Dance result requires bounded evidence and no rejection code";
    }
    return result.score_bps === null && result.rejection_code !== null
      ? undefined
      : "A non-scored Dance result requires a rejection code and no score";
  }),
);
export type DanceAttemptTerminalResultV1 = Schema.Schema.Type<typeof DanceAttemptTerminalResultV1>;

export const DancePrivateSessionV1 = Schema.Struct({
  object: Schema.Literal("dance_session"),
  session_id: BoundedIdentifier,
  persona_id: PersonaIdV1,
  community_id: BoundedIdentifier,
  song_post_id: BoundedIdentifier,
  audio_revision: PositiveInteger,
  segment_id: BoundedIdentifier,
  choreography_id: BoundedIdentifier,
  choreography_revision: PositiveInteger,
  reward_mode: Schema.Literal("practice"),
  objective_snapshot: Schema.Tuple([]),
  expected_scored_duration_ms: Schema.Int.check(
    Schema.isBetween({ minimum: 6_000, maximum: 30_000 }),
  ),
  cue: DanceStartCueV1,
  policy: DanceShadowPolicySnapshotV1,
  session_terms_hash: Sha256,
  state: DanceSessionStateV1,
  consented_at: Schema.NullOr(CanonicalInstant),
  upload_state: Schema.Literals(["none", "reserved", "sealed", "cleanup_pending", "deleted"]),
  attempt_id: Schema.NullOr(BoundedIdentifier),
  result: Schema.NullOr(DanceAttemptTerminalResultV1),
  created_at: CanonicalInstant,
  expires_at: CanonicalInstant,
}).check(
  Schema.makeFilter((session) => {
    if (Date.parse(session.expires_at) <= Date.parse(session.created_at)) {
      return "Dance session expiry must follow creation";
    }
    if (session.state === "created" && session.consented_at !== null) {
      return "A created Dance session cannot carry consent";
    }
    if (
      !["created", "expired", "abandoned"].includes(session.state) &&
      session.consented_at === null
    ) {
      return "A post-consent Dance session requires its consent instant";
    }
    const terminal = ["completed", "rejected", "processing_failed"].includes(session.state);
    if (terminal !== (session.result !== null)) {
      return "Dance terminal state and result must agree";
    }
    if (session.result !== null && session.result.attempt_id !== session.attempt_id) {
      return "Dance session and terminal result must bind the same attempt";
    }
    if (["grading_pending", "completed", "rejected", "processing_failed"].includes(session.state)) {
      if (session.attempt_id === null) return "A grading-derived Dance state requires its attempt";
    }
    if (
      ["uploaded", "grading_pending", "completed", "rejected", "processing_failed"].includes(
        session.state,
      )
    ) {
      return session.upload_state === "sealed" ||
        session.upload_state === "cleanup_pending" ||
        session.upload_state === "deleted"
        ? undefined
        : "A post-upload Dance session requires sealed or cleanup-state media";
    }
    return undefined;
  }),
);
export type DancePrivateSessionV1 = Schema.Schema.Type<typeof DancePrivateSessionV1>;

export const DanceUploadReservationV1 = Schema.Struct({
  object: Schema.Literal("dance_upload_reservation"),
  reservation_id: BoundedIdentifier,
  session_id: BoundedIdentifier,
  upload_url: SignedUploadUrl,
  expected_content_type: Schema.Literals(["video/mp4", "video/quicktime", "video/webm"]),
  expected_size_bytes: PositiveInteger,
  expected_duration_ms: PositiveInteger,
  expires_at: CanonicalInstant,
});
export type DanceUploadReservationV1 = Schema.Schema.Type<typeof DanceUploadReservationV1>;

const CommunityDanceSessionPath = Schema.Struct({
  communityId: BoundedIdentifier,
  sessionId: BoundedIdentifier,
});
const DanceSessionCreatePath = Schema.Struct({
  communityId: BoundedIdentifier,
  postId: BoundedIdentifier,
  choreographyId: BoundedIdentifier,
  revision: CanonicalPositiveInteger,
});
const DanceAttemptErrors = [AuthError, BadRequest, Conflict, NotFound, InternalError] as const;

export const CreateDanceSession = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts/:postId/dance/choreographies/:choreographyId/revisions/:revision/sessions",
  auth: Auth.user(),
  request: {
    path: DanceSessionCreatePath,
    body: Schema.Struct({
      idempotency_key: BoundedIdentifier,
      persona_id: PersonaIdV1,
      reward_mode: Schema.Literal("practice"),
    }),
  },
  response: Schema.Struct({ session: DancePrivateSessionV1, replayed: Schema.Boolean }),
  successStatus: [200, 201],
  errors: [...DanceAttemptErrors, RateLimited],
});

export const RecordDanceSessionConsent = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/sessions/:sessionId/consent",
  auth: Auth.user(),
  request: {
    path: CommunityDanceSessionPath,
    body: Schema.Struct({
      idempotency_key: BoundedIdentifier,
      persona_id: PersonaIdV1,
      session_terms_hash: Sha256,
      consent_policy_version_id: BoundedIdentifier,
      retention_disclosure_version: BoundedIdentifier,
      source: Schema.Literals(["camera", "file_upload"]),
    }),
  },
  response: Schema.Struct({ session: DancePrivateSessionV1, replayed: Schema.Boolean }),
  errors: DanceAttemptErrors,
});

export const ReserveDanceSessionUpload = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/sessions/:sessionId/upload-reservations",
  auth: Auth.user(),
  request: {
    path: CommunityDanceSessionPath,
    body: Schema.Struct({
      idempotency_key: BoundedIdentifier,
      expected_content_type: Schema.Literals(["video/mp4", "video/quicktime", "video/webm"]),
      expected_size_bytes: PositiveInteger,
      expected_duration_ms: PositiveInteger,
      expected_sha256: Schema.optional(Sha256),
    }),
  },
  response: Schema.Struct({
    session: DancePrivateSessionV1,
    reservation: DanceUploadReservationV1,
    replayed: Schema.Boolean,
  }),
  successStatus: [200, 201],
  errors: [...DanceAttemptErrors, RateLimited],
});

export const FinalizeDanceSessionUpload = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/sessions/:sessionId/upload/finalize",
  auth: Auth.user(),
  request: {
    path: CommunityDanceSessionPath,
    body: Schema.Struct({
      idempotency_key: BoundedIdentifier,
      reservation_id: BoundedIdentifier,
    }),
  },
  response: Schema.Struct({ session: DancePrivateSessionV1, replayed: Schema.Boolean }),
  errors: DanceAttemptErrors,
});

export const SubmitDanceSessionForGrading = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/sessions/:sessionId/grading-submissions",
  auth: Auth.user(),
  request: {
    path: CommunityDanceSessionPath,
    body: Schema.Struct({ idempotency_key: BoundedIdentifier }),
  },
  response: Schema.Struct({ session: DancePrivateSessionV1, replayed: Schema.Boolean }),
  successStatus: [200, 202],
  errors: [...DanceAttemptErrors, RateLimited],
});

export const GetDanceSession = endpoint({
  method: "GET",
  path: "/communities/:communityId/dance/sessions/:sessionId",
  auth: Auth.user(),
  request: { path: CommunityDanceSessionPath },
  response: DancePrivateSessionV1,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});
