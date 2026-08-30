import type {
  DanceReferenceQueueDependencies,
  DanceReferenceQueueDisposition,
  DanceReferenceWorkflowLauncher,
  DanceReferenceWorkflowPayload,
} from "@pirate/application/dance/reference-processing-wakeup";
import { consumeDanceReferenceQueueMessage } from "@pirate/application/dance/reference-processing-wakeup";

export interface CloudflareDanceReferenceWorkflowBinding {
  readonly createBatch: (
    options: readonly {
      readonly id: string;
      readonly params: DanceReferenceWorkflowPayload;
    }[],
  ) => Promise<readonly unknown[]>;
}

export interface CloudflareDanceReferenceQueueMessage {
  readonly id: string;
  readonly body: unknown;
  readonly ack: () => void;
  readonly retry: (options?: { readonly delaySeconds?: number }) => void;
}

export interface CloudflareDanceReferenceQueueBatch {
  readonly messages: readonly CloudflareDanceReferenceQueueMessage[];
}

async function providerWorkflowId(logicalId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(logicalId)),
  );
  return `dref-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function makeCloudflareDanceReferenceWorkflowLauncher(
  binding: CloudflareDanceReferenceWorkflowBinding,
): DanceReferenceWorkflowLauncher {
  return {
    create: async (instanceId, payload) => {
      const created = await binding.createBatch([
        { id: await providerWorkflowId(instanceId), params: payload },
      ]);
      if (created.length === 1) return "created";
      if (created.length === 0) return "already_exists";
      throw new Error("Dance reference Workflow returned an unexpected instance count");
    },
  };
}

export function applyDanceReferenceQueueDisposition(
  message: Pick<CloudflareDanceReferenceQueueMessage, "ack" | "retry">,
  disposition: DanceReferenceQueueDisposition,
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

export async function handleDanceReferenceQueueBatch(
  batch: CloudflareDanceReferenceQueueBatch,
  dependencies: DanceReferenceQueueDependencies,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      const disposition = await consumeDanceReferenceQueueMessage(
        message.body,
        message.id,
        dependencies,
      );
      applyDanceReferenceQueueDisposition(message, disposition);
    }),
  );
}
