import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
import { makeControlPlaneMediaOutboxRepository } from "../../../packages/platform-cf/src/media-outbox-repository.ts";

export type MediaOutboxDispatchMessage = Readonly<{ readonly outbox_id: string }>;
type VideoAnalysisOutboxDispatchMessage = Readonly<{
  readonly kind: "video_analysis";
  readonly outbox_id: string;
}>;

export interface MediaOutboxDispatchQueue {
  readonly send: (
    message: MediaOutboxDispatchMessage | VideoAnalysisOutboxDispatchMessage,
  ) => Promise<void>;
}

export interface MediaOutboxDispatchSource {
  readonly listEligible: (
    limit: number,
  ) => Promise<readonly Readonly<{ readonly outboxEventId: string }>[]>;
}

export type MediaOutboxDispatchResult = Readonly<{
  readonly selected: number;
  readonly sent: number;
  readonly failed: number;
}>;

/**
 * Reads a bounded page of durable identities and sends no business data.
 * Rows remain eligible until the Queue consumer claims and completes them, so
 * concurrent or repeated dispatch is intentionally at least once.
 */
export async function dispatchEligibleMediaOutbox(
  source: MediaOutboxDispatchSource,
  queue: MediaOutboxDispatchQueue,
  limit = 25,
): Promise<MediaOutboxDispatchResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("media outbox dispatch limit must be between 1 and 100");
  }
  const records = await source.listEligible(limit);
  const deliveries = await Promise.allSettled(
    records.map((record) => queue.send(Object.freeze({ outbox_id: record.outboxEventId }))),
  );
  const sent = deliveries.filter((delivery) => delivery.status === "fulfilled").length;
  return Object.freeze({ selected: records.length, sent, failed: records.length - sent });
}

export function makeMediaOutboxDispatchSource(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): MediaOutboxDispatchSource {
  const repository = makeControlPlaneMediaOutboxRepository();
  return {
    listEligible: (limit) =>
      Effect.runPromise(Effect.provide(runtime)(repository.listEligible(limit))),
  };
}
