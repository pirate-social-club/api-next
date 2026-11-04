// Private transport-bound ORIGINAL Account source reader; no raw row grant.
import {
  type ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type LearningAccess,
  type ParticipationSource,
} from "@pirate/application";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";

const Text = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Source = Schema.Struct({
  kind: Schema.Literal("account"),
  ownerId: Text,
  accountId: Text,
  personaId: Text,
});
const Receipt = Schema.Struct({ source: Source, attemptId: Text });
export type OriginalAccountSource = Extract<ParticipationSource, { kind: "account" }>;
export type OriginalAccountSourceControl = ReturnType<typeof makeOriginalAccountStudySourceControl>;
const failed = (label: string) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });
export function makeOriginalAccountStudySourceControl(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  const read = Effect.fn("OriginalAccountStudySourceControl.read")(function* <
    S extends Schema.ConstraintDecoder<unknown>,
  >(label: string, text: string, values: readonly unknown[], schema: S) {
    const rows = yield* boundedLearnerAudioTransaction((tx) =>
      tx.execute({ label, text, values, readonly: false }),
    );
    return yield* Effect.try({
      try: () => {
        if (rows.rows.length !== 1) throw new Error();
        const outer = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }), {
          onExcessProperty: "error",
        })(rows.rows[0]);
        return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(outer.result);
      },
      catch: () => failed(`${label}.decode`),
    });
  });
  return {
    resolve: (
      input: Readonly<{
        access: Extract<LearningAccess, { kind: "account" }>;
        communityId: string;
        sessionId: string;
        sessionItemId?: string;
      }>,
    ) =>
      read(
        "owner-account.source",
        "SELECT read_original_account_study_source_v1($1::jsonb,$2,$3,$4) AS result",
        [
          JSON.stringify(input.access),
          input.communityId,
          input.sessionId,
          input.sessionItemId ?? null,
        ],
        Schema.NullOr(Source),
      ).pipe(Effect.provide(runtime)),
    receipt: (
      input: Readonly<{
        access: Extract<LearningAccess, { kind: "account" }>;
        communityId: string;
        sessionId: string;
        sessionItemId: string;
        idempotencyKey: string;
        requestHash: string;
      }>,
    ) =>
      read(
        "owner-account.answer-receipt",
        "SELECT read_original_account_study_answer_receipt_v1($1::jsonb,$2,$3,$4,$5,$6) AS result",
        [
          JSON.stringify(input.access),
          input.communityId,
          input.sessionId,
          input.sessionItemId,
          input.idempotencyKey,
          input.requestHash,
        ],
        Schema.NullOr(Receipt),
      ).pipe(Effect.provide(runtime)),
  };
}
