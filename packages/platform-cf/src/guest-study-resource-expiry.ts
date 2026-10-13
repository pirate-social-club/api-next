// Private system adapter. No browser endpoint, raw owner selector or activation.
import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import { Effect, type Layer, Schema } from "effect";

const Result = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle") }),
  Schema.Struct({
    state: Schema.Literal("released"),
    terminalState: Schema.Literals(["completed", "expired"]),
  }),
]);
const Limits = Schema.Struct({
  transaction: Schema.Literal("3s"),
  lock: Schema.Literal("250ms"),
  statement: Schema.Literal("2s"),
  idle: Schema.Literal("2s"),
});
const invalid = (label: string) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });
export function makeControlPlaneGuestStudyResourceExpiry(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  const releaseNext = Effect.fn("GuestStudyResourceExpiry.releaseNext")(function* () {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute({
          label: "guest-expiry.limits",
          text: "SELECT set_config('transaction_timeout','3s',true),set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)",
          values: [],
          readonly: true,
        });
        const limits = yield* transaction.execute({
          label: "guest-expiry.limits.verify",
          text: "SELECT current_setting('transaction_timeout') AS transaction,current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement,current_setting('idle_in_transaction_session_timeout') AS idle",
          values: [],
          readonly: true,
        });
        yield* Effect.try({
          try: () => {
            if (limits.rows.length !== 1) throw new Error();
            Schema.decodeUnknownSync(Limits, { onExcessProperty: "error" })(limits.rows[0]);
          },
          catch: () => invalid("guest-expiry.limits.decode"),
        });
        const reply = yield* transaction.execute({
          label: "guest-expiry.release-next",
          text: "SELECT release_next_guest_study_resource_remainder_v1() AS result",
          values: [],
          readonly: false,
        });
        return yield* Effect.try({
          try: () => {
            if (reply.rows.length !== 1) throw new Error();
            return Schema.decodeUnknownSync(Schema.Struct({ result: Result }), {
              onExcessProperty: "error",
            })(reply.rows[0]).result;
          },
          catch: () => invalid("guest-expiry.result.decode"),
        });
      }),
    );
  });
  return { releaseNext: () => releaseNext().pipe(Effect.provide(runtime)) };
}
