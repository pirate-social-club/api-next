import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import type { DanceReferenceWakeupStore } from "@pirate/application/dance/reference-processing-wakeup";
import { makeDanceReferenceProcessingStore } from "@pirate/platform-cf/dance-reference-processing-repository";
import type { Layer } from "effect";

export type DanceReferenceDispatchQueue = Readonly<{
  readonly send: (message: Readonly<{ readonly outbox_id: string }>) => Promise<void>;
}>;

export type DanceReferenceJobsBindings = Readonly<{
  readonly DANCE_REFERENCE_PROCESSING_ENABLED?: string;
  readonly DANCE_REFERENCE_PROCESSING_QUEUE?: DanceReferenceDispatchQueue;
}>;

export type DanceReferenceMaintenanceResult = Readonly<{
  readonly selected: number;
  readonly dispatched: number;
  readonly failed: number;
}>;

export async function dispatchDanceReferenceWakeups(
  store: Pick<DanceReferenceWakeupStore, "listEligibleWakeups">,
  queue: DanceReferenceDispatchQueue,
  limit = 25,
): Promise<DanceReferenceMaintenanceResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Dance reference dispatch limit must be between 1 and 100");
  }
  const wakeups = await store.listEligibleWakeups(limit);
  const results = await Promise.allSettled(
    wakeups.map((wakeup) => queue.send(Object.freeze({ outbox_id: wakeup.outboxId }))),
  );
  const dispatched = results.filter((result) => result.status === "fulfilled").length;
  return Object.freeze({
    selected: wakeups.length,
    dispatched,
    failed: wakeups.length - dispatched,
  });
}

/** Disabled unless the exact flag and Queue producer binding are both present. */
export function makeDanceReferenceMaintenance(
  env: DanceReferenceJobsBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): (() => Promise<DanceReferenceMaintenanceResult>) | null {
  if (env.DANCE_REFERENCE_PROCESSING_ENABLED !== "true") return null;
  if (env.DANCE_REFERENCE_PROCESSING_QUEUE === undefined) {
    throw new Error("Dance reference Queue binding is required when processing is enabled");
  }
  const store = makeDanceReferenceProcessingStore(runtime);
  const queue = env.DANCE_REFERENCE_PROCESSING_QUEUE;
  return () => dispatchDanceReferenceWakeups(store, queue);
}
