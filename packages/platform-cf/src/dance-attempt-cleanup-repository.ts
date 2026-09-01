import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import {
  DanceAttemptCleanupBinding,
  DanceAttemptCleanupInvalid,
  type DanceAttemptCleanupStore,
} from "@pirate/application/dance/attempt-cleanup";
import { Effect, type Layer, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Failure = DanceAttemptCleanupInvalid | ControlPlaneError;

const invalid = (phase: DanceAttemptCleanupInvalid["phase"]) =>
  new DanceAttemptCleanupInvalid({ phase });

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw invalid("claim");
  return value;
};

const integer = (row: Row, key: string): number => {
  const value = row[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw invalid("claim");
  return parsed;
};

function decodeBinding(value: unknown): DanceAttemptCleanupBinding {
  try {
    return Schema.decodeUnknownSync(DanceAttemptCleanupBinding, {
      onExcessProperty: "error",
    })(value);
  } catch {
    throw invalid("claim");
  }
}

function runWithRuntime<A>(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  effect: Effect.Effect<A, Failure, ControlPlaneDb>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(runtime)(effect)).catch((error: unknown) => {
    if (error instanceof DanceAttemptCleanupInvalid) throw error;
    throw invalid("claim");
  });
}

export function makeDanceAttemptCleanupStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): DanceAttemptCleanupStore {
  const claim: DanceAttemptCleanupStore["claim"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runWithRuntime(
          runtime,
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            const current = yield* db.execute<Row>({
              label: "dance-attempt-cleanup.current",
              text: `SELECT state,attempts FROM dance_media_cleanup_operations
                      WHERE cleanup_operation_id=$1`,
              values: [input.cleanupOperationId],
              readonly: true,
            });
            if (current.rows.length !== 1) {
              return { kind: "terminal", status: "exhausted" } as const;
            }
            const currentRow = current.rows[0] as Row;
            if (text(currentRow, "state") === "completed") {
              return { kind: "terminal", status: "completed" } as const;
            }
            if (text(currentRow, "state") === "failed" && integer(currentRow, "attempts") >= 10) {
              return { kind: "terminal", status: "exhausted" } as const;
            }
            const claimed = yield* db.execute<Row>({
              label: "dance-attempt-cleanup.claim",
              text: `UPDATE dance_media_cleanup_operations SET
                       state='leased',lease_owner=$2,lease_fence=lease_fence+1,
                       lease_expires_at=clock_timestamp()+make_interval(secs=>$3),
                       next_eligible_at=NULL,attempts=attempts+1,failure_code=NULL,
                       updated_at=clock_timestamp()
                      WHERE cleanup_operation_id=$1 AND attempts<10 AND (
                        state='pending'
                        OR (state='failed' AND next_eligible_at<=clock_timestamp())
                        OR (state='leased' AND lease_expires_at<=clock_timestamp())
                      ) RETURNING *`,
              values: [input.cleanupOperationId, input.workerId, input.leaseSeconds],
              readonly: false,
            });
            if (claimed.rows.length === 0) return { kind: "busy" } as const;
            if (claimed.rows.length !== 1) return yield* Effect.fail(invalid("claim"));
            const row = claimed.rows[0] as Row;
            return {
              kind: "claimed",
              binding: decodeBinding({
                version: "dance-attempt-cleanup-binding-v1",
                cleanupOperationId: text(row, "cleanup_operation_id"),
                sessionId: text(row, "session_id"),
                artifactKind: text(row, "artifact_kind"),
                privateArtifactRef: text(row, "private_artifact_ref"),
                attemptNumber: integer(row, "attempts"),
                claimOwner: text(row, "lease_owner"),
                claimFence: integer(row, "lease_fence"),
              }),
            } as const;
          }),
        ),
      catch: () => invalid("claim"),
    });

  const complete: DanceAttemptCleanupStore["complete"] = (binding) =>
    Effect.tryPromise({
      try: () =>
        runWithRuntime(
          runtime,
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            const result = yield* db.execute({
              label: "dance-attempt-cleanup.complete",
              text: `UPDATE dance_media_cleanup_operations SET
                       state='completed',lease_owner=NULL,lease_expires_at=NULL,
                       next_eligible_at=NULL,failure_code=NULL,
                       completed_at=clock_timestamp(),updated_at=clock_timestamp()
                      WHERE cleanup_operation_id=$1 AND state='leased' AND lease_owner=$2
                        AND lease_fence=$3 AND lease_expires_at>clock_timestamp()`,
              values: [binding.cleanupOperationId, binding.claimOwner, binding.claimFence],
              readonly: false,
            });
            if (result.rowCount === 1) return "committed" as const;
            const replay = yield* db.execute<Row>({
              label: "dance-attempt-cleanup.complete-replay",
              text: `SELECT state FROM dance_media_cleanup_operations
                      WHERE cleanup_operation_id=$1`,
              values: [binding.cleanupOperationId],
              readonly: true,
            });
            return replay.rows.length === 1 && text(replay.rows[0] as Row, "state") === "completed"
              ? ("replayed" as const)
              : ("stale" as const);
          }),
        ),
      catch: () => invalid("complete"),
    });

  const fail: DanceAttemptCleanupStore["fail"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runWithRuntime(
          runtime,
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            const result = yield* db.execute<Row>({
              label: "dance-attempt-cleanup.fail",
              text: `UPDATE dance_media_cleanup_operations SET
                       state='failed',lease_owner=NULL,lease_expires_at=NULL,
                       next_eligible_at=CASE WHEN attempts<10 THEN
                         clock_timestamp()+make_interval(secs=>$4) ELSE NULL END,
                       failure_code=$5,updated_at=clock_timestamp()
                      WHERE cleanup_operation_id=$1 AND state='leased' AND lease_owner=$2
                        AND lease_fence=$3 AND lease_expires_at>clock_timestamp()
                      RETURNING attempts`,
              values: [
                input.binding.cleanupOperationId,
                input.binding.claimOwner,
                input.binding.claimFence,
                input.retryAfterSeconds,
                input.failureCode,
              ],
              readonly: false,
            });
            if (result.rows.length !== 1) return "stale" as const;
            return integer(result.rows[0] as Row, "attempts") >= 10
              ? ("exhausted" as const)
              : ("retryable" as const);
          }),
        ),
      catch: () => invalid("fail"),
    });

  return { claim, complete, fail };
}
