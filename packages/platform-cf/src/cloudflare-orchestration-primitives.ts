export const PROCESSING_WORKFLOW_STEP_OPTIONS = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

export interface CloudflareWorkflowStepDo<Options> {
  readonly do: <T>(name: string, options: Options, callback: () => Promise<T>) => Promise<T>;
}

/** Encodes the exact logical identity without changing existing provider instance names. */
export async function cloudflareDigestWorkflowId(
  prefix: "drw" | "vaw",
  logicalId: string,
): Promise<string> {
  if (logicalId.length === 0 || logicalId.length > 512 || logicalId !== logicalId.trim()) {
    throw new TypeError("invalid logical Workflow identity");
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(logicalId)),
  );
  return `${prefix}-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export const isExplicitlyEnabled = (value: string | undefined): boolean => value === "true";

const PRESENT_WORKFLOW_STATUSES = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
  "rollingBack",
]);

export const isPresentWorkflowStatus = (status: string): boolean =>
  PRESENT_WORKFLOW_STATUSES.has(status);

export function classifyWorkflowCreateBatch(
  created: readonly unknown[],
  unexpectedCountMessage: string,
): "created" | "already_exists" {
  if (created.length === 1) return "created";
  if (created.length === 0) return "already_exists";
  throw new Error(unexpectedCountMessage);
}

type CloudflareQueueDisposition =
  | Readonly<{ readonly disposition: "ack" }>
  | Readonly<{ readonly disposition: "retry"; readonly delaySeconds: number }>
  | Readonly<{ readonly disposition: "dlq" }>;

interface CloudflareQueueMessageDispositionPort {
  readonly ack: () => void;
  readonly retry: (options?: { readonly delaySeconds?: number }) => void;
}

export function applyCloudflareQueueDisposition(
  message: CloudflareQueueMessageDispositionPort,
  disposition: CloudflareQueueDisposition,
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
