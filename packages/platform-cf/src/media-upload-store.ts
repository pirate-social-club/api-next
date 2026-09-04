import { ControlPlaneDb, type ControlPlaneError, type M2Actor } from "@pirate/application";
import type {
  MediaLyricsSnapshot,
  MediaModeratorView,
  MediaSubmissionServices,
  MediaSubmissionView,
  MediaUploadStore,
} from "@pirate/application/media/submission-service";
import {
  bindMediaLyrics,
  bindMediaReference,
  bindMediaTerms,
  cancelMediaSubmission,
  createMediaSubmission,
  finalizeMediaSubmission,
  getMediaSubmission,
  MediaUploadStoreError,
  moderateMediaSubmission,
  reserveMediaUpload,
  retryMediaSubmission,
} from "@pirate/application/media/submission-service";
import {
  cancelVideoSubmission,
  createVideoSubmission,
  finalizeVideoSubmission,
  getVideoSubmission,
  moderateVideoSubmission,
  renewVideoUploadParts,
  reserveVideoUpload,
  retryVideoPoster,
  retryVideoSubmission,
  type VideoPublicationServices,
} from "@pirate/application/video/publication";

export type { VideoPublicationServices } from "@pirate/application/video/publication";

import { Effect, type Layer } from "effect";
import {
  MediaSubmissionRepositoryError,
  makeControlPlaneMediaSubmissionRepository,
} from "./media-submission-repository.ts";
import { publicPersonaFromSql } from "./public-persona-projection.ts";

type Row = Readonly<Record<string, unknown>>;

function mapFailure(error: unknown): MediaUploadStoreError {
  if (error instanceof MediaSubmissionRepositoryError) {
    const reason =
      error.reason === "post-ownership"
        ? "transition-rejected"
        : error.reason === "stale-fence"
          ? "stale-fence"
          : error.reason;
    return new MediaUploadStoreError({
      reason,
      ...(error.submissionId === undefined ? {} : { submissionId: error.submissionId }),
      ...(error.reservationId === undefined ? {} : { reservationId: error.reservationId }),
    });
  }
  return new MediaUploadStoreError({ reason: "unavailable" });
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new MediaUploadStoreError({ reason: "invalid-row" });
  return date.toISOString();
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    !value.includes("\u0000")
  );
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function snapshotBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array && value.byteLength > 0) return new Uint8Array(value);
  return null;
}

function reservationReplay(
  row: Row,
  requestHash: string,
  communityId: string,
): Awaited<ReturnType<MediaUploadStore["replayReservation"]>> {
  if (!validId(row.reservation_id)) {
    throw new MediaUploadStoreError({ reason: "invalid-row" });
  }
  if (row.request_hash !== requestHash || row.community_id !== communityId) {
    return { kind: "conflict", reservationId: row.reservation_id };
  }
  const bytes = snapshotBytes(row.response_snapshot_bytes);
  if (bytes === null || !validHash(row.response_snapshot_sha256)) {
    throw new MediaUploadStoreError({ reason: "invalid-row" });
  }
  return {
    kind: "replay",
    reservationId: row.reservation_id,
    bytes,
    sha256: row.response_snapshot_sha256,
  };
}

function readLocatorByAuthor(input: {
  readonly submissionId: string;
  readonly actorUserId: string;
  readonly personaId: string;
}) {
  return Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<Row>({
      label: "media-upload.author-view-locator",
      text: "SELECT community_id,updated_at FROM media_post_submissions WHERE submission_id=$1 AND actor_user_id=$2 AND author_persona_id=$3",
      values: [input.submissionId, input.actorUserId, input.personaId],
      readonly: true,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1 || !validId(result.rows[0]?.community_id)) {
      return yield* Effect.fail(new MediaUploadStoreError({ reason: "invalid-row" }));
    }
    return {
      communityId: result.rows[0]?.community_id as string,
      updatedAt: yield* Effect.try({
        try: () => iso(result.rows[0]?.updated_at),
        catch: () => new MediaUploadStoreError({ reason: "invalid-row" }),
      }),
    };
  });
}

function readLocatorByModerator(input: {
  readonly submissionId: string;
  readonly moderatorActor: M2Actor;
}) {
  return Effect.gen(function* () {
    if (
      (input.moderatorActor.kind !== "user" && input.moderatorActor.kind !== "admin") ||
      !validId(input.moderatorActor.userId)
    ) {
      return yield* Effect.fail(new MediaUploadStoreError({ reason: "not-found" }));
    }
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<Row>({
      label: "media-upload.moderator-view-locator",
      text: `SELECT community_id, actor_user_id, author_persona_id, updated_at,
                    public_persona_projection(author_persona_id) AS author_persona
               FROM media_post_submissions
              WHERE submission_id = $1
                AND has_community_moderation_capability_v1(
                  $2, community_id, 'moderation.act'
                )`,
      values: [input.submissionId, input.moderatorActor.userId],
      readonly: true,
    });
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const persona = publicPersonaFromSql(row?.author_persona);
    if (
      result.rows.length !== 1 ||
      !validId(row?.community_id) ||
      !validId(row?.actor_user_id) ||
      !validId(row?.author_persona_id) ||
      persona === null ||
      persona === undefined
    ) {
      return yield* Effect.fail(new MediaUploadStoreError({ reason: "invalid-row" }));
    }
    return {
      communityId: row.community_id as string,
      actorUserId: row.actor_user_id as string,
      personaId: row.author_persona_id as string,
      authorPersona: persona,
      updatedAt: yield* Effect.try({
        try: () => iso(row.updated_at),
        catch: () => new MediaUploadStoreError({ reason: "invalid-row" }),
      }),
    };
  });
}

function readLocatorByAccount(input: {
  readonly submissionId: string;
  readonly actorUserId: string;
}) {
  return Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<Row>({
      label: "media-upload.account-view-locator",
      text: "SELECT community_id,author_persona_id FROM media_post_submissions WHERE submission_id=$1 AND actor_account_id=$2",
      values: [input.submissionId, input.actorUserId],
      readonly: true,
    });
    if (result.rows.length === 0) return null;
    if (
      result.rows.length !== 1 ||
      !validId(result.rows[0]?.community_id) ||
      !validId(result.rows[0]?.author_persona_id)
    ) {
      return yield* Effect.fail(new MediaUploadStoreError({ reason: "invalid-row" }));
    }
    return {
      communityId: result.rows[0]?.community_id as string,
      personaId: result.rows[0]?.author_persona_id as string,
    };
  });
}

/**
 * Application command surface injected into the HTTP transport by the later
 * composition owner. Keeping this adapter outside the Worker preserves the
 * application import boundary without widening a shared export barrel.
 */
export function makeMediaUploadApplicationCommands(
  services: MediaSubmissionServices,
  videoServices?: VideoPublicationServices,
) {
  const objectBody = (value: unknown): Readonly<Record<string, unknown>> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  const videoForAccount = async (input: {
    submissionId: string;
    actor: M2Actor;
  }): Promise<boolean> =>
    videoServices !== undefined &&
    (input.actor.kind === "user" || input.actor.kind === "admin") &&
    (await videoServices.store.getSubmissionForAccount({
      submissionId: input.submissionId,
      actorAccountId: input.actor.userId,
    })) !== null;
  return {
    reserve: (input: Parameters<typeof reserveMediaUpload>[0]) =>
      videoServices !== undefined && objectBody(input.body)?.track === "video"
        ? reserveVideoUpload(input, videoServices)
        : reserveMediaUpload(input, services),
    create: (input: Parameters<typeof createMediaSubmission>[0]) =>
      videoServices !== undefined && objectBody(input.body)?.version === "video-start-input-v1"
        ? createVideoSubmission(input, videoServices)
        : createMediaSubmission(input, services),
    bindTerms: (input: Parameters<typeof bindMediaTerms>[0]) => bindMediaTerms(input, services),
    bindLyrics: (input: Parameters<typeof bindMediaLyrics>[0]) => bindMediaLyrics(input, services),
    finalize: (input: Parameters<typeof finalizeMediaSubmission>[0]) =>
      videoServices !== undefined && Array.isArray(objectBody(input.body)?.parts)
        ? finalizeVideoSubmission(input, videoServices)
        : finalizeMediaSubmission(input, services),
    renewParts: (input: Parameters<typeof renewVideoUploadParts>[0]) => {
      if (videoServices === undefined) throw new MediaUploadStoreError({ reason: "unavailable" });
      return renewVideoUploadParts(input, videoServices);
    },
    get: async (input: Parameters<typeof getMediaSubmission>[0]) =>
      videoServices !== undefined && (await videoForAccount(input))
        ? getVideoSubmission(input, videoServices)
        : getMediaSubmission(input, services),
    bindReference: (input: Parameters<typeof bindMediaReference>[0]) =>
      bindMediaReference(input, services),
    retry: async (input: Parameters<typeof retryMediaSubmission>[0]) =>
      videoServices !== undefined && (await videoForAccount(input))
        ? retryVideoSubmission(input, videoServices)
        : retryMediaSubmission(input, services),
    retryPoster: (input: Parameters<typeof retryVideoPoster>[0]) => {
      if (videoServices === undefined) throw new MediaUploadStoreError({ reason: "unavailable" });
      return retryVideoPoster(input, videoServices);
    },
    cancel: async (input: Parameters<typeof cancelMediaSubmission>[0]) =>
      videoServices !== undefined && (await videoForAccount(input))
        ? cancelVideoSubmission(input, videoServices)
        : cancelMediaSubmission(input, services),
    moderate: async (input: Parameters<typeof moderateMediaSubmission>[0]) => {
      if (
        videoServices !== undefined &&
        (await videoServices.store.getSubmissionForModerator({
          submissionId: input.submissionId,
          actor: input.actor,
        })) !== null
      ) {
        return moderateVideoSubmission(input, videoServices);
      }
      return moderateMediaSubmission(input, services);
    },
  };
}

export function makeMediaUploadStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): MediaUploadStore {
  const repository = makeControlPlaneMediaSubmissionRepository();
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>): Promise<A> =>
    Effect.runPromise(
      Effect.provide(runtime)(effect).pipe(Effect.mapError((error) => mapFailure(error))),
    );
  const view = async (input: {
    readonly submissionId: string;
    readonly actorUserId: string;
    readonly personaId: string;
  }): Promise<MediaSubmissionView | null> => {
    const locator = await run(readLocatorByAuthor(input));
    if (locator === null) return null;
    const [state, lyrics] = await Promise.all([
      run(
        repository.getForAuthor({
          communityId: locator.communityId,
          submissionId: input.submissionId,
          actorUserId: input.actorUserId,
          personaId: input.personaId,
        }),
      ),
      run(
        repository.getLyricsForAuthor({
          communityId: locator.communityId,
          submissionId: input.submissionId,
          actorUserId: input.actorUserId,
          personaId: input.personaId,
        }),
      ),
    ]);
    if (state === null || lyrics === null) {
      throw new MediaUploadStoreError({ reason: "invalid-row" });
    }
    return { state, lyrics: lyrics as MediaLyricsSnapshot, updatedAt: locator.updatedAt };
  };

  const replayReservation: MediaUploadStore["replayReservation"] = (input) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "media-upload.reservation-replay",
          text: "SELECT community_id,reservation_id,request_hash,response_snapshot_bytes,response_snapshot_sha256 FROM media_upload_reservations WHERE actor_account_id=$1 AND actor_persona_id=$2 AND endpoint_template='/communities/:communityId/media-upload-reservations' AND idempotency_key=$3",
          values: [input.actorUserId, input.personaId, input.idempotencyKey],
          readonly: true,
        });
        if (result.rows.length === 0) return { kind: "none" } as const;
        if (result.rows.length !== 1) {
          return yield* Effect.fail(new MediaUploadStoreError({ reason: "invalid-row" }));
        }
        return yield* Effect.try({
          try: () => reservationReplay(result.rows[0] as Row, input.requestHash, input.communityId),
          catch: (error) =>
            error instanceof MediaUploadStoreError
              ? error
              : new MediaUploadStoreError({ reason: "invalid-row" }),
        });
      }),
    );

  const getFinalizeContext: MediaUploadStore["getFinalizeContext"] = async (input) => {
    const authorView = await view(input);
    if (
      authorView === null ||
      authorView.state.reservationId !== input.reservationId ||
      authorView.state.audioRevision !== 0 ||
      !["awaiting_upload", "finalize"].includes(authorView.state.phase ?? "")
    ) {
      return null;
    }
    const reservation = await run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "media-upload.finalize-context",
          text: "SELECT reservation_id,state,expected_content_type,expected_size_bytes,expected_sha256,expires_at FROM media_upload_reservations WHERE reservation_id=$1 AND actor_account_id=$2 AND actor_persona_id=$3 AND submission_id=$4 AND operation_id=$5",
          values: [
            input.reservationId,
            input.actorUserId,
            input.personaId,
            input.submissionId,
            authorView.state.operationId,
          ],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) {
          return yield* Effect.fail(new MediaUploadStoreError({ reason: "invalid-row" }));
        }
        const row = result.rows[0] as Row;
        const size = Number(row.expected_size_bytes);
        if (
          row.state !== "claimed" ||
          !validId(row.reservation_id) ||
          !validId(row.expected_content_type) ||
          !Number.isSafeInteger(size) ||
          size < 1 ||
          (row.expected_sha256 !== null && !validHash(row.expected_sha256))
        ) {
          return yield* Effect.fail(
            new MediaUploadStoreError({
              reason: "reservation-conflict",
              reservationId: input.reservationId,
            }),
          );
        }
        const expiresAt = yield* Effect.try({
          try: () => iso(row.expires_at),
          catch: () => new MediaUploadStoreError({ reason: "invalid-row" }),
        });
        if (authorView.state.phase === "awaiting_upload" && Date.parse(expiresAt) <= Date.now()) {
          return yield* Effect.fail(
            new MediaUploadStoreError({
              reason: "reservation-conflict",
              reservationId: input.reservationId,
            }),
          );
        }
        return {
          reservationId: row.reservation_id as string,
          state: "claimed" as const,
          expectedContentType: row.expected_content_type as string,
          expectedSizeBytes: size,
          expectedSha256: row.expected_sha256 as string | null,
          expiresAt,
        };
      }),
    );
    return reservation === null ? null : { view: authorView, reservation };
  };

  const recordFinalizeSourceMissing: MediaUploadStore["recordFinalizeSourceMissing"] = (input) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute({
              label: "media-upload.finalize-missing-lock",
              text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
              values: [
                JSON.stringify([
                  input.actorUserId,
                  input.personaId,
                  input.endpointTemplate,
                  input.idempotencyKey,
                ]),
              ],
              readonly: false,
            });
            const prior = yield* tx.execute<Row>({
              label: "media-upload.finalize-missing-replay",
              text: "SELECT community_id,submission_id,operation_id,request_hash,response_snapshot_bytes,response_snapshot_sha256 FROM media_submission_command_replays WHERE actor_account_id=$1 AND actor_persona_id=$2 AND endpoint_template=$3 AND idempotency_key=$4 FOR UPDATE",
              values: [
                input.actorUserId,
                input.personaId,
                input.endpointTemplate,
                input.idempotencyKey,
              ],
              readonly: false,
            });
            if (prior.rows.length > 1) {
              return yield* Effect.fail(new MediaUploadStoreError({ reason: "invalid-row" }));
            }
            if (prior.rows.length === 1) {
              const row = prior.rows[0] as Row;
              if (!validId(row.submission_id)) {
                return yield* Effect.fail(new MediaUploadStoreError({ reason: "invalid-row" }));
              }
              if (
                row.request_hash !== input.requestHash ||
                row.community_id !== input.communityId
              ) {
                return { kind: "conflict", submissionId: row.submission_id } as const;
              }
              const bytes = snapshotBytes(row.response_snapshot_bytes);
              if (
                bytes === null ||
                !validHash(row.response_snapshot_sha256) ||
                !validId(row.operation_id)
              ) {
                return yield* Effect.fail(new MediaUploadStoreError({ reason: "invalid-row" }));
              }
              return {
                kind: "replay",
                submissionId: row.submission_id,
                operationId: row.operation_id,
                bytes,
                sha256: row.response_snapshot_sha256,
              } as const;
            }
            const current = yield* tx.execute<Row>({
              label: "media-upload.finalize-missing-current",
              text: "SELECT s.operation_id FROM media_post_submissions s JOIN media_upload_reservations r ON r.community_id=s.community_id AND r.actor_account_id=s.actor_account_id AND r.actor_persona_id=s.author_persona_id AND r.reservation_id=s.audio_reservation_id AND r.submission_id=s.submission_id AND r.operation_id=s.operation_id WHERE s.community_id=$1 AND s.actor_account_id=$2 AND s.author_persona_id=$3 AND s.submission_id=$4 AND s.operation_id=$5 AND s.creation_revision=$6 AND s.status='processing' AND s.phase='awaiting_upload' AND s.audio_revision=0 AND r.reservation_id=$7 AND r.state='claimed' AND r.expires_at>clock_timestamp() FOR UPDATE OF s,r",
              values: [
                input.communityId,
                input.actorUserId,
                input.personaId,
                input.submissionId,
                input.operationId,
                input.expectedCreationRevision,
                input.reservationId,
              ],
              readonly: false,
            });
            if (current.rows.length !== 1) {
              return yield* Effect.fail(
                new MediaUploadStoreError({
                  reason: "transition-rejected",
                  submissionId: input.submissionId,
                }),
              );
            }
            const inserted = yield* tx.execute({
              label: "media-upload.finalize-missing-insert",
              text: "INSERT INTO media_submission_command_replays (community_id,actor_user_id,actor_persona_id,submission_actor_user_id,submission_author_persona_id,endpoint_template,idempotency_key,request_hash,submission_id,operation_id,response_snapshot_bytes,response_snapshot_sha256) VALUES ($1,$2,$3,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
              values: [
                input.communityId,
                input.actorUserId,
                input.personaId,
                input.endpointTemplate,
                input.idempotencyKey,
                input.requestHash,
                input.submissionId,
                input.operationId,
                input.responseBytes,
                input.responseSha256,
              ],
              readonly: false,
            });
            if (inserted.rowCount !== 1) {
              return yield* Effect.fail(new MediaUploadStoreError({ reason: "constraint" }));
            }
            return { kind: "committed", submissionId: input.submissionId } as const;
          }),
        );
      }),
    );

  return {
    replayReservation,
    reserve: (input) => run(repository.reserve(input)),
    replay: (input) => run(repository.replay(input)),
    createSubmission: (input) => run(repository.createSubmission(input)),
    getViewForAuthor: view,
    getAuthorContext: async (input) => {
      const locator = await run(readLocatorByAccount(input));
      if (locator === null) return null;
      const authorView = await view({ ...input, personaId: locator.personaId });
      return authorView === null ? null : { view: authorView, personaId: locator.personaId };
    },
    getFinalizeContext,
    beginFinalize: (input) => run(repository.beginFinalize(input)),
    getViewForModerator: async (input): Promise<MediaModeratorView | null> => {
      const locator = await run(readLocatorByModerator(input));
      if (locator === null) return null;
      const authorView = await view({
        submissionId: input.submissionId,
        actorUserId: locator.actorUserId,
        personaId: locator.personaId,
      });
      if (authorView === null) throw new MediaUploadStoreError({ reason: "invalid-row" });
      return { ...authorView, authorPersona: locator.authorPersona };
    },
    bindTerms: (input) =>
      run(repository.bindTerms(input as Parameters<typeof repository.bindTerms>[0])),
    bindLyrics: (input) =>
      run(repository.bindLyrics(input as Parameters<typeof repository.bindLyrics>[0])),
    bindReference: (input) =>
      run(repository.bindReference(input as Parameters<typeof repository.bindReference>[0])),
    retry: (input) => run(repository.retry(input)),
    authorCancel: (input) => run(repository.authorCancel(input)),
    finalizeSealed: (input) =>
      run(repository.finalizeSealed(input as Parameters<typeof repository.finalizeSealed>[0])),
    recordFinalizeSourceMissing,
    uploadExpectationMismatch: (input) => run(repository.uploadExpectationMismatch(input)),
    uploadSourcePreconditionFailed: (input) =>
      run(repository.uploadSourcePreconditionFailed(input)),
    recordSealConflict: (input) => run(repository.recordSealConflict(input)),
    recordMediaFailure: (input) => run(repository.recordMediaFailure(input)),
    moderate: (input) =>
      run(repository.moderate(input as Parameters<typeof repository.moderate>[0])),
  };
}
