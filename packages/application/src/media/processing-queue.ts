import {
  decodeMediaProcessingQueueMessage,
  type MediaProcessingObserver,
  type MediaProcessingStore,
  type MediaProcessingWorkflowLauncher,
  type MediaProcessingWorkflowPayload,
} from "./processing-contracts.ts";

export type MediaProcessingQueueDisposition =
  | Readonly<{ readonly disposition: "ack" }>
  | Readonly<{ readonly disposition: "retry"; readonly delaySeconds: number }>
  | Readonly<{ readonly disposition: "dlq" }>;

export type MediaProcessingQueueDependencies = Readonly<{
  readonly store: MediaProcessingStore;
  readonly workflow: MediaProcessingWorkflowLauncher;
  readonly workerId: string;
  readonly observe?: MediaProcessingObserver;
}>;

const retryDelaySeconds = (attempt: number): number => Math.min(900, 15 * 2 ** (attempt - 1));

function workflowPayload(record: {
  readonly outboxId: string;
  readonly submissionId: string;
  readonly operationId: string;
  readonly workflowRevision: number;
}): MediaProcessingWorkflowPayload {
  return Object.freeze({
    outboxId: record.outboxId,
    submissionId: record.submissionId,
    operationId: record.operationId,
    workflowRevision: record.workflowRevision,
  });
}

/**
 * Converges one at-least-once Queue delivery onto the persisted Workflow
 * identity. The caller performs the returned ack/retry action exactly once.
 */
export async function consumeMediaProcessingQueueMessage(
  body: unknown,
  dependencies: MediaProcessingQueueDependencies,
): Promise<MediaProcessingQueueDisposition> {
  let message: ReturnType<typeof decodeMediaProcessingQueueMessage>;
  try {
    message = decodeMediaProcessingQueueMessage(body);
  } catch {
    dependencies.observe?.({ event: "queue_dlq" });
    return { disposition: "dlq" };
  }

  const existing = await dependencies.store.getOutbox(message.outbox_id);
  if (existing === null) {
    dependencies.observe?.({ event: "queue_dlq", outboxId: message.outbox_id });
    return { disposition: "dlq" };
  }
  if (existing.state === "delivered") {
    dependencies.observe?.({
      event: "queue_ack",
      outboxId: existing.outboxId,
      operationId: existing.operationId,
      submissionId: existing.submissionId,
      workflowRevision: existing.workflowRevision,
    });
    return { disposition: "ack" };
  }
  if (existing.state === "exhausted" || existing.deliveryAttempts >= 3) {
    dependencies.observe?.({
      event: "queue_dlq",
      outboxId: existing.outboxId,
      operationId: existing.operationId,
      submissionId: existing.submissionId,
      workflowRevision: existing.workflowRevision,
    });
    return { disposition: "dlq" };
  }

  const claimed = await dependencies.store.claimOutbox(existing.outboxId, dependencies.workerId);
  if (claimed === null) {
    const refreshed = await dependencies.store.getOutbox(existing.outboxId);
    if (refreshed?.state === "delivered") return { disposition: "ack" };
    return {
      disposition: "retry",
      delaySeconds: retryDelaySeconds(Math.max(1, refreshed?.deliveryAttempts ?? 1)),
    };
  }

  const authority = await dependencies.store.loadAuthority(
    claimed.submissionId,
    claimed.operationId,
  );
  if (
    authority === null ||
    authority.workflowRevision !== claimed.workflowRevision ||
    authority.submissionId !== claimed.submissionId ||
    authority.operationId !== claimed.operationId ||
    claimed.workflowInstanceId !== `media-${claimed.operationId}-r${claimed.workflowRevision}`
  ) {
    await dependencies.store.failOutbox(claimed, "provider_invalid");
    dependencies.observe?.({
      event: "queue_dlq",
      outboxId: claimed.outboxId,
      operationId: claimed.operationId,
      submissionId: claimed.submissionId,
      workflowRevision: claimed.workflowRevision,
    });
    return { disposition: "dlq" };
  }

  const payload = workflowPayload(claimed);
  try {
    const present = await dependencies.workflow.get(claimed.workflowInstanceId);
    if (present === "missing") {
      const created = await dependencies.workflow.create(claimed.workflowInstanceId, payload);
      if (created === "already_exists") {
        const converged = await dependencies.workflow.get(claimed.workflowInstanceId);
        if (converged === "missing") throw new Error("workflow identity did not converge");
      }
    } else if (claimed.eventType !== "analysis_launch") {
      await dependencies.workflow.notify(claimed.workflowInstanceId, claimed.eventType, payload);
    }
    const completed = await dependencies.store.completeOutbox(claimed);
    if (!completed) throw new Error("outbox completion fence was lost");
    dependencies.observe?.({
      event: "workflow_converged",
      outboxId: claimed.outboxId,
      operationId: claimed.operationId,
      submissionId: claimed.submissionId,
      workflowRevision: claimed.workflowRevision,
    });
    dependencies.observe?.({
      event: "queue_ack",
      outboxId: claimed.outboxId,
      operationId: claimed.operationId,
      submissionId: claimed.submissionId,
      workflowRevision: claimed.workflowRevision,
    });
    return { disposition: "ack" };
  } catch {
    const failed = await dependencies.store.failOutbox(claimed, "provider_unavailable");
    const attempts = claimed.deliveryAttempts;
    if (!failed || attempts >= 3) {
      dependencies.observe?.({
        event: "queue_dlq",
        outboxId: claimed.outboxId,
        operationId: claimed.operationId,
        submissionId: claimed.submissionId,
        workflowRevision: claimed.workflowRevision,
      });
      return { disposition: "dlq" };
    }
    dependencies.observe?.({
      event: "queue_retry",
      outboxId: claimed.outboxId,
      operationId: claimed.operationId,
      submissionId: claimed.submissionId,
      workflowRevision: claimed.workflowRevision,
    });
    return { disposition: "retry", delaySeconds: retryDelaySeconds(attempts) };
  }
}
