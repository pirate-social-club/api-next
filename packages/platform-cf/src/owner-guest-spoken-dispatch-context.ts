import {
  type ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  GuestParticipationStoreRejected,
  type OwnerGuestSpokenDispatchContextStore,
} from "@pirate/application";
import {
  GuestIdentifierV1,
  GuestParticipationResultV1,
  GuestStudyAnswerResultV1,
  StudySessionItemV2,
  StudySpokenLanguageProvenanceV2,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { boundedLearnerAudioTransaction } from "./bounded-audio-transaction.ts";

const Reply = Schema.Struct({
  source: Schema.Struct({
    kind: Schema.Literal("guest"),
    ownerId: GuestIdentifierV1,
  }),
  context: Schema.Struct({
    item: StudySessionItemV2,
    referenceText: Schema.String.check(Schema.isMaxLength(4096)),
    dominantLanguage: Schema.NullOr(Schema.String),
    languageProvenance: StudySpokenLanguageProvenanceV2,
  }),
  resourceReservationId: GuestIdentifierV1,
  deletionFenceRevision: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
const failed = () =>
  new ControlPlaneStatementFailed({
    label: "guest-spoken.dispatch-context.decode",
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });
const OwnedAnswer = Schema.Struct({
  source: Reply.fields.source,
  answer: GuestStudyAnswerResultV1,
  participation: GuestParticipationResultV1,
});
const Original = Schema.Union([
  Schema.Struct({ state: Schema.Literal("absent") }),
  Schema.Struct({
    state: Schema.Literals(["reserved", "known_aborted", "completed"]),
    operationId: GuestIdentifierV1,
    result: Schema.NullOr(OwnedAnswer),
  }).check(
    Schema.makeFilter((row) =>
      (row.state === "completed") === (row.result !== null)
        ? undefined
        : "Exact original result shape",
    ),
  ),
]);
export function makeOwnerGuestSpokenDispatchContextStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): OwnerGuestSpokenDispatchContextStore {
  return {
    resolveAnswerSource: Effect.fn("OwnerGuestSpokenDispatchContextStore.resolveAnswerSource")(
      function* (
        input: Parameters<OwnerGuestSpokenDispatchContextStore["resolveAnswerSource"]>[0],
      ) {
        if (input.access.kind !== "guest")
          return yield* new GuestParticipationStoreRejected({ reason: "owner-mismatch" });
        const source = yield* boundedLearnerAudioTransaction((tx) =>
          tx
            .execute({
              label: "guest-study.answer-source",
              text: "SELECT read_owner_guest_answer_source_v1($1::jsonb,$2,$3,$4) AS result",
              values: [
                JSON.stringify(input.access),
                input.communityId,
                input.sessionId,
                input.sessionItemId,
              ],
              readonly: false,
            })
            .pipe(
              Effect.flatMap((rows) =>
                Effect.try({
                  try: () => {
                    if (rows.rows.length !== 1) throw new Error();
                    const outer = Schema.decodeUnknownSync(
                      Schema.Struct({ result: Schema.Unknown }),
                      { onExcessProperty: "error" },
                    )(rows.rows[0]);
                    return Schema.decodeUnknownSync(Reply.fields.source, {
                      onExcessProperty: "error",
                    })(outer.result);
                  },
                  catch: failed,
                }),
              ),
            ),
        ).pipe(Effect.provide(runtime));
        if (source.ownerId !== input.access.ownerId)
          return yield* new GuestParticipationStoreRejected({ reason: "owner-mismatch" });
        return source;
      },
    ),
    load: Effect.fn("OwnerGuestSpokenDispatchContextStore.load")(function* (
      input: Parameters<OwnerGuestSpokenDispatchContextStore["load"]>[0],
    ) {
      if (input.access.kind !== "guest")
        return yield* new GuestParticipationStoreRejected({
          reason: "owner-mismatch",
        });
      const result = yield* boundedLearnerAudioTransaction((tx) =>
        tx
          .execute({
            label: "guest-spoken.dispatch-context",
            text: "SELECT read_owner_guest_spoken_dispatch_context_v1($1::jsonb,$2,$3,$4,$5) AS result",
            values: [
              JSON.stringify(input.access),
              input.communityId,
              input.sessionId,
              input.sessionItemId,
              input.idempotencyKey,
            ],
            readonly: false,
          })
          .pipe(
            Effect.flatMap((rows) =>
              Effect.try({
                try: () => {
                  if (rows.rows.length !== 1) throw new Error();
                  const outer = Schema.decodeUnknownSync(
                    Schema.Struct({ result: Schema.Unknown }),
                    { onExcessProperty: "error" },
                  )(rows.rows[0]);
                  return Schema.decodeUnknownSync(Reply, {
                    onExcessProperty: "error",
                  })(outer.result);
                },
                catch: failed,
              }),
            ),
          ),
      ).pipe(Effect.provide(runtime));
      if (
        result.source.ownerId !== input.access.ownerId ||
        result.context.item.session_item_id !== input.sessionItemId ||
        result.context.item.exercise_type !== "say_it_back"
      )
        return yield* new GuestParticipationStoreRejected({
          reason: "owner-mismatch",
        });
      return result;
    }),
    findAnswerOutcome: Effect.fn("OwnerGuestSpokenDispatchContextStore.findAnswerOutcome")(
      function* (input: Parameters<OwnerGuestSpokenDispatchContextStore["findAnswerOutcome"]>[0]) {
        if (
          input.access.kind !== "guest" ||
          input.access.ownerId !== input.source.ownerId ||
          input.operation.sourceOwnerId !== input.source.ownerId ||
          input.operation.kind !== "study_answer" ||
          input.operation.idempotencyKey !== input.idempotencyKey
        )
          return yield* new GuestParticipationStoreRejected({
            reason: "owner-mismatch",
          });
        const reply = yield* boundedLearnerAudioTransaction((tx) =>
          tx
            .execute({
              label: "guest-spoken.original-operation",
              text: "SELECT read_owner_guest_answer_operation_v1($1::jsonb,$2,$3::jsonb,$4,$5,$6,$7::integer) AS result",
              values: [
                JSON.stringify(input.access),
                input.source.ownerId,
                JSON.stringify(input.operation),
                input.communityId,
                input.sessionId,
                input.sessionItemId,
                input.attemptNumber,
              ],
              readonly: false,
            })
            .pipe(
              Effect.flatMap((rows) =>
                Effect.try({
                  try: () => {
                    if (rows.rows.length !== 1) throw new Error();
                    const outer = Schema.decodeUnknownSync(
                      Schema.Struct({ result: Schema.Unknown }),
                      { onExcessProperty: "error" },
                    )(rows.rows[0]);
                    return Schema.decodeUnknownSync(Original, {
                      onExcessProperty: "error",
                    })(outer.result);
                  },
                  catch: failed,
                }),
              ),
            ),
        ).pipe(Effect.provide(runtime));
        if (reply.state === "known_aborted")
          return { state: "known_aborted", operation: input.operation };
        if (reply.state === "absent" || reply.state === "reserved")
          return {
            state: "pending_confirmation",
            operation: input.operation,
            outcomeId: reply.state === "absent" ? null : reply.operationId,
          };
        if (
          reply.result === null ||
          reply.result.source.ownerId !== input.source.ownerId ||
          reply.result.answer.session.session_id !== input.sessionId ||
          reply.result.answer.session.community_id !== input.communityId ||
          reply.result.answer.session_item_id !== input.sessionItemId ||
          reply.result.answer.attempt_number !== input.attemptNumber
        )
          return yield* new GuestParticipationStoreRejected({
            reason: "owner-mismatch",
          });
        return {
          state: "completed",
          operation: input.operation,
          outcomeId: reply.operationId,
          result: reply.result,
        };
      },
    ),
  };
}
