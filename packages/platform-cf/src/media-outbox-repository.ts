import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Data, Effect } from "effect";

type Row = Readonly<Record<string, unknown>>;
const ID = /^\S+$/u;

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
  readonly outboxEventId: string;
  readonly submissionId: string;
  readonly operationId: string;
  readonly creationRevision: number;
  readonly workflowRevision: number;
  readonly workflowInstanceId: string;
  readonly eventType: "analysis_launch" | "publication" | "reference_wakeup" | "retry_wakeup";
  readonly effectIdentity: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: "pending" | "claimed" | "delivered" | "failed";
  readonly deliveryAttempts: number;
}>;

export type MediaOutboxStore = {
  readonly enqueue: (
    input: Readonly<{
      readonly outboxEventId: string;
      readonly submissionId: string;
      readonly operationId: string;
      readonly creationRevision: number;
      readonly workflowRevision: number;
      readonly workflowInstanceId: string;
      readonly eventType: MediaOutboxRecord["eventType"];
      readonly effectIdentity: string;
      readonly payload: Readonly<Record<string, unknown>>;
    }>,
  ) => Effect.Effect<
    | { readonly kind: "created"; readonly outboxEventId: string }
    | { readonly kind: "replay"; readonly outboxEventId: string },
    MediaOutboxRepositoryFailure,
    ControlPlaneDb
  >;
  readonly get: (
    outboxEventId: string,
  ) => Effect.Effect<MediaOutboxRecord | null, MediaOutboxRepositoryFailure, ControlPlaneDb>;
  readonly claim: (
    input: Readonly<{
      readonly outboxEventId: string;
      readonly expectedState?: "pending" | "failed";
      readonly workflowRevision: number;
    }>,
  ) => Effect.Effect<MediaOutboxRecord | null, MediaOutboxRepositoryFailure, ControlPlaneDb>;
  readonly markDelivered: (
    input: Readonly<{
      readonly outboxEventId: string;
      readonly workflowRevision: number;
      readonly workflowInstanceId: string;
    }>,
  ) => Effect.Effect<boolean, MediaOutboxRepositoryFailure, ControlPlaneDb>;
  readonly markFailed: (
    input: Readonly<{
      readonly outboxEventId: string;
      readonly workflowRevision: number;
      readonly workflowInstanceId: string;
    }>,
  ) => Effect.Effect<boolean, MediaOutboxRepositoryFailure, ControlPlaneDb>;
};

const validId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value) && !value.includes("\u0000") && value.length <= 512;
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
const parsedPayload = (value: unknown): Readonly<Record<string, unknown>> | null => {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Readonly<Record<string, unknown>>;
  if (typeof value === "string") {
    try {
      const decoded: unknown = JSON.parse(value);
      return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
        ? (decoded as Readonly<Record<string, unknown>>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
};
const record = (
  row: Row,
  operation: MediaOutboxRepositoryError["operation"],
): MediaOutboxRecord => {
  const eventId = row.outbox_event_id;
  const submissionId = row.submission_id;
  const operationId = row.operation_id;
  const creationRevision = row.creation_revision;
  const workflowRevision = row.workflow_revision;
  const workflowInstanceId = row.workflow_instance_id;
  const eventType = row.event_type;
  const effectIdentity = row.effect_identity;
  const state = row.state;
  const attempts = row.delivery_attempts;
  const payload = parsedPayload(row.payload);
  if (
    !validId(eventId) ||
    !validId(submissionId) ||
    !validId(operationId) ||
    !Number.isSafeInteger(creationRevision) ||
    !Number.isSafeInteger(workflowRevision) ||
    !validId(workflowInstanceId) ||
    !validId(eventType) ||
    !validId(effectIdentity) ||
    !["analysis_launch", "publication", "reference_wakeup", "retry_wakeup"].includes(
      String(eventType),
    ) ||
    !["pending", "claimed", "delivered", "failed"].includes(String(state)) ||
    !Number.isSafeInteger(attempts) ||
    payload === null
  )
    throw fail(operation, "invalid-row", typeof eventId === "string" ? eventId : undefined);
  return {
    outboxEventId: eventId,
    submissionId,
    operationId,
    creationRevision: creationRevision as number,
    workflowRevision: workflowRevision as number,
    workflowInstanceId,
    eventType: eventType as MediaOutboxRecord["eventType"],
    effectIdentity,
    payload,
    state: state as MediaOutboxRecord["state"],
    deliveryAttempts: attempts as number,
  };
};
const lock = (tx: ControlPlaneTransaction, id: string) =>
  tx.execute({
    label: "media-outbox.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    values: [id],
    readonly: false,
  });

export function makeControlPlaneMediaOutboxRepository(): MediaOutboxStore {
  const enqueue: MediaOutboxStore["enqueue"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.outboxEventId) ||
        !validId(input.submissionId) ||
        !validId(input.operationId) ||
        !validId(input.workflowInstanceId) ||
        !validId(input.effectIdentity) ||
        !Number.isSafeInteger(input.creationRevision) ||
        input.creationRevision < 1 ||
        !Number.isSafeInteger(input.workflowRevision) ||
        input.workflowRevision < 1 ||
        !["analysis_launch", "publication", "reference_wakeup", "retry_wakeup"].includes(
          input.eventType,
        )
      )
        return yield* Effect.fail(fail("enqueue", "invalid-input", input.outboxEventId));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* lock(tx, input.effectIdentity);
          const existing = yield* tx.execute<Row>({
            label: "media-outbox.existing",
            text: `SELECT * FROM media_submission_outbox WHERE effect_identity = $1 FOR UPDATE`,
            values: [input.effectIdentity],
            readonly: false,
          });
          if (existing.rows.length > 1)
            return yield* Effect.fail(fail("enqueue", "invalid-row", input.outboxEventId));
          if (existing.rows.length === 1) {
            const current = record(existing.rows[0] as Row, "enqueue");
            if (
              current.outboxEventId !== input.outboxEventId ||
              current.submissionId !== input.submissionId ||
              current.operationId !== input.operationId ||
              current.creationRevision !== input.creationRevision ||
              current.workflowRevision !== input.workflowRevision ||
              current.workflowInstanceId !== input.workflowInstanceId ||
              current.eventType !== input.eventType ||
              JSON.stringify(current.payload) !== JSON.stringify(input.payload)
            )
              return yield* Effect.fail(fail("enqueue", "identity-conflict", input.outboxEventId));
            return { kind: "replay" as const, outboxEventId: current.outboxEventId };
          }
          const result = yield* tx.execute({
            label: "media-outbox.insert",
            text: `INSERT INTO media_submission_outbox (outbox_event_id, submission_id, operation_id, creation_revision, workflow_revision, workflow_instance_id, event_type, effect_identity, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            values: [
              input.outboxEventId,
              input.submissionId,
              input.operationId,
              input.creationRevision,
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
          return { kind: "created" as const, outboxEventId: input.outboxEventId };
        }),
      );
    });
  const get: MediaOutboxStore["get"] = (id) =>
    Effect.gen(function* () {
      if (!validId(id)) return yield* Effect.fail(fail("get", "invalid-input", id));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-outbox.get",
        text: "SELECT * FROM media_submission_outbox WHERE outbox_event_id = $1",
        values: [id],
        readonly: true,
      });
      if (result.rows.length > 1) return yield* Effect.fail(fail("get", "invalid-row", id));
      return result.rows.length === 0 ? null : record(result.rows[0] as Row, "get");
    });
  const claim: MediaOutboxStore["claim"] = (input) =>
    Effect.gen(function* () {
      if (
        !validId(input.outboxEventId) ||
        !Number.isSafeInteger(input.workflowRevision) ||
        input.workflowRevision < 1
      )
        return yield* Effect.fail(fail("claim", "invalid-input", input.outboxEventId));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          const result = yield* tx.execute<Row>({
            label: "media-outbox.claim",
            text: `UPDATE media_submission_outbox SET state = 'claimed', delivery_attempts = delivery_attempts + 1, claimed_at = clock_timestamp() WHERE outbox_event_id = $1 AND workflow_revision = $2 AND state = ANY($3::text[]) RETURNING *`,
            values: [
              input.outboxEventId,
              input.workflowRevision,
              [input.expectedState ?? "pending", "failed"],
            ],
            readonly: false,
          });
          return result.rows.length === 0 ? null : record(result.rows[0] as Row, "claim");
        }),
      );
    });
  const complete = (
    operation: "deliver" | "fail",
    state: "delivered" | "failed",
    input: {
      readonly outboxEventId: string;
      readonly workflowRevision: number;
      readonly workflowInstanceId: string;
    },
  ) =>
    Effect.gen(function* () {
      if (
        !validId(input.outboxEventId) ||
        !validId(input.workflowInstanceId) ||
        !Number.isSafeInteger(input.workflowRevision) ||
        input.workflowRevision < 1
      )
        return yield* Effect.fail(fail(operation, "invalid-input", input.outboxEventId));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* lock(tx, input.outboxEventId);
          const result = yield* tx.execute({
            label: `media-outbox.${operation}`,
            text: `UPDATE media_submission_outbox SET state = $1, delivered_at = CASE WHEN $1 = 'delivered' THEN clock_timestamp() ELSE NULL END WHERE outbox_event_id = $2 AND workflow_revision = $3 AND workflow_instance_id = $4 AND state = 'claimed'`,
            values: [state, input.outboxEventId, input.workflowRevision, input.workflowInstanceId],
            readonly: false,
          });
          return result.rowCount === 1;
        }),
      );
    });
  return {
    enqueue,
    get,
    claim,
    markDelivered: (input) => complete("deliver", "delivered", input),
    markFailed: (input) => complete("fail", "failed", input),
  };
}

export const makeMediaOutboxRepository = makeControlPlaneMediaOutboxRepository;
export const makeControlPlaneMediaOutboxStore = makeControlPlaneMediaOutboxRepository;
