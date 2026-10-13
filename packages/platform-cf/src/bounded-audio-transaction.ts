import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Effect, Schema } from "effect";

const Bounds = Schema.Struct({
  transaction: Schema.Literal("3s"),
  lock: Schema.Literal("250ms"),
  statement: Schema.Literal("2s"),
  idle: Schema.Literal("2s"),
});
const limits = Effect.fn("learnerAudioTransaction.limits")(function* (tx: ControlPlaneTransaction) {
  yield* tx.execute({
    label: "learner-audio.limits.set",
    text: "SELECT set_config('transaction_timeout','3s',true),set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)",
    values: [],
    readonly: true,
  });
  const rows = yield* tx.execute<unknown>({
    label: "learner-audio.limits.verify",
    text: "SELECT current_setting('transaction_timeout') AS transaction,current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement,current_setting('idle_in_transaction_session_timeout') AS idle",
    values: [],
    readonly: true,
  });
  yield* Effect.try({
    try: () => {
      if (rows.rows.length !== 1) throw new Error();
      Schema.decodeUnknownSync(Bounds, { onExcessProperty: "error" })(rows.rows[0]);
    },
    catch: () =>
      new ControlPlaneStatementFailed({
        label: "learner-audio.limits.verify",
        sqlState: null,
        constraint: null,
        outcomeCertainty: "completed",
      }),
  });
});
export const boundedLearnerAudioTransaction = Effect.fn("boundedLearnerAudioTransaction")(
  function* <A, E, R>(
    use: (tx: ControlPlaneTransaction) => Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | ControlPlaneError, R | ControlPlaneDb> {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((tx) => limits(tx).pipe(Effect.flatMap(() => use(tx))));
  },
);
