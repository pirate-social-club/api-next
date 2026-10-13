// Private system stage only. No endpoint, default schedule or runtime grant.
import {
  type ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { GuestIdentifierV1, GuestSha256V1 } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";

const Identifier = GuestIdentifierV1;
const Cleanup = Schema.Struct({
  cleanupId: Identifier,
  uploadAttemptId: Identifier,
  attemptId: GuestIdentifierV1.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u)),
  contentDigest: GuestSha256V1,
  objectRef: Schema.NonEmptyString.check(
    Schema.isMaxLength(213),
    Schema.isPattern(/^learner-audio\/study\/[A-Za-z0-9_-]{1,128}\/[0-9a-f]{64}$/u),
  ),
}).check(
  Schema.makeFilter((cleanup) =>
    cleanup.objectRef === `learner-audio/study/${cleanup.attemptId}/${cleanup.contentDigest}`
      ? undefined
      : "Original Guest Study key differs from captured attempt/digest",
  ),
);
const Prepared = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle") }),
  Schema.Struct({ state: Schema.Literal("prepared"), cleanup: Cleanup }),
]);
export type GuestEphemeralCleanup = typeof Cleanup.Type;
const invalid = (label: string) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });
function one<S extends Schema.ConstraintDecoder<unknown>>(
  tx: ControlPlaneTransaction,
  label: string,
  text: string,
  values: readonly unknown[],
  schema: S,
) {
  return tx.execute<unknown>({ label, text, values, readonly: false }).pipe(
    Effect.flatMap((rows) =>
      Effect.try({
        try: () => {
          if (rows.rows.length !== 1) throw new Error();
          const row = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), {
            onExcessProperty: "error",
          })(rows.rows[0]);
          return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(row.result);
        },
        catch: () => invalid(`${label}.decode`),
      }),
    ),
  );
}
export function makeControlPlaneGuestEphemeralCleanup(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  const prepareNext = Effect.fn("GuestEphemeralCleanup.prepareNext")(function* () {
    return yield* boundedLearnerAudioTransaction((tx) =>
      one(
        tx,
        "guest-ephemeral.prepare-next",
        "SELECT prepare_next_guest_ephemeral_audio_cleanup_private_v1() AS result",
        [],
        Prepared,
      ),
    );
  });
  const confirm = Effect.fn("GuestEphemeralCleanup.confirm")(function* (
    cleanup: GuestEphemeralCleanup,
    deletedAt: string,
  ) {
    yield* boundedLearnerAudioTransaction((tx) =>
      tx.execute({
        label: "guest-ephemeral.confirm",
        text: "SELECT confirm_guest_ephemeral_audio_cleanup_private_v1($1,$2,$3,$4::timestamptz)",
        values: [cleanup.cleanupId, cleanup.uploadAttemptId, cleanup.objectRef, deletedAt],
        readonly: false,
      }),
    );
  });
  return {
    prepareNext: () => prepareNext().pipe(Effect.provide(runtime)),
    confirm: (cleanup: GuestEphemeralCleanup, deletedAt: string) =>
      confirm(cleanup, deletedAt).pipe(Effect.provide(runtime)),
  };
}
export class GuestEphemeralStorageOutcomeUnknown extends Schema.TaggedError<GuestEphemeralStorageOutcomeUnknown>()(
  "GuestEphemeralStorageOutcomeUnknown",
  { cleanupId: Identifier },
) {}
/** Include inside the SINGLE serial Study-recovery declaration. It must retain
 * this whole task through its existing job lifecycle. No separate table writer.
 * Each prepare/confirm owns one short transaction; DELETE holds no SQL lock.
 */
export function makeGuestEphemeralCleanupStage(
  input: Readonly<{
    runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
    bucket: Readonly<{ delete: (key: string) => Promise<void> }>;
    maximumDeletes: number;
  }>,
) {
  const maximum = Schema.decodeUnknownSync(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  )(input.maximumDeletes);
  const store = makeControlPlaneGuestEphemeralCleanup(input.runtime);
  return Effect.fn("GuestEphemeralCleanupStage.run")(function* () {
    for (let completed = 0; completed < maximum; completed++) {
      const prepared = yield* store.prepareNext();
      if (prepared.state === "idle") break;
      // No abort inference from rejection. The same pending cleanup/key survives;
      // a later job may repeat this exact idempotent DELETE, never a replacement PUT.
      yield* Effect.tryPromise({
        try: () => input.bucket.delete(prepared.cleanup.objectRef),
        catch: () =>
          new GuestEphemeralStorageOutcomeUnknown({ cleanupId: prepared.cleanup.cleanupId }),
      });
      yield* store.confirm(prepared.cleanup, new Date().toISOString());
    }
  });
}
