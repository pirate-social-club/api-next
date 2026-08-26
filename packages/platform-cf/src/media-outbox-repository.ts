import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Data, Effect } from "effect";
import {
  deterministicMediaWorkflowInstanceId,
  type MediaOutboxPayload,
} from "../../domain/src/media-submission.ts";

type Row = Readonly<Record<string, unknown>>;
type EventType =
  | "analysis_launch"
  | "decision_wakeup"
  | "publication"
  | "alignment"
  | "workflow_replacement";
const ID = /^\S(?:.*\S)?$/u;
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 512 && !value.includes("\u0000") && ID.test(value);
const integer = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const decoded = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};
const keys = (value: Record<string, unknown>) => Object.keys(value).sort().join(",");
const payloadFor = (value: unknown, kind: EventType): MediaOutboxPayload | null => {
  const object = decoded(value);
  if (object === null) return null;
  const expected =
    kind === "analysis_launch"
      ? "analysis_revision,audio_revision,kind,operation_id,submission_id,workflow_instance_id,workflow_revision"
      : kind === "decision_wakeup"
        ? "creation_revision,kind,lyrics_revision,operation_id,submission_id,trigger,workflow_instance_id,workflow_revision"
        : kind === "workflow_replacement"
          ? "kind,operation_id,replacement_sequence,submission_id,workflow_instance_id,workflow_revision"
          : kind === "publication"
            ? "creation_revision,kind,lyrics_revision,operation_id,submission_id,workflow_instance_id,workflow_revision"
            : "kind,lyrics_revision,operation_id,post_id,submission_id,workflow_instance_id,workflow_revision";
  if (
    keys(object) !== expected ||
    object.kind !== kind ||
    !validId(object.submission_id) ||
    !validId(object.operation_id) ||
    !validId(object.workflow_instance_id)
  )
    return null;
  if (
    kind === "analysis_launch" &&
    ![object.audio_revision, object.analysis_revision, object.workflow_revision].every(
      (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
    )
  )
    return null;
  if (
    kind === "alignment" &&
    (!validId(object.post_id) ||
      !Number.isSafeInteger(object.workflow_revision) ||
      (object.workflow_revision as number) < 1)
  )
    return null;
  if (
    kind === "decision_wakeup" &&
    (!Number.isSafeInteger(object.creation_revision) ||
      (object.creation_revision as number) < 1 ||
      (object.lyrics_revision !== null &&
        (!Number.isSafeInteger(object.lyrics_revision) ||
          (object.lyrics_revision as number) < 1)) ||
      !["terms", "lyrics"].includes(String(object.trigger)))
  )
    return null;
  if (
    kind === "workflow_replacement" &&
    (!Number.isSafeInteger(object.replacement_sequence) ||
      (object.replacement_sequence as number) < 1)
  )
    return null;
  if (
    kind === "publication" &&
    (!Number.isSafeInteger(object.creation_revision) || (object.creation_revision as number) < 1)
  )
    return null;
  if (
    (kind === "publication" || kind === "alignment") &&
    object.lyrics_revision !== null &&
    (!Number.isSafeInteger(object.lyrics_revision) || (object.lyrics_revision as number) < 1)
  )
    return null;
  return object as unknown as MediaOutboxPayload;
};
const payloadMatchesInput = (
  payload: MediaOutboxPayload,
  input: MediaOutboxEnqueueInput,
): boolean =>
  payload.submission_id === input.submissionId &&
  payload.operation_id === input.operationId &&
  payload.workflow_instance_id === input.workflowInstanceId &&
  payload.workflow_revision === input.workflowRevision &&
  (payload.kind === "analysis_launch"
    ? payload.audio_revision === input.audioRevision &&
      payload.analysis_revision === input.analysisRevision
    : payload.kind === "decision_wakeup"
      ? payload.creation_revision === input.creationRevision &&
        payload.lyrics_revision === input.lyricsRevision
      : payload.kind === "workflow_replacement"
        ? payload.replacement_sequence === input.replacementSequence
        : payload.kind === "publication"
          ? payload.creation_revision === input.creationRevision &&
            payload.lyrics_revision === input.lyricsRevision
          : validId(input.postId) &&
            payload.post_id === input.postId &&
            payload.lyrics_revision === input.lyricsRevision);

export class MediaOutboxRepositoryError extends Data.TaggedError("MediaOutboxRepositoryError")<{
  readonly operation: "enqueue" | "get" | "list" | "claim" | "deliver" | "fail";
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
  actorUserId: string;
  personaId?: string;
  operationId: string;
  creationRevision: number;
  audioRevision: number;
  analysisRevision: number;
  lyricsRevision: number | null;
  workflowRevision: number;
  workflowInstanceId: string;
  eventType: EventType;
  effectIdentity: string;
  payload: MediaOutboxPayload;
  state: "pending" | "running" | "delivered" | "failed" | "exhausted";
  deliveryAttempts: number;
  claimOwner: string | null;
  claimFence: number;
}>;
export type MediaOutboxEnqueueInput = Readonly<{
  outboxEventId: string;
  submissionId: string;
  communityId: string;
  actorUserId: string;
  personaId?: string;
  operationId: string;
  creationRevision: number;
  audioRevision: number;
  analysisRevision: number;
  lyricsRevision: number | null;
  workflowRevision: number;
  workflowInstanceId: string;
  eventType: EventType;
  effectIdentity: string;
  postId?: string;
  replacementSequence?: number;
  payload: MediaOutboxPayload;
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
export type MediaOutboxFailureCode =
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_invalid";
export type MediaOutboxStore = {
  enqueue(
    input: MediaOutboxEnqueueInput,
  ): Effect.Effect<
    { readonly kind: "created" | "replay"; readonly outboxEventId: string },
    MediaOutboxRepositoryFailure,
    ControlPlaneDb
  >;
  get(
    outboxEventId: string,
  ): Effect.Effect<MediaOutboxRecord | null, MediaOutboxRepositoryFailure, ControlPlaneDb>;
  listEligible(
    limit: number,
  ): Effect.Effect<readonly MediaOutboxRecord[], MediaOutboxRepositoryFailure, ControlPlaneDb>;
  claim(
    input: MediaOutboxClaimInput,
  ): Effect.Effect<MediaOutboxRecord | null, MediaOutboxRepositoryFailure, ControlPlaneDb>;
  markDelivered(
    input: MediaOutboxCompletionInput,
  ): Effect.Effect<boolean, MediaOutboxRepositoryFailure, ControlPlaneDb>;
  markFailed(
    input: MediaOutboxCompletionInput & {
      failureCode: MediaOutboxFailureCode;
      nextEligibleAt: string;
    },
  ): Effect.Effect<boolean, MediaOutboxRepositoryFailure, ControlPlaneDb>;
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
  const creationRevision = integer(row.creation_revision),
    audioRevision = integer(row.audio_revision),
    analysisRevision = integer(row.analysis_revision),
    lyricsRevision = row.lyrics_revision === null ? null : integer(row.lyrics_revision),
    workflowRevision = integer(row.workflow_revision),
    attempts = integer(row.delivery_attempts),
    fence = integer(row.claim_fence);
  const eventType = String(row.event_type) as EventType;
  const payload = payloadFor(row.payload, eventType);
  if (
    ![
      row.outbox_event_id,
      row.submission_id,
      row.community_id,
      row.actor_user_id,
      row.operation_id,
      row.workflow_instance_id,
      row.effect_identity,
    ].every(validId) ||
    creationRevision === null ||
    creationRevision < 1 ||
    audioRevision === null ||
    audioRevision < 1 ||
    analysisRevision === null ||
    analysisRevision < 0 ||
    workflowRevision === null ||
    workflowRevision < 1 ||
    row.workflow_instance_id !==
      deterministicMediaWorkflowInstanceId(String(row.operation_id), workflowRevision) ||
    ![
      "analysis_launch",
      "decision_wakeup",
      "publication",
      "alignment",
      "workflow_replacement",
    ].includes(eventType) ||
    (row.lyrics_revision !== null && lyricsRevision === null) ||
    payload === null ||
    payload.submission_id !== row.submission_id ||
    payload.operation_id !== row.operation_id ||
    payload.workflow_revision !== workflowRevision ||
    payload.workflow_instance_id !== row.workflow_instance_id ||
    (payload.kind === "analysis_launch" &&
      (payload.audio_revision !== audioRevision ||
        payload.analysis_revision !== analysisRevision)) ||
    attempts === null ||
    attempts < 0 ||
    attempts > 3 ||
    fence === null ||
    fence < 0 ||
    !["pending", "running", "delivered", "failed", "exhausted"].includes(String(row.state)) ||
    (row.claim_owner !== null && !validId(row.claim_owner))
  )
    throw fail(
      operation,
      "invalid-row",
      typeof row.outbox_event_id === "string" ? row.outbox_event_id : undefined,
    );
  return {
    outboxEventId: row.outbox_event_id as string,
    submissionId: row.submission_id as string,
    communityId: row.community_id as string,
    actorUserId: row.actor_user_id as string,
    ...(validId(row.author_persona_id) ? { personaId: row.author_persona_id as string } : {}),
    operationId: row.operation_id as string,
    creationRevision,
    audioRevision,
    analysisRevision,
    lyricsRevision,
    workflowRevision,
    workflowInstanceId: row.workflow_instance_id as string,
    eventType,
    effectIdentity: row.effect_identity as string,
    payload,
    state: row.state as MediaOutboxRecord["state"],
    deliveryAttempts: attempts,
    claimOwner: row.claim_owner as string | null,
    claimFence: fence,
  };
}
const decode = (row: Row, operation: MediaOutboxRepositoryError["operation"], id?: string) =>
  Effect.try({
    try: () => decodeRecord(row, operation),
    catch: (error) =>
      error instanceof MediaOutboxRepositoryError ? error : fail(operation, "invalid-row", id),
  });

export function makeControlPlaneMediaOutboxRepository(): MediaOutboxStore {
  const enqueue: MediaOutboxStore["enqueue"] = (input) =>
    Effect.gen(function* () {
      const checkedPayload = payloadFor(input.payload, input.eventType);
      if (
        ![
          input.outboxEventId,
          input.submissionId,
          input.communityId,
          input.actorUserId,
          input.operationId,
          input.workflowInstanceId,
          input.effectIdentity,
        ].every(validId) ||
        (input.personaId !== undefined && !validId(input.personaId)) ||
        ![
          input.creationRevision,
          input.audioRevision,
          input.analysisRevision,
          input.workflowRevision,
        ].every((n) => Number.isSafeInteger(n)) ||
        input.creationRevision < 1 ||
        input.audioRevision < 1 ||
        input.analysisRevision < 0 ||
        (input.lyricsRevision !== null &&
          (!Number.isSafeInteger(input.lyricsRevision) || input.lyricsRevision < 1)) ||
        input.workflowRevision < 1 ||
        input.workflowInstanceId !==
          deterministicMediaWorkflowInstanceId(input.operationId, input.workflowRevision) ||
        checkedPayload === null ||
        !payloadMatchesInput(checkedPayload, input)
      )
        return yield* Effect.fail(fail("enqueue", "invalid-input", input.outboxEventId));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* lock(tx, input.effectIdentity);
          const prior = yield* tx.execute<Row>({
            label: "media-outbox.enqueue.replay",
            text: "SELECT * FROM media_submission_outbox WHERE effect_identity=$1 FOR UPDATE",
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
              current.actorUserId !== input.actorUserId ||
              (input.personaId !== undefined && current.personaId !== input.personaId) ||
              current.operationId !== input.operationId ||
              current.creationRevision !== input.creationRevision ||
              current.audioRevision !== input.audioRevision ||
              current.analysisRevision !== input.analysisRevision ||
              current.lyricsRevision !== input.lyricsRevision ||
              current.workflowRevision !== input.workflowRevision ||
              current.eventType !== input.eventType ||
              JSON.stringify(current.payload) !== JSON.stringify(input.payload)
            )
              return yield* Effect.fail(fail("enqueue", "identity-conflict", input.outboxEventId));
            return { kind: "replay", outboxEventId: current.outboxEventId } as const;
          }
          const result = yield* tx.execute({
            label: "media-outbox.enqueue",
            text: "INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,operation_id,creation_revision,audio_revision,analysis_revision,lyrics_revision,workflow_revision,workflow_instance_id,event_type,effect_identity,payload,author_persona_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)",
            values: [
              input.outboxEventId,
              input.submissionId,
              input.communityId,
              input.actorUserId,
              input.operationId,
              input.creationRevision,
              input.audioRevision,
              input.analysisRevision,
              input.lyricsRevision,
              input.workflowRevision,
              input.workflowInstanceId,
              input.eventType,
              input.effectIdentity,
              JSON.stringify(input.payload),
              input.personaId ?? null,
            ],
            readonly: false,
          });
          if (result.rowCount !== 1)
            return yield* Effect.fail(fail("enqueue", "identity-conflict", input.outboxEventId));
          return { kind: "created", outboxEventId: input.outboxEventId } as const;
        }),
      );
    });
  const get: MediaOutboxStore["get"] = (id) =>
    Effect.gen(function* () {
      if (!validId(id)) return yield* Effect.fail(fail("get", "invalid-input", id));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-outbox.get",
        text: "SELECT * FROM media_submission_outbox WHERE outbox_event_id=$1",
        values: [id],
        readonly: true,
      });
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) return yield* Effect.fail(fail("get", "invalid-row", id));
      return yield* decode(result.rows[0] as Row, "get", id);
    });
  const listEligible: MediaOutboxStore["listEligible"] = (limit) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return yield* Effect.fail(fail("list", "invalid-input"));
      }
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-outbox.list-eligible",
        text: "SELECT * FROM media_submission_outbox WHERE delivery_attempts < 3 AND (state='pending' OR (state='failed' AND next_eligible_at<=clock_timestamp()) OR (state='running' AND lease_expires_at<=clock_timestamp())) ORDER BY created_at,outbox_event_id LIMIT $1",
        values: [limit],
        readonly: true,
      });
      return yield* Effect.forEach(result.rows, (row) => decode(row, "list"));
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
        input.leaseSeconds > 3600
      )
        return yield* Effect.fail(fail("claim", "invalid-input", input.outboxEventId));
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "media-outbox.claim",
        text: "UPDATE media_submission_outbox SET state='running',delivery_attempts=CASE WHEN delivery_attempts < 3 THEN delivery_attempts+1 ELSE delivery_attempts END,claim_owner=$1,claim_fence=claim_fence+1,lease_expires_at=clock_timestamp()+make_interval(secs=>$2),next_eligible_at=NULL,failure_code=NULL,updated_at=clock_timestamp() WHERE outbox_event_id=$3 AND workflow_revision=$4 AND ((state='pending') OR (state='failed' AND delivery_attempts < 3 AND next_eligible_at<=clock_timestamp()) OR (state='running' AND lease_expires_at<=clock_timestamp())) RETURNING *",
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
        text: "UPDATE media_submission_outbox SET state='delivered',claim_owner=NULL,lease_expires_at=NULL,delivered_at=clock_timestamp(),failure_code=NULL,next_eligible_at=NULL,updated_at=clock_timestamp() WHERE outbox_event_id=$1 AND workflow_revision=$2 AND workflow_instance_id=$3 AND state='running' AND claim_owner=$4 AND claim_fence=$5 AND lease_expires_at>clock_timestamp()",
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
        text: "UPDATE media_submission_outbox SET state=CASE WHEN delivery_attempts >= 3 THEN 'exhausted' ELSE 'failed' END,claim_owner=NULL,lease_expires_at=NULL,failure_code=$1,next_eligible_at=CASE WHEN delivery_attempts >= 3 THEN NULL ELSE $2::timestamptz END,updated_at=clock_timestamp() WHERE outbox_event_id=$3 AND workflow_revision=$4 AND workflow_instance_id=$5 AND state='running' AND claim_owner=$6 AND claim_fence=$7 AND lease_expires_at>clock_timestamp()",
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
  return { enqueue, get, listEligible, claim, markDelivered, markFailed };
}
