export const PROCESSING_WORKFLOW_STEP_OPTIONS = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

export const SONG_PIPELINE_WORKFLOW_STEP_OPTIONS = {
  retries: { limit: 5, delay: "15 seconds", backoff: "exponential" },
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

/**
 * Terminal instance states. A finished instance is neither proof of success nor
 * grounds for replacement: recovery must reconcile the persisted operation row
 * instead of relaunching the Workflow.
 */
const FINISHED_WORKFLOW_STATUSES = new Set(["complete", "errored", "terminated"]);

export const isFinishedWorkflowStatus = (status: string): boolean =>
  FINISHED_WORKFLOW_STATUSES.has(status);

/**
 * The installed runtime reports an unknown Workflow instance id as an `Error`
 * whose message is exactly `instance.not_found`. That is measured behavior of
 * the installed runtime, not a guaranteed API contract, and the runtime
 * exposes no typed error. Classification therefore matches only that exact
 * message: unfamiliar errors must remain visible lookup failures rather than
 * being mistaken for a missing instance.
 */
export const isWorkflowInstanceMissingError = (error: unknown): boolean =>
  error instanceof Error && error.message.trim() === "instance.not_found";

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
