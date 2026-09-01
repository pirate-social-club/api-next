import { Effect, Schema } from "effect";
import {
  type DanceAttemptGraderAdapter,
  type DanceAttemptProcessingDisposition,
  type DanceAttemptProcessingStore,
  runDanceAttemptProcessing,
} from "./attempt-processing.ts";

const Identifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 512 && value === value.trim() && !value.includes("\u0000")
      ? undefined
      : "Expected a bounded identifier",
  ),
);
const DeliveryIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 256 && value === value.trim() && !value.includes("\u0000")
      ? undefined
      : "Expected a bounded delivery identifier",
  ),
);

const DanceAttemptQueueMessage = Schema.Struct({ attempt_id: Identifier });
const DanceAttemptWorkflowPayload = Schema.Struct({
  version: Schema.Literal("dance-attempt-workflow-v1"),
  attemptId: Identifier,
  effectIdentity: Identifier,
  inputDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
export type DanceAttemptWorkflowPayload = Schema.Schema.Type<typeof DanceAttemptWorkflowPayload>;

export type DanceAttemptWakeupRecord = Readonly<{
  readonly attemptId: string;
  readonly effectIdentity: string;
  readonly inputDigest: string;
  readonly attemptState: "grading_pending" | "completed" | "rejected" | "processing_failed";
  readonly state: "pending" | "running" | "delivered" | "failed";
  readonly deliveryAttempts: number;
  readonly claimFence: number;
  readonly eligible: boolean;
}>;

export interface DanceAttemptWakeupStore {
  readonly getWakeup: (attemptId: string) => Promise<DanceAttemptWakeupRecord | null>;
  readonly listEligibleWakeups: (limit: number) => Promise<readonly DanceAttemptWakeupRecord[]>;
}

export interface DanceAttemptWorkflowLauncher {
  readonly create: (
    instanceId: string,
    payload: DanceAttemptWorkflowPayload,
  ) => Promise<"created" | "already_exists">;
}

export type DanceAttemptQueueDisposition =
  | Readonly<{ readonly disposition: "ack" }>
  | Readonly<{ readonly disposition: "retry"; readonly delaySeconds: number }>
  | Readonly<{ readonly disposition: "dlq" }>;

export type DanceAttemptQueueDependencies = Readonly<{
  readonly store: DanceAttemptWakeupStore;
  readonly workflow: DanceAttemptWorkflowLauncher;
}>;

export async function consumeDanceAttemptQueueMessage(
  body: unknown,
  deliveryIdInput: unknown,
  dependencies: DanceAttemptQueueDependencies,
): Promise<DanceAttemptQueueDisposition> {
  let message: Schema.Schema.Type<typeof DanceAttemptQueueMessage>;
  let deliveryId: string;
  try {
    message = Schema.decodeUnknownSync(DanceAttemptQueueMessage, {
      onExcessProperty: "error",
    })(body);
    deliveryId = Schema.decodeUnknownSync(DeliveryIdentifier)(deliveryIdInput);
  } catch {
    return { disposition: "dlq" };
  }
  const record = await dependencies.store.getWakeup(message.attempt_id);
  if (record === null) return { disposition: "dlq" };
  if (record.state === "delivered") return { disposition: "ack" };
  if (!record.eligible) return { disposition: "ack" };
  const payload: DanceAttemptWorkflowPayload = Object.freeze({
    version: "dance-attempt-workflow-v1",
    attemptId: record.attemptId,
    effectIdentity: record.effectIdentity,
    inputDigest: record.inputDigest,
  });
  try {
    await dependencies.workflow.create(`dance-attempt-${deliveryId}`, payload);
    return { disposition: "ack" };
  } catch {
    return { disposition: "retry", delaySeconds: 15 };
  }
}

export type DanceAttemptWorkflowDependencies = Readonly<{
  readonly store: DanceAttemptProcessingStore & DanceAttemptWakeupStore;
  readonly adapter: DanceAttemptGraderAdapter | null;
  readonly leaseSeconds: number;
  readonly retryAfterSeconds: number;
}>;

/** A null adapter returns before authority lookup and therefore before any claim. */
export async function advanceDanceAttemptWorkflow(
  payloadInput: unknown,
  instanceIdInput: unknown,
  dependencies: DanceAttemptWorkflowDependencies,
): Promise<DanceAttemptProcessingDisposition> {
  let payload: DanceAttemptWorkflowPayload;
  let instanceId: string;
  try {
    payload = Schema.decodeUnknownSync(DanceAttemptWorkflowPayload, {
      onExcessProperty: "error",
    })(payloadInput);
    instanceId = Schema.decodeUnknownSync(Identifier)(instanceIdInput);
  } catch {
    return { kind: "inert" };
  }
  if (dependencies.adapter === null) return { kind: "inert" };
  const authority = await dependencies.store.getWakeup(payload.attemptId);
  if (
    authority === null ||
    authority.effectIdentity !== payload.effectIdentity ||
    authority.inputDigest !== payload.inputDigest
  ) {
    return { kind: "inert" };
  }
  if (authority.attemptState !== "grading_pending") {
    return {
      kind: "terminal",
      status: authority.attemptState === "processing_failed" ? "failed" : "completed",
    };
  }
  if (!authority.eligible) return { kind: "busy" };
  return Effect.runPromise(
    runDanceAttemptProcessing(
      {
        attemptId: payload.attemptId,
        workerId: instanceId,
        leaseSeconds: dependencies.leaseSeconds,
        retryAfterSeconds: dependencies.retryAfterSeconds,
      },
      { store: dependencies.store, adapter: dependencies.adapter },
    ),
  );
}
