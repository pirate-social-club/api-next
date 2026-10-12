// Private proposal segment for the frozen owner store. No endpoint/port edit.
// This segment handles GUEST source methods only; root composes ordinary-account
// dispatch with the retained adapter/shared continuation, without source rewrite.
import {
  ControlPlaneDb,
  ControlPlaneStatementFailed,
  GuestParticipationStoreRejected,
  continueStudyLessonMutation,
  evaluateStudyChoice,
  evaluateStudySpokenAttempt,
  projectStudySpokenFeedback,
  projectStudySpokenResultMetadata,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type DurableParticipationOutcome,
  type GuestParticipationStoreFailure,
  type OwnerAwareStudyV2Store,
  type OwnerStudyAnswer,
  type ParticipationOperationIdentity,
} from "@pirate/application";
import {
  GuestIdentifierV1,
  GuestSha256V1,
  GuestStudyAnswerResultV1,
  StudySessionItemV2,
  StudySpokenLanguageProvenanceV2,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { readGuestResourceAdmissionPolicy } from "./guest-resource-policy.ts";
import { OwnerSpokenRetainedSuccessResultSchema } from "./owner-spoken-checkpoint-store.ts";

type Methods = Pick<
  OwnerAwareStudyV2Store,
  | "submitAnswer"
  | "loadSpokenAnswerContext"
  | "reserveSpokenAnswer"
  | "failSpokenAnswer"
  | "persistSuccessfulSpokenResult"
  | "completeSpokenAnswer"
>;
type Input<K extends keyof Methods> = Parameters<Methods[K]>[0];
const Id = GuestIdentifierV1;
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Attempt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }));
const Finite = Schema.Number.check(
  Schema.makeFilter((v) => (Number.isFinite(v) ? undefined : "Finite number required")),
);
const ClockText = Schema.String.check(
  Schema.makeFilter((v) =>
    Number.isFinite(Date.parse(v)) ? undefined : "Stored finite instant required",
  ),
);
const Source = Schema.Struct({ kind: Schema.Literal("guest"), ownerId: Id });
const Operation = Schema.Struct({
  sourceOwnerId: Id,
  kind: Schema.Literal("study_answer"),
  idempotencyKey: Id,
  requestHash: GuestSha256V1,
});
const Review = Schema.Struct({
  difficulty: Finite,
  lapses: Count,
  repetitions: Count,
  stability: Finite,
});
const Choice = Schema.Struct({
  kind: Schema.Literal("single_select"),
  choice_key: Schema.NonEmptyString,
});
const OwnedAnswer = Schema.Struct({
  source: Source,
  answer: GuestStudyAnswerResultV1,
  participation: Schema.Struct({ state: Schema.Literal("practice_only") }),
});
const Resolved = Schema.Struct({
  state: Schema.Literals(["completed", "reserved", "known_aborted"]),
  operationId: Id,
  result: Schema.NullOr(OwnedAnswer),
}).check(
  Schema.makeFilter((reply) =>
    (reply.state === "completed") === (reply.result !== null)
      ? undefined
      : "Immutable answer outcome shape",
  ),
);
const JsonCandidate = Schema.Struct({
  state: Schema.Literal("candidate"),
  sourceOwnerId: Id,
  communityId: Id,
  sessionId: Id,
  sessionItemId: Id,
  attemptNumber: Attempt,
  answer: Choice,
  item: StudySessionItemV2,
  reviewItemId: Id,
  contentRevision: Count,
  grader: Schema.Struct({
    correctChoiceKey: Schema.NonEmptyString,
    correctText: Schema.String,
    explanation: Schema.NullOr(Schema.String),
  }),
  review: Review,
  priorPresentationCount: Count,
  currentPresentedAt: ClockText,
  acceptedAt: ClockText,
  totalCards: Count,
  remainingCards: Count,
  resourceReservationId: Id,
});
const JsonPrepared = Schema.Union([JsonCandidate, Resolved]);
const JsonMutated = Schema.Struct({
  state: Schema.Literal("mutated"),
  operationId: Id,
  capture: JsonCandidate,
  decision: Schema.Unknown,
  totalCards: Count,
  remainingCards: Count,
  priorPresentationCount: Count,
});
const JsonApplied = Schema.Union([JsonMutated, Resolved]);
const Context = Schema.Struct({
  source: Source,
  context: Schema.Struct({
    item: StudySessionItemV2,
    referenceText: Schema.String,
    dominantLanguage: Schema.NullOr(Schema.String),
    languageProvenance: StudySpokenLanguageProvenanceV2,
  }),
});
const Reserved = Schema.Struct({
  state: Schema.Literal("reserved"),
  commandId: Id,
  leaseToken: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  attemptId: Id,
  artifactId: Id,
  resourceReservationId: Id,
  deletionFenceRevision: Count,
});
const Reservation = Schema.Union([
  Reserved,
  Schema.Struct({ state: Schema.Literal("completed"), result: OwnedAnswer }),
  Schema.Struct({
    state: Schema.Literal("pending_confirmation"),
    operation: Operation,
  }),
]);
const FailureReceipt = Schema.Struct({
  state: Schema.Literals(["reserved", "known_aborted"]),
  operationId: Id,
  result: Schema.Null,
});
const CheckpointReceipt = Schema.Struct({
  state: Schema.Literals(["completed", "reserved"]),
  outcome_id: Id,
  result: Schema.NullOr(Schema.Struct({ checkpointId: Id })),
}).check(
  Schema.makeFilter((reply) =>
    (reply.state === "completed") === (reply.result !== null)
      ? undefined
      : "Accepted checkpoint ACK shape",
  ),
);
const Archive = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("stored"),
    objectRef: Schema.NonEmptyString,
  }),
  Schema.Struct({ state: Schema.Literal("failed"), objectRef: Schema.Null }),
]);
const SpokenCandidate = Schema.Struct({
  state: Schema.Literal("candidate"),
  checkpointId: Id,
  captureId: Id,
  operationId: Id,
  sourceOwnerId: Id,
  result: OwnerSpokenRetainedSuccessResultSchema,
  item: StudySessionItemV2,
  reviewItemId: Id,
  review: Review,
  priorRerecordRecorded: Schema.Boolean,
  priorPresentationCount: Count,
  currentPresentedAt: ClockText,
  totalCards: Count,
  remainingCards: Count,
  archive: Archive,
  resourceReservationId: Id,
});
const SpokenPrepared = Schema.Union([SpokenCandidate, Resolved]);
const SpokenMutated = Schema.Struct({
  state: Schema.Literal("mutated"),
  operationId: Id,
  capture: SpokenCandidate,
  decision: Schema.Unknown,
  feedback: Schema.Unknown,
  spoken: Schema.Unknown,
  totalCards: Count,
  remainingCards: Count,
  priorPresentationCount: Count,
});
const SpokenApplied = Schema.Union([SpokenMutated, Resolved]);

const invalid = (label: string) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });
const rejected = (reason: GuestParticipationStoreRejected["reason"]) =>
  new GuestParticipationStoreRejected({ reason });
const check = (condition: boolean) => {
  if (!condition) throw new Error();
};
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const one = <S extends Schema.ConstraintDecoder<unknown>>(
  tx: ControlPlaneTransaction,
  label: string,
  text: string,
  values: readonly unknown[],
  schema: S,
  readonly = false,
) =>
  tx.execute({ label, text, values, readonly }).pipe(
    Effect.flatMap((rows) =>
      Effect.try({
        try: () => {
          check(rows.rows.length === 1);
          const outer = decode(Schema.Struct({ result: Schema.Unknown }), rows.rows[0]);
          return decode(schema, outer.result);
        },
        catch: () => invalid(`${label}.decode`),
      }),
    ),
  );
const statement = (
  tx: ControlPlaneTransaction,
  label: string,
  text: string,
  values: readonly unknown[],
) => tx.execute({ label, text, values, readonly: false }).pipe(Effect.asVoid);
const limits = Effect.fn("OwnerStudyMutations.limits")(function* (tx: ControlPlaneTransaction) {
  yield* tx.execute({
    label: "guest-study.mutation.bounds.set",
    text: "SELECT set_config('transaction_timeout','3s',true),set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)",
    values: [],
    readonly: true,
  });
  const actual = yield* tx.execute({
    label: "guest-study.mutation.bounds.verify",
    text: "SELECT current_setting('transaction_timeout') AS transaction,current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement,current_setting('idle_in_transaction_session_timeout') AS idle",
    values: [],
    readonly: true,
  });
  if (
    actual.rows.length !== 1 ||
    actual.rows[0]?.transaction !== "3s" ||
    actual.rows[0]?.lock !== "250ms" ||
    actual.rows[0]?.statement !== "2s" ||
    actual.rows[0]?.idle !== "2s"
  )
    return yield* rejected("resource-policy-unavailable");
});
const assertOperation = (
  source: Input<"submitAnswer">["source"],
  operation: ParticipationOperationIdentity,
) => {
  decode(Source, source);
  decode(Operation, operation);
  check(source.ownerId === operation.sourceOwnerId);
};
const assertAnswer = (
  reply: OwnerStudyAnswer,
  sourceOwnerId: string,
  expected?: Readonly<{
    communityId: string;
    sessionId: string;
    sessionItemId: string;
    attemptNumber: number;
  }>,
) => {
  const saved = decode(OwnedAnswer, reply);
  check(
    saved.source.ownerId === sourceOwnerId &&
      saved.answer.session.owner_id === sourceOwnerId &&
      saved.answer.session.reward_mode === "practice_only" &&
      saved.participation.state === "practice_only",
  );
  if (expected !== undefined)
    check(
      saved.answer.session.community_id === expected.communityId &&
        saved.answer.session.session_id === expected.sessionId &&
        saved.answer.session_item_id === expected.sessionItemId &&
        saved.answer.attempt_number === expected.attemptNumber,
    );
};
const outcome = (
  reply: typeof Resolved.Type,
  operation: ParticipationOperationIdentity,
  expected?: Parameters<typeof assertAnswer>[2],
): DurableParticipationOutcome<OwnerStudyAnswer> => {
  if (reply.state === "known_aborted") return { state: "known_aborted", operation };
  if (reply.state === "reserved")
    return {
      state: "pending_confirmation",
      operation,
      outcomeId: reply.operationId,
    };
  if (reply.result === null) throw new Error();
  assertAnswer(reply.result, operation.sourceOwnerId, expected);
  return {
    state: "completed",
    operation,
    outcomeId: reply.operationId,
    result: reply.result,
  };
};
const sqlRejection = (error: ControlPlaneStatementFailed) => {
  switch (error.sqlState) {
    case "GP001":
      return rejected("proof-revoked");
    case "GP002":
      return rejected("owner-mismatch");
    case "GP003":
      return rejected("authority-conflict");
    case "GP005":
      return rejected("idempotency-conflict");
    case "GP006":
      return rejected("resource-policy-unavailable");
    case "GP007":
      return rejected("lease-expired");
    case "GP009":
      return rejected("deletion-in-progress");
    case "GP010":
      return rejected("not-found");
    default:
      return error;
  }
};
const serializedSchedule = <A extends Readonly<{ review: Readonly<{ dueAt: number }> | null }>>(
  decision: A,
) => ({
  ...decision,
  review:
    decision.review === null
      ? null
      : {
          ...decision.review,
          dueAt: new Date(decision.review.dueAt).toISOString(),
        },
});

export const makeControlPlaneOwnerStudyMutations = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  config: Readonly<{
    rawPolicy: unknown;
    disclosureVersion: string;
    rerecordEnabled: boolean;
    providerRetention: "stored" | "not_stored";
  }>,
  ids: Readonly<{ newOperationId: () => string; newUploadId: () => string }> = {
    newOperationId: () => `guest_answer_${crypto.randomUUID()}`,
    newUploadId: () => `guest_upload_${crypto.randomUUID()}`,
  },
): Methods => {
  const policy = readGuestResourceAdmissionPolicy(config.rawPolicy);
  decode(Id, config.disclosureVersion);
  decode(Schema.Boolean, config.rerecordEnabled);
  decode(Schema.Literals(["stored", "not_stored"]), config.providerRetention);
  const run = Effect.fn("OwnerStudyMutations.run")(function* <A>(
    work: (tx: ControlPlaneTransaction) => Effect.Effect<A, GuestParticipationStoreFailure>,
  ) {
    return yield* Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* limits(tx);
          return yield* work(tx);
        }),
      );
    }).pipe(
      Effect.catchTag("ControlPlaneStatementFailed", (error) => Effect.fail(sqlRejection(error))),
      Effect.provide(runtime),
    );
  });
  return {
    submitAnswer: (input) =>
      run((tx) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => {
              assertOperation(input.source, input.operation);
              decode(Choice, input.answer);
              check(
                input.access.kind === "guest" &&
                  input.access.ownerId === input.source.ownerId &&
                  input.idempotencyKey === input.operation.idempotencyKey &&
                  input.requestHash === input.operation.requestHash,
              );
            },
            catch: () => invalid("guest-study.answer.input"),
          });
          const values = [
            JSON.stringify(input.access),
            JSON.stringify(input.operation),
            input.communityId,
            input.sessionId,
            input.sessionItemId,
            input.attemptNumber,
            JSON.stringify(input.answer),
          ];
          const prepared = yield* one(
            tx,
            "guest-study.answer.prepare",
            "SELECT prepare_guest_json_answer_v1($1::jsonb,$2::jsonb,$3,$4,$5,$6::integer,$7::jsonb) AS result",
            values,
            JsonPrepared,
          );
          if (prepared.state !== "candidate")
            return yield* Effect.try({
              try: () => outcome(prepared, input.operation, input),
              catch: () => invalid("guest-study.answer.replay"),
            });
          const decision = yield* Effect.try({
            try: () => {
              check(
                prepared.sourceOwnerId === input.source.ownerId &&
                  prepared.communityId === input.communityId &&
                  prepared.sessionId === input.sessionId &&
                  prepared.sessionItemId === input.sessionItemId &&
                  prepared.attemptNumber === input.attemptNumber &&
                  prepared.item.session_item_id === input.sessionItemId &&
                  prepared.item.exercise_type === "translation_choice",
              );
              return evaluateStudyChoice({
                submittedChoiceKey: prepared.answer.choice_key,
                correctChoiceKey: prepared.grader.correctChoiceKey,
                correctText: prepared.grader.correctText,
                explanation: prepared.grader.explanation ?? undefined,
                attemptNumber: prepared.attemptNumber,
                maximumAttempts: prepared.item.maximum_attempts,
                review: {
                  ...prepared.review,
                  reviewedAt: Date.parse(prepared.acceptedAt),
                },
              });
            },
            catch: () => invalid("guest-study.answer.shared-choice"),
          });
          const operationId = ids.newOperationId();
          const schedule = serializedSchedule(decision);
          const applied = yield* one(
            tx,
            "guest-study.answer.item",
            "SELECT apply_guest_json_item_mutation_v1($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6) AS result",
            [
              values[0],
              values[1],
              JSON.stringify(prepared),
              JSON.stringify(schedule),
              operationId,
              input.attemptId,
            ],
            JsonApplied,
          );
          if (applied.state !== "mutated")
            return yield* Effect.try({
              try: () => outcome(applied, input.operation, input),
              catch: () => invalid("guest-study.answer.concurrent-replay"),
            });
          yield* Effect.try({
            try: () =>
              check(
                applied.operationId === operationId &&
                  applied.capture.sourceOwnerId === prepared.sourceOwnerId &&
                  applied.priorPresentationCount === prepared.priorPresentationCount,
              ),
            catch: () => invalid("guest-study.answer.mutation-correlation"),
          });
          const continuation = (transition: unknown) =>
            statement(
              tx,
              "guest-study.answer.continue",
              "SELECT transition_guest_json_answer_v1($1::jsonb,$2,$3::jsonb,$4::jsonb,$5::jsonb)",
              [
                values[1],
                operationId,
                JSON.stringify(prepared),
                JSON.stringify(schedule),
                JSON.stringify(transition),
              ],
            );
          yield* continueStudyLessonMutation(
            {
              complete: continuation,
              advance: continuation,
              keepCurrent: continuation,
            },
            {
              kind: decision.spent ? "advance" : "choice_retryable",
              priorPresentationCount: applied.priorPresentationCount,
              totalCards: applied.totalCards,
              remainingUnresolvedCards: applied.remainingCards,
            },
          );
          const done = yield* one(
            tx,
            "guest-study.answer.finish",
            "SELECT finish_guest_json_answer_v1($1::jsonb,$2,$3::jsonb,$4::jsonb) AS result",
            [values[1], operationId, JSON.stringify(prepared), JSON.stringify(schedule)],
            Resolved,
          );
          return yield* Effect.try({
            try: () => outcome(done, input.operation, input),
            catch: () => invalid("guest-study.answer.result-correlation"),
          });
        }),
      ),
    loadSpokenAnswerContext: (input) =>
      run((tx) =>
        Effect.gen(function* () {
          if (input.access.kind !== "guest") return yield* rejected("owner-mismatch");
          const access = input.access;
          const result = yield* one(
            tx,
            "guest-study.spoken.context",
            "SELECT read_guest_spoken_context_v1($1::jsonb,$2,$3,$4,$5) AS result",
            [
              JSON.stringify(access),
              input.communityId,
              input.sessionId,
              input.sessionItemId,
              input.idempotencyKey,
            ],
            Context,
          );
          yield* Effect.try({
            try: () =>
              check(
                result.source.ownerId === access.ownerId &&
                  result.context.item.session_item_id === input.sessionItemId &&
                  result.context.item.exercise_type === "say_it_back",
              ),
            catch: () => invalid("guest-study.spoken.context-correlation"),
          });
          return result;
        }),
      ),
    reserveSpokenAnswer: (input) =>
      run((tx) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => {
              assertOperation(input.source, input.operation);
              check(
                input.access.kind === "guest" &&
                  input.access.ownerId === input.source.ownerId &&
                  input.idempotencyKey === input.operation.idempotencyKey &&
                  input.requestHash === input.operation.requestHash,
              );
              decode(Id, input.commandId);
              decode(Id, input.attemptId);
              decode(Id, input.artifactId);
              decode(Reserved.fields.leaseToken, input.leaseToken);
            },
            catch: () => invalid("guest-study.spoken.reserve-input"),
          });
          const payload = {
            sessionId: input.sessionId,
            sessionItemId: input.sessionItemId,
            attemptNumber: input.attemptNumber,
            audioDigest: input.audioDigest,
            audioContentType: input.audioContentType,
            audioByteSize: input.audioByteSize,
            audioDurationMs: input.audioDurationMs,
            commandId: input.commandId,
            attemptId: input.attemptId,
            artifactId: input.artifactId,
            leaseToken: input.leaseToken,
            providerRetention: input.providerRetention,
            requestHash: input.requestHash,
          };
          const result = yield* one(
            tx,
            "guest-study.spoken.reserve",
            "SELECT reserve_guest_spoken_answer_v1($1::jsonb,$2::jsonb,$3,$4::jsonb,$5,$6::bigint,$7::jsonb,$8,$9,$10,$11,$12) AS result",
            [
              JSON.stringify(input.access),
              JSON.stringify(input.operation),
              input.source.ownerId,
              JSON.stringify(payload),
              input.resourceReservationId,
              input.deletionFenceRevision,
              JSON.stringify(policy),
              config.disclosureVersion,
              config.rerecordEnabled,
              config.providerRetention,
              ids.newOperationId(),
              ids.newUploadId(),
            ],
            Reservation,
          );
          yield* Effect.try({
            try: () => {
              if (result.state === "completed")
                assertAnswer(result.result, input.source.ownerId, {
                  communityId: result.result.answer.session.community_id,
                  sessionId: input.sessionId,
                  sessionItemId: input.sessionItemId,
                  attemptNumber: input.attemptNumber,
                });
              if (result.state === "reserved")
                check(
                  result.resourceReservationId === input.resourceReservationId &&
                    result.deletionFenceRevision === input.deletionFenceRevision &&
                    result.leaseToken === input.leaseToken,
                );
              if (result.state === "pending_confirmation")
                check(
                  result.operation.sourceOwnerId === input.operation.sourceOwnerId &&
                    result.operation.kind === input.operation.kind &&
                    result.operation.idempotencyKey === input.operation.idempotencyKey &&
                    result.operation.requestHash === input.operation.requestHash,
                );
            },
            catch: () => invalid("guest-study.spoken.reserve-correlation"),
          });
          return result;
        }),
      ),
    failSpokenAnswer: (input) =>
      run((tx) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => assertOperation(input.source, input.operation),
            catch: () => invalid("guest-study.spoken.fail-input"),
          });
          const receipt = yield* one(
            tx,
            "guest-study.spoken.fail",
            "SELECT fail_guest_spoken_answer_v1($1,$2::jsonb,$3,$4,$5,$6,$7) AS result",
            [
              input.source.ownerId,
              JSON.stringify(input.operation),
              input.commandId,
              input.leaseToken,
              input.resourceReservationId,
              input.providerDisposition,
              input.providerFailureKind,
            ],
            FailureReceipt,
          );
          return receipt.state === "reserved"
            ? {
                state: "pending_confirmation" as const,
                operation: input.operation,
                outcomeId: receipt.operationId,
              }
            : { state: "known_aborted" as const, operation: input.operation };
        }),
      ),
    persistSuccessfulSpokenResult: (input) =>
      run((tx) =>
        Effect.gen(function* () {
          const checkpoint = input.checkpoint;
          yield* Effect.try({
            try: () => {
              assertOperation(checkpoint.source, checkpoint.operation);
              const { archive, leaseToken, ...accepted } = checkpoint.result;
              decode(OwnerSpokenRetainedSuccessResultSchema, accepted);
              decode(Archive, archive);
              decode(Reserved.fields.leaseToken, leaseToken);
              check(
                checkpoint.result.commandId === checkpoint.commandId &&
                  checkpoint.result.requestHash === checkpoint.operation.requestHash,
              );
            },
            catch: () => invalid("guest-study.spoken.ack-input"),
          });
          // This frozen method ONLY acknowledges an existing original checkpoint;
          // the internal success protocol must have persisted before archive I/O.
          // Captured access is not a second fresh lease requirement after provider.
          const receipt = yield* one(
            tx,
            "guest-study.spoken.ack",
            "SELECT acknowledge_owner_guest_spoken_success_v1($1::jsonb,$2::jsonb,$3,$4,$5::jsonb,$6::jsonb,$7,$8::bigint) AS result",
            [
              JSON.stringify(checkpoint.source),
              JSON.stringify(checkpoint.operation),
              checkpoint.commandId,
              checkpoint.result.leaseToken,
              JSON.stringify(checkpoint.result),
              JSON.stringify(checkpoint.providerResult),
              checkpoint.resourceReservationId,
              checkpoint.deletionFenceRevision,
            ],
            CheckpointReceipt,
          );
          if (receipt.state === "reserved" || receipt.result === null)
            return {
              state: "pending_confirmation" as const,
              operation: checkpoint.operation,
              outcomeId: receipt.outcome_id,
            };
          yield* Effect.try({
            try: () =>
              check(receipt.result !== null && receipt.result.checkpointId === receipt.outcome_id),
            catch: () => invalid("guest-study.spoken.ack-correlation"),
          });
          return {
            state: "completed" as const,
            operation: checkpoint.operation,
            outcomeId: receipt.outcome_id,
            result: receipt.result,
          };
        }),
      ),
    completeSpokenAnswer: (input) =>
      run((tx) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => {
              assertOperation(input.source, input.operation);
              decode(Id, input.checkpointId);
            },
            catch: () => invalid("guest-study.spoken.complete-input"),
          });
          // access is deliberately NOT checked/re-serialized here. Only already
          // accepted immutable checkpoint+original source/op/call/lease authorizes
          // this continuation. Provider success is never regraded or redispatched.
          const values = [
            input.source.ownerId,
            JSON.stringify(input.operation),
            input.checkpointId,
          ];
          const prepared = yield* one(
            tx,
            "guest-study.spoken.complete-prepare",
            "SELECT prepare_guest_spoken_finalization_v1($1,$2::jsonb,$3) AS result",
            values,
            SpokenPrepared,
          );
          if (prepared.state !== "candidate")
            return yield* Effect.try({
              try: () => outcome(prepared, input.operation),
              catch: () => invalid("guest-study.spoken.complete-replay"),
            });
          const facts = yield* Effect.try({
            try: () => {
              check(
                prepared.checkpointId === input.checkpointId &&
                  prepared.sourceOwnerId === input.source.ownerId &&
                  prepared.result.requestHash === input.operation.requestHash &&
                  prepared.item.session_item_id === prepared.result.sessionItemId &&
                  prepared.item.exercise_type === "say_it_back",
              );
              const decision = evaluateStudySpokenAttempt({
                grade: prepared.result.grade,
                attemptNumber: prepared.result.attemptNumber,
                rerecordEnabled: prepared.result.rerecordEnabled,
                rerecordAssessment: prepared.result.rerecordAssessment,
                priorRerecordRecorded: prepared.priorRerecordRecorded,
                review: {
                  ...prepared.review,
                  reviewedAt: Date.parse(prepared.result.acceptedAt),
                },
              });
              const { feedback, tokenDiff } = projectStudySpokenFeedback(prepared.result.grade);
              const spoken = projectStudySpokenResultMetadata({
                languageProvenance: prepared.result.languageProvenance,
                rerecordEnabled: prepared.result.rerecordEnabled,
                rerecord: decision.kind === "ungraded_rerecord",
                assessment: prepared.result.rerecordAssessment,
              });
              return { decision, feedback, tokenDiff, spoken };
            },
            catch: () => invalid("guest-study.spoken.shared-decision"),
          });
          const schedule = serializedSchedule(facts.decision);
          const applied = yield* one(
            tx,
            "guest-study.spoken.complete-item",
            "SELECT apply_guest_spoken_item_mutation_v1($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) AS result",
            [
              ...values,
              JSON.stringify(prepared),
              JSON.stringify(schedule),
              JSON.stringify(facts.feedback),
              JSON.stringify(facts.tokenDiff),
              JSON.stringify(facts.spoken),
            ],
            SpokenApplied,
          );
          if (applied.state !== "mutated")
            return yield* Effect.try({
              try: () => outcome(applied, input.operation),
              catch: () => invalid("guest-study.spoken.concurrent-result"),
            });
          yield* Effect.try({
            try: () =>
              check(
                applied.operationId === prepared.operationId &&
                  applied.capture.captureId === prepared.captureId &&
                  applied.priorPresentationCount === prepared.priorPresentationCount,
              ),
            catch: () => invalid("guest-study.spoken.mutation-correlation"),
          });
          const continuation = (transition: unknown) =>
            statement(
              tx,
              "guest-study.spoken.continue",
              "SELECT transition_guest_spoken_answer_v1($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb)",
              [
                ...values,
                JSON.stringify(prepared),
                JSON.stringify(schedule),
                JSON.stringify(transition),
              ],
            );
          yield* continueStudyLessonMutation(
            {
              complete: continuation,
              advance: continuation,
              keepCurrent: continuation,
              unchanged: continuation,
            },
            {
              kind: facts.decision.kind === "ungraded_rerecord" ? "ungraded_rerecord" : "advance",
              priorPresentationCount: applied.priorPresentationCount,
              totalCards: applied.totalCards,
              remainingUnresolvedCards: applied.remainingCards,
            },
          );
          const done = yield* one(
            tx,
            "guest-study.spoken.finish",
            "SELECT finish_guest_spoken_answer_v1($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) AS result",
            [
              ...values,
              JSON.stringify(prepared),
              JSON.stringify(schedule),
              JSON.stringify(facts.feedback),
              JSON.stringify(facts.spoken),
            ],
            Resolved,
          );
          return yield* Effect.try({
            try: () =>
              outcome(done, input.operation, {
                communityId: prepared.result.communityId,
                sessionId: prepared.result.sessionId,
                sessionItemId: prepared.result.sessionItemId,
                attemptNumber: prepared.result.attemptNumber,
              }),
            catch: () => invalid("guest-study.spoken.result-correlation"),
          });
        }),
      ),
  };
};
