import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneStatement,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Cause, Effect, Layer, Predicate } from "effect";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

export type FailureDiagnostic =
  | Readonly<{
      _tag: string;
      label: string | null;
      sqlState: string | null;
      constraint: string | null;
      phase: string | null;
      outcomeCertainty: string | null;
    }>
  | Readonly<{
      _tag: string;
      reason: "in-flight" | "store-unavailable" | "storage-unavailable" | null;
      bucketCalls: number | null;
    }>;

type Sink = (diagnostic: FailureDiagnostic) => void;
const log: Sink = (diagnostic) => console.error("postgres-test-failure", diagnostic);

// Diagnostic failure (including a hostile getter or throwing console) must not
// become another Cause, mask the original failure, or change cleanup behavior.
const safely = (write: () => void) => {
  try {
    write();
  } catch {
    // The original Effect outcome remains authoritative.
  }
};
const identifier = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(value) ? value : null;
const label = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z][a-z0-9._-]{0,127}$/.test(value) ? value : null;

const observeNative = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  statementLabel: string | null,
  sink: Sink,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.onError((cause) =>
      Effect.sync(() =>
        safely(() => {
          for (const reason of cause.reasons) {
            const error: Record<PropertyKey, unknown> =
              Cause.isFailReason(reason) && Predicate.isObject(reason.error) ? reason.error : {};
            const tag = error._tag;
            const native =
              tag === "ControlPlaneStatementFailed" ||
              tag === "ControlPlaneOperationTimedOut" ||
              tag === "ControlPlaneTransactionOutcomeUnknown" ||
              tag === "ControlPlaneAcquireFailed";
            const phase = error.phase;
            const certainty = error.outcomeCertainty;
            sink({
              _tag: native
                ? tag
                : Cause.isDieReason(reason)
                  ? "Die"
                  : Cause.isFailReason(reason)
                    ? "Fail"
                    : "Interrupt",
              label: native ? (label(error.label) ?? label(statementLabel)) : label(statementLabel),
              sqlState:
                native && typeof error.sqlState === "string" && /^[0-9A-Z]{5}$/.test(error.sqlState)
                  ? error.sqlState
                  : null,
              constraint: native ? identifier(error.constraint) : null,
              phase:
                native &&
                (phase === "commit" ||
                  phase === "rollback" ||
                  phase === "connection" ||
                  phase === "acquisition")
                  ? phase
                  : null,
              outcomeCertainty:
                native &&
                (certainty === "completed" ||
                  certainty === "aborted" ||
                  certainty === "not-started" ||
                  certainty === "unknown")
                  ? certainty
                  : tag === "ControlPlaneTransactionOutcomeUnknown"
                    ? "unknown"
                    : null,
            });
          }
        }),
      ),
    ),
  );

// Delegate the original transaction exactly once. Decorate the transaction's
// own execute too: decorating only db.execute misses repository transactions.
export const withPostgresFailureDiagnostics = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
  sink: Sink = log,
): Layer.Layer<ControlPlaneDb, ControlPlaneError> =>
  Layer.effect(
    ControlPlaneDb,
    Effect.map(ControlPlaneDb, (db) => {
      const transaction = (original: ControlPlaneTransaction): ControlPlaneTransaction => ({
        execute: <Row = unknown>(statement: ControlPlaneStatement) =>
          observeNative(original.execute<Row>(statement), statement.label, sink),
      });
      return ControlPlaneDb.of({
        ...transaction(db),
        withTransaction: (use) =>
          observeNative(
            db.withTransaction((tx) => use(transaction(tx))),
            null,
            sink,
          ),
      });
    }),
  ).pipe(Layer.provide(runtime));

export const makeDiagnosticPostgresControlPlaneLayer = (
  ...args: Parameters<typeof makeDirectPostgresControlPlaneLayer>
) => withPostgresFailureDiagnostics(makeDirectPostgresControlPlaneLayer(...args));

// Observe the typed reason before runPromise translates an Effect failure.
// Only the number of bucket invocations is read, never the keys or input owner.
export const observeAudioDeletionFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  bucketCalls: () => number,
  sink: Sink = log,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.onError((cause) =>
      Effect.sync(() =>
        safely(() => {
          for (const failure of cause.reasons) {
            const error: Record<PropertyKey, unknown> =
              Cause.isFailReason(failure) && Predicate.isObject(failure.error) ? failure.error : {};
            const typed = error._tag === "LearnerAudioDeletionFailed";
            const reason = error.reason;
            const calls = bucketCalls();
            sink({
              _tag: typed
                ? "LearnerAudioDeletionFailed"
                : Cause.isDieReason(failure)
                  ? "Die"
                  : Cause.isFailReason(failure)
                    ? "Fail"
                    : "Interrupt",
              reason:
                typed &&
                (reason === "in-flight" ||
                  reason === "store-unavailable" ||
                  reason === "storage-unavailable")
                  ? reason
                  : null,
              bucketCalls: Number.isSafeInteger(calls) && calls >= 0 ? calls : null,
            });
          }
        }),
      ),
    ),
  );
