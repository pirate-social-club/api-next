import {
  BadRequest,
  Conflict,
  CreateVideoSubmissionV1,
  FinalizeVideoUploadV1,
  IdempotencyConflict,
  InternalError,
  ModerateVideoSubmissionV1,
  NotFound,
  RenewVideoUploadPartsV1,
  ReserveVideoUploadV1,
  RetryOrCancelSongSubmissionV1,
  RetryVideoPosterV1,
  VideoPostSubmissionV1,
  VideoUploadReservationV1,
} from "@pirate/contracts";
import { Schema } from "effect";
import {
  attachImmutableVideo,
  attachVideoDecision,
  createOriginalVideoSubmission,
  decideOriginalAudioVideo,
  type OriginalSoundReference,
  publishOriginalVideo,
  VIDEO_INGEST_POLICY_V1,
  type VideoPublicationDecision,
  type VideoSubmissionState,
  type VideoTrustedAnalysis,
} from "../../../domain/src/video-submission.ts";
import type { MediaSealObjectIdentity, MediaUploadSealer } from "../media/submission-sealing.ts";
import {
  type MediaSubmissionServices,
  mediaRequestHash,
  mediaSha256Bytes,
  requireMediaHumanActor,
  requireMediaPersona,
} from "../media/submission-service.ts";
import type { M2Actor } from "../ports.ts";
import type { PersonaRecord } from "../use-cases/personas.ts";

export const VIDEO_PUBLICATION_ENDPOINTS = {
  reserve: "/communities/:communityId/media-upload-reservations",
  create: "/communities/:communityId/media-post-submissions",
  finalize: "/media-post-submissions/:submissionId/finalize",
  renewParts: "/media-upload-reservations/:reservationId/parts/renew",
  retry: "/media-post-submissions/:submissionId/retry",
  retryPoster: "/media-post-submissions/:submissionId/poster-retry",
  cancel: "/media-post-submissions/:submissionId/cancel",
  moderate: "/moderation/media-post-submissions/:submissionId/actions",
} as const;

const exactParseOptions = { onExcessProperty: "error" } as const;
const encoder = new TextEncoder();
const sha256Pattern = /^[0-9a-f]{64}$/u;

export const VIDEO_MULTIPART_PART_SIZE_BYTES = 10 * 1024 * 1024;
export const VIDEO_MULTIPART_URL_TTL_SECONDS = 60 * 60;

export const videoIngressObjectKey = (reservationId: string): string =>
  `reservations/${reservationId}/source`;
export const videoImmutableObjectKey = (operationId: string): string =>
  `immutable/${operationId}/video/1`;
export const videoImmutableRef = (operationId: string): string =>
  `media://immutable/${operationId}/video/1`;

export type VideoMultipartPart = Readonly<{
  partNumber: number;
  url: string;
  expiresAt: string;
}>;

export type VideoMultipartManifestPart = Readonly<{
  partNumber: number;
  etag: string;
}>;

export type VideoMultipartSession = Readonly<{
  uploadId: string;
  partSizeBytes: number;
  partCount: number;
  parts: readonly VideoMultipartPart[];
  expiresAt: string;
}>;

/** External multipart effects. Implementations must make completeOrInspect replay-safe. */
export interface VideoMultipartUploadGateway {
  readonly create: (input: {
    readonly objectKey: string;
    readonly contentType: "video/mp4" | "video/quicktime";
    readonly partSizeBytes: number;
    readonly partCount: number;
    readonly expiresInSeconds: number;
  }) => Promise<VideoMultipartSession>;
  readonly renew: (input: {
    readonly objectKey: string;
    readonly uploadId: string;
    readonly partNumbers: readonly number[];
    readonly expiresInSeconds: number;
  }) => Promise<readonly VideoMultipartPart[]>;
  readonly completeOrInspect: (input: {
    readonly objectKey: string;
    readonly uploadId: string;
    readonly contentType: "video/mp4" | "video/quicktime";
    readonly parts: readonly VideoMultipartManifestPart[];
  }) => Promise<Readonly<{ completed: true }>>;
  readonly abort: (input: {
    readonly objectKey: string;
    readonly uploadId: string;
  }) => Promise<void>;
}

export type VideoReservationRecord = Readonly<{
  reservationId: string;
  communityId: string;
  actorAccountId: string;
  authorPersonaId: string;
  requestHash: string;
  expectedContentType: "video/mp4" | "video/quicktime";
  expectedSizeBytes: number;
  expectedSha256: string | null;
  ingestPolicyRevision: number;
  uploadId: string;
  partSizeBytes: number;
  partCount: number;
  expiresAt: string;
  state: "issued" | "claimed" | "sealed" | "rejected" | "expired";
  submissionId: string | null;
  operationId: string | null;
  manifest: readonly VideoMultipartManifestPart[] | null;
  responseBytes: Uint8Array;
  updatedAt: string;
}>;

export type VideoSubmissionRecord = Readonly<{
  state: VideoSubmissionState;
  authorPersona: VideoPostSubmissionV1["author_persona"];
  updatedAt: string;
}>;

type StoredReplay =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "replay"; bytes: Uint8Array; entityId: string }>
  | Readonly<{ kind: "conflict"; entityId: string }>;

export type VideoPublishBundle = Readonly<{
  state: VideoSubmissionState;
  decision: VideoPublicationDecision;
  originalSound: OriginalSoundReference;
  poster: Readonly<{ artifactRef: string; canonicalSha256: string }>;
  derivedArtifacts: readonly Readonly<{
    artifactRef: string;
    artifactKind: "extracted_audio" | "poster" | "first" | "midpoint";
    canonicalSha256: string;
  }>[];
}>;

/** PostgreSQL owns replay, revisions, membership rechecks, and atomic publication effects. */
export interface VideoPublicationStore {
  readonly replayReservation: (input: {
    communityId: string;
    actorAccountId: string;
    authorPersonaId: string;
    idempotencyKey: string;
    requestHash: string;
  }) => Promise<StoredReplay>;
  readonly createReservation: (input: {
    record: VideoReservationRecord;
    idempotencyKey: string;
    responseSha256: string;
    parts: readonly VideoMultipartPart[];
  }) => Promise<StoredReplay>;
  readonly getReservationForAuthor: (input: {
    reservationId: string;
    actorAccountId: string;
    authorPersonaId: string;
  }) => Promise<VideoReservationRecord | null>;
  readonly renewParts: (input: {
    reservation: VideoReservationRecord;
    endpointTemplate: string;
    idempotencyKey: string;
    requestHash: string;
    responseBytes: Uint8Array;
    responseSha256: string;
    parts: readonly VideoMultipartPart[];
  }) => Promise<StoredReplay>;
  readonly createSubmission: (input: {
    state: VideoSubmissionState;
    idempotencyKey: string;
    requestHash: string;
    startInput: Readonly<Record<string, unknown>>;
    responseBytes: Uint8Array;
    responseSha256: string;
  }) => Promise<StoredReplay>;
  readonly getSubmissionForAccount: (input: {
    submissionId: string;
    actorAccountId: string;
  }) => Promise<VideoSubmissionRecord | null>;
  readonly getSubmissionByOperation: (input: {
    submissionId: string;
    operationId: string;
  }) => Promise<VideoSubmissionRecord | null>;
  readonly getSubmissionForModerator: (input: {
    submissionId: string;
    actor: M2Actor;
  }) => Promise<VideoSubmissionRecord | null>;
  readonly replayCommand: (input: {
    submission: VideoSubmissionState;
    actorAccountId: string;
    actorPersonaId: string | null;
    endpointTemplate: string;
    idempotencyKey: string;
    requestHash: string;
  }) => Promise<StoredReplay>;
  readonly beginFinalize: (input: {
    submission: VideoSubmissionState;
    expectedCreationRevision: number;
    posterTimestampMs: number | null;
    manifest: readonly VideoMultipartManifestPart[];
  }) => Promise<Readonly<{ reservation: VideoReservationRecord; alreadyCompleted: boolean }>>;
  readonly recordMultipartCompleted: (input: {
    submission: VideoSubmissionState;
    manifest: readonly VideoMultipartManifestPart[];
  }) => Promise<void>;
  readonly abandonInvalidManifest: (input: {
    submission: VideoSubmissionState;
    reservation: VideoReservationRecord;
    evidenceRef: string;
  }) => Promise<void>;
  readonly finalizeSealed: (input: {
    submission: VideoSubmissionState;
    expectedCreationRevision: number;
    immutable: Readonly<{
      immutableRef: string;
      destinationRef: string;
      etag: string;
      objectVersion: string;
      sizeBytes: number;
      contentType: "video/mp4" | "video/quicktime";
      canonicalSha256: string;
    }>;
    responseBytes: Uint8Array;
    responseSha256: string;
    endpointTemplate: string;
    idempotencyKey: string;
    requestHash: string;
  }) => Promise<StoredReplay>;
  readonly abandonExpectationMismatch: (input: {
    submission: VideoSubmissionState;
    evidenceRef: string;
    responseBytes: Uint8Array;
    responseSha256: string;
    endpointTemplate: string;
    idempotencyKey: string;
    requestHash: string;
  }) => Promise<StoredReplay>;
  readonly commitAnalysisDecision: (input: {
    submission: VideoSubmissionState;
    analysis: VideoTrustedAnalysis;
    decision: VideoPublicationDecision;
    nextState: VideoSubmissionState;
  }) => Promise<VideoSubmissionRecord>;
  readonly publish: (input: VideoPublishBundle) => Promise<VideoSubmissionRecord>;
  readonly retryPoster: (input: {
    submission: VideoSubmissionState;
    posterTimestampMs: number;
    endpointTemplate: string;
    idempotencyKey: string;
    requestHash: string;
  }) => Promise<VideoSubmissionRecord>;
  readonly cancel: (input: {
    submission: VideoSubmissionState;
    endpointTemplate: string;
    idempotencyKey: string;
    requestHash: string;
  }) => Promise<VideoSubmissionRecord>;
  readonly moderate: (input: {
    submission: VideoSubmissionState;
    actor: M2Actor;
    expectedCreationRevision: number;
    action:
      | Readonly<{ kind: "approve"; hold: "safety"; evidenceRef: null }>
      | Readonly<{ kind: "approve"; hold: "soundtrack"; evidenceRef: string }>
      | Readonly<{
          kind: "block";
          reasonCode: "policy_violation" | "rights_violation";
          evidenceRef: string;
        }>;
    endpointTemplate: string;
    idempotencyKey: string;
    requestHash: string;
  }) => Promise<VideoSubmissionRecord>;
}

export type VideoPublicationServices = Readonly<{
  store: VideoPublicationStore;
  multipart: VideoMultipartUploadGateway;
  sealer: MediaUploadSealer;
  personaServices: Pick<MediaSubmissionServices, "personaStore">;
  nowIso: () => string;
  randomUuid?: () => string;
}>;

function decodeBody<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, exactParseOptions)(input);
  } catch {
    throw new BadRequest({ message: "Invalid request body" });
  }
}

async function snapshot<T>(document: T): Promise<
  Readonly<{
    document: T;
    bytes: Uint8Array;
    sha256: string;
  }>
> {
  const bytes = encoder.encode(JSON.stringify(document));
  return { document, bytes, sha256: await mediaSha256Bytes(bytes) };
}

function decodeReservation(bytes: Uint8Array): VideoUploadReservationV1 {
  try {
    return Schema.decodeUnknownSync(
      VideoUploadReservationV1,
      exactParseOptions,
    )(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new InternalError({ message: "Stored video reservation response is invalid" });
  }
}

function decodeSubmission(bytes: Uint8Array): VideoPostSubmissionV1 {
  try {
    return Schema.decodeUnknownSync(
      VideoPostSubmissionV1,
      exactParseOptions,
    )(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new InternalError({ message: "Stored video submission response is invalid" });
  }
}

function idempotencyConflict(entityId: string): IdempotencyConflict {
  return new IdempotencyConflict({
    message: "The idempotency key was already used with a different request",
    details: { reason_code: "idempotency_conflict", submission_id: entityId },
  });
}

function replayReservation(outcome: StoredReplay): VideoUploadReservationV1 | null {
  if (outcome.kind === "replay") return decodeReservation(outcome.bytes);
  if (outcome.kind === "conflict") throw idempotencyConflict(outcome.entityId);
  return null;
}

function replaySubmission(outcome: StoredReplay): VideoPostSubmissionV1 | null {
  if (outcome.kind === "replay") return decodeSubmission(outcome.bytes);
  if (outcome.kind === "conflict") throw idempotencyConflict(outcome.entityId);
  return null;
}

function publicPersona(persona: PersonaRecord): VideoPostSubmissionV1["author_persona"] {
  return {
    persona_id: persona.persona_id,
    object: "persona",
    display_name: persona.profile.display_name,
    avatar_ref: persona.profile.avatar_ref,
    primary_public_handle: persona.profile.primary_public_handle,
  };
}

export function projectVideoSubmission(record: VideoSubmissionRecord): VideoPostSubmissionV1 {
  const state = record.state;
  const common = {
    submission_id: state.submissionId,
    author_persona: record.authorPersona,
    href: `/media-post-submissions/${encodeURIComponent(state.submissionId)}`,
    track: "video" as const,
    intent: "original_audio" as const,
    creation_revision: state.creationRevision,
    video_revision: state.videoRevision,
    caption: state.caption,
    updated_at: record.updatedAt,
  };
  switch (state.status) {
    case "processing":
      if (state.phase === null) throw new InternalError({ message: "Video phase is missing" });
      return { ...common, status: "processing", phase: state.phase };
    case "manual_review":
      return {
        ...common,
        status: "manual_review",
        reason_codes: state.reviewReasons,
        review_ref: `video-review-${state.operationId}-r${state.creationRevision}`,
      };
    case "published":
      if (state.postId === null) throw new InternalError({ message: "Video post is missing" });
      return {
        ...common,
        status: "published",
        published_resource: {
          post_id: state.postId,
          href: `/posts/${encodeURIComponent(state.postId)}`,
        },
      };
    case "blocked": {
      const outcome = state.decision?.outcome;
      const reason = outcome?.kind === "block" ? outcome.reasonCode : "policy_violation";
      return {
        ...common,
        status: "blocked",
        reason_code: reason,
        ...(outcome?.kind === "block" && outcome.songPostId !== undefined
          ? { song_post_id: outcome.songPostId }
          : {}),
      };
    }
    case "processing_failed":
      if (state.failureCode === null)
        throw new InternalError({ message: "Video failure is missing" });
      return {
        ...common,
        status: "processing_failed",
        reason_code: state.failureCode,
        retry_count: state.retryCount as 0 | 1 | 2 | 3,
        retryable: state.retryCount < 3,
      };
    case "abandoned":
      return { ...common, status: "abandoned", reason_code: "author_cancelled_before_finalize" };
  }
}

function reservationDocument(
  record: Omit<
    VideoReservationRecord,
    "responseBytes" | "updatedAt" | "manifest" | "state" | "submissionId" | "operationId"
  >,
  parts: readonly VideoMultipartPart[],
): VideoUploadReservationV1 {
  return {
    reservation_id: record.reservationId,
    track: "video",
    slot: "primary_video",
    status: "awaiting_upload",
    author_persona_id: record.authorPersonaId,
    ingest_policy_revision: record.ingestPolicyRevision,
    intent: "original_audio",
    upload: {
      method: "MULTIPART",
      upload_id: record.uploadId,
      part_size_bytes: record.partSizeBytes,
      part_count: record.partCount,
      parts: parts.map((part) => ({
        part_number: part.partNumber,
        url: part.url,
        expires_at: part.expiresAt,
      })),
      expires_at: record.expiresAt,
    },
  };
}

function capabilityUnavailable(capability: "song_reference" | "original_sound_reuse"): BadRequest {
  return new BadRequest({
    message: "Video capability is unavailable",
    details: { reason_code: "capability_unavailable", track: "video", capability },
  });
}

function uuid(services: VideoPublicationServices): string {
  return services.randomUuid?.() ?? crypto.randomUUID();
}

export async function reserveVideoUpload(
  input: Readonly<{ communityId: string; actor: M2Actor; body: unknown }>,
  services: VideoPublicationServices,
): Promise<VideoUploadReservationV1> {
  requireMediaHumanActor(input.actor);
  const body = decodeBody(ReserveVideoUploadV1, input.body);
  await requireMediaPersona(input.actor, body.persona_id, services.personaServices);
  const requestHash = await mediaRequestHash({ community_id: input.communityId }, body);
  const prior = replayReservation(
    await services.store.replayReservation({
      communityId: input.communityId,
      actorAccountId: input.actor.userId,
      authorPersonaId: body.persona_id,
      idempotencyKey: body.idempotency_key,
      requestHash,
    }),
  );
  if (prior !== null) return prior;
  if (body.intent === "song_reference") throw capabilityUnavailable("song_reference");

  const reservationId = `media-reservation-${uuid(services)}`;
  const partCount = Math.ceil(body.expected_size_bytes / VIDEO_MULTIPART_PART_SIZE_BYTES);
  let upload: VideoMultipartSession;
  try {
    upload = await services.multipart.create({
      objectKey: videoIngressObjectKey(reservationId),
      contentType: body.expected_content_type,
      partSizeBytes: VIDEO_MULTIPART_PART_SIZE_BYTES,
      partCount,
      expiresInSeconds: VIDEO_MULTIPART_URL_TTL_SECONDS,
    });
  } catch {
    throw new InternalError({ message: "Video multipart reservation is unavailable" });
  }
  if (
    upload.partCount !== partCount ||
    upload.partSizeBytes !== VIDEO_MULTIPART_PART_SIZE_BYTES ||
    upload.parts.length !== partCount ||
    upload.parts.some((part, index) => part.partNumber !== index + 1)
  ) {
    await services.multipart
      .abort({ objectKey: videoIngressObjectKey(reservationId), uploadId: upload.uploadId })
      .catch(() => undefined);
    throw new InternalError({ message: "Video multipart reservation is invalid" });
  }
  const base = {
    reservationId,
    communityId: input.communityId,
    actorAccountId: input.actor.userId,
    authorPersonaId: body.persona_id,
    requestHash,
    expectedContentType: body.expected_content_type,
    expectedSizeBytes: body.expected_size_bytes,
    expectedSha256: body.expected_sha256 ?? null,
    ingestPolicyRevision: VIDEO_INGEST_POLICY_V1.policyRevision,
    uploadId: upload.uploadId,
    partSizeBytes: upload.partSizeBytes,
    partCount: upload.partCount,
    expiresAt: upload.expiresAt,
  } as const;
  const response = await snapshot(reservationDocument(base, upload.parts));
  const record: VideoReservationRecord = {
    ...base,
    state: "issued",
    submissionId: null,
    operationId: null,
    manifest: null,
    responseBytes: response.bytes,
    updatedAt: services.nowIso(),
  };
  const stored = await services.store.createReservation({
    record,
    idempotencyKey: body.idempotency_key,
    responseSha256: response.sha256,
    parts: upload.parts,
  });
  const replayed = replayReservation(stored);
  if (replayed !== null) {
    if (stored.kind === "replay" && stored.entityId !== reservationId) {
      await services.multipart
        .abort({ objectKey: videoIngressObjectKey(reservationId), uploadId: upload.uploadId })
        .catch(() => undefined);
    }
    return replayed;
  }
  return response.document;
}

export function normalizeVideoMultipartManifest(
  parts: readonly Readonly<{ part_number: number; etag: string }>[],
  expectedPartCount: number,
): readonly VideoMultipartManifestPart[] | null {
  if (parts.length !== expectedPartCount) return null;
  const normalized: VideoMultipartManifestPart[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part.part_number !== index + 1) return null;
    let etag = part.etag;
    if (etag.startsWith('"') && etag.endsWith('"') && etag.length >= 2) etag = etag.slice(1, -1);
    if (etag.length === 0 || etag.length > 256 || /[\r\n]/u.test(etag)) return null;
    normalized.push({ partNumber: part.part_number, etag });
  }
  return normalized;
}

function ensurePersonaContinuity(state: VideoSubmissionState, personaId: string): void {
  if (state.authorPersonaId !== personaId) {
    throw new Conflict({
      message: "The reserving persona is required",
      details: { reason_code: "reservation_persona_required" },
    });
  }
}

export async function renewVideoUploadParts(
  input: Readonly<{ reservationId: string; actor: M2Actor; body: unknown }>,
  services: VideoPublicationServices,
): Promise<VideoUploadReservationV1> {
  requireMediaHumanActor(input.actor);
  const body = decodeBody(RenewVideoUploadPartsV1, input.body);
  if (body.reservation_id !== input.reservationId)
    throw new BadRequest({ message: "Reservation mismatch" });
  await requireMediaPersona(input.actor, body.persona_id, services.personaServices);
  const reservation = await services.store.getReservationForAuthor({
    reservationId: input.reservationId,
    actorAccountId: input.actor.userId,
    authorPersonaId: body.persona_id,
  });
  if (reservation === null) throw new NotFound({ message: "Video reservation not found" });
  if (reservation.authorPersonaId !== body.persona_id)
    ensurePersonaContinuity(
      createOriginalVideoSubmission({
        submissionId: "unknown",
        operationId: "unknown",
        communityId: reservation.communityId,
        actorAccountId: reservation.actorAccountId,
        authorPersonaId: reservation.authorPersonaId,
        reservationId: reservation.reservationId,
        caption: null,
        authorDeclaredRating: "general",
      }),
      body.persona_id,
    );
  if (
    reservation.state !== "issued" ||
    reservation.manifest !== null ||
    Date.parse(reservation.expiresAt) <= Date.parse(services.nowIso())
  ) {
    throw new Conflict({
      message: "Video upload action expired",
      details: { reason_code: "action_expired" },
    });
  }
  const partNumbers = [...body.part_numbers].sort((a, b) => a - b);
  if (
    new Set(partNumbers).size !== partNumbers.length ||
    partNumbers.some((partNumber) => partNumber < 1 || partNumber > reservation.partCount)
  )
    throw new BadRequest({ message: "Invalid video part numbers" });
  const requestHash = await mediaRequestHash({ reservation_id: input.reservationId }, body);
  const replay = replayReservation(
    await services.store.replayReservation({
      communityId: reservation.communityId,
      actorAccountId: input.actor.userId,
      authorPersonaId: body.persona_id,
      idempotencyKey: `${VIDEO_PUBLICATION_ENDPOINTS.renewParts}:${body.idempotency_key}`,
      requestHash,
    }),
  );
  if (replay !== null) return replay;
  let renewed: readonly VideoMultipartPart[];
  try {
    renewed = await services.multipart.renew({
      objectKey: videoIngressObjectKey(reservation.reservationId),
      uploadId: reservation.uploadId,
      partNumbers,
      expiresInSeconds: VIDEO_MULTIPART_URL_TTL_SECONDS,
    });
  } catch {
    throw new InternalError({ message: "Video multipart renewal is unavailable" });
  }
  const response = await snapshot(
    reservationDocument(
      {
        reservationId: reservation.reservationId,
        communityId: reservation.communityId,
        actorAccountId: reservation.actorAccountId,
        authorPersonaId: reservation.authorPersonaId,
        requestHash: reservation.requestHash,
        expectedContentType: reservation.expectedContentType,
        expectedSizeBytes: reservation.expectedSizeBytes,
        expectedSha256: reservation.expectedSha256,
        ingestPolicyRevision: reservation.ingestPolicyRevision,
        uploadId: reservation.uploadId,
        partSizeBytes: reservation.partSizeBytes,
        partCount: reservation.partCount,
        expiresAt: reservation.expiresAt,
      },
      renewed,
    ),
  );
  const outcome = await services.store.renewParts({
    reservation,
    endpointTemplate: VIDEO_PUBLICATION_ENDPOINTS.renewParts,
    idempotencyKey: body.idempotency_key,
    requestHash,
    responseBytes: response.bytes,
    responseSha256: response.sha256,
    parts: renewed,
  });
  return replayReservation(outcome) ?? response.document;
}

export async function createVideoSubmission(
  input: Readonly<{ communityId: string; actor: M2Actor; body: unknown }>,
  services: VideoPublicationServices,
): Promise<VideoPostSubmissionV1> {
  requireMediaHumanActor(input.actor);
  const body = decodeBody(CreateVideoSubmissionV1, input.body);
  const persona = await requireMediaPersona(input.actor, body.persona_id, services.personaServices);
  const reservation = await services.store.getReservationForAuthor({
    reservationId: body.video_reservation_id,
    actorAccountId: input.actor.userId,
    authorPersonaId: body.persona_id,
  });
  if (reservation === null) throw new NotFound({ message: "Video reservation not found" });
  if (reservation.communityId !== input.communityId || reservation.state !== "issued") {
    throw new Conflict({ message: "Video reservation cannot be claimed" });
  }
  const requestHash = await mediaRequestHash({ community_id: input.communityId }, body);
  const state = createOriginalVideoSubmission({
    submissionId: `media-submission-${uuid(services)}`,
    operationId: `media-operation-${uuid(services)}`,
    communityId: input.communityId,
    actorAccountId: input.actor.userId,
    authorPersonaId: body.persona_id,
    reservationId: body.video_reservation_id,
    caption: body.caption ?? null,
    authorDeclaredRating: body.author_declared_rating ?? "general",
  });
  const response = await snapshot(
    projectVideoSubmission({
      state,
      authorPersona: publicPersona(persona),
      updatedAt: services.nowIso(),
    }),
  );
  const outcome = await services.store.createSubmission({
    state,
    idempotencyKey: body.idempotency_key,
    requestHash,
    startInput: body,
    responseBytes: response.bytes,
    responseSha256: response.sha256,
  });
  return replaySubmission(outcome) ?? response.document;
}

function retainedEvidence(identity: MediaSealObjectIdentity | undefined, fallback: string): string {
  return identity === undefined
    ? fallback
    : `video-seal:${identity.key}:${identity.version}:${identity.etag}:${identity.size}`;
}

export async function finalizeVideoSubmission(
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: VideoPublicationServices,
): Promise<VideoPostSubmissionV1> {
  requireMediaHumanActor(input.actor);
  const body = decodeBody(FinalizeVideoUploadV1, input.body);
  await requireMediaPersona(input.actor, body.persona_id, services.personaServices);
  const record = await services.store.getSubmissionForAccount({
    submissionId: input.submissionId,
    actorAccountId: input.actor.userId,
  });
  if (record === null) throw new NotFound({ message: "Video submission not found" });
  ensurePersonaContinuity(record.state, body.persona_id);
  if (record.state.reservationId !== body.reservation_id)
    throw new BadRequest({ message: "Reservation mismatch" });
  const requestHash = await mediaRequestHash({ submission_id: input.submissionId }, body);
  const replayed = replaySubmission(
    await services.store.replayCommand({
      submission: record.state,
      actorAccountId: input.actor.userId,
      actorPersonaId: body.persona_id,
      endpointTemplate: VIDEO_PUBLICATION_ENDPOINTS.finalize,
      idempotencyKey: body.idempotency_key,
      requestHash,
    }),
  );
  if (replayed !== null) return replayed;
  const reservation = await services.store.getReservationForAuthor({
    reservationId: body.reservation_id,
    actorAccountId: input.actor.userId,
    authorPersonaId: body.persona_id,
  });
  if (reservation === null) throw new NotFound({ message: "Video reservation not found" });
  const manifest = normalizeVideoMultipartManifest(body.parts, reservation.partCount);
  if (manifest === null) {
    await services.multipart
      .abort({
        objectKey: videoIngressObjectKey(reservation.reservationId),
        uploadId: reservation.uploadId,
      })
      .catch(() => undefined);
    await services.store.abandonInvalidManifest({
      submission: record.state,
      reservation,
      evidenceRef: `video-invalid-manifest:${reservation.reservationId}`,
    });
    throw new BadRequest({ message: "Invalid multipart manifest" });
  }
  const begun = await services.store.beginFinalize({
    submission: record.state,
    expectedCreationRevision: body.expected_creation_revision,
    posterTimestampMs: body.poster_timestamp_ms ?? null,
    manifest,
  });
  if (!begun.alreadyCompleted) {
    try {
      await services.multipart.completeOrInspect({
        objectKey: videoIngressObjectKey(reservation.reservationId),
        uploadId: reservation.uploadId,
        contentType: reservation.expectedContentType,
        parts: manifest,
      });
      await services.store.recordMultipartCompleted({ submission: record.state, manifest });
    } catch {
      throw new InternalError({ message: "Video multipart completion failed" });
    }
  }
  let inspection: Awaited<ReturnType<MediaUploadSealer["inspect"]>>;
  try {
    inspection = await services.sealer.inspect({
      sourceKey: videoIngressObjectKey(reservation.reservationId),
      expectedSizeBytes: reservation.expectedSizeBytes,
      expectedContentType: reservation.expectedContentType,
    });
  } catch {
    throw new InternalError({ message: "Video upload inspection failed" });
  }
  if (inspection.outcome !== "ready") {
    const abandoned: VideoSubmissionState = { ...record.state, status: "abandoned", phase: null };
    const response = await snapshot(
      projectVideoSubmission({ ...record, state: abandoned, updatedAt: services.nowIso() }),
    );
    const outcome = await services.store.abandonExpectationMismatch({
      submission: record.state,
      evidenceRef: `video-upload-expectation:${reservation.reservationId}`,
      responseBytes: response.bytes,
      responseSha256: response.sha256,
      endpointTemplate: VIDEO_PUBLICATION_ENDPOINTS.finalize,
      idempotencyKey: body.idempotency_key,
      requestHash,
    });
    return replaySubmission(outcome) ?? response.document;
  }
  let sealed: Awaited<ReturnType<MediaUploadSealer["seal"]>>;
  try {
    sealed = await services.sealer.seal({
      source: inspection.source,
      destinationKey: videoImmutableObjectKey(record.state.operationId),
      immutableRef: videoImmutableRef(record.state.operationId),
      expectedSizeBytes: reservation.expectedSizeBytes,
      expectedContentType: reservation.expectedContentType,
      ...(reservation.expectedSha256 === null
        ? {}
        : { expectedSha256: reservation.expectedSha256 }),
      ownershipMarker: record.state.operationId,
    });
  } catch (error) {
    throw new InternalError({
      message: retainedEvidence(
        typeof error === "object" && error !== null && "retainedDestination" in error
          ? (error as { retainedDestination?: MediaSealObjectIdentity }).retainedDestination
          : undefined,
        "Video upload seal failed",
      ),
    });
  }
  if (sealed.result.outcome !== "sealed") {
    throw new Conflict({
      message: "Video upload could not be sealed",
      details: { reason_code: sealed.result.outcome },
    });
  }
  const nextState = attachImmutableVideo(record.state, {
    videoRevision: 1,
    immutableRef: sealed.result.immutable_ref,
    canonicalSha256: sealed.result.canonical_sha256,
    contentType: reservation.expectedContentType,
    sizeBytes: sealed.result.size_bytes,
  });
  const response = await snapshot(
    projectVideoSubmission({ ...record, state: nextState, updatedAt: services.nowIso() }),
  );
  const outcome = await services.store.finalizeSealed({
    submission: record.state,
    expectedCreationRevision: body.expected_creation_revision,
    immutable: {
      immutableRef: sealed.result.immutable_ref,
      destinationRef: sealed.result.destination_ref,
      etag: sealed.result.etag,
      objectVersion: sealed.result.version,
      sizeBytes: sealed.result.size_bytes,
      contentType: reservation.expectedContentType,
      canonicalSha256: sealed.result.canonical_sha256,
    },
    responseBytes: response.bytes,
    responseSha256: response.sha256,
    endpointTemplate: VIDEO_PUBLICATION_ENDPOINTS.finalize,
    idempotencyKey: body.idempotency_key,
    requestHash,
  });
  return replaySubmission(outcome) ?? response.document;
}

export async function getVideoSubmission(
  input: Readonly<{ submissionId: string; actor: M2Actor }>,
  services: VideoPublicationServices,
): Promise<VideoPostSubmissionV1> {
  requireMediaHumanActor(input.actor);
  const record = await services.store.getSubmissionForAccount({
    submissionId: input.submissionId,
    actorAccountId: input.actor.userId,
  });
  if (record === null) throw new NotFound({ message: "Video submission not found" });
  await requireMediaPersona(input.actor, record.state.authorPersonaId, services.personaServices);
  return projectVideoSubmission(record);
}

export async function acceptTrustedVideoAnalysis(
  input: Readonly<{ submissionId: string; analysis: VideoTrustedAnalysis }>,
  services: VideoPublicationServices,
): Promise<VideoPostSubmissionV1> {
  const record = await services.store.getSubmissionByOperation({
    submissionId: input.submissionId,
    operationId: input.analysis.operationId,
  });
  if (record === null || record.state.operationId !== input.analysis.operationId)
    throw new NotFound({ message: "Video submission not found" });
  if (record.state.status === "published") return projectVideoSubmission(record);
  if (
    record.state.phase === "publish" &&
    record.state.analysis?.analysisRevision === input.analysis.analysisRevision &&
    record.state.decision?.outcome.kind === "publish"
  ) {
    return projectVideoSubmission(await publishPreparedVideo(record, services));
  }
  const captionSha256 =
    record.state.caption === null
      ? null
      : await mediaSha256Bytes(
          encoder.encode(
            record.state.caption
              .replaceAll("\r\n", "\n")
              .replaceAll("\r", "\n")
              .normalize("NFC")
              .trim(),
          ),
        );
  const decision = decideOriginalAudioVideo({
    state: record.state,
    analysis: input.analysis,
    canonicalCaptionSha256: captionSha256,
    decidedAt: services.nowIso(),
  });
  const nextState = attachVideoDecision(record.state, input.analysis, decision);
  let committed = await services.store.commitAnalysisDecision({
    submission: record.state,
    analysis: input.analysis,
    decision,
    nextState,
  });
  if (nextState.status === "processing" && nextState.phase === "publish") {
    committed = await publishPreparedVideo(committed, services);
  }
  return projectVideoSubmission(committed);
}

async function publishPreparedVideo(
  record: VideoSubmissionRecord,
  services: VideoPublicationServices,
): Promise<VideoSubmissionRecord> {
  const analysis = record.state.analysis;
  const decision = record.state.decision;
  if (analysis === null || decision === null || decision.outcome.kind !== "publish") {
    throw new Conflict({ message: "Video publication is not ready" });
  }
  const postId = record.state.postId ?? `post-${uuid(services)}`;
  const published = publishOriginalVideo(record.state, postId);
  const poster = analysis.frames.extracted[0];
  const soundtrack = analysis.audio.soundtrack;
  return services.store.publish({
    state: published.state,
    decision,
    originalSound: published.originalSound,
    poster: { artifactRef: poster.artifactRef, canonicalSha256: poster.sha256 },
    derivedArtifacts: [
      {
        artifactRef: soundtrack.extractedAudioRef,
        artifactKind: "extracted_audio",
        canonicalSha256: soundtrack.extractedAudioSha256,
      },
      ...analysis.frames.extracted.map((frame) => ({
        artifactRef: frame.artifactRef,
        artifactKind: frame.role,
        canonicalSha256: frame.sha256,
      })),
    ],
  });
}

export async function retryVideoPoster(
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: VideoPublicationServices,
): Promise<VideoPostSubmissionV1> {
  requireMediaHumanActor(input.actor);
  const body = decodeBody(RetryVideoPosterV1, input.body);
  await requireMediaPersona(input.actor, body.persona_id, services.personaServices);
  const record = await services.store.getSubmissionForAccount({
    submissionId: input.submissionId,
    actorAccountId: input.actor.userId,
  });
  if (record === null) throw new NotFound({ message: "Video submission not found" });
  ensurePersonaContinuity(record.state, body.persona_id);
  if (
    record.state.status !== "processing_failed" ||
    !["poster_undecodable", "poster_timestamp_out_of_range"].includes(
      record.state.failureCode ?? "",
    ) ||
    record.state.retryCount >= 3
  )
    throw new Conflict({
      message: "Poster retry is not allowed",
      details: { reason_code: "retry_not_allowed" },
    });
  const requestHash = await mediaRequestHash({ submission_id: input.submissionId }, body);
  return projectVideoSubmission(
    await services.store.retryPoster({
      submission: record.state,
      posterTimestampMs: body.poster_timestamp_ms,
      endpointTemplate: VIDEO_PUBLICATION_ENDPOINTS.retryPoster,
      idempotencyKey: body.idempotency_key,
      requestHash,
    }),
  );
}

export async function retryVideoSubmission(
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: VideoPublicationServices,
): Promise<VideoPostSubmissionV1> {
  const body = decodeBody(RetryOrCancelSongSubmissionV1, input.body);
  const record = await services.store.getSubmissionForAccount({
    submissionId: input.submissionId,
    actorAccountId: input.actor.userId,
  });
  if (record === null) throw new NotFound({ message: "Video submission not found" });
  ensurePersonaContinuity(record.state, body.persona_id);
  if (
    ["poster_undecodable", "poster_timestamp_out_of_range"].includes(record.state.failureCode ?? "")
  ) {
    throw new Conflict({
      message: "Poster retry endpoint is required",
      details: { reason_code: "poster_retry_required" },
    });
  }
  throw new Conflict({
    message: "Video retry is not allowed",
    details: { reason_code: "retry_not_allowed" },
  });
}

export async function cancelVideoSubmission(
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: VideoPublicationServices,
): Promise<VideoPostSubmissionV1> {
  requireMediaHumanActor(input.actor);
  const body = decodeBody(RetryOrCancelSongSubmissionV1, input.body);
  await requireMediaPersona(input.actor, body.persona_id, services.personaServices);
  const record = await services.store.getSubmissionForAccount({
    submissionId: input.submissionId,
    actorAccountId: input.actor.userId,
  });
  if (record === null) throw new NotFound({ message: "Video submission not found" });
  ensurePersonaContinuity(record.state, body.persona_id);
  if (record.state.video !== null || record.state.status !== "processing")
    throw new Conflict({
      message: "Video cancellation is not allowed",
      details: { reason_code: "action_expired" },
    });
  const requestHash = await mediaRequestHash({ submission_id: input.submissionId }, body);
  const reservation = await services.store.getReservationForAuthor({
    reservationId: record.state.reservationId,
    actorAccountId: input.actor.userId,
    authorPersonaId: body.persona_id,
  });
  if (reservation !== null && reservation.manifest === null) {
    await services.multipart
      .abort({
        objectKey: videoIngressObjectKey(reservation.reservationId),
        uploadId: reservation.uploadId,
      })
      .catch(() => undefined);
  }
  return projectVideoSubmission(
    await services.store.cancel({
      submission: record.state,
      endpointTemplate: VIDEO_PUBLICATION_ENDPOINTS.cancel,
      idempotencyKey: body.idempotency_key,
      requestHash,
    }),
  );
}

export async function moderateVideoSubmission(
  input: Readonly<{ submissionId: string; actor: M2Actor; body: unknown }>,
  services: VideoPublicationServices,
): Promise<VideoPostSubmissionV1> {
  requireMediaHumanActor(input.actor);
  const body = decodeBody(ModerateVideoSubmissionV1, input.body);
  const record = await services.store.getSubmissionForModerator({
    submissionId: input.submissionId,
    actor: input.actor,
  });
  if (record === null) throw new NotFound({ message: "Video submission not found" });
  const requestHash = await mediaRequestHash({ submission_id: input.submissionId }, body);
  const action =
    body.action === "block"
      ? { kind: "block" as const, reasonCode: body.reason_code, evidenceRef: body.evidence_ref }
      : body.hold === "soundtrack"
        ? { kind: "approve" as const, hold: "soundtrack" as const, evidenceRef: body.evidence_ref }
        : { kind: "approve" as const, hold: "safety" as const, evidenceRef: null };
  let moderated = await services.store.moderate({
      submission: record.state,
      actor: input.actor,
      expectedCreationRevision: body.expected_creation_revision,
      action,
      endpointTemplate: VIDEO_PUBLICATION_ENDPOINTS.moderate,
      idempotencyKey: body.idempotency_key,
      requestHash,
    });
  if (moderated.state.status === "processing" && moderated.state.phase === "publish") {
    moderated = await publishPreparedVideo(moderated, services);
  }
  return projectVideoSubmission(moderated);
}

export const videoAnalysisFixtureSha256IsValid = (analysis: VideoTrustedAnalysis): boolean =>
  sha256Pattern.test(analysis.canonicalVideoSha256) &&
  sha256Pattern.test(analysis.audio.soundtrack.extractedAudioSha256);
