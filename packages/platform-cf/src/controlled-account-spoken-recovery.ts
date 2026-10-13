import {
  type ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import type { ControlledAccountSpokenProtocol } from "@pirate/application/controlled-account-spoken";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";
import { LearnerAudioUploadCaptureSchema } from "./learner-audio-producer-store.ts";
import { OwnerSpokenRetainedSuccessResultSchema } from "./owner-spoken-checkpoint-store.ts";
const Success = Schema.Struct({
  ...OwnerSpokenRetainedSuccessResultSchema.fields,
  accountId: Schema.NonEmptyString,
  leaseToken: Schema.NonEmptyString,
});
const Archive = Schema.Union([
  Schema.Struct({ state: Schema.Literal("stored"), objectRef: Schema.NonEmptyString }),
  Schema.Struct({ state: Schema.Literal("failed"), objectRef: Schema.Null }),
]);
const Ready = Schema.Array(
  Schema.Struct({ capture: LearnerAudioUploadCaptureSchema, success: Success, archive: Archive }),
).check(Schema.isMaxLength(25));
/** Selected only after genuine capture/ordinary producer conversion. Replaces
 * legacy lease-steal/delete/head/finalizeFailed cron; no historical unknown is
 * converted merely because its lease expired. No R2 operation exists here.
 */
export const makeControlledAccountSpokenRecovery = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  finalize: ControlledAccountSpokenProtocol["finalize"],
) => ({
  recover: Effect.fn("controlledAccountSpokenRecovery.recover")(function* () {
    const rows = yield* boundedLearnerAudioTransaction((tx) =>
      tx.execute<unknown>({
        label: "account-spoken.recovery.closed-checkpoints",
        text: "SELECT list_closed_account_spoken_checkpoints_private_v1(25) AS result",
        values: [],
        readonly: false,
      }),
    ).pipe(Effect.provide(runtime));
    const ready = yield* Effect.try({
      try: () => {
        if (rows.rows.length !== 1) throw new Error();
        const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), {
          onExcessProperty: "error",
        })(rows.rows[0]);
        return Schema.decodeUnknownSync(Ready, { onExcessProperty: "error" })(envelope.result);
      },
      catch: () =>
        new ControlPlaneStatementFailed({
          label: "account-spoken.recovery.closed-checkpoints",
          sqlState: null,
          constraint: null,
          outcomeCertainty: "completed",
        }),
    });
    let recovered = 0;
    const fenced = 0;
    for (const candidate of ready) {
      if (
        candidate.capture.sourceKind !== "study" ||
        candidate.capture.commandRef !== candidate.success.commandId ||
        candidate.capture.artifactId !== candidate.success.artifactId ||
        candidate.capture.attemptRef !== candidate.success.attemptId ||
        candidate.capture.contentDigest !== candidate.success.audioDigest
      )
        return yield* new ControlPlaneStatementFailed({
          label: "account-spoken.recovery.correlation",
          sqlState: null,
          constraint: null,
          outcomeCertainty: "completed",
        });
      // A lost COMMIT acknowledgement must stop before any later candidate or
      // guest/expiry stage. The original native receipt remains reconcilable.
      yield* finalize(candidate.capture, candidate.success, candidate.archive);
      recovered++;
    }
    return { claimed: ready.length, recovered, storageFailures: 0, fenced };
  }),
});
