import { processingQueueRetryDelaySeconds } from "../processing-queue-primitives.ts";
import {
  runOriginalVideoAnalysis,
  VideoAnalysisPending,
  VideoAnalysisRetryable,
  type VideoAnalysisRuntimeServices,
} from "./analysis.ts";
import { recordVideoProcessingFailure } from "./publication.ts";

const identifierPattern = /^\S(?:.*\S)?$/u;

const validIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.includes("\u0000") &&
  identifierPattern.test(value);

export type VideoAnalysisQueueMessage = Readonly<{
  readonly kind: "video_analysis";
  readonly outbox_id: string;
}>;

/** Queue bodies carry a discriminator and one durable identity, never media facts. */
export function decodeVideoAnalysisQueueMessage(input: unknown): VideoAnalysisQueueMessage {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("video analysis queue payload must be an object");
  }
  const value = input as Readonly<Record<string, unknown>>;
  if (
    Object.keys(value).sort().join(",") !== "kind,outbox_id" ||
    value.kind !== "video_analysis" ||
    !validIdentifier(value.outbox_id)
  ) {
    throw new TypeError("video analysis queue payload must contain only kind and outbox_id");
  }
  return Object.freeze({ kind: "video_analysis", outbox_id: value.outbox_id });
}

export type VideoAnalysisOutboxRecord = Readonly<{
  readonly effectIdentity: string;
  readonly submissionId: string;
  readonly operationId: string;
  readonly videoRevision: number;
  readonly creationRevision: number;
  readonly canonicalVideoSha256: string;
  readonly state: "pending" | "running" | "poll_wait" | "delivered" | "failed" | "exhausted";
  readonly deliveryAttempts: number;
  readonly claimOwner: string | null;
  readonly claimFence: number;
}>;

export interface VideoAnalysisOutboxStore {
  readonly get: (effectIdentity: string) => Promise<VideoAnalysisOutboxRecord | null>;
  readonly claim: (
    effectIdentity: string,
    workerId: string,
  ) => Promise<VideoAnalysisOutboxRecord | null>;
  readonly complete: (record: VideoAnalysisOutboxRecord) => Promise<boolean>;
  readonly defer: (
    record: VideoAnalysisOutboxRecord,
    retryAfterSeconds: number,
  ) => Promise<boolean>;
  readonly fail: (
    record: VideoAnalysisOutboxRecord,
    failure: "provider_unavailable" | "provider_timeout" | "provider_invalid",
  ) => Promise<boolean>;
}

export type VideoAnalysisQueueDisposition =
  | Readonly<{ readonly disposition: "ack" }>
  | Readonly<{ readonly disposition: "retry"; readonly delaySeconds: number }>
  | Readonly<{ readonly disposition: "dlq" }>;

export type VideoAnalysisQueueObservation = Readonly<{
  readonly event: "queue_ack" | "queue_retry" | "queue_dlq" | "analysis_completed";
  readonly outboxId?: string;
  readonly submissionId?: string;
  readonly operationId?: string;
}>;

export type VideoAnalysisQueueDependencies = Readonly<{
  readonly outbox: VideoAnalysisOutboxStore;
  readonly runtime: VideoAnalysisRuntimeServices;
  readonly workerId: string;
  readonly observe?: (observation: VideoAnalysisQueueObservation) => void;
}>;

function observe(
  dependencies: VideoAnalysisQueueDependencies,
  event: VideoAnalysisQueueObservation["event"],
  record?: VideoAnalysisOutboxRecord,
): void {
  dependencies.observe?.({
    event,
    ...(record === undefined
      ? {}
      : {
          outboxId: record.effectIdentity,
          submissionId: record.submissionId,
          operationId: record.operationId,
        }),
  });
}

function retryDelay(record: VideoAnalysisOutboxRecord | null): number {
  return processingQueueRetryDelaySeconds(Math.max(1, record?.deliveryAttempts ?? 1));
}

/**
 * Claims and executes one durable analysis intent. A crash after publication
 * but before completion re-enters the idempotent publication fence, while an
 * expired running claim can be recovered by another worker.
 */
export async function consumeVideoAnalysisQueueMessage(
  body: unknown,
  dependencies: VideoAnalysisQueueDependencies,
): Promise<VideoAnalysisQueueDisposition> {
  let message: VideoAnalysisQueueMessage;
  try {
    message = decodeVideoAnalysisQueueMessage(body);
  } catch {
    observe(dependencies, "queue_dlq");
    return { disposition: "dlq" };
  }

  const existing = await dependencies.outbox.get(message.outbox_id);
  if (existing === null) {
    observe(dependencies, "queue_dlq");
    return { disposition: "dlq" };
  }
  if (existing.state === "delivered") {
    observe(dependencies, "queue_ack", existing);
    return { disposition: "ack" };
  }
  if (
    existing.state === "exhausted" ||
    (existing.deliveryAttempts >= 3 && existing.state !== "poll_wait")
  ) {
    observe(dependencies, "queue_dlq", existing);
    return { disposition: "dlq" };
  }

  const claimed = await dependencies.outbox.claim(existing.effectIdentity, dependencies.workerId);
  if (claimed === null) {
    const refreshed = await dependencies.outbox.get(existing.effectIdentity);
    if (refreshed?.state === "delivered") return { disposition: "ack" };
    return { disposition: "retry", delaySeconds: retryDelay(refreshed) };
  }

  const authority = await dependencies.runtime.store.getSubmissionByOperation({
    submissionId: claimed.submissionId,
    operationId: claimed.operationId,
  });
  if (
    authority === null ||
    authority.state.submissionId !== claimed.submissionId ||
    authority.state.operationId !== claimed.operationId ||
    authority.state.videoRevision !== claimed.videoRevision ||
    authority.state.creationRevision !== claimed.creationRevision ||
    authority.state.video?.canonicalSha256 !== claimed.canonicalVideoSha256
  ) {
    await dependencies.outbox.fail(claimed, "provider_invalid");
    observe(dependencies, "queue_dlq", claimed);
    return { disposition: "dlq" };
  }

  try {
    await runOriginalVideoAnalysis(
      { submissionId: claimed.submissionId, operationId: claimed.operationId },
      dependencies.runtime,
    );
    const completed = await dependencies.outbox.complete(claimed);
    if (!completed) throw new Error("video analysis outbox completion fence was lost");
    observe(dependencies, "analysis_completed", claimed);
    observe(dependencies, "queue_ack", claimed);
    return { disposition: "ack" };
  } catch (error) {
    if (error instanceof VideoAnalysisPending) {
      const deferred = await dependencies.outbox.defer(claimed, error.retryAfterSeconds);
      if (!deferred) return { disposition: "retry", delaySeconds: retryDelay(claimed) };
      observe(dependencies, "queue_retry", claimed);
      return { disposition: "retry", delaySeconds: error.retryAfterSeconds };
    }
    if (error instanceof VideoAnalysisRetryable && claimed.deliveryAttempts >= 3) {
      await recordVideoProcessingFailure(
        {
          submissionId: claimed.submissionId,
          operationId: claimed.operationId,
          failureCode: error.failureCode,
          evidenceRef: error.evidenceRef,
        },
        dependencies.runtime,
      );
    }
    const failed = await dependencies.outbox.fail(claimed, "provider_unavailable");
    if (!failed || claimed.deliveryAttempts >= 3) {
      observe(dependencies, "queue_dlq", claimed);
      return { disposition: "dlq" };
    }
    observe(dependencies, "queue_retry", claimed);
    return { disposition: "retry", delaySeconds: retryDelay(claimed) };
  }
}
