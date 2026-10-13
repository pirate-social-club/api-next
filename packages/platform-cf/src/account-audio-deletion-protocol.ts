import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  LearnerAudioDeletionFailed,
} from "@pirate/application";
import { LearnerAudioDeletionResult } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";
import type { AccountLearnerAudioDeleteProtocol } from "./owner-audio-deletion-io.ts";

const invalid = () => new LearnerAudioDeletionFailed({ reason: "store-unavailable" });
const Prepared = Schema.Struct({
  batchId: Schema.NonEmptyString,
  objectRefs: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(1000)),
  fenceRevision: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
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
export const makeAccountLearnerAudioDeleteProtocol = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): AccountLearnerAudioDeleteProtocol => {
  const short = <A>(
    use: (
      tx: ControlPlaneTransaction,
    ) => Effect.Effect<A, ControlPlaneError | LearnerAudioDeletionFailed>,
  ) => boundedLearnerAudioTransaction(use).pipe(Effect.provide(runtime));
  return {
    prepare: Effect.fn("accountAudioDelete.prepare")(function* (accountId: string, maximum: 1000) {
      return yield* short((tx) =>
        one(
          tx,
          "account-audio-delete.prepare",
          "SELECT prepare_account_audio_delete_private_v1($1,$2) AS result",
          [accountId, maximum],
          Prepared,
        ),
      );
    }),
    unknown: Effect.fn("accountAudioDelete.unknown")(function* (
      batch: Parameters<AccountLearnerAudioDeleteProtocol["unknown"]>[0],
    ) {
      yield* boundedLearnerAudioTransaction((tx) =>
        tx.execute({
          label: "account-audio-delete.unknown",
          text: "SELECT fail_account_audio_delete_private_v1($1,$2)",
          values: [batch.batchId, batch.fenceRevision],
          readonly: false,
        }),
      ).pipe(Effect.provide(runtime));
    }),
    confirm: Effect.fn("accountAudioDelete.confirm")(function* (
      batch: Parameters<AccountLearnerAudioDeleteProtocol["confirm"]>[0],
      deletedAt: string,
    ) {
      return yield* short((tx) =>
        one(
          tx,
          "account-audio-delete.confirm",
          "SELECT confirm_account_audio_delete_private_v1($1,$2,$3::timestamptz) AS result",
          [batch.batchId, batch.fenceRevision, deletedAt],
          LearnerAudioDeletionResult,
        ),
      ).pipe(
        Effect.catchTag(
          "ControlPlaneStatementFailed",
          (error): Effect.Effect<never, ControlPlaneError | LearnerAudioDeletionFailed> =>
            error.sqlState === "GA001"
              ? Effect.fail(new LearnerAudioDeletionFailed({ reason: "in-flight" }))
              : Effect.fail(error),
        ),
      );
    }),
  };
};
