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
  readonly createBatch: (
    options: readonly {
      id: string;
      params: DataRegistrationWorkflowPayload;
    }[],
  ) => Promise<readonly unknown[]>;
}

export interface CloudflareDataRegistrationQueueMessage {
  readonly body: unknown;
  readonly ack: () => void;
  readonly retry: (options?: { delaySeconds?: number }) => void;
}

export interface CloudflareDataRegistrationQueueBatch {
  readonly messages: readonly CloudflareDataRegistrationQueueMessage[];
}

export async function cloudflareDataRegistrationWorkflowId(logicalId: string): Promise<string> {
  if (logicalId.length === 0 || logicalId.length > 512 || logicalId !== logicalId.trim()) {
    throw new TypeError("invalid logical DATA registration Workflow identity");
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(logicalId)),
  );
  return `drw-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function makeCloudflareDataRegistrationWorkflowLauncher(
  binding: CloudflareDataRegistrationWorkflowBinding,
  isMissing: (error: unknown) => boolean,
): DataRegistrationWorkflowLauncher {
  const get: DataRegistrationWorkflowLauncher["get"] = async (instanceId) => {
    try {
      const instance = await binding.get(await cloudflareDataRegistrationWorkflowId(instanceId));
      const status = (await instance.status()).status;
      return ["queued", "running", "paused", "waiting", "waitingForPause", "rollingBack"].includes(
        status,
      )
        ? "present"
        : "missing";
    } catch (error) {
      if (isMissing(error)) return "missing";
      throw error;
    }
  };
  return {
    get,
    create: async (instanceId, payload) => {
      const providerInstanceId = await cloudflareDataRegistrationWorkflowId(instanceId);
      const created = await binding.createBatch([{ id: providerInstanceId, params: payload }]);
      if (created.length === 1) return "created";
      if (created.length === 0) return "already_exists";
      throw new Error("Workflow createBatch returned an unexpected instance count");
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
