// PRIVATE source proposal. No public owner arrays, no R2 dependency, no grants.
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";
import {
  LearnerAudioCaptureRejected,
  type CapturedLearnerAudioUploadStore,
  type CapturedUploadDisposition,
} from "./learner-audio-captured-io.ts";
const Capture = Schema.Struct({
  uploadAttemptId: Schema.NonEmptyString,
  sourceOwnerId: Schema.NonEmptyString,
  artifactId: Schema.NonEmptyString,
  sourceKind: Schema.Literals(["study", "karaoke"]),
  attemptRef: Schema.NonEmptyString,
  commandRef: Schema.NonEmptyString,
  reservationRef: Schema.NonEmptyString,
  capturedRevision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  objectRef: Schema.NonEmptyString,
  contentDigest: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
  contentType: Schema.NonEmptyString,
  byteSize: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
});
const Status = Schema.Struct({
  capture: Capture,
  ioState: Schema.Literals(["registered", "writing", "unknown", "closed"]),
  storageDisposition: Schema.NullOr(Schema.Literals(["stored", "absent", "failed"])),
  cleanupRequired: Schema.Boolean,
  mayPublish: Schema.Boolean,
  mayContinue: Schema.Boolean,
  claimed: Schema.Boolean,
});
const invalid = () => new LearnerAudioCaptureRejected({ reason: "capture-mismatch" });
function one<S extends Schema.ConstraintDecoder<unknown>>(
  tx: ControlPlaneTransaction,
  label: string,
  text: string,
  values: readonly unknown[],
  schema: S,
) {
  return tx.execute<unknown>({ label, text, values, readonly: false }).pipe(
    Effect.flatMap((rows) =>
      Effect.try({
        try: () => {
          if (rows.rows.length !== 1) throw invalid();
          const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), {
            onExcessProperty: "error",
          })(rows.rows[0]);
          return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(envelope.result);
        },
        catch: invalid,
      }),
    ),
  );
}
export const makeCapturedLearnerAudioUploadStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CapturedLearnerAudioUploadStore => {
  const short = <A>(
    use: (
      tx: ControlPlaneTransaction,
    ) => Effect.Effect<A, ControlPlaneError | LearnerAudioCaptureRejected>,
  ) => boundedLearnerAudioTransaction(use).pipe(Effect.provide(runtime));
  return {
    claim: (capture) =>
      short((tx) =>
        one(
          tx,
          "learner-audio.capture.claim",
          "SELECT claim_captured_learner_audio_private_v1($1::jsonb) AS result",
          [JSON.stringify(capture)],
          Status,
        ).pipe(
          Effect.flatMap(
            (status): Effect.Effect<CapturedUploadDisposition, LearnerAudioCaptureRejected> => {
              if (
                Object.keys(status.capture).some(
                  (key) => Reflect.get(status.capture, key) !== Reflect.get(capture, key),
                )
              )
                return Effect.fail(invalid());
              if (status.claimed) return Effect.succeed({ state: "write" } as const);
              if (status.ioState !== "closed") return Effect.succeed({ state: "unknown" } as const);
              return Effect.succeed(
                status.mayPublish
                  ? ({ state: "stored", objectRef: status.capture.objectRef } as const)
                  : ({ state: "failed" } as const),
              );
            },
          ),
        ),
      ),
    mayContinue: (capture) =>
      short((tx) =>
        one(
          tx,
          "learner-audio.capture.continue",
          "SELECT continue_captured_learner_audio_private_v1($1::jsonb) AS result",
          [JSON.stringify(capture)],
          Schema.Boolean,
        ),
      ),
    noteMultipartId: Effect.fn("CapturedLearnerAudioUploadStore.noteMultipartId")(function* (
      capture: Parameters<CapturedLearnerAudioUploadStore["noteMultipartId"]>[0],
      id: string,
    ) {
      return yield* short(
        Effect.fn("CapturedLearnerAudioUploadStore.noteMultipartId.transaction")(function* (
          tx: ControlPlaneTransaction,
        ) {
          yield* one(
            tx,
            "learner-audio.capture.require",
            "SELECT require_captured_learner_audio_private_v1($1::jsonb) AS result",
            [JSON.stringify(capture)],
            Schema.String,
          );
          yield* tx.execute({
            label: "learner-audio.capture.multipart-id",
            text: "SELECT note_learner_audio_multipart_id_private_v1($1,$2)",
            values: [capture.uploadAttemptId, id],
            readonly: false,
          });
        }),
      );
    }),
    settle: Effect.fn("CapturedLearnerAudioUploadStore.settle")(function* (
      input: Parameters<CapturedLearnerAudioUploadStore["settle"]>[0],
    ) {
      return yield* short(
        Effect.fn("CapturedLearnerAudioUploadStore.settle.transaction")(function* (
          tx: ControlPlaneTransaction,
        ) {
          yield* one(
            tx,
            "learner-audio.capture.require",
            "SELECT require_captured_learner_audio_private_v1($1::jsonb) AS result",
            [JSON.stringify(input.capture)],
            Schema.String,
          );
          return yield* one(
            tx,
            "learner-audio.capture.settle",
            "SELECT settle_learner_audio_terminal_fact_private_v1($1,$2,$3,$4,$5::jsonb) AS result",
            [
              input.capture.uploadAttemptId,
              input.disposition,
              input.knownNoMoreIo,
              input.multipartId,
              input.terminalFact === undefined ? null : JSON.stringify(input.terminalFact),
            ],
            Schema.Boolean,
          );
        }),
      );
    }),
  };
};
export { Capture as LearnerAudioUploadCaptureSchema };
