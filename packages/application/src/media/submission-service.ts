import {
  BadRequest,
  BindSongLyricsV1,
  BindSongReferenceV1,
  BindSongTermsV1,
  Conflict,
  CreateSongSubmissionV1,
  IdempotencyConflict,
  InternalError,
  MediaPostSubmissionV1,
  MembershipRequired,
  ModerateSongSubmissionV1,
  NotFound,
  RetryOrCancelSongSubmissionV1,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type {
  BoundReference,
  MediaSubmissionState,
  ModeratorApprovalEvidence,
  PublicationDecision,
  SongTerms,
} from "../../../domain/src/media-submission.ts";
import { transitionMediaSubmission } from "../../../domain/src/media-submission.ts";
import type { M2Actor } from "../ports.ts";
import type { PersonaRecord, PersonaStoreService } from "../use-cases/personas.ts";

export const MEDIA_SUBMISSION_ENDPOINTS = {
  create: "/communities/:communityId/media-post-submissions",
  terms: "/media-post-submissions/:submissionId/terms",
  lyrics: "/media-post-submissions/:submissionId/lyrics",
  finalize: "/media-post-submissions/:submissionId/finalize",
  reference: "/media-post-submissions/:submissionId/reference",
  retry: "/media-post-submissions/:submissionId/retry",
  cancel: "/media-post-submissions/:submissionId/cancel",
  moderate: "/moderation/media-post-submissions/:submissionId/actions",
} as const;

type Bytes = Uint8Array;
type ReplayOutcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "replay";
      readonly submissionId: string;
      readonly operationId: string;
      readonly bytes: Bytes;
      readonly sha256: string;
    }
  | { readonly kind: "conflict"; readonly submissionId: string };
type CommitOutcome = ReplayOutcome | { readonly kind: "committed"; readonly submissionId: string };
type CreatedOutcome =
  | ReplayOutcome
  | {
      readonly kind: "created";
      readonly submissionId: string;
      readonly operationId: string;
      readonly bytes: Bytes;
      readonly sha256: string;
    };

export type MediaReservationOutcome =
  | Readonly<{
      readonly kind: "created" | "replay";
      readonly reservationId: string;
      readonly bytes: Bytes;
      readonly sha256: string;
    }>
  | Readonly<{ readonly kind: "conflict"; readonly reservationId: string }>;

export type MediaFinalizeContext = Readonly<{
  readonly view: MediaSubmissionView;
  readonly reservation: Readonly<{
    readonly reservationId: string;
    readonly state: "claimed";
    readonly expectedContentType: string;
    readonly expectedSizeBytes: number;
    readonly expectedSha256: string | null;
    readonly expiresAt: string;
  }>;
}>;

export type MediaLyricsSnapshot = Readonly<{
  asrSuggestion:
    | { readonly status: "pending" }
    | { readonly status: "ready"; readonly transcriptRevision: number; readonly text: string }
    | { readonly status: "no_speech" }
    | { readonly status: "unavailable" };
  current:
    | { readonly status: "not_bound" }
    | Readonly<{
        readonly status: "ready";
        readonly lyricsRevision: number;
        readonly audioRevision: number;
        readonly canonicalAudioSha256: string;
        readonly text: string;
        readonly baseTranscriptRevision: number | null;
        readonly provenance: "asr_accepted" | "pasted" | "corrected";
      }>
    | { readonly status: "no_lyrics" };
}>;

export type MediaSubmissionView = Readonly<{
  readonly state: MediaSubmissionState;
  readonly lyrics: MediaLyricsSnapshot;
  readonly updatedAt: string;
}>;

export type MediaModeratorView = MediaSubmissionView &
  Readonly<{
    readonly authorPersona: MediaPostSubmissionV1["author_persona"];
  }>;

export type MediaCommandBase = Readonly<{
  readonly communityId: string;
  readonly submissionId: string;
  readonly actorUserId: string;
  readonly personaId: string;
  readonly endpointTemplate: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly responseBytes: Bytes;
  readonly responseSha256: string;
}>;

export type MediaOutboxWrite = Readonly<{
  readonly outboxEventId: string;
  readonly effectIdentity: string;
  readonly payload: Readonly<Record<string, unknown>>;
}>;

export class MediaUploadStoreError extends Error {
  readonly reason:
    | "invalid-input"
    | "not-found"
    | "membership-required"
    | "idempotency-conflict"
    | "stale-revision"
    | "reservation-conflict"
    | "immutable-object-conflict"
    | "transition-rejected"
    | "constraint"
    | "invalid-row"
    | "stale-fence"
    | "closed-payload"
    | "unavailable";
  readonly submissionId: string | undefined;
  readonly reservationId: string | undefined;

  constructor(input: {
    readonly reason: MediaUploadStoreError["reason"];
    readonly submissionId?: string;
    readonly reservationId?: string;
  }) {
    super("media upload store operation failed");
    this.name = "MediaUploadStoreError";
    this.reason = input.reason;
    this.submissionId = input.submissionId;
    this.reservationId = input.reservationId;
  }
}

export interface MediaUploadStore {
  readonly reserve: (input: {
    readonly communityId: string;
    readonly actorUserId: string;
    readonly personaId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly expectedContentType: string;
    readonly expectedSizeBytes: number;
    readonly expectedSha256?: string;
    readonly uploadUrl: string;
    readonly uploadHeaders: readonly Readonly<{ name: string; value: string }>[];
    readonly expiresAt: string;
    readonly responseBytes: Bytes;
    readonly responseSha256: string;
    readonly reservationId: string;
  }) => Promise<MediaReservationOutcome>;
  readonly replay: (input: {
    readonly communityId: string;
    readonly actorUserId: string;
    readonly personaId: string | null;
    readonly endpointTemplate: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }) => Promise<ReplayOutcome>;
  readonly createSubmission: (
    input: Readonly<{
      readonly communityId: string;
      readonly actorUserId: string;
      readonly personaId: string;
      readonly idempotencyKey: string;
      readonly requestHash: string;
      readonly title: string;
      readonly songType: "original" | "remix";
      readonly reservationId: string;
      readonly submissionId: string;
      readonly operationId: string;
      readonly responseBytes: Bytes;
      readonly responseSha256: string;
    }>,
  ) => Promise<CreatedOutcome>;
  readonly getViewForAuthor: (input: {
    readonly submissionId: string;
    readonly actorUserId: string;
    readonly personaId: string;
  }) => Promise<MediaSubmissionView | null>;
  readonly getViewForModerator: (input: {
    readonly submissionId: string;
    readonly moderatorActor: M2Actor;
  }) => Promise<MediaModeratorView | null>;
  readonly getFinalizeContext: (input: {
    readonly submissionId: string;
    readonly actorUserId: string;
    readonly personaId: string;
    readonly reservationId: string;
  }) => Promise<MediaFinalizeContext | null>;
  readonly bindTerms: (
    input: MediaCommandBase & Readonly<{ expectedCreationRevision: number; terms: SongTerms; outbox?: MediaOutboxWrite }>,
  ) => Promise<CommitOutcome>;
  readonly bindLyrics: (
    input: MediaCommandBase &
      Readonly<{
        expectedCreationRevision: number;
        expectedAudioRevision: number;
        lyrics: string;
        baseTranscriptRevision: number | null;
        outbox: MediaOutboxWrite;
      }>,
  ) => Promise<CommitOutcome>;
  readonly bindReference: (
    input: MediaCommandBase &
      Readonly<{ expectedCreationRevision: number; reference: BoundReference }>,
  ) => Promise<CommitOutcome>;
  readonly retry: (
    input: MediaCommandBase & Readonly<{ expectedCreationRevision: number }>,
  ) => Promise<CommitOutcome>;
  readonly authorCancel: (
    input: MediaCommandBase & Readonly<{ expectedCreationRevision: number }>,
  ) => Promise<CommitOutcome>;
  readonly moderate: (
    input: Omit<MediaCommandBase, "actorUserId" | "personaId"> &
      Readonly<{
        expectedCreationRevision: number;
        action: "approve" | "block";
        actor: M2Actor;
        approval?: ModeratorApprovalEvidence;
        evidenceRef?: string;
        decision?: PublicationDecision;
        outbox?: MediaOutboxWrite;
      }>,
  ) => Promise<CommitOutcome>;
  readonly finalizeSealed: (
    input: MediaCommandBase &
      Readonly<{
        expectedCreationRevision: number;
        expectedAudioRevision: number;
        reservationId: string;
        immutableObject: Readonly<{
          immutableRef: string;
          destinationRef: string;
          etag: string;
          objectVersion: string;
          sizeBytes: number;
          contentType: string;
          canonicalSha256: string;
        }>;
        outbox: MediaOutboxWrite;
      }>,
  ) => Promise<CommitOutcome & Partial<{ immutableRef: string; outboxEventId: string }>>;
  readonly recordFinalizeSourceMissing: (
    input: MediaCommandBase & Readonly<{ operationId: string }>,
  ) => Promise<ReplayOutcome | { readonly kind: "committed"; readonly submissionId: string }>;
  readonly uploadExpectationMismatch: (
    input: MediaCommandBase &
      Readonly<{ expectedCreationRevision: number; evidenceRef: string }>,
  ) => Promise<CommitOutcome>;
  readonly uploadSourcePreconditionFailed: (
    input: MediaCommandBase &
      Readonly<{ expectedCreationRevision: number; evidenceRef: string }>,
  ) => Promise<CommitOutcome>;
  readonly recordSealConflict: (
    input: MediaCommandBase &
      Readonly<{
        expectedCreationRevision: number;
        failure: Readonly<{
          code: "upload_seal_conflict";
          retryable: false;
          retryCount: 0 | 1 | 2 | 3;
          lastSafePhase: "finalize";
          evidenceRef: string;
        }>;
      }>,
  ) => Promise<CommitOutcome>;
}

export interface MediaReferenceResolver {
  readonly resolve: (input: {
    readonly actorUserId: string;
    readonly submission: MediaSubmissionState;
    readonly referenceRequestRef: string;
    readonly upstreamAssetId: string;
  }) => Promise<BoundReference | null>;
}

export type MediaSubmissionServices = Readonly<{
  readonly store: MediaUploadStore;
  readonly personaStore: Pick<PersonaStoreService, "findOwned">;
  readonly nowIso: () => string;
  readonly referenceResolver?: MediaReferenceResolver;
}>;

const exactParseOptions = { onExcessProperty: "error" } as const;
const encoder = new TextEncoder();

function decodeBody<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, exactParseOptions)(input);
  } catch {
    throw new BadRequest({ message: "Invalid request body" });
  }
}

export function requireMediaHumanActor(actor: M2Actor): void {
  if (
    (actor.kind !== "user" && actor.kind !== "admin") ||
    actor.userId.length === 0 ||
    actor.userId !== actor.userId.trim()
  ) {
    throw new BadRequest({ message: "Only human-direct actors are supported" });
  }
}

export async function requireMediaPersona(
  actor: M2Actor,
  personaId: string,
  services: MediaSubmissionServices,
): Promise<PersonaRecord> {
  let persona: PersonaRecord | null;
  try {
    persona = await Effect.runPromise(
      services.personaStore.findOwned({ accountId: actor.userId, personaId }),
    );
  } catch {
    throw new InternalError({ message: "Persona lookup failed" });
  }
  if (persona === null || persona.status !== "active") {
    throw new NotFound({ message: "Persona not found" });
  }
  return persona;
}

export async function mediaSha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("unsupported json value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("unsupported json value");
}

export async function mediaRequestHash(target: unknown, body: unknown): Promise<string> {
  return mediaSha256Bytes(encoder.encode(canonicalJson({ target, body })));
}

export async function mediaResponseSnapshot(document: MediaPostSubmissionV1): Promise<{
  readonly document: MediaPostSubmissionV1;
  readonly bytes: Bytes;
  readonly sha256: string;
}> {
  const bytes = encoder.encode(JSON.stringify(document));
  return { document, bytes, sha256: await mediaSha256Bytes(bytes) };
}

export function decodeMediaReplay(bytes: Bytes): MediaPostSubmissionV1 {
  try {
    return Schema.decodeUnknownSync(MediaPostSubmissionV1, exactParseOptions)(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
  } catch {
    throw new InternalError({ message: "Stored media response is invalid" });
  }
}

function publicPersona(
  persona: PersonaRecord | MediaPostSubmissionV1["author_persona"],
): MediaPostSubmissionV1["author_persona"] {
  return "profile" in persona
    ? {
        persona_id: persona.persona_id,
        object: "persona",
        display_name: persona.profile.display_name,
        avatar_ref: persona.profile.avatar_ref,
        primary_public_handle: persona.profile.primary_public_handle,
      }
    : persona;
}

export function projectMediaSubmission(
  view: Readonly<{ state: MediaSubmissionState; lyrics: MediaLyricsSnapshot; updatedAt: string }>,
  persona: PersonaRecord | MediaPostSubmissionV1["author_persona"],
): MediaPostSubmissionV1 {
  const { state } = view;
  const common = {
    submission_id: state.submissionId,
    author_persona: publicPersona(persona),
    href: `/media-post-submissions/${encodeURIComponent(state.submissionId)}`,
    track: "song" as const,
    creation_revision: state.creationRevision,
    audio_revision: state.audioRevision,
    lyrics_state: {
      asr_suggestion:
        view.lyrics.asrSuggestion.status === "ready"
          ? {
              status: "ready" as const,
              transcript_revision: view.lyrics.asrSuggestion.transcriptRevision,
              text: view.lyrics.asrSuggestion.text,
            }
          : view.lyrics.asrSuggestion,
      current:
        view.lyrics.current.status === "ready"
          ? {
              status: "ready" as const,
              text: view.lyrics.current.text,
              lyrics_revision: view.lyrics.current.lyricsRevision,
              audio_revision: view.lyrics.current.audioRevision,
              base_transcript_revision: view.lyrics.current.baseTranscriptRevision,
            }
          : view.lyrics.current,
    },
    updated_at: view.updatedAt,
  };
  switch (state.status) {
    case "processing":
      if (state.phase === null) throw new Error("processing phase missing");
      return { ...common, status: "processing", phase: state.phase };
    case "action_required":
      if (state.action === null) throw new Error("required action missing");
      return {
        ...common,
        status: "action_required",
        action: {
          kind: "reference_required",
          expires_at: state.action.expiresAt,
          reference_request_ref: state.action.referenceRequestRef,
        },
      };
    case "manual_review":
      if (state.review === null) throw new Error("review missing");
      return {
        ...common,
        status: "manual_review",
        reason_code: state.review.reasonCode,
        review_ref: state.review.reviewRef,
      };
    case "published":
      if (state.postId === null) throw new Error("published post missing");
      return {
        ...common,
        status: "published",
        published_resource: {
          post_id: state.postId,
          href: `/posts/${encodeURIComponent(state.postId)}`,
        },
      };
    case "blocked":
      return { ...common, status: "blocked", reason_code: "policy_violation" };
    case "processing_failed":
      if (state.failure === null) throw new Error("failure missing");
      return {
        ...common,
        status: "processing_failed",
        reason_code: state.failure.code,
        retry_count: state.failure.retryCount,
        retryable: state.failure.retryable,
      };
    case "abandoned": {
      if (state.abandonment === null) throw new Error("abandonment missing");
      const reason = {
        reservation_expired: "upload_reservation_expired",
        upload_expectation_mismatch: "upload_expectation_mismatch",
        upload_source_changed_before_finalize: "upload_source_changed_before_finalize",
        action_deadline_elapsed: "reference_window_expired",
        author_cancelled: "author_cancelled_before_finalize",
      } as const;
      return { ...common, status: "abandoned", reason_code: reason[state.abandonment.reason] };
    }
  }
}

export function mapMediaStoreError(error: unknown): Error {
  if (!(error instanceof MediaUploadStoreError)) {
    return new InternalError({ message: "Media submission operation failed" });
  }
  switch (error.reason) {
    case "membership-required":
      return new MembershipRequired({ message: "Community membership is required" });
    case "not-found":
      return new NotFound({ message: "Media submission not found" });
    case "idempotency-conflict":
      return new IdempotencyConflict({
        message: "The idempotency key was already used with a different request",
        details: {
          reason_code: "idempotency_conflict",
          submission_id: error.submissionId ?? "unknown",
        },
      });
    case "invalid-input":
    case "constraint":
    case "closed-payload":
      return new BadRequest({ message: "Invalid media submission request" });
    case "stale-revision":
    case "reservation-conflict":
    case "immutable-object-conflict":
    case "transition-rejected":
    case "stale-fence":
      return new Conflict({
        message: "Media submission conflicts with current state",
        details: { reason_code: error.reason },
      });
    case "invalid-row":
    case "unavailable":
      return new InternalError({ message: "Media submission operation failed" });
  }
}

export function applyMediaTransition(current: MediaSubmissionState | null, command: Parameters<typeof transitionMediaSubmission>[1]): MediaSubmissionState {
  const result = transitionMediaSubmission(current, command);
  if (!result.ok) {
    throw new Conflict({
      message: "Media submission conflicts with current state",
      details: { reason_code: result.rejection._tag },
    });
  }
  return result.state;
}

function lyricsFromState(
  state: MediaSubmissionState,
  prior: MediaLyricsSnapshot["asrSuggestion"] = { status: "pending" },
): MediaLyricsSnapshot {
  return {
    asrSuggestion: prior,
    current:
      state.lyrics === null
        ? prior.status === "no_speech"
          ? { status: "no_lyrics" }
          : { status: "not_bound" }
        : { status: "ready", ...state.lyrics },
  };
}

function idempotencyConflict(submissionId: string): IdempotencyConflict {
  return new IdempotencyConflict({
    message: "The idempotency key was already used with a different request",
    details: { reason_code: "idempotency_conflict", submission_id: submissionId },
  });
}

function handleReplay(outcome: ReplayOutcome): MediaPostSubmissionV1 | null {
  if (outcome.kind === "replay") return decodeMediaReplay(outcome.bytes);
  if (outcome.kind === "conflict") throw idempotencyConflict(outcome.submissionId);
  return null;
}

async function loadOwnedView(
  submissionId: string,
  actor: M2Actor,
  personaId: string,
  services: MediaSubmissionServices,
): Promise<MediaSubmissionView> {
  let view: MediaSubmissionView | null;
  try {
    view = await services.store.getViewForAuthor({
      submissionId,
      actorUserId: actor.userId,
      personaId,
    });
  } catch (error) {
    throw mapMediaStoreError(error);
  }
  if (view === null) throw new NotFound({ message: "Media submission not found" });
  return view;
}

async function replayFirst(
  input: {
    readonly state: MediaSubmissionState;
    readonly actor: M2Actor;
    readonly personaId: string | null;
    readonly endpointTemplate: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  },
  store: MediaUploadStore,
): Promise<MediaPostSubmissionV1 | null> {
  try {
    return handleReplay(
      await store.replay({
        communityId: input.state.communityId,
        actorUserId: input.actor.userId,
        personaId: input.personaId,
        endpointTemplate: input.endpointTemplate,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      }),
    );
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof InternalError) throw error;
    throw mapMediaStoreError(error);
  }
}

function outbox(
  state: MediaSubmissionState,
  requestDigest: string,
  payload: Readonly<Record<string, unknown>>,
): MediaOutboxWrite {
  return {
    outboxEventId: `media-outbox-${requestDigest}`,
    effectIdentity: `media:${state.operationId}:${requestDigest}`,
    payload,
  };
}

export async function createMediaSubmission(
  input: Readonly<{ communityId: string; actor: M2Actor; body: unknown }>,
  services: MediaSubmissionServices,
): Promise<MediaPostSubmissionV1> {
  requireMediaHumanActor(input.actor);
  const body = decodeBody(CreateSongSubmissionV1, input.body);
  const persona = await requireMediaPersona(input.actor, body.persona_id, services);
  const digest = await mediaRequestHash({ community_id: input.communityId }, body);
  const submissionId = `media-submission-${crypto.randomUUID()}`;
  const operationId = `media-operation-${crypto.randomUUID()}`;
  const reserved = applyMediaTransition(null, {
    event: "submission_reserved",
    actorId: input.actor.userId,
    expectedCreationRevision: 0,
    submissionId,
    operationId,
    communityId: input.communityId,
    personaId: body.persona_id,
    title: body.title,
    songType: body.song_type,
    reservationId: body.audio_reservation_id,
  });
  const state = applyMediaTransition(reserved, {
    event: "media_reservation_issued",
    actorId: input.actor.userId,
    expectedCreationRevision: reserved.creationRevision,
  });
  const response = await mediaResponseSnapshot(
    projectMediaSubmission(
      { state, lyrics: lyricsFromState(state), updatedAt: services.nowIso() },
      persona,
    ),
  );
  let outcome: CreatedOutcome;
  try {
    outcome = await services.store.createSubmission({
      communityId: input.communityId,
      actorUserId: input.actor.userId,
      personaId: body.persona_id,
      idempotencyKey: body.idempotency_key,
      requestHash: digest,
      title: body.title,
      songType: body.song_type,
      reservationId: body.audio_reservation_id,
      submissionId,
      operationId,
      responseBytes: response.bytes,
      responseSha256: response.sha256,
    });
  } catch (error) {
    throw mapMediaStoreError(error);
  }
  if (outcome.kind === "replay") return decodeMediaReplay(outcome.bytes);
  if (outcome.kind === "conflict") throw idempotencyConflict(outcome.submissionId);
  return response.document;
}

export async function getMediaSubmission(
  input: Readonly<{ submissionId: string; actor: M2Actor; personaId: string }>,
  services: MediaSubmissionServices,
): Promise<MediaPostSubmissionV1> {
  requireMediaHumanActor(input.actor);
  const persona = await requireMediaPersona(input.actor, input.personaId, services);
  const view = await loadOwnedView(input.submissionId, input.actor, input.personaId, services);
  return projectMediaSubmission(view, persona);
}

async function mutationContext<S extends Schema.ConstraintDecoder<unknown>>(
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  schema: S,
  endpointTemplate: string,
  services: MediaSubmissionServices,
): Promise<Readonly<{
  body: S["Type"] & { persona_id: string; idempotency_key: string };
  persona: PersonaRecord;
  view: MediaSubmissionView;
  requestHash: string;
  replay: MediaPostSubmissionV1 | null;
}>> {
  requireMediaHumanActor(input.actor);
  const body = decodeBody(schema, input.body) as S["Type"] & {
    persona_id: string;
    idempotency_key: string;
  };
  const persona = await requireMediaPersona(input.actor, body.persona_id, services);
  const view = await loadOwnedView(input.submissionId, input.actor, body.persona_id, services);
  const digest = await mediaRequestHash({ submission_id: input.submissionId }, body);
  const replay = await replayFirst(
    {
      state: view.state,
      actor: input.actor,
      personaId: body.persona_id,
      endpointTemplate,
      idempotencyKey: body.idempotency_key,
      requestHash: digest,
    },
    services.store,
  );
  return { body, persona, view, requestHash: digest, replay };
}

async function commitSnapshot(
  outcome: CommitOutcome,
  response: Awaited<ReturnType<typeof mediaResponseSnapshot>>,
): Promise<MediaPostSubmissionV1> {
  if (outcome.kind === "replay") return decodeMediaReplay(outcome.bytes);
  if (outcome.kind === "conflict") throw idempotencyConflict(outcome.submissionId);
  return response.document;
}

export async function bindMediaTerms(
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: MediaSubmissionServices,
): Promise<MediaPostSubmissionV1> {
  const context = await mutationContext(
    input,
    BindSongTermsV1,
    MEDIA_SUBMISSION_ENDPOINTS.terms,
    services,
  );
  if (context.replay !== null) return context.replay;
  const body = context.body as Schema.Schema.Type<typeof BindSongTermsV1>;
  const terms: SongTerms = {
    licensePreset: body.license_preset,
    commercialRemixShareBps:
      body.license_preset === "commercial-remix" ? body.commercial_rev_share_bps : 0,
    royaltyAllocations: body.royalty_allocations.map(({ recipient_id, share_bps }) => ({
      recipientId: recipient_id,
      shareBps: share_bps,
    })),
    accessMode: body.access_mode,
  };
  const state = applyMediaTransition(context.view.state, {
    event: "song_terms_bound",
    actorId: input.actor.userId,
    expectedCreationRevision: body.expected_creation_revision,
    terms,
  });
  const response = await mediaResponseSnapshot(
    projectMediaSubmission(
      { state, lyrics: context.view.lyrics, updatedAt: services.nowIso() },
      context.persona,
    ),
  );
  const command: MediaCommandBase & {
    expectedCreationRevision: number;
    terms: SongTerms;
    outbox?: MediaOutboxWrite;
  } = {
    communityId: state.communityId,
    submissionId: state.submissionId,
    actorUserId: input.actor.userId,
    personaId: body.persona_id,
    endpointTemplate: MEDIA_SUBMISSION_ENDPOINTS.terms,
    idempotencyKey: body.idempotency_key,
    requestHash: context.requestHash,
    responseBytes: response.bytes,
    responseSha256: response.sha256,
    expectedCreationRevision: body.expected_creation_revision,
    terms,
    ...(context.view.state.workflowRevision === 0
      ? {}
      : {
          outbox: outbox(context.view.state, context.requestHash, {
            kind: "decision_wakeup",
            trigger: "terms",
            submission_id: state.submissionId,
            operation_id: state.operationId,
            creation_revision: state.creationRevision,
            lyrics_revision: state.lyrics?.lyricsRevision ?? null,
            workflow_revision: state.workflowRevision,
            workflow_instance_id: `media-${state.operationId}-r${state.workflowRevision}`,
          }),
        }),
  };
  try {
    return await commitSnapshot(await services.store.bindTerms(command), response);
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof InternalError) throw error;
    throw mapMediaStoreError(error);
  }
}

export async function bindMediaLyrics(
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: MediaSubmissionServices,
): Promise<MediaPostSubmissionV1> {
  const context = await mutationContext(
    input,
    BindSongLyricsV1,
    MEDIA_SUBMISSION_ENDPOINTS.lyrics,
    services,
  );
  if (context.replay !== null) return context.replay;
  const body = context.body as Schema.Schema.Type<typeof BindSongLyricsV1>;
  const prior = context.view.state;
  const canonicalAudioSha256 = prior.audio?.canonicalSha256 ?? "";
  const state = applyMediaTransition(prior, {
    event: "song_lyrics_bound",
    actorId: input.actor.userId,
    expectedCreationRevision: body.expected_creation_revision,
    expectedAudioRevision: body.expected_audio_revision,
    lyrics: {
      lyricsRevision: prior.lyricsRevision + 1,
      audioRevision: body.expected_audio_revision,
      canonicalAudioSha256,
      text: body.lyrics,
      baseTranscriptRevision: body.base_transcript_revision,
      provenance:
        body.base_transcript_revision === null
          ? "pasted"
          : context.view.lyrics.asrSuggestion.status === "ready" &&
              context.view.lyrics.asrSuggestion.transcriptRevision === body.base_transcript_revision &&
              context.view.lyrics.asrSuggestion.text === body.lyrics
            ? "asr_accepted"
            : "corrected",
    },
  });
  const lyrics = lyricsFromState(state, context.view.lyrics.asrSuggestion);
  const response = await mediaResponseSnapshot(
    projectMediaSubmission({ state, lyrics, updatedAt: services.nowIso() }, context.persona),
  );
  const wakeup = outbox(prior, context.requestHash, {
    kind: "decision_wakeup",
    trigger: "lyrics",
    submission_id: state.submissionId,
    operation_id: state.operationId,
    creation_revision: state.creationRevision,
    lyrics_revision: state.lyricsRevision,
    workflow_revision: state.workflowRevision,
    workflow_instance_id: `media-${state.operationId}-r${state.workflowRevision}`,
  });
  try {
    return await commitSnapshot(
      await services.store.bindLyrics({
        communityId: state.communityId,
        submissionId: state.submissionId,
        actorUserId: input.actor.userId,
        personaId: body.persona_id,
        endpointTemplate: MEDIA_SUBMISSION_ENDPOINTS.lyrics,
        idempotencyKey: body.idempotency_key,
        requestHash: context.requestHash,
        responseBytes: response.bytes,
        responseSha256: response.sha256,
        expectedCreationRevision: body.expected_creation_revision,
        expectedAudioRevision: body.expected_audio_revision,
        lyrics: body.lyrics,
        baseTranscriptRevision: body.base_transcript_revision,
        outbox: wakeup,
      }),
      response,
    );
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof InternalError) throw error;
    throw mapMediaStoreError(error);
  }
}

export async function bindMediaReference(
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: MediaSubmissionServices,
): Promise<MediaPostSubmissionV1> {
  const context = await mutationContext(
    input,
    BindSongReferenceV1,
    MEDIA_SUBMISSION_ENDPOINTS.reference,
    services,
  );
  if (context.replay !== null) return context.replay;
  const body = context.body as Schema.Schema.Type<typeof BindSongReferenceV1>;
  if (services.referenceResolver === undefined) {
    throw new InternalError({ message: "Media reference resolution is unavailable" });
  }
  const reference = await services.referenceResolver.resolve({
    actorUserId: input.actor.userId,
    submission: context.view.state,
    referenceRequestRef: body.reference_request_ref,
    upstreamAssetId: body.upstream_asset_id,
  });
  if (reference === null) {
    throw new Conflict({
      message: "Media reference is not valid for this submission",
      details: { reason_code: "reference_binding_invalid" },
    });
  }
  const state = applyMediaTransition(context.view.state, {
    event: "reference_bound",
    actorId: input.actor.userId,
    expectedCreationRevision: body.expected_creation_revision,
    reference,
    nowEpochMs: Date.parse(services.nowIso()),
  });
  const response = await mediaResponseSnapshot(
    projectMediaSubmission(
      { state, lyrics: context.view.lyrics, updatedAt: services.nowIso() },
      context.persona,
    ),
  );
  try {
    return await commitSnapshot(
      await services.store.bindReference({
        communityId: state.communityId,
        submissionId: state.submissionId,
        actorUserId: input.actor.userId,
        personaId: body.persona_id,
        endpointTemplate: MEDIA_SUBMISSION_ENDPOINTS.reference,
        idempotencyKey: body.idempotency_key,
        requestHash: context.requestHash,
        responseBytes: response.bytes,
        responseSha256: response.sha256,
        expectedCreationRevision: body.expected_creation_revision,
        reference,
      }),
      response,
    );
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof InternalError) throw error;
    throw mapMediaStoreError(error);
  }
}

async function retryOrCancel(
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: MediaSubmissionServices,
  action: "retry" | "cancel",
): Promise<MediaPostSubmissionV1> {
  const endpoint = MEDIA_SUBMISSION_ENDPOINTS[action];
  const context = await mutationContext(input, RetryOrCancelSongSubmissionV1, endpoint, services);
  if (context.replay !== null) return context.replay;
  const body = context.body as Schema.Schema.Type<typeof RetryOrCancelSongSubmissionV1>;
  const state = applyMediaTransition(context.view.state, {
    event: action === "retry" ? "retry_authorized" : "author_cancelled",
    actorId: input.actor.userId,
    expectedCreationRevision: body.expected_creation_revision,
  });
  const response = await mediaResponseSnapshot(
    projectMediaSubmission(
      { state, lyrics: context.view.lyrics, updatedAt: services.nowIso() },
      context.persona,
    ),
  );
  const command = {
    communityId: state.communityId,
    submissionId: state.submissionId,
    actorUserId: input.actor.userId,
    personaId: body.persona_id,
    endpointTemplate: endpoint,
    idempotencyKey: body.idempotency_key,
    requestHash: context.requestHash,
    responseBytes: response.bytes,
    responseSha256: response.sha256,
    expectedCreationRevision: body.expected_creation_revision,
  };
  try {
    const outcome =
      action === "retry"
        ? await services.store.retry(command)
        : await services.store.authorCancel(command);
    return await commitSnapshot(outcome, response);
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof InternalError) throw error;
    throw mapMediaStoreError(error);
  }
}

export const retryMediaSubmission = (
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: MediaSubmissionServices,
): Promise<MediaPostSubmissionV1> => retryOrCancel(input, services, "retry");

export const cancelMediaSubmission = (
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: MediaSubmissionServices,
): Promise<MediaPostSubmissionV1> => retryOrCancel(input, services, "cancel");

export async function moderateMediaSubmission(
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: MediaSubmissionServices,
): Promise<MediaPostSubmissionV1> {
  requireMediaHumanActor(input.actor);
  if (
    input.actor.kind !== "admin" ||
    input.actor.scopes?.includes("moderation") !== true
  ) {
    throw new NotFound({ message: "Media submission not found" });
  }
  const body = decodeBody(ModerateSongSubmissionV1, input.body);
  let view: MediaModeratorView | null;
  try {
    view = await services.store.getViewForModerator({
      submissionId: input.submissionId,
      moderatorActor: input.actor,
    });
  } catch (error) {
    throw mapMediaStoreError(error);
  }
  if (view === null) throw new NotFound({ message: "Media submission not found" });
  const digest = await mediaRequestHash({ submission_id: input.submissionId }, body);
  const replay = await replayFirst(
    {
      state: view.state,
      actor: input.actor,
      personaId: null,
      endpointTemplate: MEDIA_SUBMISSION_ENDPOINTS.moderate,
      idempotencyKey: body.idempotency_key,
      requestHash: digest,
    },
    services.store,
  );
  if (replay !== null) return replay;

  const evidenceRef =
    "evidence_ref" in body ? body.evidence_ref : `moderation-evidence-${digest}`;
  const actionId = `moderation-action-${digest}`;
  let state: MediaSubmissionState;
  let approval: ModeratorApprovalEvidence | undefined;
  let decision: PublicationDecision | undefined;
  if (body.action === "approve") {
    const current = view.state;
    if (current.audio === null || current.analysis === null) {
      throw new Conflict({
        message: "Media submission is not ready for moderation",
        details: { reason_code: "required_stage_missing" },
      });
    }
    approval = {
      actionId,
      moderatorActorId: input.actor.userId,
      evidenceRef,
      approvalKind: body.approval_kind,
      reasonCode: body.approval_kind === "standard" ? null : body.reason_code,
      heldRevision: current.creationRevision,
    };
    decision = {
      decisionRevision: current.decisionRevision + 1,
      outcome: "allow",
      creationRevision: current.creationRevision,
      audioRevision: current.audioRevision,
      analysisRevision: current.analysisRevision,
      lyricsRevision: current.lyrics?.lyricsRevision ?? null,
      canonicalAudioSha256: current.audio.canonicalSha256,
      policyRevision:
        current.decision?.policyRevision ?? current.analysis.speechLyrics.policyRevision,
      evidenceRef,
    };
    state = applyMediaTransition(current, {
      event: "moderator_approved",
      actorId: current.actorId,
      expectedCreationRevision: body.expected_creation_revision,
      communityActive: true,
      membershipActive: true,
      approval,
      decision,
    });
  } else {
    state = applyMediaTransition(view.state, {
      event: "moderator_blocked",
      actorId: view.state.actorId,
      expectedCreationRevision: body.expected_creation_revision,
      communityActive: true,
      membershipActive: true,
      actionId,
      moderatorActorId: input.actor.userId,
      evidenceRef,
      reasonCode: "policy_violation",
    });
  }
  const response = await mediaResponseSnapshot(
    projectMediaSubmission(
      { state, lyrics: view.lyrics, updatedAt: services.nowIso() },
      view.authorPersona,
    ),
  );
  const publication =
    body.action === "approve"
      ? outbox(view.state, digest, {
          kind: "publication",
          submission_id: state.submissionId,
          operation_id: state.operationId,
          creation_revision: state.creationRevision,
          lyrics_revision: state.lyrics?.lyricsRevision ?? null,
          workflow_revision: state.workflowRevision,
          workflow_instance_id: `media-${state.operationId}-r${state.workflowRevision}`,
        })
      : undefined;
  try {
    return await commitSnapshot(
      await services.store.moderate({
        communityId: state.communityId,
        submissionId: state.submissionId,
        endpointTemplate: MEDIA_SUBMISSION_ENDPOINTS.moderate,
        idempotencyKey: body.idempotency_key,
        requestHash: digest,
        responseBytes: response.bytes,
        responseSha256: response.sha256,
        expectedCreationRevision: body.expected_creation_revision,
        action: body.action,
        actor: input.actor,
        ...(approval === undefined ? {} : { approval }),
        ...(decision === undefined ? {} : { decision }),
        ...(body.action === "block" ? { evidenceRef } : {}),
        ...(publication === undefined ? {} : { outbox: publication }),
      }),
      response,
    );
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof InternalError) throw error;
    throw mapMediaStoreError(error);
  }
}
