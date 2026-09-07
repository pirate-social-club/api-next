import { consumeVideoStreamIngest, type VideoStreamIngestServices } from "./stream-ingest.ts";
import { consumeVideoThumbnail, type VideoThumbnailServices } from "./thumbnail-enrichment.ts";

export const VIDEO_ENRICHMENT_POLICY = {
  acceptanceMs: 300_000,
  encodingMs: 1_800_000,
  leaseMs: 120_000,
  pollMs: 30_000,
} as const;

export interface VideoEnrichmentExecution {
  readonly effectIdentity: string;
  readonly generation: number;
  readonly kind: "stream" | "thumbnail";
  readonly startedAtMs: number;
}

export interface VideoEnrichmentExecutionStore {
  /** Initializes once from exact durable publication facts, never queue fields. */
  prepare(effectIdentity: string): Promise<VideoEnrichmentExecution | null>;
  /** Terminal Workflow recovery only; never resets the original start time. */
  replace(execution: VideoEnrichmentExecution): Promise<VideoEnrichmentExecution | null>;
  active(execution: VideoEnrichmentExecution): Promise<boolean>;
}

export function videoEnrichmentWorkflowIdentity(execution: VideoEnrichmentExecution): string {
  return `video-enrichment:${execution.effectIdentity}:g${execution.generation}`;
}

export interface VideoEnrichmentServices {
  readonly executions: VideoEnrichmentExecutionStore;
  readonly stream: VideoStreamIngestServices;
  readonly thumbnail: VideoThumbnailServices;
  readonly nowMs: () => number;
}

export async function launchVideoEnrichment(
  body: unknown,
  services: {
    executions: VideoEnrichmentExecutionStore;
    launcher: {
      create(identity: string): Promise<unknown>;
      get(identity: string): Promise<"present" | "missing" | "terminal">;
    };
  },
): Promise<"ack" | "retry"> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "ack";
  const message = body as Record<string, unknown>;
  if (
    Object.keys(message).sort().join(",") !== "kind,outbox_id" ||
    message.kind !== "video_enrichment" ||
    typeof message.outbox_id !== "string" ||
    !/^\S{1,400}$/u.test(message.outbox_id)
  )
    return "ack";
  try {
    let execution = await services.executions.prepare(message.outbox_id);
    if (execution === null) return "ack";
    const identity = videoEnrichmentWorkflowIdentity(execution);
    // Idempotent create also handles the first launch without guessing absence
    // from a thrown provider error. A lost response keeps the same durable ID.
    await services.launcher.create(identity);
    const state = await services.launcher.get(identity);
    if (state === "present") return "ack";
    if (state === "missing") return "retry";
    execution = await services.executions.replace(execution);
    if (execution === null) return "ack";
    await services.launcher.create(videoEnrichmentWorkflowIdentity(execution));
    return "ack";
  } catch {
    return "retry";
  }
}

/** Only identifiers/statuses enter durable step results; grants and bytes do not. */
export async function runVideoEnrichmentWorkflow(
  identity: string,
  step: {
    do<T>(name: string, run: () => Promise<T>): Promise<T>;
    sleep(name: string, ms: number): Promise<void>;
  },
  services: VideoEnrichmentServices,
): Promise<{ outcome: "enrichment_complete" }> {
  const match = /^video-enrichment:(\S{1,400}):g(\d+)$/u.exec(identity);
  if (match === null) throw new Error("Invalid enrichment Workflow identity");
  const effectIdentity = match[1];
  const generation = Number(match[2]);
  if (effectIdentity === undefined || !Number.isSafeInteger(generation))
    throw new Error("Invalid enrichment Workflow generation");
  for (let turn = 0; ; turn += 1) {
    const done = await step.do(`video-enrichment-${turn}`, async () => {
      const execution = await services.executions.prepare(effectIdentity);
      if (execution === null || execution.generation !== generation) return true;
      if (!(await services.executions.active(execution))) return true;
      if (execution.kind === "stream") {
        await consumeVideoStreamIngest(effectIdentity, services.stream);
      } else if (services.nowMs() >= execution.startedAtMs + VIDEO_ENRICHMENT_POLICY.encodingMs) {
        // Persistent storage unavailability is a delivery failure, not a claim
        // that the sealed object is absent. No automatic reset or second copy.
        const claim = await services.thumbnail.store.claim(effectIdentity);
        if (claim !== null) await services.thumbnail.store.complete(claim, "failed");
      } else {
        await consumeVideoThumbnail(effectIdentity, services.thumbnail);
      }
      return !(await services.executions.active(execution));
    });
    if (done) return { outcome: "enrichment_complete" };
    await step.sleep(`video-enrichment-wait-${turn}`, VIDEO_ENRICHMENT_POLICY.pollMs);
  }
}
