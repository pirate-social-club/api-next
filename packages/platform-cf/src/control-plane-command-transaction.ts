import { Cause, Effect, Exit } from "effect";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "../../application/src/ports.ts";

/** One existing ControlPlaneDb transaction, never retried. Retain callback and
 * bounded release outcomes before rc.109 restores external interruption. Domain
 * locks, replay authorization and error classification remain with the caller.
 */
export const withRetainedControlPlaneCommandTransaction = Effect.fn(
  "ControlPlaneCommand.withTransaction",
)(function* <A, E, R>(
  use: (transaction: ControlPlaneTransaction) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | ControlPlaneError, R | ControlPlaneDb> {
  const db = yield* ControlPlaneDb;
  let callbackCause: Cause.Cause<E> | undefined;
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(
        db.withTransaction((transaction) =>
          restore(
            Effect.gen(function* () {
              return yield* use(transaction);
            }).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit)) callbackCause = exit.cause;
                }),
              ),
            ),
          ),
        ),
      );
      const cancellation = yield* Effect.exit(restore(Effect.void));
      if (Exit.isFailure(outcome)) {
        const cause =
          callbackCause === undefined ? outcome.cause : Cause.combine(callbackCause, outcome.cause);
        return yield* Effect.failCause(
          Exit.isFailure(cancellation) ? Cause.combine(cause, cancellation.cause) : cause,
        );
      }
      if (Exit.isFailure(cancellation)) return yield* Effect.failCause(cancellation.cause);
      return outcome.value;
    }),
  );
});
