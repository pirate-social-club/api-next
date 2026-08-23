import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { deterministicMediaWorkflowInstanceId } from "@pirate/domain";
import { Data, Effect } from "effect";

type Row = Readonly<Record<string, unknown>>;
const ID = /^\S(?:.*\S)?$/u;

export class MediaOutboxRepositoryError extends Data.TaggedError("MediaOutboxRepositoryError")<{
  readonly operation: "enqueue" | "get" | "claim" | "deliver" | "fail";
  readonly reason:
    | "invalid-input"
    | "not-found"
    | "identity-conflict"
    | "stale-fence"
    | "invalid-row";
  readonly outboxEventId?: string;
}> {}
export type MediaOutboxRepositoryFailure = MediaOutboxRepositoryError | ControlPlaneError;

export type MediaOutboxRecord = Readonly<{
  outboxEventId: string;
  submissionId: string;
  communityId: string;
  operationId: string;
  creationRevision: number;
  audioRevision: number;
  analysisRevision: number;
  workflowRevision: number;
  workflowInstanceId: string;
  eventType: "analysis_launch" | "publication";
  effectIdentity: string;
  payload: Readonly<Record<string, unknown>>;
  state: "pending" | "claimed" | "delivered" | "failed";
  deliveryAttempts: number;
  claimOwner: string | null;
  claimFence: number;
}>;

export type MediaOutboxEnqueueInput = Readonly<{
  outboxEventId: string;
  submissionId: string;
  communityId: string;
  operationId: string;
  creationRevision: number;
  audioRevision: number;
  analysisRevision: number;
  workflowRevision: number;
  workflowInstanceId: string;
  eventType: MediaOutboxRecord["eventType"];
  effectIdentity: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type MediaOutboxClaimInput = Readonly<{
  outboxEventId: string;
  workflowRevision: number;
  workerId: string;
  leaseSeconds: number;
}>;

export type MediaOutboxCompletionInput = Readonly<{
  outboxEventId: string;
  workflowRevision: number;
  workflowInstanceId: string;
  workerId: string;
  claimFence: number;
}>;

export type MediaOutboxStore = {
  enqueue: (
    input: MediaOutboxEnqueueInput,
  ) => Effect.Effect<
    | { readonly kind: "created"; readonly outboxEventId: string }
    | { readonly kind: "replay"; readonly outboxEventId: string },
    MediaOutboxRepositoryFailure,
    ControlPlaneDb
  >;
  get: (
    outboxEventId: string,
  ) => Effect.Effect<MediaOutboxRecord | null, MediaOutboxRepositoryFailure, ControlPlaneDb>;
  claim: (
    input: MediaOutboxClaimInput,
  ) => Effect.Effect<MediaOutboxRecord | null, MediaOutboxRepositoryFailure, ControlPlaneDb>;
  markDelivered: (
    input: MediaOutboxCompletionInput,
  ) => Effect.Effect<boolean, MediaOutboxRepositoryFailure, ControlPlaneDb>;
  markFailed: (
    input: MediaOutboxCompletionInput & { failureCode: string; nextEligibleAt: string },
  ) => Effect.Effect<boolean, MediaOutboxRepositoryFailure, ControlPlaneDb>;
};

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 512 && !value.includes("\u0000") && ID.test(value);
const integer = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^-?[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const payload = (value: unknown): Readonly<Record<string, unknown>> | null => {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Readonly<Record<string, unknown>>;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
};
const fail = (
  operation: MediaOutboxRepositoryError["operation"],
  reason: MediaOutboxRepositoryError["reason"],
  outboxEventId?: string,
) =>
  new MediaOutboxRepositoryError({
    operation,
    reason,
    ...(outboxEventId === undefined ? {} : { outboxEventId }),
  });
const lock = (tx: ControlPlaneTransaction, value: string) =>
  tx.execute({
    label: "media-outbox.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    values: [value],
    readonly: false,
  });

function decodeRecord(
  row: Row,
  operation: MediaOutboxRepositoryError["operation"],
): MediaOutboxRecord {
  const creationRevision = integer(row.creation_revision);
  const audioRevision = integer(row.audio_revision);
  const analysisRevision = integer(row.analysis_revision);
  const workflowRevision = integer(row.workflow_revision);
  const deliveryAttempts = integer(row.delivery_attempts);
  const claimFence = integer(row.claim_fence);
  const decodedPayload = payload(row.payload);
  if (
    !validId(row.outbox_event_id) ||
    !validId(row.submission_id) ||
    !validId(row.community_id) ||
    !validId(row.operation_id) ||
    creationRevision === null ||
    creationRevision < 1 ||
    audioRevision === null ||
    audioRevision < 1 ||
    analysisRevision === null ||
    analysisRevision < 0 ||
    workflowRevision === null ||
    workflowRevision < 1 ||
    !validId(row.workflow_instance_id) ||
    row.workflow_instance_id !==
      deterministicMediaWorkflowInstanceId(row.operation_id, workflowRevision) ||
    !["analysis_launch", "publication"].includes(String(row.event_type)) ||
    !validId(row.effect_identity) ||
    decodedPayload === null ||
    !["pending", "claimed", "delivered", "failed"].includes(String(row.state)) ||
    deliveryAttempts === null ||
    deliveryAttempts < 0 ||
    claimFence === null ||
    claimFence < 0 ||
    (row.claim_owner !== null && !validId(row.claim_owner))
  )
    throw fail(
      operation,
      "invalid-row",
      typeof row.outbox_event_id === "string" ? row.outbox_event_id : undefined,
    );
  return {
    outboxEventId: row.outbox_event_id,
    submissionId: row.submission_id,
    communityId: row.community_id,
    operationId: row.operation_id,
    creationRevision,
    audioRevision,
    analysisRevision,
    workflowRevision,
    workflowInstanceId: row.workflow_instance_id,
    eventType: row.event_type as MediaOutboxRecord["eventType"],
    effectIdentity: row.effect_identity,
    payload: decodedPayload,
    state: row.state as MediaOutboxRecord["state"],
    deliveryAttempts,
    claimOwner: row.claim_owner as string | null,
    claimFence,
  };
}

const decode = (
  row: Row,
  operation: MediaOutboxRepositoryError["operation"],
  outboxEventId?: string,
) =>
  Effect.try({
    try: () => decodeRecord(row, operation),
    catch: (error) =>
      error instanceof MediaOutboxRepositoryError
        ? error
        : fail(operation, "invalid-row", outboxEventId),
  });

export function makeControlPlaneMediaOutboxRepository(): MediaOutboxStore {
  const enqueue: MediaOutboxStore["enqueue"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.outboxEventId) ||
        !validId(input.submissionId) ||
        !validId(input.communityId) ||
        !validId(input.operationId) ||
        !Number.isSafeInteger(input.creationRevision) ||
        input.creationRevision < 1 ||
        !Number.isSafeInteger(input.audioRevision) ||
        input.audioRevision < 1 ||
        !Number.isSafeInteger(input.analysisRevision) ||
        input.analysisRevision < 0 ||
        !Number.isSafeInteger(input.workflowRevision) ||
        input.workflowRevision < 1 ||
        input.workflowInstanceId !==
          deterministicMediaWorkflowInstanceId(input.operationId, input.workflowRevision) ||
        !["analysis_launch", "publication"].includes(input.eventType) ||
        !validId(input.effectIdentity)
      )
        return yield* Effect.fail(fail("enqueue", "invalid-input", input.outboxEventId));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* lock(tx, input.effectIdentity);
          const prior = yield* tx.execute<Row>({
            label: "media-outbox.enqueue.replay",
            text: "SELECT * FROM media_submission_outbox WHERE effect_identity = $1 FOR UPDATE",
            values: [input.effectIdentity],
            readonly: false,
          });
          if (prior.rows.length > 1)
            return yield* Effect.fail(fail("enqueue", "invalid-row", input.outboxEventId));
          if (prior.rows.length === 1) {
            const current = yield* decode(prior.rows[0] as Row, "enqueue", input.outboxEventId);
            if (
              current.outboxEventId !== input.outboxEventId ||
              current.submissionId !== input.submissionId ||
              current.communityId !== input.communityId ||
              current.operationId !== input.operationId ||
              current.creationRevision !== input.creationRevision ||
              current.audioRevision !== input.audioRevision ||
              current.analysisRevision !== input.analysisRevision ||
              current.workflowRevision !== input.workflowRevision ||
              current.workflowInstanceId !== input.workflowInstanceId ||
              current.eventType !== input.eventType ||
              JSON.stringify(current.payload) !== JSON.stringify(input.payload)
            )
              return yield* Effect.fail(fail("enqueue", "identity-conflict", input.outboxEventId));
            return { kind: "replay", outboxEventId: current.outboxEventId } as const;
          }
          const result = yield* tx.execute({
            label: "media-outbox.enqueue",
            text: `INSERT INTO media_submission_outbox (
                     outbox_event_id, submission_id, community_id, operation_id,
                     creation_revision, audio_revision, analysis_revision,
                     workflow_revision, workflow_instance_id, event_type,
                     effect_identity, payload
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
            values: [
              input.outboxEventId,
              input.submissionId,
              input.communityId,
              input.operationId,
              input.creationRevision,
              input.audioRevision,
              input.analysisRevision,
              input.workflowRevision,
              input.workflowInstanceId,
              input.eventType,
              input.effectIdentity,
              JSON.stringify(input.payload),
            ],
            readonly: false,
          });
          if (result.rowCount !== 1)
            return yield* Effect.fail(fail("enqueue", "identity-conflict", input.outboxEventId));
          return { kind: "created", outboxEventId: input.outboxEventId } as const;
        }),
      );
    });

  const get: MediaOutboxStore["get"] = (outboxEventId) =>
    Effect.gen(function* () {
      if (!validId(outboxEventId))
        return yield* Effect.fail(fail("get", "invalid-input", outboxEventId));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-outbox.get",
        text: "SELECT * FROM media_submission_outbox WHERE outbox_event_id = $1",
        values: [outboxEventId],
        readonly: true,
      });
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1)
        return yield* Effect.fail(fail("get", "invalid-row", outboxEventId));
      return yield* decode(result.rows[0] as Row, "get", outboxEventId);
    });

  const claim: MediaOutboxStore["claim"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.outboxEventId) ||
        !validId(input.workerId) ||
        !Number.isSafeInteger(input.workflowRevision) ||
        input.workflowRevision < 1 ||
        !Number.isSafeInteger(input.leaseSeconds) ||
        input.leaseSeconds < 1 ||
        input.leaseSeconds > 3_600
      )
        return yield* Effect.fail(fail("claim", "invalid-input", input.outboxEventId));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-outbox.claim",
        text: `UPDATE media_submission_outbox
                  SET state = 'claimed', delivery_attempts = delivery_attempts + 1,
                      claim_owner = $1, claim_fence = claim_fence + 1,
                      lease_expires_at = clock_timestamp() + make_interval(secs => $2),
                      next_eligible_at = NULL, failure_code = NULL,
                      updated_at = clock_timestamp()
                WHERE outbox_event_id = $3 AND workflow_revision = $4
                  AND (
                    state = 'pending'
                    OR (state = 'failed' AND next_eligible_at <= clock_timestamp())
                    OR (state = 'claimed' AND lease_expires_at <= clock_timestamp())
                  )
                RETURNING *`,
        values: [input.workerId, input.leaseSeconds, input.outboxEventId, input.workflowRevision],
        readonly: false,
      });
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1)
        return yield* Effect.fail(fail("claim", "invalid-row", input.outboxEventId));
      return yield* decode(result.rows[0] as Row, "claim", input.outboxEventId);
    });

  const markDelivered: MediaOutboxStore["markDelivered"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.outboxEventId) ||
        !validId(input.workflowInstanceId) ||
        !validId(input.workerId) ||
        !Number.isSafeInteger(input.workflowRevision) ||
        input.workflowRevision < 1 ||
        !Number.isSafeInteger(input.claimFence) ||
        input.claimFence < 1
      )
        return yield* Effect.fail(fail("deliver", "invalid-input", input.outboxEventId));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute({
        label: "media-outbox.deliver",
        text: `UPDATE media_submission_outbox
                  SET state = 'delivered', claim_owner = NULL, lease_expires_at = NULL,
                      delivered_at = clock_timestamp(), failure_code = NULL,
                      next_eligible_at = NULL, updated_at = clock_timestamp()
                WHERE outbox_event_id = $1 AND workflow_revision = $2
                  AND workflow_instance_id = $3 AND state = 'claimed'
                  AND claim_owner = $4 AND claim_fence = $5
                  AND lease_expires_at > clock_timestamp()`,
        values: [
          input.outboxEventId,
          input.workflowRevision,
          input.workflowInstanceId,
          input.workerId,
          input.claimFence,
        ],
        readonly: false,
      });
      return result.rowCount === 1;
    });

  const markFailed: MediaOutboxStore["markFailed"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.outboxEventId) ||
        !validId(input.workflowInstanceId) ||
        !validId(input.workerId) ||
        !validId(input.failureCode) ||
        !Number.isFinite(Date.parse(input.nextEligibleAt)) ||
        !Number.isSafeInteger(input.workflowRevision) ||
        input.workflowRevision < 1 ||
        !Number.isSafeInteger(input.claimFence) ||
        input.claimFence < 1
      )
        return yield* Effect.fail(fail("fail", "invalid-input", input.outboxEventId));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute({
        label: "media-outbox.fail",
        text: `UPDATE media_submission_outbox
                  SET state = 'failed', claim_owner = NULL, lease_expires_at = NULL,
                      failure_code = $1, next_eligible_at = $2::timestamptz,
                      updated_at = clock_timestamp()
                WHERE outbox_event_id = $3 AND workflow_revision = $4
                  AND workflow_instance_id = $5 AND state = 'claimed'
                  AND claim_owner = $6 AND claim_fence = $7
                  AND lease_expires_at > clock_timestamp()`,
        values: [
          input.failureCode,
          input.nextEligibleAt,
          input.outboxEventId,
          input.workflowRevision,
          input.workflowInstanceId,
          input.workerId,
          input.claimFence,
        ],
        readonly: false,
      });
      return result.rowCount === 1;
    });

  return { enqueue, get, claim, markDelivered, markFailed };
}

export const makeMediaOutboxRepository = makeControlPlaneMediaOutboxRepository;
export const makeControlPlaneMediaOutboxStore = makeControlPlaneMediaOutboxRepository;
