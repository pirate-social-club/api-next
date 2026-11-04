// Platform internal read seam; original lease and grade never enter HTTP output.
import {
  type ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  GuestParticipationStoreRejected,
} from "@pirate/application";
import type {
  OwnerGuestSpokenCheckpointRecoveryStore,
  OwnerGuestSpokenClosedRecoveryStore,
} from "@pirate/application/owner-guest-spoken-checkpoint-recovery";
import { GuestIdentifierV1, GuestSha256V1 } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";
import { decodeOwnerSpokenSavedCheckpoint } from "./owner-spoken-checkpoint-store.ts";

const Id = GuestIdentifierV1;
const Input = Schema.Struct({
  access: Schema.Struct({
    kind: Schema.Literal("guest"),
    ownerId: Id,
    credentialId: Id,
    origin: Schema.NonEmptyString.check(Schema.isMaxLength(2048)),
  }),
  communityId: Id,
  sessionId: Id,
  sessionItemId: Id,
  idempotencyKey: Id,
  attemptNumber: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  audioDigest: GuestSha256V1,
  audioContentType: Schema.Literals(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"]),
  audioByteSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 524288 })),
  audioDurationMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 })),
});
const Locator = Schema.Struct({ checkpointId: Id });
const Maximum = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));
const Archive = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("stored"),
    objectRef: Schema.NonEmptyString.check(Schema.isMaxLength(2048)),
  }),
  Schema.Struct({ state: Schema.Literal("failed"), objectRef: Schema.Null }),
]);
const Closed = Schema.Struct({ saved: Schema.Unknown, archive: Archive });
const invalid = () => new GuestParticipationStoreRejected({ reason: "idempotency-conflict" });
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const one = (
  tx: ControlPlaneTransaction,
  label: string,
  text: string,
  values: readonly unknown[],
) =>
  tx.execute<unknown>({ label, text, values, readonly: true }).pipe(
    Effect.flatMap((rows) =>
      Effect.try({
        try: () => {
          if (rows.rows.length !== 1) throw invalid();
          return decode(Schema.Struct({ result: Schema.Unknown }), rows.rows[0]).result;
        },
        catch: invalid,
      }),
    ),
  );
const mapped = (error: ControlPlaneError | GuestParticipationStoreRejected) =>
  error._tag !== "ControlPlaneStatementFailed"
    ? error
    : error.sqlState === "GP001"
      ? new GuestParticipationStoreRejected({ reason: "proof-revoked" })
      : error.sqlState === "GP002"
        ? new GuestParticipationStoreRejected({ reason: "owner-mismatch" })
        : error.sqlState === "GP005"
          ? invalid()
          : error;
export const makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): Readonly<{
  browser: OwnerGuestSpokenCheckpointRecoveryStore;
  closed: OwnerGuestSpokenClosedRecoveryStore;
}> => {
  const short = <A>(
    use: (
      tx: ControlPlaneTransaction,
    ) => Effect.Effect<A, ControlPlaneError | GuestParticipationStoreRejected>,
  ) => boundedLearnerAudioTransaction(use).pipe(Effect.provide(runtime), Effect.mapError(mapped));
  const browser: OwnerGuestSpokenCheckpointRecoveryStore = {
    findForAudio: Effect.fn("guest-spoken.recovery.findForAudio")(function* (
      input: Parameters<OwnerGuestSpokenCheckpointRecoveryStore["findForAudio"]>[0],
    ) {
      // Accept the recovery portion of the actual verified access. A carried
      // learning lease is intentionally not decoded or checked after accepted CP.
      const accepted = yield* Effect.try({
        try: () =>
          decode(Input, {
            ...input,
            access: {
              kind: input.access.kind,
              ownerId: input.access.ownerId,
              credentialId: input.access.credentialId,
              origin: input.access.origin,
            },
          }),
        catch: invalid,
      });
      const raw = yield* short((tx) =>
        one(
          tx,
          "guest-spoken.recovery.findForAudio",
          "SELECT find_owner_guest_spoken_success_for_audio_v1($1::jsonb,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",
          [
            JSON.stringify(accepted.access),
            accepted.communityId,
            accepted.sessionId,
            accepted.sessionItemId,
            accepted.idempotencyKey,
            accepted.attemptNumber,
            accepted.audioDigest,
            accepted.audioContentType,
            accepted.audioByteSize,
            accepted.audioDurationMs,
          ],
        ),
      );
      return yield* Effect.try({
        try: () => {
          const found = decodeOwnerSpokenSavedCheckpoint(raw);
          if (found === null) return null;
          const saved = found.success,
            r = saved.result;
          if (
            saved.source.ownerId !== accepted.access.ownerId ||
            saved.operation.idempotencyKey !== accepted.idempotencyKey ||
            r.communityId !== accepted.communityId ||
            r.sessionId !== accepted.sessionId ||
            r.sessionItemId !== accepted.sessionItemId ||
            r.attemptNumber !== accepted.attemptNumber ||
            r.audioDigest !== accepted.audioDigest ||
            r.audioContentType !== accepted.audioContentType ||
            r.audioByteSize !== accepted.audioByteSize ||
            r.audioDurationMs !== accepted.audioDurationMs
          )
            throw invalid();
          return found;
        },
        catch: invalid,
      });
    }),
  };
  const closed: OwnerGuestSpokenClosedRecoveryStore = {
    list: Effect.fn("guest-spoken.recovery.list")(function* (maximum: number) {
      const bound = yield* Effect.try({ try: () => decode(Maximum, maximum), catch: invalid });
      const raw = yield* short((tx) =>
        one(
          tx,
          "guest-spoken.recovery.list",
          "SELECT list_guest_spoken_closed_recovery_v1($1) AS result",
          [bound],
        ),
      );
      return yield* Effect.try({
        try: () => {
          const found = decode(Schema.Array(Locator).check(Schema.isMaxLength(100)), raw);
          if (
            found.length > bound ||
            new Set(found.map((item) => item.checkpointId)).size !== found.length
          )
            throw invalid();
          return found;
        },
        catch: invalid,
      });
    }),
    read: Effect.fn("guest-spoken.recovery.read")(function* (checkpointId: string) {
      const id = yield* Effect.try({ try: () => decode(Id, checkpointId), catch: invalid });
      const raw = yield* short((tx) =>
        one(
          tx,
          "guest-spoken.recovery.read",
          "SELECT read_guest_spoken_closed_recovery_v1($1) AS result",
          [id],
        ),
      );
      return yield* Effect.try({
        try: () => {
          if (raw === null) return null;
          const row = decode(Closed, raw),
            saved = decodeOwnerSpokenSavedCheckpoint(row.saved);
          if (saved === null || saved.checkpointId !== id) throw invalid();
          return { ...saved, archive: row.archive };
        },
        catch: invalid,
      });
    }),
  };
  return { browser, closed };
};
