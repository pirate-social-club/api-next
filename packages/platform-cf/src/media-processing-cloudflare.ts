import type {
  MediaProcessingEventType,
  MediaProcessingWorkflowLauncher,
  MediaProcessingWorkflowPayload,
} from "../../application/src/media/processing-contracts.ts";
import type {
  MediaProcessingQueueDependencies,
  MediaProcessingQueueDisposition,
} from "../../application/src/media/processing-queue.ts";
import { consumeMediaProcessingQueueMessage } from "../../application/src/media/processing-queue.ts";

export interface CloudflareMediaWorkflowBinding {
  readonly get: (instanceId: string) => Promise<{
    readonly status: () => Promise<
      Readonly<{
        readonly status:
          | "queued"
          | "running"
          | "paused"
          | "errored"
          | "terminated"
          | "complete"
          | "waiting"
          | "waitingForPause"
          | "rollingBack"
          | "unknown";
      }>
    >;
    readonly sendEvent: (event: {
      readonly type: MediaProcessingEventType;
      readonly payload: MediaProcessingWorkflowPayload;
    }) => Promise<void>;
  }>;
  readonly createBatch: (
    options: readonly {
      readonly id: string;
      readonly params: MediaProcessingWorkflowPayload;
    }[],
  ) => Promise<readonly unknown[]>;
}

export interface CloudflareMediaQueueMessage {
  readonly body: unknown;
  readonly ack: () => void;
  readonly retry: (options?: { readonly delaySeconds?: number }) => void;
}

export interface CloudflareMediaQueueBatch {
  readonly messages: readonly CloudflareMediaQueueMessage[];
}

export type CloudflareMissingWorkflowErrorClassifier = (error: unknown) => boolean;

async function workflowIsPresent(
  binding: CloudflareMediaWorkflowBinding,
  instanceId: string,
): Promise<boolean> {
  const instance = await binding.get(instanceId);
  const status = await instance.status();
  return ["queued", "running", "paused", "waiting", "waitingForPause", "rollingBack"].includes(
    status.status,
  );
}

/**
 * Wraps the Cloudflare Workflow binding without exposing platform types to the
 * application layer. Cloudflare's createBatch is idempotent: a retained
 * deterministic instance id is skipped rather than rejected.
 */
export function makeCloudflareMediaProcessingWorkflowLauncher(
  binding: CloudflareMediaWorkflowBinding,
  isMissingInstanceError: CloudflareMissingWorkflowErrorClassifier,
): MediaProcessingWorkflowLauncher {
  return {
    get: async (instanceId) => {
      try {
        return (await workflowIsPresent(binding, instanceId)) ? "present" : "missing";
      } catch (error) {
        if (isMissingInstanceError(error)) return "missing";
        throw error;
      }
    },
    create: async (instanceId, payload) => {
      const created = await binding.createBatch([{ id: instanceId, params: payload }]);
      if (created.length === 1) return "created";
      if (created.length === 0) return "already_exists";
      throw new Error("Workflow createBatch returned an unexpected instance count");
    },
    notify: async (instanceId, eventType, payload) => {
      const instance = await binding.get(instanceId);
      await instance.sendEvent({ type: eventType, payload });
    },
  };
}

/** Cloudflare owns DLQ transfer after the configured retry limit. */
export function applyMediaProcessingQueueDisposition(
  message: Pick<CloudflareMediaQueueMessage, "ack" | "retry">,
  disposition: MediaProcessingQueueDisposition,
): void {
  if (disposition.disposition === "ack") {
    message.ack();
    return;
  }
  if (disposition.disposition === "retry") {
    message.retry({ delaySeconds: disposition.delaySeconds });
    return;
  }
  message.retry();
}

/** Each delivery gets exactly one terminal Queue action. */
export async function handleMediaProcessingQueueBatch(
  batch: CloudflareMediaQueueBatch,
  dependencies: MediaProcessingQueueDependencies,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      const disposition = await consumeMediaProcessingQueueMessage(message.body, dependencies);
      applyMediaProcessingQueueDisposition(message, disposition);
    }),
  );
}
