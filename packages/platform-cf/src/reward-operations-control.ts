import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  RewardOperationsPaused,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

/** A missing row never authorizes admission. SQL errors remain failures. */
export const makeRewardOperationsRunningReader =
  (layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>) => () =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<{ readonly paused: boolean; readonly state: string }>({
        label: "reward-operations.control.read",
        text: "SELECT state,paused FROM reward_operations_control WHERE singleton",
        values: [],
        readonly: true,
      });
      return (
        result.rows.length === 1 &&
        result.rows[0]?.state === "running" &&
        result.rows[0]?.paused === false
      );
    }).pipe(Effect.provide(layer));

/** Preserve a database admission refusal before a repository maps storage errors. */
export function mapRewardAdmissionFailure<E>(
  error: E | ControlPlaneError,
): E | ControlPlaneError | RewardOperationsPaused {
  return error instanceof ControlPlaneStatementFailed && error.sqlState === "PR001"
    ? new RewardOperationsPaused({ reason: "paused" })
    : error;
}
