import { Effect, Schema } from "effect";
import {
  type DanceReferenceProcessingStore,
  type DanceReferenceProcessorService,
  runDanceReferenceProcessing,
} from "./reference-processing.ts";

const Identifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
      ? undefined
      : "Expected a bounded canonical identifier",
  ),
);
const DeliveryIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 256 && value.trim() === value && !value.includes("\u0000")
      ? undefined
      : "Expected a bounded Queue delivery identifier",
  ),
);
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

const DanceReferenceQueueMessage = Schema.Struct({ outbox_id: Identifier });
const DanceReferenceWorkflowPayload = Schema.Struct({
  version: Schema.Literal("dance-reference-workflow-v1"),
  outboxId: Identifier,
  choreographyId: Identifier,
  choreographyRevision: PositiveInteger,
  effectIdentity: Identifier,
});
export type DanceReferenceWorkflowPayload = Schema.Schema.Type<
  typeof DanceReferenceWorkflowPayload
>;

export type DanceReferenceWakeupRecord = Readonly<{
  readonly outboxId: string;
  readonly choreographyId: string;
  readonly choreographyRevision: number;
  readonly effectIdentity: string;
  readonly revisionStatus: "processing" | "ready" | "processing_failed" | "disabled" | "retired";
  readonly state: "pending" | "running" | "delivered" | "failed" | "exhausted";
  readonly deliveryAttempts: number;
  readonly claimFence: number;
  readonly eligible: boolean;
}>;

export interface DanceReferenceWakeupStore {
  readonly getWakeup: (outboxId: string) => Promise<DanceReferenceWakeupRecord | null>;
  readonly listEligibleWakeups: (limit: number) => Promise<readonly DanceReferenceWakeupRecord[]>;
}

export interface DanceReferenceWorkflowLauncher {
  readonly create: (
    instanceId: string,
    payload: DanceReferenceWorkflowPayload,
  ) => Promise<"created" | "already_exists">;
}

export type DanceReferenceQueueDisposition =
  | Readonly<{ readonly disposition: "ack" }>
  | Readonly<{ readonly disposition: "retry"; readonly delaySeconds: number }>
  | Readonly<{ readonly disposition: "dlq" }>;

export type DanceReferenceQueueDependencies = Readonly<{
  readonly store: DanceReferenceWakeupStore;
  readonly workflow: DanceReferenceWorkflowLauncher;
}>;

export async function consumeDanceReferenceQueueMessage(
  body: unknown,
  deliveryIdInput: unknown,
  dependencies: DanceReferenceQueueDependencies,
): Promise<DanceReferenceQueueDisposition> {
  let message: Schema.Schema.Type<typeof DanceReferenceQueueMessage>;
  let deliveryId: string;
  try {
    message = Schema.decodeUnknownSync(DanceReferenceQueueMessage, {
      onExcessProperty: "error",
    })(body);
    deliveryId = Schema.decodeUnknownSync(DeliveryIdentifier)(deliveryIdInput);
  } catch {
    return { disposition: "dlq" };
  }
  const record = await dependencies.store.getWakeup(message.outbox_id);
  if (record === null) return { disposition: "dlq" };
  if (record.state === "delivered") return { disposition: "ack" };
  if (record.state === "exhausted") return { disposition: "dlq" };
  if (!record.eligible) return { disposition: "ack" };
  const payload: DanceReferenceWorkflowPayload = Object.freeze({
    version: "dance-reference-workflow-v1",
    outboxId: record.outboxId,
    choreographyId: record.choreographyId,
    choreographyRevision: record.choreographyRevision,
    effectIdentity: record.effectIdentity,
  });
  try {
    await dependencies.workflow.create(`dance-reference-${deliveryId}`, payload);
    return { disposition: "ack" };
  } catch {
    return { disposition: "retry", delaySeconds: 15 };
  }
}

export type DanceReferenceWorkflowResume = Readonly<{
  readonly claimFence: number;
  readonly outboxClaimFence: number;
}>;

export type DanceReferenceWorkflowAdvance =
  | Readonly<{ readonly outcome: "inert" | "busy" | "stale" }>
  | Readonly<{
      readonly outcome: "waiting";
      readonly resume: DanceReferenceWorkflowResume;
    }>
  | Readonly<{
      readonly outcome: "terminal";
      readonly status: "ready" | "processing_failed";
    }>
  | Readonly<{
      readonly outcome: "committed" | "replayed";
      readonly status: "ready" | "failed";
    }>;

export type DanceReferenceWorkflowDependencies = Readonly<{
  readonly store: DanceReferenceProcessingStore & DanceReferenceWakeupStore;
  readonly processor: DanceReferenceProcessorService | null;
  readonly leaseSeconds: number;
  readonly adapterId: string;
  readonly adapterRevision: string;
}>;

function decodeWorkflowPayload(input: unknown): DanceReferenceWorkflowPayload {
  return Schema.decodeUnknownSync(DanceReferenceWorkflowPayload, {
    onExcessProperty: "error",
  })(input);
}

export const advanceDanceReferenceWorkflow = Effect.fn("advanceDanceReferenceWorkflow")(function* (
  payloadInput: unknown,
  instanceIdInput: unknown,
  dependencies: DanceReferenceWorkflowDependencies,
  resume?: DanceReferenceWorkflowResume,
): Effect.fn.Return<DanceReferenceWorkflowAdvance, unknown> {
  let payload: DanceReferenceWorkflowPayload;
  let instanceId: string;
  try {
    payload = decodeWorkflowPayload(payloadInput);
    instanceId = Schema.decodeUnknownSync(Identifier)(instanceIdInput);
  } catch {
    return { outcome: "inert" };
  }
  if (dependencies.processor === null) return { outcome: "inert" };
  const authority = yield* Effect.tryPromise({
    try: () => dependencies.store.getWakeup(payload.outboxId),
    catch: (error) => error,
  });
  if (
    authority === null ||
    authority.choreographyId !== payload.choreographyId ||
    authority.choreographyRevision !== payload.choreographyRevision ||
    authority.effectIdentity !== payload.effectIdentity
  ) {
    return { outcome: "inert" };
  }
  if (authority.state === "delivered") {
    return {
      outcome: "terminal",
      status: authority.revisionStatus === "ready" ? "ready" : "processing_failed",
    };
  }
  if (authority.state === "exhausted") {
    return { outcome: "terminal", status: "processing_failed" };
  }
  if (resume === undefined && !authority.eligible) return { outcome: "busy" };

  const disposition = yield* runDanceReferenceProcessing(
    {
      choreographyId: payload.choreographyId,
      choreographyRevision: payload.choreographyRevision,
      workerId: instanceId,
      leaseSeconds: dependencies.leaseSeconds,
      adapterId: dependencies.adapterId,
      adapterRevision: dependencies.adapterRevision,
      ...(resume === undefined ? {} : { resume }),
    },
    { store: dependencies.store, processor: dependencies.processor },
  );
  if (disposition.kind === "pending") {
    return {
      outcome: "waiting",
      resume: {
        claimFence: disposition.claimFence,
        outboxClaimFence: disposition.outboxClaimFence,
      },
    };
  }
  if (disposition.kind === "terminal") {
    return { outcome: "terminal", status: disposition.status };
  }
  if (disposition.kind === "committed" || disposition.kind === "replayed") {
    return {
      outcome: disposition.kind,
      status: disposition.status,
    };
  }
  return { outcome: disposition.kind };
});
