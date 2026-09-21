import { AlertCollector, ControlPlaneDb } from "@pirate/application";
import { AvatarFailure } from "@pirate/application/avatars/ports";
import type { AlertSink } from "@pirate/platform-cf";
import type { AvatarBucket } from "@pirate/platform-cf/avatar-storage";
import { makeAvatarStoreFromDb } from "@pirate/platform-cf/avatar-store";
import { Effect } from "effect";
import { defaultRetrySchedule, type JobDeclaration } from "./registry.ts";

export type AvatarCleanupBuckets = Readonly<{
  ingress: Pick<AvatarBucket, "delete">;
  sealed: Pick<AvatarBucket, "delete">;
}>;
export function makeAvatarCleanupJob(
  sink: AlertSink,
  buckets: AvatarCleanupBuckets,
): JobDeclaration<unknown, ControlPlaneDb | AlertCollector> {
  return {
    name: "avatars.cleanup",
    lane: "avatar-maintenance",
    schedule: "*/5 * * * *",
    timeout: "45 seconds",
    retry: defaultRetrySchedule,
    expectedFailures: ["AvatarFailure"],
    severity: {
      expectedFailure: { AvatarFailure: "medium" },
      timeout: "high",
      transactionOutcomeUnknown: "high",
      defect: "high",
    },
    reads: ["postgres:avatar_assets"],
    writes: ["postgres:avatar_assets"],
    alertSink: sink,
    run: Effect.gen(function* () {
      const store = makeAvatarStoreFromDb(yield* ControlPlaneDb);
      const collector = yield* AlertCollector;
      for (let batch = 0; batch < 100; batch++) {
        const summary = yield* store.cleanup((key) =>
          Effect.tryPromise({
            try: () => (key.startsWith("ingress/") ? buckets.ingress : buckets.sealed).delete(key),
            catch: () => new AvatarFailure({ reason: "unavailable" }),
          }).pipe(
            Effect.timeout("3 seconds"),
            Effect.mapError(() => new AvatarFailure({ reason: "unavailable" })),
          ),
        );
        if (summary.failed > 0) {
          yield* collector.emit({
            key: "avatars:cleanup-failures",
            severity: "medium",
            body: "Avatar object deletion requires a later cleanup pass.",
            entity: `failed:${summary.failed}`,
          });
          break;
        }
        if (summary.removed < 3) break;
      }
    }),
  };
}
