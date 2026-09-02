import { processingQueueRetryDelaySeconds } from "../processing-queue-primitives";
import type { DataRegistrationOutbox, DataRegistrationStore } from "./registration-persistence";
import { deterministicDataRegistrationWorkflowId } from "./registration-persistence";
import type { DataRegistrationWorkflowPayload } from "./registration-workflow";

export type DataRegistrationQueueDisposition =
  | Readonly<{ disposition: "ack" }>
  | Readonly<{ disposition: "retry"; delaySeconds: number }>
  | Readonly<{ disposition: "dlq" }>;

export interface DataRegistrationWorkflowLauncher {
  readonly get: (instanceId: string) => Promise<"present" | "missing">;
  readonly create: (
    instanceId: string,
    payload: DataRegistrationWorkflowPayload,
  ) => Promise<"created" | "already_exists">;
}

export type DataRegistrationQueueDependencies = Readonly<{
  store: DataRegistrationStore;
  workflow: DataRegistrationWorkflowLauncher;
  workerId: string;
  leaseSeconds: number;
}>;

const message = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.outbox_id !== "string") return null;
  return record.outbox_id.length > 0 && record.outbox_id.length <= 512 ? record.outbox_id : null;
};

const payloadFrom = (outbox: DataRegistrationOutbox): DataRegistrationWorkflowPayload => ({
  outboxId: outbox.outboxId,
  registrationOperationId: outbox.registrationOperationId,
  workflowRevision: outbox.workflowRevision,
});

export async function consumeDataRegistrationQueueMessage(
  body: unknown,
  dependencies: DataRegistrationQueueDependencies,
): Promise<DataRegistrationQueueDisposition> {
  const outboxId = message(body);
  if (outboxId === null) return { disposition: "dlq" };
  const existing = await dependencies.store.getOutbox(outboxId);
  if (existing === null) return { disposition: "dlq" };
  if (existing.state === "delivered") return { disposition: "ack" };
  if (existing.state === "exhausted" || existing.deliveryAttempts >= 5) {
    return { disposition: "dlq" };
  }
  const claimed = await dependencies.store.claimOutbox(
    outboxId,
    dependencies.workerId,
    dependencies.leaseSeconds,
  );
  if (claimed === null) {
    const refreshed = await dependencies.store.getOutbox(outboxId);
    return refreshed?.state === "delivered"
      ? { disposition: "ack" }
      : {
          disposition: "retry",
          delaySeconds: processingQueueRetryDelaySeconds(refreshed?.deliveryAttempts ?? 1),
        };
  }
  const operation = await dependencies.store.getOperation(claimed.registrationOperationId);
  const deterministicId = deterministicDataRegistrationWorkflowId(
    claimed.registrationOperationId,
    claimed.workflowRevision,
  );
  if (
    operation === null ||
    operation.workflowRevision !== claimed.workflowRevision ||
    operation.workflowInstanceId !== deterministicId ||
    claimed.workflowInstanceId !== deterministicId
  ) {
    await dependencies.store.failOutbox({
      outboxId,
      workerId: dependencies.workerId,
      claimFence: claimed.claimFence,
      failureCode: "invalid_binding",
      nextEligibleAt: null,
    });
    return { disposition: "dlq" };
  }
  try {
    await dependencies.workflow.create(deterministicId, payloadFrom(claimed));
    const completed = await dependencies.store.completeOutbox(
      outboxId,
      dependencies.workerId,
      claimed.claimFence,
    );
    return completed ? { disposition: "ack" } : { disposition: "retry", delaySeconds: 15 };
  } catch {
    const nextEligibleAt = new Date(
      Date.now() + processingQueueRetryDelaySeconds(claimed.deliveryAttempts) * 1_000,
    ).toISOString();
    const failed = await dependencies.store.failOutbox({
      outboxId,
      workerId: dependencies.workerId,
      claimFence: claimed.claimFence,
      failureCode: "workflow_unavailable",
      nextEligibleAt: claimed.deliveryAttempts >= 5 ? null : nextEligibleAt,
    });
    return !failed || claimed.deliveryAttempts >= 5
      ? { disposition: "dlq" }
      : {
          disposition: "retry",
          delaySeconds: processingQueueRetryDelaySeconds(claimed.deliveryAttempts),
        };
  }
}

export async function replaceLostDataRegistrationWorkflow(
  registrationOperationId: string,
  expectedWorkflowRevision: bigint,
  dependencies: Pick<DataRegistrationQueueDependencies, "store" | "workflow">,
): Promise<"present" | "replacement_enqueued"> {
  const operation = await dependencies.store.getOperation(registrationOperationId);
  if (operation === null || operation.workflowRevision !== expectedWorkflowRevision) {
    throw new Error("workflow authority changed");
  }
  if ((await dependencies.workflow.get(operation.workflowInstanceId)) === "present") {
    return "present";
  }
  await dependencies.store.replaceMissingWorkflow(
    registrationOperationId,
    expectedWorkflowRevision,
  );
  return "replacement_enqueued";
}
