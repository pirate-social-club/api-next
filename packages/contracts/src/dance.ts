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
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const NonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
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
const PublicResourceHref = Schema.NonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) =>
    value.startsWith("/") &&
    !value.startsWith("//") &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
      ? undefined
      : "Expected a bounded public resource path",
  ),
);

export const DanceMirrorPolicyV1 = Schema.Literals(["strict", "allowed"]);
export type DanceMirrorPolicyV1 = Schema.Schema.Type<typeof DanceMirrorPolicyV1>;

export const DanceChoreographyStatusV1 = Schema.Literals([
  "draft",
  "processing",
  "ready",
  "disabled",
  "retired",
]);
export type DanceChoreographyStatusV1 = Schema.Schema.Type<typeof DanceChoreographyStatusV1>;

export const DanceChoreographyRevisionStatusV1 = Schema.Literals([
  "processing",
  "ready",
  "processing_failed",
  "disabled",
  "retired",
]);
export type DanceChoreographyRevisionStatusV1 = Schema.Schema.Type<
  typeof DanceChoreographyRevisionStatusV1
>;

export const DanceSegmentBoundsV1 = Schema.Struct({
  start_ms: NonNegativeInteger,
  end_ms: PositiveInteger,
}).check(
  Schema.makeFilter(({ start_ms, end_ms }) => {
    const duration = end_ms - start_ms;
    return end_ms > start_ms && duration >= 6_000 && duration <= 30_000
      ? undefined
      : "Expected a half-open Dance interval between 6000 and 30000 milliseconds";
  }),
);
export type DanceSegmentBoundsV1 = Schema.Schema.Type<typeof DanceSegmentBoundsV1>;

export const DanceReferenceInputV1 = Schema.Struct({
  audio_revision: PositiveInteger,
  reference_video_post_id: BoundedIdentifier,
  start_ms: NonNegativeInteger,
  end_ms: PositiveInteger,
  mirror_policy: DanceMirrorPolicyV1,
}).check(
  Schema.makeFilter(({ start_ms, end_ms }) => {
    const duration = end_ms - start_ms;
    return end_ms > start_ms && duration >= 6_000 && duration <= 30_000
      ? undefined
      : "Expected a half-open Dance interval between 6000 and 30000 milliseconds";
  }),
);
export type DanceReferenceInputV1 = Schema.Schema.Type<typeof DanceReferenceInputV1>;

export const DanceSongSegmentV1 = Schema.Struct({
  segment_id: BoundedIdentifier,
  song_post_id: BoundedIdentifier,
  audio_revision: PositiveInteger,
  start_ms: NonNegativeInteger,
  end_ms: PositiveInteger,
  duration_ms: Schema.Int.check(Schema.isBetween({ minimum: 6_000, maximum: 30_000 })),
  canonical_segment_sha256: Sha256,
  extraction_policy_version: BoundedIdentifier,
  segment_terms_hash: Sha256,
}).check(
  Schema.makeFilter(({ start_ms, end_ms, duration_ms }) =>
    end_ms > start_ms && duration_ms === end_ms - start_ms
      ? undefined
      : "Dance segment duration must equal its half-open bounds",
  ),
);
export type DanceSongSegmentV1 = Schema.Schema.Type<typeof DanceSongSegmentV1>;

export const DanceChoreographyV1 = Schema.Struct({
  object: Schema.Literal("dance_choreography"),
  choreography_id: BoundedIdentifier,
  song_post_id: BoundedIdentifier,
  creator_persona_id: PersonaIdV1,
  status: DanceChoreographyStatusV1,
  active_revision: Schema.NullOr(PositiveInteger),
  created_at: CanonicalInstant,
  disabled_at: Schema.NullOr(CanonicalInstant),
  retired_at: Schema.NullOr(CanonicalInstant),
}).check(
  Schema.makeFilter((choreography) => {
    if (choreography.status === "ready" && choreography.active_revision === null) {
      return "A ready Dance choreography requires an active revision";
    }
    if (
      ["draft", "processing"].includes(choreography.status) &&
      choreography.active_revision !== null
    ) {
      return "A not-ready Dance choreography cannot carry an active revision";
    }
    if (choreography.status === "disabled" && choreography.disabled_at === null) {
      return "A disabled Dance choreography requires its cutoff instant";
    }
    if (choreography.status === "disabled" && choreography.retired_at !== null) {
      return "A disabled Dance choreography cannot carry a retirement instant";
    }
    if (choreography.status === "retired" && choreography.retired_at === null) {
      return "A retired Dance choreography requires its retirement instant";
    }
    if (
      ["draft", "processing", "ready"].includes(choreography.status) &&
      (choreography.disabled_at !== null || choreography.retired_at !== null)
    ) {
      return "An active Dance choreography cannot carry a terminal instant";
    }
    return undefined;
  }),
);
export type DanceChoreographyV1 = Schema.Schema.Type<typeof DanceChoreographyV1>;

export const DanceReferenceProcessingV1 = Schema.Struct({
  object: Schema.Literal("dance_reference_processing"),
  choreography_id: BoundedIdentifier,
  revision: PositiveInteger,
  song_post_id: BoundedIdentifier,
  audio_revision: PositiveInteger,
  reference_video_post_id: BoundedIdentifier,
  start_ms: NonNegativeInteger,
  end_ms: PositiveInteger,
  mirror_policy: DanceMirrorPolicyV1,
  status: DanceChoreographyRevisionStatusV1,
  segment: Schema.NullOr(DanceSongSegmentV1),
  reference_video_scored_start_ms: Schema.NullOr(NonNegativeInteger),
  reference_video_scored_end_ms: Schema.NullOr(PositiveInteger),
  processing_failure_code: Schema.NullOr(BoundedIdentifier),
  revision_terms_hash: Sha256,
  created_at: CanonicalInstant,
  terminal_at: Schema.NullOr(CanonicalInstant),
}).check(
  Schema.makeFilter((processing) => {
    const duration = processing.end_ms - processing.start_ms;
    if (processing.end_ms <= processing.start_ms || duration < 6_000 || duration > 30_000) {
      return "Dance processing must retain the submitted half-open interval";
    }
    const scoredStart = processing.reference_video_scored_start_ms;
    const scoredEnd = processing.reference_video_scored_end_ms;
    if ((scoredStart === null) !== (scoredEnd === null)) {
      return "A mapped Dance reference window must be complete";
    }
    if (scoredStart !== null && scoredEnd !== null && scoredEnd <= scoredStart) {
      return "A mapped Dance reference window must be increasing";
    }
    if (processing.status === "processing") {
      return processing.terminal_at === null && processing.processing_failure_code === null
        ? undefined
        : "A processing Dance revision cannot carry a terminal result";
    }
    if (processing.terminal_at === null) {
      return "A terminal Dance revision requires its terminal instant";
    }
    if (["ready", "disabled", "retired"].includes(processing.status)) {
      return processing.segment !== null &&
        scoredStart !== null &&
        scoredEnd !== null &&
        processing.processing_failure_code === null
        ? undefined
        : "A ready-derived Dance revision requires its segment and mapped reference window";
    }
    if (processing.status === "processing_failed") {
      return processing.processing_failure_code === null
        ? "A failed Dance revision requires a bounded failure code"
        : undefined;
    }
    return undefined;
  }),
);
export type DanceReferenceProcessingV1 = Schema.Schema.Type<typeof DanceReferenceProcessingV1>;

export const DanceReferenceVideoV1 = Schema.Struct({
  post_id: BoundedIdentifier,
  href: PublicResourceHref,
});
export type DanceReferenceVideoV1 = Schema.Schema.Type<typeof DanceReferenceVideoV1>;

/** Public and persona-only; account, provider, artifact, and score facts are absent. */
export const DanceChoreographyPublicRevisionV1 = Schema.Struct({
  object: Schema.Literal("dance_choreography_revision"),
  choreography_id: BoundedIdentifier,
  revision: PositiveInteger,
  song_post_id: BoundedIdentifier,
  audio_revision: PositiveInteger,
  segment: DanceSongSegmentV1,
  readiness: Schema.Literal("ready"),
  mirror_policy: DanceMirrorPolicyV1,
  reference_video: DanceReferenceVideoV1,
  creator_persona: PublicPersonaV1,
  is_active_revision: Schema.Boolean,
  featured: Schema.Boolean,
  revision_terms_hash: Sha256,
  created_at: CanonicalInstant,
  ready_at: CanonicalInstant,
});
export type DanceChoreographyPublicRevisionV1 = Schema.Schema.Type<
  typeof DanceChoreographyPublicRevisionV1
>;

export const DanceReadyChoreographyListV1 = Schema.Struct({
  object: Schema.Literal("dance_choreography_list"),
  song_post_id: BoundedIdentifier,
  audio_revision: PositiveInteger,
  items: Schema.Array(DanceChoreographyPublicRevisionV1).check(Schema.isMaxLength(100)),
  next_cursor: Schema.NullOr(BoundedIdentifier),
});
export type DanceReadyChoreographyListV1 = Schema.Schema.Type<typeof DanceReadyChoreographyListV1>;

const DanceSongPresentationIdentityV1 = {
  object: Schema.Literal("song_dance_presentation"),
  song_post_id: BoundedIdentifier,
  audio_revision: PositiveInteger,
  presentation_revision: PositiveInteger,
  updated_at: CanonicalInstant,
} as const;

export const DanceFeaturedSongPresentationV1 = Schema.Struct({
  ...DanceSongPresentationIdentityV1,
  featured: Schema.Struct({
    choreography_id: BoundedIdentifier,
    choreography_revision: PositiveInteger,
  }),
});
export type DanceFeaturedSongPresentationV1 = Schema.Schema.Type<
  typeof DanceFeaturedSongPresentationV1
>;

export const DanceClearedSongPresentationV1 = Schema.Struct({
  ...DanceSongPresentationIdentityV1,
  featured: Schema.Null,
});
export type DanceClearedSongPresentationV1 = Schema.Schema.Type<
  typeof DanceClearedSongPresentationV1
>;

export const DanceSongPresentationV1 = Schema.Union([
  DanceFeaturedSongPresentationV1,
  DanceClearedSongPresentationV1,
]);
export type DanceSongPresentationV1 = Schema.Schema.Type<typeof DanceSongPresentationV1>;

const CommunityPostPath = Schema.Struct({
  communityId: BoundedIdentifier,
  postId: BoundedIdentifier,
});
const ChoreographyPath = Schema.Struct({
  communityId: BoundedIdentifier,
  choreographyId: BoundedIdentifier,
});
const ChoreographyRevisionPath = Schema.Struct({
  communityId: BoundedIdentifier,
  choreographyId: BoundedIdentifier,
  revision: CanonicalPositiveInteger,
});
const DanceCommandErrors = [AuthError, BadRequest, Conflict, NotFound, InternalError] as const;

export const CreateDanceChoreography = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts/:postId/dance/choreographies",
  auth: Auth.userOrAdmin(),
  request: {
    path: CommunityPostPath,
    body: Schema.Struct({
      idempotency_key: BoundedIdentifier,
      creator_persona_id: PersonaIdV1,
      audio_revision: PositiveInteger,
      reference_video_post_id: BoundedIdentifier,
      start_ms: NonNegativeInteger,
      end_ms: PositiveInteger,
      mirror_policy: DanceMirrorPolicyV1,
    }).check(
      Schema.makeFilter(({ start_ms, end_ms }) => {
        const duration = end_ms - start_ms;
        return end_ms > start_ms && duration >= 6_000 && duration <= 30_000
          ? undefined
          : "Expected a half-open Dance interval between 6000 and 30000 milliseconds";
      }),
    ),
  },
  response: Schema.Struct({
    choreography: DanceChoreographyV1,
    processing: DanceReferenceProcessingV1,
    replayed: Schema.Boolean,
  }),
  successStatus: [200, 202],
  errors: [...DanceCommandErrors, RateLimited],
});

export const GetDanceChoreographyProcessing = endpoint({
  method: "GET",
  path: "/communities/:communityId/dance/choreographies/:choreographyId",
  auth: Auth.userOrAdmin(),
  request: { path: ChoreographyPath },
  response: Schema.Struct({
    choreography: DanceChoreographyV1,
    revisions: Schema.NonEmptyArray(DanceReferenceProcessingV1).check(Schema.isMaxLength(100)),
  }),
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const AppendDanceChoreographyRevision = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/choreographies/:choreographyId/revisions",
  auth: Auth.userOrAdmin(),
  request: {
    path: ChoreographyPath,
    body: Schema.Struct({
      idempotency_key: BoundedIdentifier,
      audio_revision: PositiveInteger,
      reference_video_post_id: BoundedIdentifier,
      start_ms: NonNegativeInteger,
      end_ms: PositiveInteger,
      mirror_policy: DanceMirrorPolicyV1,
    }).check(
      Schema.makeFilter(({ start_ms, end_ms }) => {
        const duration = end_ms - start_ms;
        return end_ms > start_ms && duration >= 6_000 && duration <= 30_000
          ? undefined
          : "Expected a half-open Dance interval between 6000 and 30000 milliseconds";
      }),
    ),
  },
  response: Schema.Struct({
    choreography: DanceChoreographyV1,
    processing: DanceReferenceProcessingV1,
    replayed: Schema.Boolean,
  }),
  successStatus: [200, 202],
  errors: [...DanceCommandErrors, RateLimited],
});

export const DisableDanceChoreography = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/choreographies/:choreographyId/disable",
  auth: Auth.userOrAdmin(),
  request: {
    path: ChoreographyPath,
    body: Schema.Struct({
      idempotency_key: BoundedIdentifier,
      reason: Schema.Literals(["rights", "safety"]),
    }),
  },
  response: Schema.Struct({ choreography: DanceChoreographyV1, replayed: Schema.Boolean }),
  errors: DanceCommandErrors,
});

export const RetireDanceChoreography = endpoint({
  method: "POST",
  path: "/communities/:communityId/dance/choreographies/:choreographyId/retire",
  auth: Auth.userOrAdmin(),
  request: {
    path: ChoreographyPath,
    body: Schema.Struct({ idempotency_key: BoundedIdentifier }),
  },
  response: Schema.Struct({ choreography: DanceChoreographyV1, replayed: Schema.Boolean }),
  errors: DanceCommandErrors,
});

export const ListReadyDanceChoreographies = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/dance/choreographies",
  auth: Auth.user({ optionalUser: true }),
  request: {
    path: CommunityPostPath,
    query: Schema.Struct({
      audio_revision: CanonicalPositiveInteger,
      cursor: Schema.optional(BoundedIdentifier),
      limit: Schema.optional(Schema.String.check(Schema.isPattern(/^(?:[1-9]|[1-9][0-9]|100)$/u))),
    }),
  },
  response: DanceReadyChoreographyListV1,
  errors: [BadRequest, NotFound, InternalError],
});

export const GetDanceChoreographyRevision = endpoint({
  method: "GET",
  path: "/communities/:communityId/dance/choreographies/:choreographyId/revisions/:revision",
  auth: Auth.user({ optionalUser: true }),
  request: { path: ChoreographyRevisionPath },
  response: DanceChoreographyPublicRevisionV1,
  errors: [BadRequest, NotFound, InternalError],
});

export const SetSongDancePresentation = endpoint({
  method: "PUT",
  path: "/communities/:communityId/posts/:postId/dance/presentation",
  auth: Auth.userOrAdmin(),
  request: {
    path: CommunityPostPath,
    body: Schema.Struct({
      idempotency_key: BoundedIdentifier,
      audio_revision: PositiveInteger,
      choreography_id: BoundedIdentifier,
      choreography_revision: PositiveInteger,
    }),
  },
  response: Schema.Struct({
    presentation: DanceFeaturedSongPresentationV1,
    replayed: Schema.Boolean,
  }),
  errors: DanceCommandErrors,
});

export const ClearSongDancePresentation = endpoint({
  method: "DELETE",
  path: "/communities/:communityId/posts/:postId/dance/presentation",
  auth: Auth.userOrAdmin(),
  request: {
    path: CommunityPostPath,
    body: Schema.Struct({
      idempotency_key: BoundedIdentifier,
      audio_revision: PositiveInteger,
    }),
  },
  response: Schema.Struct({
    presentation: DanceClearedSongPresentationV1,
    replayed: Schema.Boolean,
  }),
  errors: DanceCommandErrors,
});
