import { processingQueueRetryDelaySeconds } from "../processing-queue-primitives.ts";
import type { VideoAnalysisRuntimeServices } from "./analysis.ts";

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
  readonly state: "pending" | "launching" | "launched" | "retry_wait" | "exhausted";
  readonly launchAttempts: number;
  readonly continuation: number;
  readonly workflowInstanceId: string | null;
  readonly instanceMissing: boolean;
  readonly claimOwner: string | null;
  readonly claimFence: number;
}>;

export interface VideoAnalysisOutboxStore {
  readonly get: (effectIdentity: string) => Promise<VideoAnalysisOutboxRecord | null>;
  readonly claim: (
    effectIdentity: string,
    workerId: string,
  ) => Promise<VideoAnalysisOutboxRecord | null>;
  readonly markLaunched: (
    record: VideoAnalysisOutboxRecord,
    instanceId: string,
  ) => Promise<boolean>;
  readonly markRetryWait: (
    record: VideoAnalysisOutboxRecord,
    failure: "provider_unavailable" | "provider_timeout" | "provider_invalid",
  ) => Promise<boolean>;
  readonly markExhausted: (record: VideoAnalysisOutboxRecord) => Promise<boolean>;
  readonly markInstanceMissing: (record: VideoAnalysisOutboxRecord) => Promise<boolean>;
}

export type VideoAnalysisQueueDisposition =
  | Readonly<{ readonly disposition: "ack" }>
  | Readonly<{ readonly disposition: "retry"; readonly delaySeconds: number }>
  | Readonly<{ readonly disposition: "dlq" }>;

export type VideoAnalysisQueueObservation = Readonly<{
  readonly event: "queue_ack" | "queue_retry" | "queue_dlq" | "workflow_launched";
  readonly outboxId?: string;
  readonly submissionId?: string;
  readonly operationId?: string;
}>;

export type VideoAnalysisQueueDependencies = Readonly<{
  readonly outbox: VideoAnalysisOutboxStore;
  readonly runtime: VideoAnalysisRuntimeServices;
  readonly launcher: {
    readonly instanceId: (effectIdentity: string, continuation?: number) => Promise<string>;
    readonly create: (
      effectIdentity: string,
      continuation?: number,
    ) => Promise<"created" | "already_exists">;
    readonly get: (
      effectIdentity: string,
      continuation?: number,
    ) => Promise<"present" | "missing" | "terminal">;
  };
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
  return processingQueueRetryDelaySeconds(Math.max(1, record?.launchAttempts ?? 1));
}

/** Launch delivery only. Provider execution and waiting belong to the Workflow. */
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
  if (existing === null) return { disposition: "dlq" };
  if (
    existing.state === "exhausted" ||
    (existing.state === "launched" && !existing.instanceMissing)
  ) {
    observe(dependencies, "queue_ack", existing);
    return { disposition: "ack" };
  }
  const prior = await dependencies.runtime.store.getSubmissionByOperation(existing);
  if (
    prior?.state.creationRevision === existing.creationRevision &&
    prior.state.videoRevision === existing.videoRevision &&
    prior.state.status === "processing_failed" &&
    existing.state === "launching" &&
    existing.launchAttempts === 3
  ) {
    return (await dependencies.outbox.markExhausted(existing))
      ? { disposition: "ack" }
      : { disposition: "retry", delaySeconds: retryDelay(existing) };
  }
  if (
    prior === null ||
    prior.state.creationRevision !== existing.creationRevision ||
    prior.state.videoRevision !== existing.videoRevision ||
    prior.state.status !== "processing" ||
    (prior.state.decision !== null && prior.state.phase !== "publish")
  )
    return { disposition: "ack" };
  const claimed = await dependencies.outbox.claim(existing.effectIdentity, dependencies.workerId);
  if (claimed === null) return { disposition: "retry", delaySeconds: retryDelay(existing) };
  const authority = await dependencies.runtime.store.getSubmissionByOperation({
    submissionId: claimed.submissionId,
    operationId: claimed.operationId,
  });
  if (
    authority === null ||
    authority.state.videoRevision !== claimed.videoRevision ||
    authority.state.creationRevision !== claimed.creationRevision ||
    authority.state.video?.canonicalSha256 !== claimed.canonicalVideoSha256
  ) {
    // Superseded intents cannot launch. The sweep also checks current authority.
    return { disposition: "ack" };
  }
  if (
    (authority.state.decision !== null && authority.state.phase !== "publish") ||
    authority.state.status !== "processing"
  ) {
    // PostgreSQL outcomes outlive the provider's instance-retention period.
    return { disposition: "ack" };
  }
  const instanceId = await dependencies.launcher.instanceId(
    claimed.effectIdentity,
    claimed.continuation,
  );
  // No database operation belongs in this catch: only a failed provider create
  // consumes the launch-failure path. A lost acknowledgement reuses the same ID.
  try {
    await dependencies.launcher.create(claimed.effectIdentity, claimed.continuation);
  } catch {
    if (claimed.launchAttempts >= 3) {
      // Three lost responses still do not prove three rejected launches.
      // Resolve the deterministic instance before permitting an author retry.
      const status = await dependencies.launcher.get(claimed.effectIdentity, claimed.continuation);
      if (status === "present") {
        return (await dependencies.outbox.markLaunched(claimed, instanceId))
          ? { disposition: "ack" }
          : { disposition: "retry", delaySeconds: retryDelay(claimed) };
      }
      if (authority.state.status === "processing" && authority.state.decision === null) {
        await dependencies.runtime.store.recordProcessingFailure({
          submission: authority.state,
          observedEventSequence: authority.eventSequence,
          failureCode:
            authority.state.phase === "publish" ? "publication_failed" : "transform_failed",
          evidenceRef: `video-workflow-launch-exhausted:${instanceId}`,
        });
      }
      if (!(await dependencies.outbox.markExhausted(claimed))) {
        return { disposition: "retry", delaySeconds: retryDelay(claimed) };
      }
      return { disposition: "ack" };
    }
    await dependencies.outbox.markRetryWait(claimed, "provider_unavailable");
    observe(dependencies, "queue_retry", claimed);
    return { disposition: "retry", delaySeconds: retryDelay(claimed) };
  }
  if (!(await dependencies.outbox.markLaunched(claimed, instanceId))) {
    return { disposition: "retry", delaySeconds: retryDelay(claimed) };
  }
  observe(dependencies, "workflow_launched", claimed);
  return { disposition: "ack" };
}
