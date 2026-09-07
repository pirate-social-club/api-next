import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { VideoPublicationWakeupStore } from "@pirate/application/video/publication-wakeup";
import { Effect, type Layer } from "effect";

export function makeVideoPublicationWakeupStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VideoPublicationWakeupStore {
  const execute = <R extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
    readonly: boolean,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.execute<R>({ label: "video-publication-wakeup", text, values, readonly });
      }).pipe(Effect.provide(runtime)),
    );
  return {
    listPending: async (limit) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("invalid video wakeup limit");
      const result = await execute<{
        wakeup_identity: string;
        effect_identity: string;
        action_id: string;
      }>(
        "SELECT wakeup_identity,effect_identity,action_id FROM media_video_publication_wakeups WHERE delivered_at IS NULL ORDER BY last_attempt_at NULLS FIRST,created_at,wakeup_identity LIMIT $1",
        [limit],
        true,
      );
      return result.rows.map((row) => ({
        identity: row.wakeup_identity,
        effectIdentity: row.effect_identity,
        actionId: row.action_id,
      }));
    },
    touch: async (row) =>
      (
        await execute(
          "UPDATE media_video_publication_wakeups SET last_attempt_at=clock_timestamp() WHERE wakeup_identity=$1 AND effect_identity=$2 AND action_id=$3 AND delivered_at IS NULL",
          [row.identity, row.effectIdentity, row.actionId],
          false,
        )
      ).rowCount === 1,
    acknowledge: async (row) =>
      (
        await execute(
          "UPDATE media_video_publication_wakeups SET delivered_at=clock_timestamp() WHERE wakeup_identity=$1 AND effect_identity=$2 AND action_id=$3 AND delivered_at IS NULL",
          [row.identity, row.effectIdentity, row.actionId],
          false,
        )
      ).rowCount === 1,
  };
}
