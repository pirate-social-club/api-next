import type {
  ControlPlaneDb,
  ControlPlaneError,
  ControlPlaneTransaction,
  KaraokeSessionAuthority,
} from "@pirate/application";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";
import { LearnerAudioCaptureRejected } from "./learner-audio-captured-io.ts";
import {
  LearnerAudioUploadCaptureSchema,
  makeCapturedLearnerAudioUploadStore,
} from "./learner-audio-producer-store.ts";
export const makeCapturedKaraokeBindings = Effect.fn("makeCapturedKaraokeBindings")(function* (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  authority: KaraokeSessionAuthority,
) {
  const short = <A>(
    use: (
      tx: ControlPlaneTransaction,
    ) => Effect.Effect<A, ControlPlaneError | LearnerAudioCaptureRejected>,
  ) => boundedLearnerAudioTransaction(use).pipe(Effect.provide(runtime));
  const capture = yield* short((tx) =>
    tx
      .execute<unknown>({
        label: "karaoke.audio.capture.read",
        text: "SELECT read_account_karaoke_audio_capture_private_v1($1,$2,$3,$4) AS result",
        values: [
          authority.accountId,
          authority.sessionId,
          authority.attemptId,
          authority.artifactId,
        ],
        readonly: false,
      })
      .pipe(
        Effect.flatMap((rows) =>
          Effect.try({
            try: () => {
              if (rows.rows.length !== 1) throw new Error();
              const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), {
                onExcessProperty: "error",
              })(rows.rows[0]);
              return Schema.decodeUnknownSync(LearnerAudioUploadCaptureSchema, {
                onExcessProperty: "error",
              })(envelope.result);
            },
            catch: () => new LearnerAudioCaptureRejected({ reason: "capture-mismatch" }),
          }),
        ),
      ),
  );
  if (
    capture.sourceKind !== "karaoke" ||
    capture.commandRef !== authority.sessionId ||
    capture.attemptRef !== authority.attemptId ||
    capture.artifactId !== authority.artifactId ||
    capture.objectRef !== `karaoke/${authority.accountId}/${authority.attemptId}.pcm` ||
    capture.contentType !== "audio/L16;rate=16000;channels=1" ||
    capture.contentDigest !== null ||
    capture.byteSize !== null ||
    capture.durationMs !== null
  )
    return yield* new LearnerAudioCaptureRejected({ reason: "capture-mismatch" });
  const ledger = makeCapturedLearnerAudioUploadStore(runtime);
  return {
    capture,
    ledger,
    authorizeDeletionStop: async () => {
      await Effect.runPromise(
        short((tx) =>
          tx.execute({
            label: "karaoke.audio.deletion-fence",
            text: "SELECT require_captured_audio_deletion_stop_private_v1($1::jsonb)",
            values: [JSON.stringify(capture)],
            readonly: false,
          }),
        ),
      );
    },
    cancelUnclaimed: async () => {
      const rows = await Effect.runPromise(
        short((tx) =>
          tx.execute<unknown>({
            label: "karaoke.audio.cancel-unclaimed",
            // Account-bound entry point; the generic upload closure stays owner-only.
            text: "SELECT cancel_unclaimed_account_karaoke_audio_private_v1($1,$2,$3,$4,$5::jsonb) AS result",
            values: [
              authority.accountId,
              authority.sessionId,
              authority.attemptId,
              authority.artifactId,
              JSON.stringify(capture),
            ],
            readonly: false,
          }),
        ),
      );
      if (rows.rows.length !== 1)
        throw new LearnerAudioCaptureRejected({ reason: "capture-mismatch" });
      return Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Boolean }), {
        onExcessProperty: "error",
      })(rows.rows[0]).result;
    },
  };
});
