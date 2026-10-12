// Private controlled source adapter; no endpoint composition or serving grant.
import {
  type ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  GuestParticipationStoreRejected,
} from "@pirate/application";
import type {
  GuestLearningRetentionStore,
  ParticipationOperationIdentity,
} from "@pirate/application/guest-participation-authority";
import type { OwnerLearnerAudioDeletionStore } from "@pirate/application/owner-learner-audio-deletion";
import {
  GuestIdentifierV1,
  GuestLearnerAudioDeletionV1,
  GuestLearningRetentionV1,
  GuestSha256V1,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";

const invalid = () => new GuestParticipationStoreRejected({ reason: "owner-mismatch" });
const Operation = Schema.Struct({
  sourceOwnerId: GuestIdentifierV1,
  kind: Schema.Literals(["learner_audio_deletion", "learning_retention"]),
  idempotencyKey: GuestIdentifierV1,
  requestHash: GuestSha256V1,
});
const Batch = Schema.Struct({
  operation: Schema.Struct({ ...Operation.fields, kind: Schema.Literal("learner_audio_deletion") }),
  batchId: GuestIdentifierV1,
  fenceRevision: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  sourceOwnerIds: Schema.Array(GuestIdentifierV1),
  artifacts: Schema.Array(
    Schema.Struct({
      artifactId: GuestIdentifierV1,
      source: Schema.Struct({ kind: Schema.Literal("guest"), ownerId: GuestIdentifierV1 }),
      objectRef: Schema.NonEmptyString.check(Schema.isMaxLength(2048)),
    }),
  ).check(Schema.isMaxLength(1000)),
  providerDisposition: GuestLearnerAudioDeletionV1.fields.provider_disposition,
});
const completed = <S extends Schema.ConstraintDecoder<unknown>>(result: S) =>
  Schema.Struct({
    state: Schema.Literal("completed"),
    operation: Operation,
    outcomeId: GuestIdentifierV1,
    result,
  });
const Prepared = completed(Batch);
const Deleted = completed(GuestLearnerAudioDeletionV1);
const Retention = Schema.Union([
  completed(GuestLearningRetentionV1),
  Schema.Struct({
    state: Schema.Literal("pending_confirmation"),
    operation: Operation,
    outcomeId: Schema.NullOr(GuestIdentifierV1),
  }),
  Schema.Struct({ state: Schema.Literal("known_aborted"), operation: Operation }),
]);
function one<S extends Schema.ConstraintDecoder<unknown>>(
  tx: ControlPlaneTransaction,
  label: string,
  text: string,
  values: readonly unknown[],
  schema: S,
) {
  return tx.execute<unknown>({ label, text, values, readonly: false }).pipe(
    Effect.flatMap((r) =>
      Effect.try({
        try: () => {
          if (r.rows.length !== 1) throw invalid();
          const row = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), {
            onExcessProperty: "error",
          })(r.rows[0]);
          return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(row.result);
        },
        catch: invalid,
      }),
    ),
  );
}
const mapped = (error: ControlPlaneError | GuestParticipationStoreRejected) =>
  error._tag !== "ControlPlaneStatementFailed"
    ? error
    : error.sqlState === "GP001"
      ? new GuestParticipationStoreRejected({ reason: "proof-revoked" })
      : error.sqlState === "GP002"
        ? invalid()
        : error.sqlState === "GP004"
          ? new GuestParticipationStoreRejected({ reason: "not-found" })
          : error.sqlState === "GP005"
            ? new GuestParticipationStoreRejected({ reason: "idempotency-conflict" })
            : error.sqlState === "GD001"
              ? new GuestParticipationStoreRejected({ reason: "deletion-in-progress" })
              : error;
const sameOperation = (a: ParticipationOperationIdentity, b: ParticipationOperationIdentity) =>
  a.sourceOwnerId === b.sourceOwnerId &&
  a.kind === b.kind &&
  a.idempotencyKey === b.idempotencyKey &&
  a.requestHash === b.requestHash;
export const makeGuestRecoveryAudioDeletionStores = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): Readonly<{
  deletion: OwnerLearnerAudioDeletionStore;
  retention: GuestLearningRetentionStore;
}> => {
  const short = <A>(
    use: (
      tx: ControlPlaneTransaction,
    ) => Effect.Effect<A, ControlPlaneError | GuestParticipationStoreRejected>,
  ) => boundedLearnerAudioTransaction(use).pipe(Effect.provide(runtime), Effect.mapError(mapped));
  const deletion: OwnerLearnerAudioDeletionStore = {
    prepareBatch: Effect.fn("guestAudioDelete.prepareBatch")(function* (
      input: Parameters<OwnerLearnerAudioDeletionStore["prepareBatch"]>[0],
    ) {
      const result = yield* short((tx) =>
        one(
          tx,
          "guest-audio-delete.prepare",
          "SELECT prepare_guest_owner_audio_delete_v1($1::jsonb,$2::jsonb,$3) AS result",
          [JSON.stringify(input.access), JSON.stringify(input.operation), input.maximumArtifacts],
          Prepared,
        ),
      );
      if (
        !sameOperation(result.operation, input.operation) ||
        !sameOperation(result.result.operation, input.operation) ||
        result.outcomeId !== result.result.batchId ||
        !result.result.sourceOwnerIds.includes(input.operation.sourceOwnerId) ||
        new Set(result.result.sourceOwnerIds).size !== result.result.sourceOwnerIds.length ||
        result.result.artifacts.some(
          (item) => !result.result.sourceOwnerIds.includes(item.source.ownerId),
        )
      )
        return yield* invalid();
      return result;
    }),
    confirmBatch: Effect.fn("guestAudioDelete.confirmBatch")(function* (
      input: Parameters<OwnerLearnerAudioDeletionStore["confirmBatch"]>[0],
    ) {
      const result = yield* short((tx) =>
        one(
          tx,
          "guest-audio-delete.confirm",
          "SELECT confirm_guest_owner_audio_delete_v1($1::jsonb,$2,$3::timestamptz) AS result",
          [JSON.stringify(input.batch), input.storageDisposition, input.deletedAt],
          Deleted,
        ),
      );
      if (
        !sameOperation(result.operation, input.batch.operation) ||
        result.result.operation.operation_id !== result.outcomeId ||
          result.result.operation.idempotency_key !== input.batch.operation.idempotencyKey ||
        result.result.operation.operation_kind !== input.batch.operation.kind
      )
        return yield* invalid();
      return result;
    }),
    failBatch: Effect.fn("guestAudioDelete.failBatch")(function* (
      input: Parameters<OwnerLearnerAudioDeletionStore["failBatch"]>[0],
    ) {
      const result = yield* short((tx) =>
        one(
          tx,
          "guest-audio-delete.fail",
          "SELECT fail_guest_owner_audio_delete_v1($1::jsonb,$2) AS result",
          [JSON.stringify(input.batch), input.storageDisposition],
          Deleted,
        ),
      );
      if (
        !sameOperation(result.operation, input.batch.operation) ||
        result.result.operation.operation_id !== result.outcomeId ||
          result.result.operation.idempotency_key !== input.batch.operation.idempotencyKey ||
        result.result.operation.operation_kind !== input.batch.operation.kind
      )
        return yield* invalid();
      return result;
    }),
    findOperation: Effect.fn("guestAudioDelete.findOperation")(function* (
      input: Parameters<OwnerLearnerAudioDeletionStore["findOperation"]>[0],
    ) {
      const result = yield* short((tx) =>
        one(
          tx,
          "guest-audio-delete.find",
          "SELECT find_guest_owner_audio_delete_v1($1::jsonb,$2,$3) AS result",
          [JSON.stringify(input.access), input.sourceOwnerId, input.idempotencyKey],
          GuestLearnerAudioDeletionV1,
        ),
      );
      if (
        result.operation.operation_kind !== "learner_audio_deletion" ||
        result.operation.idempotency_key !== input.idempotencyKey
      )
        return yield* invalid();
      return result;
    }),
  };
  const retention: GuestLearningRetentionStore = {
    set: Effect.fn("guestLearningRetention.set")(function* (
      input: Parameters<GuestLearningRetentionStore["set"]>[0],
    ) {
      const result = yield* short((tx) =>
        one(
          tx,
          "guest-learning-retention.set",
          "SELECT set_guest_learning_retention_v1($1::jsonb,$2::jsonb,$3) AS result",
          [JSON.stringify(input.access), JSON.stringify(input.operation), input.mode],
          Retention,
        ),
      );
      if (
        !sameOperation(result.operation, input.operation) ||
        (result.state === "completed" && result.result.mode !== input.mode)
      )
        return yield* invalid();
      return result;
    }),
  };
  return { deletion, retention };
};
