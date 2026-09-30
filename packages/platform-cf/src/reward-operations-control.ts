import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";

/** A missing row never authorizes admission. SQL errors remain failures. */
export const makeRewardOperationsRunningReader =
  (layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>) => () =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<{ readonly paused: boolean }>({
        label: "reward-operations.control.read",
        text: "SELECT paused FROM reward_operations_control WHERE singleton",
        values: [],
        readonly: true,
      });
      return result.rows.length === 1 && result.rows[0]?.paused === false;
    }).pipe(Effect.provide(layer));
