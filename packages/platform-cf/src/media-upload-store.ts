import {
  ControlPlaneDb,
  type ControlPlaneError,
  type M2Actor,
} from "@pirate/application";
import type {
  MediaLyricsSnapshot,
  MediaModeratorView,
  MediaSubmissionView,
  MediaUploadStore,
} from "../../application/src/media/submission-service.ts";
import { MediaUploadStoreError } from "../../application/src/media/submission-service.ts";
import { Effect, type Layer } from "effect";
import {
  makeControlPlaneMediaSubmissionRepository,
  MediaSubmissionRepositoryError,
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
      input.moderatorActor.kind !== "admin" ||
      input.moderatorActor.scopes?.includes("moderation") !== true
    ) {
      return yield* Effect.fail(new MediaUploadStoreError({ reason: "not-found" }));
    }
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<Row>({
      label: "media-upload.moderator-view-locator",
      text: "SELECT community_id,actor_user_id,author_persona_id,updated_at,public_persona_projection(author_persona_id) AS author_persona FROM media_post_submissions WHERE submission_id=$1",
      values: [input.submissionId],
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

  return {
    replay: (input) => run(repository.replay(input)),
    createSubmission: (input) => run(repository.createSubmission(input)),
    getViewForAuthor: view,
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
    moderate: (input) =>
      run(repository.moderate(input as Parameters<typeof repository.moderate>[0])),
  };
}
