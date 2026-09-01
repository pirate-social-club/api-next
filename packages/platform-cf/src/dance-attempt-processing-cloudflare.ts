import type {
  DanceAttemptQueueDependencies,
  DanceAttemptQueueDisposition,
  DanceAttemptWorkflowLauncher,
  DanceAttemptWorkflowPayload,
} from "@pirate/application/dance/attempt-processing-wakeup";
import { consumeDanceAttemptQueueMessage } from "@pirate/application/dance/attempt-processing-wakeup";

/** Narrow provider port. No generated Env or deployed binding exists for Dance attempts. */
export interface CloudflareDanceAttemptWorkflowBinding {
  readonly createBatch: (
    options: readonly {
      readonly id: string;
      readonly params: DanceAttemptWorkflowPayload;
    }[],
  ) => Promise<readonly unknown[]>;
}

export interface CloudflareDanceAttemptQueueMessage {
  readonly id: string;
  readonly body: unknown;
  readonly ack: () => void;
  readonly retry: (options?: { readonly delaySeconds?: number }) => void;
}

export interface CloudflareDanceAttemptQueueBatch {
  readonly messages: readonly CloudflareDanceAttemptQueueMessage[];
}

async function providerWorkflowId(logicalId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(logicalId)),
  );
  return `datt-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function makeCloudflareDanceAttemptWorkflowLauncher(
  binding: CloudflareDanceAttemptWorkflowBinding,
): DanceAttemptWorkflowLauncher {
  return {
    create: async (instanceId, payload) => {
      const created = await binding.createBatch([
        { id: await providerWorkflowId(instanceId), params: payload },
      ]);
      if (created.length === 1) return "created";
      if (created.length === 0) return "already_exists";
      throw new Error("Dance attempt Workflow returned an unexpected instance count");
    },
  };
}

export function applyDanceAttemptQueueDisposition(
  message: Pick<CloudflareDanceAttemptQueueMessage, "ack" | "retry">,
  disposition: DanceAttemptQueueDisposition,
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

/**
 * Each at-least-once delivery receives one explicit disposition. A failed
 * authority lookup retries only its message instead of retrying the batch.
 */
export async function handleDanceAttemptQueueBatch(
  batch: CloudflareDanceAttemptQueueBatch,
  dependencies: DanceAttemptQueueDependencies,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const disposition = await consumeDanceAttemptQueueMessage(
        message.body,
        message.id,
        dependencies,
      );
      applyDanceAttemptQueueDisposition(message, disposition);
    } catch {
      message.retry({ delaySeconds: 15 });
    }
  }
}
