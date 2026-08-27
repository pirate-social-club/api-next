import type { DataRegistrationWorkflowPayload } from "@pirate/application/data/registration-workflow";
import type {
  DataRegistrationQueueDependencies,
  DataRegistrationQueueDisposition,
  DataRegistrationWorkflowLauncher,
} from "@pirate/application/data/registration-workflow-queue";
import { consumeDataRegistrationQueueMessage } from "@pirate/application/data/registration-workflow-queue";

export interface CloudflareDataRegistrationWorkflowBinding {
  readonly get: (instanceId: string) => Promise<{
    readonly status: () => Promise<Readonly<{ status: string }>>;
  }>;
  readonly create: (options: {
    id: string;
    params: DataRegistrationWorkflowPayload;
  }) => Promise<unknown>;
}

export interface CloudflareDataRegistrationQueueMessage {
  readonly body: unknown;
  readonly ack: () => void;
  readonly retry: (options?: { delaySeconds?: number }) => void;
}

export interface CloudflareDataRegistrationQueueBatch {
  readonly messages: readonly CloudflareDataRegistrationQueueMessage[];
}

export function makeCloudflareDataRegistrationWorkflowLauncher(
  binding: CloudflareDataRegistrationWorkflowBinding,
  isMissing: (error: unknown) => boolean,
): DataRegistrationWorkflowLauncher {
  const get: DataRegistrationWorkflowLauncher["get"] = async (instanceId) => {
    try {
      const instance = await binding.get(instanceId);
      return (await instance.status()).status === "unknown" ? "missing" : "present";
    } catch (error) {
      if (isMissing(error)) return "missing";
      throw error;
    }
  };
  return {
    get,
    create: async (instanceId, payload) => {
      try {
        await binding.create({ id: instanceId, params: payload });
        return "created";
      } catch (createError) {
        if ((await get(instanceId)) === "present") return "already_exists";
        throw createError;
      }
    },
  };
}

export function applyDataRegistrationQueueDisposition(
  message: Pick<CloudflareDataRegistrationQueueMessage, "ack" | "retry">,
  disposition: DataRegistrationQueueDisposition,
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

export async function handleDataRegistrationQueueBatch(
  batch: CloudflareDataRegistrationQueueBatch,
  dependencies: DataRegistrationQueueDependencies,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      const disposition = await consumeDataRegistrationQueueMessage(message.body, dependencies);
      applyDataRegistrationQueueDisposition(message, disposition);
    }),
  );
}
