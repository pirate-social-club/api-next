import type {
  DanceReferenceQueueDependencies,
  DanceReferenceQueueDisposition,
  DanceReferenceWorkflowLauncher,
  DanceReferenceWorkflowPayload,
} from "@pirate/application/dance/reference-processing-wakeup";
import { consumeDanceReferenceQueueMessage } from "@pirate/application/dance/reference-processing-wakeup";
import {
  applyCloudflareQueueDisposition,
  classifyWorkflowCreateBatch,
} from "./cloudflare-orchestration-primitives.ts";

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
      return classifyWorkflowCreateBatch(
        created,
        "Dance reference Workflow returned an unexpected instance count",
      );
    },
  };
}

export function applyDanceReferenceQueueDisposition(
  message: Pick<CloudflareDanceReferenceQueueMessage, "ack" | "retry">,
  disposition: DanceReferenceQueueDisposition,
): void {
  applyCloudflareQueueDisposition(message, disposition);
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
