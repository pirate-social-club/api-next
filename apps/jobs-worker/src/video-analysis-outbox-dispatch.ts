import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import type { Layer } from "effect";
import { makeControlPlaneVideoAnalysisOutboxRepository } from "../../../packages/platform-cf/src/video-analysis-outbox-repository.ts";
import type {
  MediaOutboxDispatchQueue,
  MediaOutboxDispatchResult,
} from "./media-outbox-dispatch.ts";

export interface VideoAnalysisOutboxDispatchSource {
  readonly listEligible: (
    limit: number,
  ) => Promise<readonly Readonly<{ readonly effectIdentity: string }>[]>;
}

/** Sends only the durable identity and the closed local queue discriminator. */
export async function dispatchEligibleVideoAnalysisOutbox(
  source: VideoAnalysisOutboxDispatchSource,
  queue: MediaOutboxDispatchQueue,
  limit = 25,
): Promise<MediaOutboxDispatchResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("video analysis outbox dispatch limit must be between 1 and 100");
  }
  const records = await source.listEligible(limit);
  const deliveries = await Promise.allSettled(
    records.map((record) =>
      queue.send(
        Object.freeze({ kind: "video_analysis" as const, outbox_id: record.effectIdentity }),
      ),
    ),
  );
  const sent = deliveries.filter((delivery) => delivery.status === "fulfilled").length;
  return Object.freeze({ selected: records.length, sent, failed: records.length - sent });
}

export function makeVideoAnalysisOutboxDispatchSource(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): VideoAnalysisOutboxDispatchSource {
  const repository = makeControlPlaneVideoAnalysisOutboxRepository(runtime);
  return { listEligible: (limit) => repository.listEligible(limit) };
}
