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
    readonly sendEvent: (event: {
      readonly type: MediaProcessingEventType;
      readonly payload: MediaProcessingWorkflowPayload;
    }) => Promise<void>;
  }>;
  readonly create: (options: {
    readonly id: string;
    readonly params: MediaProcessingWorkflowPayload;
  }) => Promise<unknown>;
}

export interface CloudflareMediaQueueMessage {
  readonly body: unknown;
  readonly ack: () => void;
  readonly retry: (options?: { readonly delaySeconds?: number }) => void;
}

export interface CloudflareMediaQueueBatch {
  readonly messages: readonly CloudflareMediaQueueMessage[];
}

/**
 * Wraps the Cloudflare Workflow binding without exposing platform types to the
 * application layer. A failed create is converged through get because create
 * rejects when a retained deterministic instance id already exists.
 */
export function makeCloudflareMediaProcessingWorkflowLauncher(
  binding: CloudflareMediaWorkflowBinding,
): MediaProcessingWorkflowLauncher {
  return {
    get: async (instanceId) => {
      try {
        await binding.get(instanceId);
        return "present";
      } catch {
        return "missing";
      }
    },
    create: async (instanceId, payload) => {
      try {
        await binding.create({ id: instanceId, params: payload });
        return "created";
      } catch (createError) {
        try {
          await binding.get(instanceId);
          return "already_exists";
        } catch {
          throw createError;
        }
      }
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
