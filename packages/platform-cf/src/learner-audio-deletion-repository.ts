import {
  ControlPlaneDb,
  type ControlPlaneError,
  LearnerAudioDeletionFailed,
  type LearnerAudioDeletionStore,
} from "@pirate/application";
import { Effect, type Layer } from "effect";
import { lockLearnerAudioAccount } from "./learner-audio-account-lock.ts";

type Row = Readonly<Record<string, unknown>>;

export const LEARNER_AUDIO_DELETE_BATCH_LIMIT = 1_000;

export interface LearnerAudioDeletionBucket {
  readonly delete: (keys: string | string[]) => Promise<void>;
}

const failed = (reason: LearnerAudioDeletionFailed["reason"]) =>
  new LearnerAudioDeletionFailed({ reason });

const mapControlPlaneError = (_error: ControlPlaneError) => failed("store-unavailable");

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${key}`);
  return value;
};

const count = (row: Row, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${key}`);
  return value;
};

const iso = (value: unknown): string => {
  const instant = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(instant.getTime())) throw new Error("invalid instant");
  return instant.toISOString();
};

const makeControlPlaneLearnerAudioDeletionRepository = (bucket: LearnerAudioDeletionBucket) => ({
  deleteBatch: ({
    accountId,
    deletedAt,
  }: Parameters<LearnerAudioDeletionStore["deleteBatch"]>[0]) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db
        .withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* lockLearnerAudioAccount(transaction, accountId);

            const inFlight = yield* transaction.execute<Row>({
              label: "learner-audio.in-flight.read",
              text: `SELECT
                EXISTS (
                  SELECT 1 FROM study_spoken_answer_commands
                   WHERE account_id=$1 AND state='reserved'
                     AND lease_expires_at > clock_timestamp()
                ) OR EXISTS (
                  SELECT 1 FROM karaoke_sessions
                   WHERE account_id=$1 AND status='active'
                     AND expires_at > clock_timestamp()
                ) AS blocked`,
              values: [accountId],
              readonly: true,
            });
            if (inFlight.rows[0]?.blocked === true) return yield* failed("in-flight");

            const totalResult = yield* transaction.execute<Row>({
              label: "learner-audio.stored.count",
              text: `SELECT count(*)::bigint AS stored_count
                       FROM learner_audio_artifacts
                      WHERE account_id=$1 AND recording_state='stored'`,
              values: [accountId],
              readonly: true,
            });
            const storedCount = count(totalResult.rows[0] as Row, "stored_count");

            if (storedCount === 0) {
              const latest = yield* transaction.execute<Row>({
                label: "learner-audio.deleted.latest",
                text: `SELECT max(deleted_at) AS last_deleted_at
                         FROM learner_audio_artifacts
                        WHERE account_id=$1 AND recording_state='deleted'`,
                values: [accountId],
                readonly: true,
              });
              const lastDeletedAt = latest.rows[0]?.last_deleted_at;
              return {
                object: "learner_audio_deletion" as const,
                deleted_count: 0,
                remaining_count: 0,
                last_deleted_at: lastDeletedAt == null ? null : iso(lastDeletedAt),
              };
            }

            const selected = yield* transaction.execute<Row>({
              label: "learner-audio.stored.select",
              text: `SELECT learner_audio_artifact_id, object_ref
                       FROM learner_audio_artifacts
                      WHERE account_id=$1 AND recording_state='stored'
                      ORDER BY created_at, learner_audio_artifact_id
                      LIMIT $2 FOR UPDATE`,
              values: [accountId, LEARNER_AUDIO_DELETE_BATCH_LIMIT],
              readonly: false,
            });
            const artifactIds = selected.rows.map((row) => text(row, "learner_audio_artifact_id"));
            const objectRefs = selected.rows.map((row) => text(row, "object_ref"));

            // The account advisory lock stays held through the one bounded R2 call.
            // R2 deletion precedes tombstoning so storage failure remains retryable.
            yield* Effect.tryPromise({
              try: () => bucket.delete(objectRefs),
              catch: () => failed("storage-unavailable"),
            });

            yield* transaction.execute({
              label: "learner-audio.karaoke.tombstone",
              text: `UPDATE karaoke_recordings
                        SET state='deleted', object_ref=NULL, reconciled_at=$2::timestamptz
                      WHERE artifact_id = ANY($1::text[]) AND state='stored'`,
              values: [artifactIds, deletedAt],
              readonly: false,
            });
            yield* transaction.execute({
              label: "learner-audio.artifact.tombstone",
              text: `UPDATE learner_audio_artifacts
                        SET recording_state='deleted', object_ref=NULL,
                            deleted_at=$2::timestamptz
                      WHERE learner_audio_artifact_id = ANY($1::text[])
                        AND account_id=$3 AND recording_state='stored'`,
              values: [artifactIds, deletedAt, accountId],
              readonly: false,
            });

            return {
              object: "learner_audio_deletion" as const,
              deleted_count: artifactIds.length,
              remaining_count: Math.max(0, storedCount - artifactIds.length),
              last_deleted_at: deletedAt,
            };
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof LearnerAudioDeletionFailed
              ? error
              : mapControlPlaneError(error as ControlPlaneError),
          ),
        );
    }),
});

export const makeControlPlaneLearnerAudioDeletionStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  bucket: LearnerAudioDeletionBucket,
): LearnerAudioDeletionStore => {
  const repository = makeControlPlaneLearnerAudioDeletionRepository(bucket);
  return {
    deleteBatch: (input) =>
      Effect.provide(runtime)(repository.deleteBatch(input)).pipe(
        Effect.mapError((error) =>
          error instanceof LearnerAudioDeletionFailed
            ? error
            : mapControlPlaneError(error as ControlPlaneError),
        ),
      ),
  };
};
