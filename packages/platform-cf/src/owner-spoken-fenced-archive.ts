// Guest-only bounded stage. Reuses actual accepted capture/checkpoint authority.
import {
  type ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  GuestParticipationStoreRejected,
} from "@pirate/application";
import type { OwnerStudyAudioArchive } from "@pirate/application/guest-study-ports";
import { GuestIdentifierV1, GuestSha256V1 } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";
import {
  type CapturedLearnerAudioUploadStore,
  type CapturedStudyAudioBucket,
  LearnerAudioCaptureRejected,
  makeCapturedR2StudyAudioArchive,
} from "./learner-audio-captured-io.ts";

const GuestCapture = Schema.Struct({
  uploadAttemptId: GuestIdentifierV1,
  sourceOwnerId: GuestIdentifierV1,
  artifactId: GuestIdentifierV1,
  sourceKind: Schema.Literal("study"),
  attemptRef: GuestIdentifierV1,
  commandRef: GuestIdentifierV1,
  reservationRef: GuestIdentifierV1,
  capturedRevision: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  objectRef: Schema.NonEmptyString.check(Schema.isMaxLength(213)),
  contentDigest: GuestSha256V1,
  contentType: Schema.Literals(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"]),
  byteSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 524288 })),
  durationMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 })),
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
    Effect.flatMap((r) =>
      Effect.try({
        try: () => {
          if (r.rows.length !== 1) throw invalid();
          const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), {
            onExcessProperty: "error",
          })(r.rows[0]);
          return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(envelope.result);
        },
        catch: invalid,
      }),
    ),
  );
}
const Status = Schema.Struct({
  capture: GuestCapture,
  claimed: Schema.Boolean,
  ioState: Schema.Literals(["registered", "writing", "unknown", "closed"]),
  storageDisposition: Schema.NullOr(Schema.Literals(["stored", "absent", "failed"])),
  cleanupRequired: Schema.Boolean,
  mayContinue: Schema.Boolean,
  mayPublish: Schema.Boolean,
});
export const makeOwnerSpokenFencedArchiveStage = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  bucket: CapturedStudyAudioBucket,
  retainTask: (task: Promise<unknown>) => void,
) => {
  const short = <A>(
    f: (
      tx: ControlPlaneTransaction,
    ) => Effect.Effect<A, ControlPlaneError | LearnerAudioCaptureRejected>,
  ) => boundedLearnerAudioTransaction(f).pipe(Effect.provide(runtime));
  const ledger: CapturedLearnerAudioUploadStore = {
    claim: (capture) =>
      short((tx) =>
        one(
          tx,
          "guest-audio.capture.claim",
          "SELECT claim_guest_audio_io_private_v1($1::jsonb) AS result",
          [JSON.stringify(capture)],
          Status,
        ).pipe(
          Effect.flatMap((status) => {
            if (
              Object.keys(status.capture).some(
                (key) => Reflect.get(status.capture, key) !== Reflect.get(capture, key),
              )
            )
              return Effect.fail(invalid());
            if (
              (status.claimed && (status.ioState !== "writing" || !status.mayContinue)) ||
              (status.mayPublish &&
                (status.ioState !== "closed" ||
                  status.storageDisposition !== "stored" ||
                  status.cleanupRequired ||
                  status.claimed))
            )
              return Effect.fail(invalid());
            return Effect.succeed(
              status.claimed
                ? ({ state: "write" } as const)
                : status.ioState !== "closed"
                  ? ({ state: "unknown" } as const)
                  : status.mayPublish
                    ? ({ state: "stored", objectRef: status.capture.objectRef } as const)
                    : ({ state: "failed" } as const),
            );
          }),
        ),
      ),
    settle: (input) =>
      short((tx) =>
        one(
          tx,
          "guest-audio.capture.settle",
          "SELECT settle_guest_audio_io_private_v1($1::jsonb,$2,$3) AS result",
          [JSON.stringify(input.capture), input.disposition, input.knownNoMoreIo],
          Schema.Boolean,
        ),
      ),
    // Guest Study uses one PUT; it has no multipart continuation/ID capability.
    mayContinue: () => Effect.fail(invalid()),
    noteMultipartId: () => Effect.fail(invalid()),
  };
  const archive = makeCapturedR2StudyAudioArchive(ledger, bucket, retainTask);
  return {
    store: Effect.fn("OwnerSpokenFencedArchiveStage.store")(
      function* (input: Parameters<OwnerStudyAudioArchive["store"]>[0]) {
        if (input.source.kind !== "guest") return yield* invalid();
        const capture = yield* short((tx) =>
          one(
            tx,
            "guest-audio.capture.resolve",
            "SELECT resolve_guest_audio_io_capture_private_v1($1::jsonb,$2::jsonb,$3,$4,$5,$6) AS result",
            [
              JSON.stringify(input.source),
              JSON.stringify(input.operation),
              input.artifactId,
              input.resourceReservationId,
              input.deletionFenceRevision,
              input.contentDigest,
            ],
            GuestCapture,
          ),
        );
        if (
          capture.sourceOwnerId !== input.source.ownerId ||
          capture.artifactId !== input.artifactId ||
          capture.reservationRef !== input.resourceReservationId ||
          capture.capturedRevision !== input.deletionFenceRevision ||
          capture.contentDigest !== input.contentDigest ||
          capture.contentType !== input.contentType
        )
          return yield* invalid();
        return yield* archive.store({ capture, audio: input.audio });
      },
      Effect.catchTag("LearnerAudioCaptureRejected", () =>
        Effect.fail(new GuestParticipationStoreRejected({ reason: "idempotency-conflict" })),
      ),
      Effect.catchTag(
        "ControlPlaneStatementFailed",
        (error): Effect.Effect<never, ControlPlaneError | GuestParticipationStoreRejected> =>
          error.sqlState === "GP005"
            ? Effect.fail(new GuestParticipationStoreRejected({ reason: "idempotency-conflict" }))
            : error.sqlState === "GP002"
              ? Effect.fail(new GuestParticipationStoreRejected({ reason: "owner-mismatch" }))
              : Effect.fail(error),
      ),
    ),
  };
};
