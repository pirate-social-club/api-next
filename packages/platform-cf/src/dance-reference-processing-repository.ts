import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  type DanceReferenceOutcome,
  type DanceReferenceProcessingBinding,
  type DanceReferenceProcessingClaim,
  type DanceReferenceProcessingClaimResult,
  type DanceReferenceProcessingStore,
  type FrozenDanceReferenceInput,
  freezeDanceReferenceInput,
  freezePreparedDanceReferenceOperation,
  type PreparedDanceReferenceOperation,
} from "@pirate/application/dance/reference-processing";
import type {
  DanceReferenceWakeupRecord,
  DanceReferenceWakeupStore,
} from "@pirate/application/dance/reference-processing-wakeup";
import { Data, Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;
type TerminalOutcome = Exclude<DanceReferenceOutcome, { readonly status: "pending" }>;

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value === value.trim() &&
  !value.includes("\u0000");
const integer = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const bytesText = (value: unknown): string | null =>
  value instanceof Uint8Array ? new TextDecoder().decode(value) : null;

export class DanceReferenceProcessingRepositoryError extends Data.TaggedError(
  "DanceReferenceProcessingRepositoryError",
)<{
  readonly operation: "claim" | "prepare" | "complete" | "wakeup";
  readonly reason: "invalid-input" | "invalid-row" | "identity-conflict" | "unavailable";
}> {}

type RepositoryFailure = DanceReferenceProcessingRepositoryError | ControlPlaneError;
class DanceReferenceClaimBusy extends Data.TaggedError("DanceReferenceClaimBusy")<{
  readonly reason: "busy";
}> {}
const fail = (
  operation: DanceReferenceProcessingRepositoryError["operation"],
  reason: DanceReferenceProcessingRepositoryError["reason"],
) => new DanceReferenceProcessingRepositoryError({ operation, reason });
const lock = (tx: ControlPlaneTransaction, value: string) =>
  tx.execute({
    label: "dance-reference-processing.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    values: [value],
    readonly: false,
  });

async function decodeRequest(row: Row): Promise<
  Readonly<{
    readonly frozenInput: FrozenDanceReferenceInput;
    readonly canonicalRequest: string;
    readonly inputDigest: string;
  }>
> {
  const storedCanonical = bytesText(row.canonical_request);
  if (storedCanonical === null || typeof row.input_digest !== "string") {
    throw fail("claim", "invalid-row");
  }
  const decoded = await freezeDanceReferenceInput(row.request_material);
  if (decoded.canonicalRequest !== storedCanonical || decoded.inputDigest !== row.input_digest) {
    throw fail("claim", "invalid-row");
  }
  return decoded;
}

async function decodePreparedRow(row: Row): Promise<PreparedDanceReferenceOperation | null> {
  if (
    row.prepared_operation === null &&
    row.prepared_operation_bytes === null &&
    row.prepared_operation_sha256 === null
  ) {
    return null;
  }
  const canonical = bytesText(row.prepared_operation_bytes);
  if (canonical === null || typeof row.prepared_operation_sha256 !== "string") {
    throw fail("claim", "invalid-row");
  }
  const decoded = await freezePreparedDanceReferenceOperation(row.prepared_operation);
  if (
    decoded.canonicalOperation !== canonical ||
    decoded.operationDigest !== row.prepared_operation_sha256
  ) {
    throw fail("claim", "invalid-row");
  }
  return decoded.operation;
}

function exactRequest(
  stored: Readonly<{ canonicalRequest: string; inputDigest: string }>,
  provided: Readonly<{ canonicalRequest: string; inputDigest: string }>,
): boolean {
  return (
    stored.canonicalRequest === provided.canonicalRequest &&
    stored.inputDigest === provided.inputDigest
  );
}

const wakeupStates = new Set(["pending", "running", "delivered", "failed", "exhausted"]);
const revisionStates = new Set(["processing", "ready", "processing_failed", "disabled", "retired"]);

function decodeWakeupRow(row: Row): DanceReferenceWakeupRecord {
  const choreographyRevision = integer(row.revision);
  const deliveryAttempts = integer(row.delivery_attempts);
  const claimFence = integer(row.claim_fence);
  if (
    !validId(row.outbox_event_id) ||
    !validId(row.choreography_id) ||
    choreographyRevision === null ||
    choreographyRevision < 1 ||
    !validId(row.effect_identity) ||
    typeof row.revision_status !== "string" ||
    !revisionStates.has(row.revision_status) ||
    typeof row.state !== "string" ||
    !wakeupStates.has(row.state) ||
    deliveryAttempts === null ||
    deliveryAttempts < 0 ||
    deliveryAttempts > 3 ||
    claimFence === null ||
    claimFence < 0 ||
    typeof row.eligible !== "boolean"
  ) {
    throw fail("wakeup", "invalid-row");
  }
  return Object.freeze({
    outboxId: row.outbox_event_id,
    choreographyId: row.choreography_id,
    choreographyRevision,
    effectIdentity: row.effect_identity,
    revisionStatus: row.revision_status as DanceReferenceWakeupRecord["revisionStatus"],
    state: row.state as DanceReferenceWakeupRecord["state"],
    deliveryAttempts,
    claimFence,
    eligible: row.eligible,
  });
}

export type DanceReferenceProcessingStoreOptions = Readonly<{
  readonly retryBaseMs?: number;
}>;

export function makeDanceReferenceProcessingStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: DanceReferenceProcessingStoreOptions = {},
): DanceReferenceProcessingStore & DanceReferenceWakeupStore {
  const retryBaseMs = options.retryBaseMs ?? 15_000;
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>): Promise<A> =>
    Effect.runPromise(Effect.provide(runtime)(effect));

  const claim: DanceReferenceProcessingStore["claim"] = async (input) => {
    if (
      !validId(input.choreographyId) ||
      !validId(input.workerId) ||
      !validId(input.adapterId) ||
      !validId(input.adapterRevision) ||
      !Number.isSafeInteger(input.choreographyRevision) ||
      input.choreographyRevision < 1 ||
      !Number.isSafeInteger(input.leaseSeconds) ||
      input.leaseSeconds < 1 ||
      input.leaseSeconds > 3_600 ||
      (input.resume !== undefined &&
        (!Number.isSafeInteger(input.resume.claimFence) ||
          input.resume.claimFence < 1 ||
          !Number.isSafeInteger(input.resume.outboxClaimFence) ||
          input.resume.outboxClaimFence < 1))
    ) {
      throw fail("claim", "invalid-input");
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* lock(
              tx,
              `dance-reference:${input.choreographyId}:${input.choreographyRevision}`,
            );
            let requestRows = yield* tx.execute<Row>({
              label: "dance-reference-processing.request.get",
              text: "SELECT request_material,canonical_request,input_digest FROM dance_reference_processing_requests WHERE choreography_id=$1 AND revision=$2 FOR UPDATE",
              values: [input.choreographyId, input.choreographyRevision],
              readonly: false,
            });
            if (requestRows.rows.length > 1) {
              return yield* Effect.fail(fail("claim", "invalid-row"));
            }
            if (requestRows.rows.length === 0) {
              if (input.request === undefined) {
                return yield* Effect.fail(fail("claim", "unavailable"));
              }
              const inserted = yield* tx.execute<Row>({
                label: "dance-reference-processing.request.insert",
                text: "INSERT INTO dance_reference_processing_requests (choreography_id,revision,effect_identity,request_material,canonical_request,input_digest) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING request_material,canonical_request,input_digest",
                values: [
                  input.choreographyId,
                  input.choreographyRevision,
                  input.request.frozenInput.effectIdentity,
                  JSON.stringify(input.request.frozenInput),
                  new TextEncoder().encode(input.request.canonicalRequest),
                  input.request.inputDigest,
                ],
                readonly: false,
              });
              if (inserted.rows.length !== 1) {
                return yield* Effect.fail(fail("claim", "identity-conflict"));
              }
              requestRows = inserted;
            }
            const request = yield* Effect.tryPromise({
              try: () => decodeRequest(requestRows.rows[0] as Row),
              catch: () => fail("claim", "invalid-row"),
            });
            if (input.request !== undefined && !exactRequest(request, input.request)) {
              return yield* Effect.fail(fail("claim", "identity-conflict"));
            }
            if (
              request.frozenInput.choreographyId !== input.choreographyId ||
              request.frozenInput.choreographyRevision !== input.choreographyRevision
            ) {
              return yield* Effect.fail(fail("claim", "invalid-row"));
            }

            const target = yield* tx.execute<Row>({
              label: "dance-reference-processing.target",
              text: "SELECT status FROM dance_choreography_revisions WHERE choreography_id=$1 AND revision=$2 FOR UPDATE",
              values: [input.choreographyId, input.choreographyRevision],
              readonly: false,
            });
            if (target.rows.length !== 1) {
              return yield* Effect.fail(fail("claim", "unavailable"));
            }
            const status = target.rows[0]?.status;
            if (status === "ready" || status === "processing_failed") {
              return {
                kind: "terminal",
                status,
              } satisfies DanceReferenceProcessingClaimResult;
            }
            if (status !== "processing") return { kind: "busy" } as const;

            const outbox =
              input.resume === undefined
                ? yield* tx.execute<Row>({
                    label: "dance-reference-processing.outbox.claim",
                    text: "UPDATE dance_reference_outbox SET state='running',delivery_attempts=delivery_attempts+1,claim_owner=$1,claim_fence=claim_fence+1,lease_expires_at=clock_timestamp()+make_interval(secs=>$2),next_eligible_at=NULL,failure_code=NULL,updated_at=clock_timestamp() WHERE choreography_id=$3 AND revision=$4 AND delivery_attempts<3 AND (state='pending' OR (state='failed' AND next_eligible_at<=clock_timestamp()) OR (state='running' AND lease_expires_at<=clock_timestamp())) RETURNING outbox_event_id,effect_identity,claim_fence",
                    values: [
                      input.workerId,
                      input.leaseSeconds,
                      input.choreographyId,
                      input.choreographyRevision,
                    ],
                    readonly: false,
                  })
                : yield* tx.execute<Row>({
                    label: "dance-reference-processing.outbox.renew",
                    text: "UPDATE dance_reference_outbox SET lease_expires_at=clock_timestamp()+make_interval(secs=>$1),updated_at=clock_timestamp() WHERE choreography_id=$2 AND revision=$3 AND state='running' AND claim_owner=$4 AND claim_fence=$5 AND lease_expires_at>clock_timestamp() RETURNING outbox_event_id,effect_identity,claim_fence",
                    values: [
                      input.leaseSeconds,
                      input.choreographyId,
                      input.choreographyRevision,
                      input.workerId,
                      input.resume.outboxClaimFence,
                    ],
                    readonly: false,
                  });
            if (outbox.rows.length === 0) {
              if (input.resume !== undefined) {
                return yield* Effect.fail(new DanceReferenceClaimBusy({ reason: "busy" }));
              }
              return { kind: "busy" } as const;
            }
            if (
              outbox.rows.length !== 1 ||
              outbox.rows[0]?.effect_identity !== request.frozenInput.effectIdentity
            ) {
              return yield* Effect.fail(fail("claim", "invalid-row"));
            }
            const outboxClaimFence = integer(outbox.rows[0]?.claim_fence);
            if (outboxClaimFence === null) {
              return yield* Effect.fail(fail("claim", "invalid-row"));
            }

            const latest = yield* tx.execute<Row>({
              label: "dance-reference-processing.attempt.latest",
              text: "SELECT * FROM dance_reference_processing_attempts WHERE choreography_id=$1 AND revision=$2 ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE",
              values: [input.choreographyId, input.choreographyRevision],
              readonly: false,
            });
            let attempt: Row;
            if (input.resume !== undefined) {
              if (latest.rows.length !== 1) {
                return yield* Effect.fail(new DanceReferenceClaimBusy({ reason: "busy" }));
              }
              const prior = latest.rows[0] as Row;
              if (
                prior.adapter_id !== input.adapterId ||
                prior.adapter_revision !== input.adapterRevision ||
                prior.input_digest !== request.inputDigest
              ) {
                return yield* Effect.fail(fail("claim", "identity-conflict"));
              }
              const renewed = yield* tx.execute<Row>({
                label: "dance-reference-processing.attempt.renew",
                text: "UPDATE dance_reference_processing_attempts SET lease_expires_at=clock_timestamp()+make_interval(secs=>$1),updated_at=clock_timestamp() WHERE processing_attempt_id=$2 AND state='leased' AND lease_owner=$3 AND lease_fence=$4 AND lease_expires_at>clock_timestamp() RETURNING *",
                values: [
                  input.leaseSeconds,
                  prior.processing_attempt_id,
                  input.workerId,
                  input.resume.claimFence,
                ],
                readonly: false,
              });
              if (renewed.rows.length !== 1) {
                return yield* Effect.fail(new DanceReferenceClaimBusy({ reason: "busy" }));
              }
              attempt = renewed.rows[0] as Row;
            } else if (latest.rows.length === 0) {
              const attemptId = `dance-processing-${request.inputDigest.slice(0, 32)}-a1`;
              const inserted = yield* tx.execute<Row>({
                label: "dance-reference-processing.attempt.insert",
                text: "INSERT INTO dance_reference_processing_attempts (processing_attempt_id,choreography_id,revision,attempt_number,adapter_id,adapter_revision,input_digest,lease_owner,lease_fence,lease_expires_at,created_at,updated_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,1,clock_timestamp()+make_interval(secs=>$8),clock_timestamp(),clock_timestamp()) RETURNING *",
                values: [
                  attemptId,
                  input.choreographyId,
                  input.choreographyRevision,
                  input.adapterId,
                  input.adapterRevision,
                  request.inputDigest,
                  input.workerId,
                  input.leaseSeconds,
                ],
                readonly: false,
              });
              if (inserted.rows.length !== 1) {
                return yield* Effect.fail(fail("claim", "identity-conflict"));
              }
              attempt = inserted.rows[0] as Row;
            } else {
              if (latest.rows.length !== 1) {
                return yield* Effect.fail(fail("claim", "invalid-row"));
              }
              const prior = latest.rows[0] as Row;
              const priorNumber = integer(prior.attempt_number);
              if (
                priorNumber === null ||
                prior.adapter_id !== input.adapterId ||
                prior.adapter_revision !== input.adapterRevision ||
                prior.input_digest !== request.inputDigest
              ) {
                return yield* Effect.fail(fail("claim", "identity-conflict"));
              }
              if (prior.state === "leased") {
                const reclaimed = yield* tx.execute<Row>({
                  label: "dance-reference-processing.attempt.reclaim",
                  text: "UPDATE dance_reference_processing_attempts SET lease_owner=$1,lease_fence=lease_fence+1,lease_expires_at=clock_timestamp()+make_interval(secs=>$2),updated_at=clock_timestamp() WHERE processing_attempt_id=$3 AND state='leased' AND lease_expires_at<=clock_timestamp() RETURNING *",
                  values: [input.workerId, input.leaseSeconds, prior.processing_attempt_id],
                  readonly: false,
                });
                if (reclaimed.rows.length !== 1) {
                  return yield* Effect.fail(new DanceReferenceClaimBusy({ reason: "busy" }));
                }
                attempt = reclaimed.rows[0] as Row;
              } else if (prior.state === "failed" && prior.retryable === true && priorNumber < 3) {
                const nextNumber = priorNumber + 1;
                const attemptId = `dance-processing-${request.inputDigest.slice(0, 32)}-a${nextNumber}`;
                const inserted = yield* tx.execute<Row>({
                  label: "dance-reference-processing.attempt.retry",
                  text: "INSERT INTO dance_reference_processing_attempts (processing_attempt_id,choreography_id,revision,attempt_number,adapter_id,adapter_revision,input_digest,lease_owner,lease_fence,lease_expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,clock_timestamp()+make_interval(secs=>$9),clock_timestamp(),clock_timestamp()) RETURNING *",
                  values: [
                    attemptId,
                    input.choreographyId,
                    input.choreographyRevision,
                    nextNumber,
                    input.adapterId,
                    input.adapterRevision,
                    request.inputDigest,
                    input.workerId,
                    input.leaseSeconds,
                  ],
                  readonly: false,
                });
                if (inserted.rows.length !== 1) {
                  return yield* Effect.fail(fail("claim", "identity-conflict"));
                }
                attempt = inserted.rows[0] as Row;
              } else {
                return yield* Effect.fail(new DanceReferenceClaimBusy({ reason: "busy" }));
              }
            }
            const attemptNumber = integer(attempt.attempt_number);
            const claimFence = integer(attempt.lease_fence);
            if (
              attemptNumber === null ||
              attemptNumber < 1 ||
              attemptNumber > 3 ||
              claimFence === null ||
              !validId(attempt.lease_owner)
            ) {
              return yield* Effect.fail(fail("claim", "invalid-row"));
            }
            if (
              input.resume !== undefined &&
              (claimFence !== input.resume.claimFence ||
                outboxClaimFence !== input.resume.outboxClaimFence)
            ) {
              return yield* Effect.fail(new DanceReferenceClaimBusy({ reason: "busy" }));
            }
            const binding: DanceReferenceProcessingBinding = {
              version: "dance-reference-processing-binding-v1",
              effectIdentity: request.frozenInput.effectIdentity,
              requestId: `${request.frozenInput.effectIdentity}-a${attemptNumber}`,
              choreographyId: input.choreographyId,
              choreographyRevision: input.choreographyRevision,
              attemptNumber,
              inputDigest: request.inputDigest,
              adapterId: input.adapterId,
              adapterRevision: input.adapterRevision,
            };
            const preparedOperation = yield* Effect.tryPromise({
              try: () => decodePreparedRow(attempt),
              catch: () => fail("claim", "invalid-row"),
            });
            const claimValue: DanceReferenceProcessingClaim = {
              ...request,
              binding,
              claimOwner: attempt.lease_owner,
              claimFence,
              outboxClaimFence,
              preparedOperation,
            };
            return { kind: "claimed", claim: claimValue } as const;
          }),
        );
      }).pipe(
        Effect.catchTag("DanceReferenceClaimBusy", () => Effect.succeed({ kind: "busy" } as const)),
      ),
    );
  };

  const recordPrepared: DanceReferenceProcessingStore["recordPrepared"] = async (
    claimValue,
    operation,
  ) => {
    const frozen = await freezePreparedDanceReferenceOperation(operation);
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "dance-reference-processing.attempt.prepare",
          text: "UPDATE dance_reference_processing_attempts SET prepared_operation=$1::jsonb,prepared_operation_bytes=$2,prepared_operation_sha256=$3,updated_at=clock_timestamp() WHERE choreography_id=$4 AND revision=$5 AND attempt_number=$6 AND input_digest=$7 AND state='leased' AND lease_owner=$8 AND lease_fence=$9 AND lease_expires_at>clock_timestamp() AND prepared_operation IS NULL RETURNING processing_attempt_id",
          values: [
            JSON.stringify(frozen.operation),
            new TextEncoder().encode(frozen.canonicalOperation),
            frozen.operationDigest,
            claimValue.binding.choreographyId,
            claimValue.binding.choreographyRevision,
            claimValue.binding.attemptNumber,
            claimValue.inputDigest,
            claimValue.claimOwner,
            claimValue.claimFence,
          ],
          readonly: false,
        });
        if (result.rows.length === 1) return true;
        const replay = yield* db.execute<Row>({
          label: "dance-reference-processing.attempt.prepare-replay",
          text: "SELECT prepared_operation_sha256 FROM dance_reference_processing_attempts WHERE choreography_id=$1 AND revision=$2 AND attempt_number=$3 AND input_digest=$4 AND state='leased' AND lease_owner=$5 AND lease_fence=$6 AND lease_expires_at>clock_timestamp()",
          values: [
            claimValue.binding.choreographyId,
            claimValue.binding.choreographyRevision,
            claimValue.binding.attemptNumber,
            claimValue.inputDigest,
            claimValue.claimOwner,
            claimValue.claimFence,
          ],
          readonly: true,
        });
        return (
          replay.rows.length === 1 &&
          replay.rows[0]?.prepared_operation_sha256 === frozen.operationDigest
        );
      }),
    );
  };

  const complete: DanceReferenceProcessingStore["complete"] = async (claimValue, outcome) =>
    run(completeEffect(claimValue, outcome, retryBaseMs));

  const getWakeup: DanceReferenceWakeupStore["getWakeup"] = async (outboxId) => {
    if (!validId(outboxId)) throw fail("wakeup", "invalid-input");
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "dance-reference-processing.wakeup.get",
          text: `SELECT outbox.outbox_event_id,outbox.choreography_id,outbox.revision::text,
                        outbox.effect_identity,revision.status AS revision_status,outbox.state,
                        outbox.delivery_attempts,outbox.claim_fence::text,
                        (revision.status='processing' AND outbox.delivery_attempts<3 AND
                          (outbox.state='pending'
                            OR (outbox.state='failed' AND outbox.next_eligible_at<=clock_timestamp())
                            OR (outbox.state='running' AND outbox.lease_expires_at<=clock_timestamp())
                          )) AS eligible
                   FROM dance_reference_outbox outbox
                   JOIN dance_choreography_revisions revision
                     ON revision.choreography_id=outbox.choreography_id
                    AND revision.revision=outbox.revision
                  WHERE outbox.outbox_event_id=$1`,
          values: [outboxId],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return yield* Effect.fail(fail("wakeup", "invalid-row"));
        return decodeWakeupRow(result.rows[0] as Row);
      }),
    );
  };

  const listEligibleWakeups: DanceReferenceWakeupStore["listEligibleWakeups"] = async (limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw fail("wakeup", "invalid-input");
    }
    return run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "dance-reference-processing.wakeup.list",
          text: `SELECT outbox.outbox_event_id,outbox.choreography_id,outbox.revision::text,
                        outbox.effect_identity,revision.status AS revision_status,outbox.state,
                        outbox.delivery_attempts,outbox.claim_fence::text,TRUE AS eligible
                   FROM dance_reference_outbox outbox
                   JOIN dance_choreography_revisions revision
                     ON revision.choreography_id=outbox.choreography_id
                    AND revision.revision=outbox.revision
                  WHERE revision.status='processing' AND outbox.delivery_attempts<3
                    AND (outbox.state='pending'
                      OR (outbox.state='failed' AND outbox.next_eligible_at<=clock_timestamp())
                      OR (outbox.state='running' AND outbox.lease_expires_at<=clock_timestamp()))
                  ORDER BY outbox.created_at,outbox.outbox_event_id
                  LIMIT $1`,
          values: [limit],
          readonly: true,
        });
        return result.rows.map(decodeWakeupRow);
      }),
    );
  };

  return { claim, recordPrepared, complete, getWakeup, listEligibleWakeups };
}

function completeEffect(
  claim: DanceReferenceProcessingClaim,
  outcome: TerminalOutcome,
  retryBaseMs: number,
): Effect.Effect<"committed" | "replayed" | "stale", RepositoryFailure, ControlPlaneDb> {
  return Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((tx) =>
      Effect.gen(function* () {
        yield* lock(
          tx,
          `dance-reference:${claim.binding.choreographyId}:${claim.binding.choreographyRevision}`,
        );
        const target = yield* tx.execute<Row>({
          label: "dance-reference-processing.complete.target",
          text: "SELECT status,terminal_evidence_digest FROM dance_choreography_revisions WHERE choreography_id=$1 AND revision=$2 FOR UPDATE",
          values: [claim.binding.choreographyId, claim.binding.choreographyRevision],
          readonly: false,
        });
        if (target.rows.length !== 1) return yield* Effect.fail(fail("complete", "invalid-row"));
        const attempt = yield* tx.execute<Row>({
          label: "dance-reference-processing.complete.attempt",
          text: "SELECT state,lease_owner,lease_fence,lease_expires_at FROM dance_reference_processing_attempts WHERE choreography_id=$1 AND revision=$2 AND attempt_number=$3 FOR UPDATE",
          values: [
            claim.binding.choreographyId,
            claim.binding.choreographyRevision,
            claim.binding.attemptNumber,
          ],
          readonly: false,
        });
        if (
          attempt.rows.length !== 1 ||
          integer(attempt.rows[0]?.lease_fence) !== claim.claimFence
        ) {
          return "stale";
        }
        const outbox = yield* tx.execute<Row>({
          label: "dance-reference-processing.complete.outbox-fence",
          text: "SELECT claim_fence FROM dance_reference_outbox WHERE choreography_id=$1 AND revision=$2 FOR UPDATE",
          values: [claim.binding.choreographyId, claim.binding.choreographyRevision],
          readonly: false,
        });
        if (
          outbox.rows.length !== 1 ||
          integer(outbox.rows[0]?.claim_fence) !== claim.outboxClaimFence
        ) {
          return "stale";
        }
        const expectedDigest =
          outcome.status === "ready"
            ? outcome.evidence.evidenceDigest
            : outcome.status === "rejected"
              ? outcome.evidenceDigest
              : outcome.resultDigest;
        const currentStatus = target.rows[0]?.status;
        if (currentStatus === "ready" || currentStatus === "processing_failed") {
          const expectedStatus = outcome.status === "ready" ? "ready" : "processing_failed";
          return currentStatus === expectedStatus &&
            target.rows[0]?.terminal_evidence_digest === expectedDigest
            ? "replayed"
            : "stale";
        }
        if (currentStatus !== "processing") return "stale";
        if (
          attempt.rows[0]?.state !== "leased" ||
          attempt.rows[0]?.lease_owner !== claim.claimOwner ||
          integer(attempt.rows[0]?.lease_fence) !== claim.claimFence
        ) {
          return "stale";
        }

        if (outcome.status === "retryable_failure") {
          const exhausted = claim.binding.attemptNumber >= 3;
          const attemptResult = yield* tx.execute({
            label: "dance-reference-processing.complete.retryable-attempt",
            text: "UPDATE dance_reference_processing_attempts SET state=$1,lease_owner=NULL,lease_expires_at=NULL,result_digest=$2,private_evidence_ref=$3,failure_code=$4,retryable=$5,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE choreography_id=$6 AND revision=$7 AND attempt_number=$8 AND state='leased' AND lease_owner=$9 AND lease_fence=$10 AND lease_expires_at>clock_timestamp()",
            values: [
              exhausted ? "exhausted" : "failed",
              outcome.resultDigest,
              outcome.evidenceRef,
              outcome.reason,
              !exhausted,
              claim.binding.choreographyId,
              claim.binding.choreographyRevision,
              claim.binding.attemptNumber,
              claim.claimOwner,
              claim.claimFence,
            ],
            readonly: false,
          });
          if (attemptResult.rowCount !== 1) return "stale";
          const outboxResult = yield* tx.execute({
            label: "dance-reference-processing.complete.retryable-outbox",
            text: "UPDATE dance_reference_outbox SET state=CASE WHEN delivery_attempts=3 THEN 'exhausted' ELSE 'failed' END,claim_owner=NULL,lease_expires_at=NULL,next_eligible_at=CASE WHEN delivery_attempts=3 THEN NULL ELSE clock_timestamp()+make_interval(secs=>$1) END,failure_code=$2,updated_at=clock_timestamp() WHERE choreography_id=$3 AND revision=$4 AND state='running' AND claim_owner=$5 AND claim_fence=$6 AND lease_expires_at>clock_timestamp()",
            values: [
              Math.ceil((retryBaseMs * 2 ** (claim.binding.attemptNumber - 1)) / 1_000),
              outcome.reason,
              claim.binding.choreographyId,
              claim.binding.choreographyRevision,
              claim.claimOwner,
              claim.outboxClaimFence,
            ],
            readonly: false,
          });
          if (outboxResult.rowCount !== 1) return "stale";
          if (exhausted) {
            yield* failRevision(tx, claim, expectedDigest, outcome.reason);
          }
          return "committed";
        }

        const attemptResult = yield* tx.execute({
          label: "dance-reference-processing.complete.terminal-attempt",
          text: "UPDATE dance_reference_processing_attempts SET state=$1,lease_owner=NULL,lease_expires_at=NULL,result_digest=$2,private_evidence_ref=$3,failure_code=$4,retryable=FALSE,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE choreography_id=$5 AND revision=$6 AND attempt_number=$7 AND state='leased' AND lease_owner=$8 AND lease_fence=$9 AND lease_expires_at>clock_timestamp()",
          values: [
            outcome.status === "ready" ? "succeeded" : "exhausted",
            outcome.status === "ready" ? outcome.evidence.resultDigest : outcome.resultDigest,
            outcome.status === "ready" ? outcome.evidence.evidenceRef : outcome.evidenceRef,
            outcome.status === "ready" ? null : outcome.reason,
            claim.binding.choreographyId,
            claim.binding.choreographyRevision,
            claim.binding.attemptNumber,
            claim.claimOwner,
            claim.claimFence,
          ],
          readonly: false,
        });
        if (attemptResult.rowCount !== 1) return "stale";
        const outboxResult = yield* tx.execute({
          label: "dance-reference-processing.complete.outbox",
          text: "UPDATE dance_reference_outbox SET state='delivered',claim_owner=NULL,lease_expires_at=NULL,next_eligible_at=NULL,delivered_at=clock_timestamp(),failure_code=NULL,updated_at=clock_timestamp() WHERE choreography_id=$1 AND revision=$2 AND state='running' AND claim_owner=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp()",
          values: [
            claim.binding.choreographyId,
            claim.binding.choreographyRevision,
            claim.claimOwner,
            claim.outboxClaimFence,
          ],
          readonly: false,
        });
        if (outboxResult.rowCount !== 1) return "stale";
        if (outcome.status === "rejected") {
          yield* failRevision(tx, claim, expectedDigest, outcome.reason);
          return "committed";
        }
        yield* readyRevision(tx, claim, outcome);
        return "committed";
      }),
    );
  });
}

function failRevision(
  tx: ControlPlaneTransaction,
  claim: DanceReferenceProcessingClaim,
  evidenceDigest: string,
  failureCode: string,
): Effect.Effect<void, RepositoryFailure> {
  return Effect.gen(function* () {
    const revision = yield* tx.execute({
      label: "dance-reference-processing.complete.failed-revision",
      text: "UPDATE dance_choreography_revisions SET status='processing_failed',terminal_evidence_digest=$1,processing_failure_code=$2,terminal_at=clock_timestamp() WHERE choreography_id=$3 AND revision=$4 AND status='processing' AND cutoff_reason IS NULL",
      values: [
        evidenceDigest,
        failureCode,
        claim.binding.choreographyId,
        claim.binding.choreographyRevision,
      ],
      readonly: false,
    });
    if (revision.rowCount !== 1) return yield* Effect.fail(fail("complete", "identity-conflict"));
    const aggregate = yield* tx.execute({
      label: "dance-reference-processing.complete.failed-aggregate",
      text: "UPDATE dance_choreographies SET version=version+1,updated_at=clock_timestamp() WHERE choreography_id=$1 AND status NOT IN ('disabled','retired')",
      values: [claim.binding.choreographyId],
      readonly: false,
    });
    if (aggregate.rowCount !== 1) return yield* Effect.fail(fail("complete", "identity-conflict"));
  });
}

function readyRevision(
  tx: ControlPlaneTransaction,
  claim: DanceReferenceProcessingClaim,
  outcome: Extract<DanceReferenceOutcome, { readonly status: "ready" }>,
): Effect.Effect<void, RepositoryFailure> {
  const input = claim.frozenInput;
  return Effect.gen(function* () {
    const segment = yield* tx.execute({
      label: "dance-reference-processing.complete.segment",
      text: "INSERT INTO dance_song_segments (segment_id,community_id,song_post_id,song_submission_id,audio_revision,start_ms,end_ms,canonical_audio_duration_ms,canonical_segment_audio_ref,canonical_segment_sha256,extraction_policy_version,source_media_sha256,segment_terms_hash) SELECT $1,r.community_id,r.song_post_id,p.submission_id,r.audio_revision,$2,$3,$4,$5,$6,$7,$8,$9 FROM dance_choreography_revisions r JOIN media_publication_projections p ON p.community_id=r.community_id AND p.post_id=r.song_post_id AND p.audio_revision=r.audio_revision WHERE r.choreography_id=$10 AND r.revision=$11 ON CONFLICT (segment_terms_hash) DO NOTHING",
      values: [
        outcome.segment.segmentId,
        outcome.segment.startMs,
        outcome.segment.endMs,
        input.canonicalAudio.durationMs,
        outcome.segment.objectKey,
        outcome.segment.sha256,
        outcome.segment.extractionPolicyVersion,
        outcome.segment.sourceSha256,
        outcome.segment.segmentTermsHash,
        claim.binding.choreographyId,
        claim.binding.choreographyRevision,
      ],
      readonly: false,
    });
    if (segment.rowCount !== 1) {
      const replay = yield* tx.execute<Row>({
        label: "dance-reference-processing.complete.segment-replay",
        text: "SELECT segment_id FROM dance_song_segments WHERE segment_terms_hash=$1 AND segment_id=$2 AND canonical_segment_sha256=$3",
        values: [
          outcome.segment.segmentTermsHash,
          outcome.segment.segmentId,
          outcome.segment.sha256,
        ],
        readonly: true,
      });
      if (replay.rows.length !== 1) {
        return yield* Effect.fail(fail("complete", "identity-conflict"));
      }
    }
    const artifact = yield* tx.execute({
      label: "dance-reference-processing.complete.artifact",
      text: "INSERT INTO dance_reference_artifacts (artifact_id,choreography_id,revision,private_artifact_ref,artifact_sha256,pose_model_version,pose_runtime_version,feature_schema_version,scorer_contract_version,integrity_policy_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (choreography_id,revision) DO NOTHING",
      values: [
        outcome.artifact.artifactId,
        claim.binding.choreographyId,
        claim.binding.choreographyRevision,
        outcome.artifact.privateArtifactRef,
        outcome.artifact.artifactSha256,
        outcome.artifact.poseModelVersion,
        outcome.artifact.poseRuntimeVersion,
        outcome.artifact.featureSchemaVersion,
        outcome.artifact.scorerContractVersion,
        outcome.artifact.integrityPolicyVersion,
      ],
      readonly: false,
    });
    if (artifact.rowCount !== 1) {
      return yield* Effect.fail(fail("complete", "identity-conflict"));
    }
    const revision = yield* tx.execute({
      label: "dance-reference-processing.complete.ready-revision",
      text: "UPDATE dance_choreography_revisions SET status='ready',segment_id=$1,reference_video_scored_start_ms=$2,reference_video_scored_end_ms=$3,alignment_metrics=$4::jsonb,reference_duration_ms=$5,reference_width=$6,reference_height=$7,reference_frame_rate_numerator=$8,reference_frame_rate_denominator=$9,usable_frame_summary=$10::jsonb,alignment_accepted=TRUE,time_stretch_detected=FALSE,body_coverage_accepted=TRUE,timeline_evidence_accepted=TRUE,visibility_evidence_accepted=TRUE,subject_continuity_accepted=TRUE,meaningful_motion_accepted=TRUE,terminal_evidence_digest=$11,terminal_at=clock_timestamp() WHERE choreography_id=$12 AND revision=$13 AND status='processing' AND cutoff_reason IS NULL",
      values: [
        outcome.segment.segmentId,
        outcome.alignment.referenceVideoScoredStartMs,
        outcome.alignment.referenceVideoScoredEndMs,
        JSON.stringify(outcome.alignment),
        outcome.artifact.referenceDurationMs,
        outcome.artifact.width,
        outcome.artifact.height,
        outcome.artifact.frameRateNumerator,
        outcome.artifact.frameRateDenominator,
        JSON.stringify(outcome.artifact.usableFrameSummary),
        outcome.evidence.evidenceDigest,
        claim.binding.choreographyId,
        claim.binding.choreographyRevision,
      ],
      readonly: false,
    });
    if (revision.rowCount !== 1) return yield* Effect.fail(fail("complete", "identity-conflict"));
    const aggregate = yield* tx.execute({
      label: "dance-reference-processing.complete.ready-aggregate",
      text: "UPDATE dance_choreographies SET status='ready',active_revision=COALESCE(active_revision,$1),version=version+1,updated_at=clock_timestamp() WHERE choreography_id=$2 AND status NOT IN ('disabled','retired')",
      values: [claim.binding.choreographyRevision, claim.binding.choreographyId],
      readonly: false,
    });
    if (aggregate.rowCount !== 1) return yield* Effect.fail(fail("complete", "identity-conflict"));
  });
}
