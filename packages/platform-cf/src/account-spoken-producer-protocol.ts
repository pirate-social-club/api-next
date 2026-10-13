import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  StudyV2CommandRejected,
  StudyV2StoreFailed,
} from "@pirate/application";
import {
  assertAccountSpokenSavedSuccess,
  type ControlledAccountSpokenProtocol,
} from "@pirate/application/controlled-account-spoken";
import { LearnerAudioStorageOutcomeUnknown } from "@pirate/application/learner-audio-io-outcome";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";
import {
  type CapturedStudyAudioBucket,
  LearnerAudioCaptureRejected,
  makeCapturedR2StudyAudioArchive,
} from "./learner-audio-captured-io.ts";
import {
  LearnerAudioUploadCaptureSchema,
  makeCapturedLearnerAudioUploadStore,
} from "./learner-audio-producer-store.ts";
import { OwnerSpokenRetainedSuccessResultSchema } from "./owner-spoken-checkpoint-store.ts";

const Success = Schema.Struct({
  ...OwnerSpokenRetainedSuccessResultSchema.fields,
  accountId: Schema.NonEmptyString,
  leaseToken: Schema.NonEmptyString,
});
const Loaded = Schema.Struct({ capture: LearnerAudioUploadCaptureSchema, success: Success });
const invalid = () => new StudyV2StoreFailed({ reason: "invalid-row" });
const mapFailure = (
  error:
    | ControlPlaneError
    | LearnerAudioCaptureRejected
    | LearnerAudioStorageOutcomeUnknown
    | StudyV2StoreFailed,
) =>
  error instanceof StudyV2StoreFailed
    ? error
    : error instanceof LearnerAudioStorageOutcomeUnknown ||
        error._tag === "ControlPlaneTransactionOutcomeUnknown"
      ? new StudyV2StoreFailed({ reason: "outcome-unknown" })
      : error instanceof LearnerAudioCaptureRejected
        ? new StudyV2CommandRejected({ reason: "command-in-flight" })
        : new StudyV2StoreFailed({ reason: "unavailable" });
function one<S extends Schema.ConstraintDecoder<unknown>>(
  tx: ControlPlaneTransaction,
  label: string,
  text: string,
  values: readonly unknown[],
  schema: S,
) {
  return tx.execute<unknown>({ label, text, values, readonly: false }).pipe(
    Effect.flatMap((r) =>
      Effect.try({
        try: () => {
          if (r.rows.length !== 1) throw invalid();
          const row = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), {
            onExcessProperty: "error",
          })(r.rows[0]);
          return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(row.result);
        },
        catch: invalid,
      }),
    ),
  );
}
export const makeAccountControlledSpokenProtocol = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  reserve: ControlledAccountSpokenProtocol["reserve"],
  finalize: ControlledAccountSpokenProtocol["finalize"],
  bucket: CapturedStudyAudioBucket,
  retainTask: (task: Promise<unknown>) => void,
): ControlledAccountSpokenProtocol => {
  const short = <A>(
    use: (tx: ControlPlaneTransaction) => Effect.Effect<A, ControlPlaneError | StudyV2StoreFailed>,
  ) =>
    boundedLearnerAudioTransaction(use).pipe(Effect.provide(runtime), Effect.mapError(mapFailure));
  const archive = makeCapturedR2StudyAudioArchive(
    makeCapturedLearnerAudioUploadStore(runtime),
    bucket,
    retainTask,
  );
  return {
    reserve,
    finalize,
    findSuccess: Effect.fn("accountSpokenProtocol.findSuccess")(function* (
      input: Parameters<ControlledAccountSpokenProtocol["findSuccess"]>[0],
    ) {
      const digest = yield* Effect.tryPromise({
        try: async () =>
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(input.audio))),
            (n) => n.toString(16).padStart(2, "0"),
          ).join(""),
        catch: invalid,
      });
      const loaded = yield* short((tx) =>
        one(
          tx,
          "account-spoken.success.find",
          "SELECT find_account_spoken_success_private_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
          [
            input.accountId,
            input.sessionId,
            input.sessionItemId,
            input.attemptNumber,
            input.idempotencyKey,
            digest,
            input.audioContentType,
            input.audio.byteLength,
            input.audioDurationMs,
          ],
          Schema.NullOr(Loaded),
        ),
      );
      if (loaded === null) return null;
      // The native predicate matched this actual stored key. Check every returned
      // route/audio/capture field before emitting its private match witness.
      const saved = { ...loaded, matchedIdempotencyKey: input.idempotencyKey };
      yield* assertAccountSpokenSavedSuccess(input, saved, digest);
      return saved;
    }),
    beginProvider: Effect.fn("accountSpokenProtocol.beginProvider")(function* (
      capture: Parameters<ControlledAccountSpokenProtocol["beginProvider"]>[0],
    ) {
      const started = yield* short((tx) =>
        one(
          tx,
          "account-spoken.provider.begin",
          "SELECT begin_account_spoken_provider_private_v1($1) AS result",
          [capture.uploadAttemptId],
          Schema.Boolean,
        ),
      );
      if (!started) return yield* new StudyV2CommandRejected({ reason: "command-in-flight" });
    }),
    providerUnknown: Effect.fn("accountSpokenProtocol.providerUnknown")(function* (
      capture: Parameters<ControlledAccountSpokenProtocol["providerUnknown"]>[0],
    ) {
      yield* short((tx) =>
        tx.execute({
          label: "account-spoken.provider.unknown",
          text: "SELECT mark_account_spoken_provider_unknown_private_v1($1)",
          values: [capture.uploadAttemptId],
          readonly: false,
        }),
      );
    }),
    persistSuccess: Effect.fn("accountSpokenProtocol.persistSuccess")(function* (
      capture: Parameters<ControlledAccountSpokenProtocol["persistSuccess"]>[0],
      result: Parameters<ControlledAccountSpokenProtocol["persistSuccess"]>[1],
    ) {
      return yield* short(
        Effect.fn("accountSpokenProtocol.persistSuccess.transaction")(function* (
          tx: ControlPlaneTransaction,
        ) {
          yield* tx.execute({
            label: "account-spoken.success.persist",
            text: "SELECT persist_account_spoken_success_private_v1($1,$2::jsonb)",
            values: [capture.uploadAttemptId, JSON.stringify(result)],
            readonly: false,
          });
          return yield* one(
            tx,
            "account-spoken.success.original",
            "SELECT load_account_spoken_success_private_v1($1) AS result",
            [capture.uploadAttemptId],
            Success,
          );
        }),
      );
    }),
    archive: Effect.fn("accountSpokenProtocol.archive")(function* (
      input: Parameters<ControlledAccountSpokenProtocol["archive"]>[0],
    ) {
      return yield* archive.store(input).pipe(Effect.mapError(mapFailure));
    }),
  };
};
