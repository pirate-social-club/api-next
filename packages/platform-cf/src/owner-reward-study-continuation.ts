// Private proposal segment for the frozen owner store. No endpoint/port edit.
// This segment handles GUEST source methods only; root composes ordinary-account
// dispatch with the retained adapter/shared continuation, without source rewrite.
import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
  continueStudyLessonMutation,
  type DurableParticipationOutcome,
  evaluateStudyChoice,
  evaluateStudySpokenAttempt,
  type GuestParticipationStoreFailure,
  GuestParticipationStoreRejected,
  type OwnerAwareStudyV2Store,
  type OwnerStudyAnswer,
  type ParticipationOperationIdentity,
  projectStudySpokenFeedback,
  projectStudySpokenResultMetadata,
} from "@pirate/application";
import type { OwnerSpokenCapturedContinuationStore } from "@pirate/application/owner-spoken-captured-continuation";
import {
  GuestIdentifierV1,
  GuestParticipationResultV1,
  GuestSha256V1,
  GuestStudyAnswerResultV1,
  StudySessionItemV2,
  StudySpokenLanguageProvenanceV2,
} from "@pirate/contracts";
import { scheduleStudyReviewV1 } from "@pirate/domain";
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
  participation: GuestParticipationResultV1,
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
    text: "SELECT set_config('transaction_timeout','3s',true),set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true),set_config('plan_cache_mode','force_generic_plan',true)",
    values: [],
    readonly: true,
  });
  const actual = yield* tx.execute({
    label: "guest-study.mutation.bounds.verify",
    text: "SELECT current_setting('transaction_timeout') AS transaction,current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement,current_setting('idle_in_transaction_session_timeout') AS idle,current_setting('plan_cache_mode') AS plan_cache_mode",
    values: [],
    readonly: true,
  });
  yield* Effect.try({
    try: () => {
      check(actual.rows.length === 1);
      decode(
        Schema.Struct({
          transaction: Schema.Literal("3s"),
          lock: Schema.Literal("250ms"),
          statement: Schema.Literal("2s"),
          idle: Schema.Literal("2s"),
          plan_cache_mode: Schema.Literal("force_generic_plan"),
        }),
        actual.rows[0],
      );
    },
    catch: () => rejected("resource-policy-unavailable"),
  });
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
      saved.participation.state === saved.answer.participation.state,
  );
  const economic = saved.participation;
  const projected = saved.answer.participation;
  if (economic.state === "admitted")
    check(
      projected.state === "admitted" &&
        economic.share_id === projected.share_id &&
        economic.original_drawing_id === projected.original_drawing_id &&
        economic.pool_leg_id === projected.pool_leg_id,
    );
  if (economic.state === "pending_confirmation")
    check(
      projected.state === "pending_confirmation" &&
        economic.operation.operation_kind === projected.operation.operation_kind &&
        economic.operation.idempotency_key === projected.operation.idempotency_key &&
        economic.operation.operation_id === projected.operation.operation_id,
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

const makeOwnerStudyMutationRunner = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) => {
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
  return run;
};

const AttemptToken = Schema.NullOr(Schema.Struct({ admissionId: Id, attemptFence: GuestSha256V1 }));
const CapturedChoice = Schema.Struct({
  state: Schema.Literal("captured"),
  operationId: Id,
  commandId: Id,
  originalContinuationNonce: GuestSha256V1,
});
const ChoiceLookup = Schema.NullOr(
  Schema.Union([
    CapturedChoice,
    Resolved,
    Schema.Struct({ state: Schema.Literal("practice_only") }),
  ]),
);
const RetainedChoiceGrade = Schema.Struct({
  correct: Schema.Boolean,
  spent: Schema.Boolean,
  resolved: Schema.Boolean,
  firstPass: Schema.Boolean,
  outcome: Schema.Literals(["correct", "incorrect"]),
  attemptState: Schema.Literals(["spent", "retryable"]),
  feedback: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({
      kind: Schema.Literal("choice_reveal"),
      correct_choice_key: Schema.NonEmptyString,
      correct_text: Schema.String,
      explanation: Schema.optional(Schema.String),
    }),
  ]),
});
const RecoveryChoice = Schema.Struct({
  source: Source,
  operation: Operation,
  communityId: Id,
  sessionId: Id,
  sessionItemId: Id,
  attemptNumber: Attempt,
  captured: CapturedChoice,
});
type ChoiceContinuationInput = Pick<
  Input<"submitAnswer">,
  "source" | "operation" | "communityId" | "sessionId" | "sessionItemId" | "attemptNumber"
>;
const CapturedChoiceReady = Schema.Struct({
  state: Schema.Literal("candidate"),
  commandId: Id,
  operationId: Id,
  attemptId: Id,
  capture: JsonCandidate,
  grade: RetainedChoiceGrade,
  originalAdmissionResult: Schema.Unknown,
  effectiveReviewAt: ClockText,
});
const CapturedChoiceRead = Schema.Union([CapturedChoiceReady, Resolved]);
const Hold = Schema.Union([
  Resolved,
  Schema.Struct({ state: Schema.Literal("practice_only") }),
  Schema.Struct({ state: Schema.Literal("prepare_required") }),
  Schema.Struct({ state: Schema.Literal("hold_refused") }),
  Schema.Struct({
    state: Schema.Literal("hold_prepared"),
    admissionId: Id,
    attemptFence: GuestSha256V1,
  }),
]);
const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const saltBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16));

/** Private concrete successor. Caller dispatches ordinary Accounts separately.
 * No flags/grants or frozen port/client edit. NEW safety config is required only
 * after an original-capture lookup returned authoritative absence under locks.
 */
export const makeControlPlaneGuestRewardStudyContinuations = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  practice: Partial<Pick<OwnerAwareStudyV2Store, "submitAnswer">> &
    OwnerSpokenCapturedContinuationStore,
) => {
  const run = makeOwnerStudyMutationRunner(runtime);
  const originalSpoken = {
    complete: (
      input: Parameters<OwnerSpokenCapturedContinuationStore["completeCapturedSpokenAnswer"]>[0],
      expectedFence: string | null,
    ) =>
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
            "SELECT prepare_owner_guest_reward_spoken_v1($1::jsonb,$2::jsonb,$3,$4) AS result",
            [JSON.stringify(input.source), values[1], values[2], expectedFence],
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
            "SELECT apply_owner_guest_reward_spoken_v1($1::jsonb,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9) AS result",
            [
              JSON.stringify(input.source),
              values[1],
              values[2],
              JSON.stringify(prepared),
              JSON.stringify(schedule),
              JSON.stringify(facts.feedback),
              JSON.stringify(facts.tokenDiff),
              JSON.stringify(facts.spoken),
              expectedFence,
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
            "SELECT finish_owner_guest_reward_spoken_v1($1::jsonb,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8) AS result",
            [
              JSON.stringify(input.source),
              values[1],
              values[2],
              JSON.stringify(prepared),
              JSON.stringify(schedule),
              JSON.stringify(facts.feedback),
              JSON.stringify(facts.spoken),
              expectedFence,
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
  const completeChoice = Effect.fn("GuestRewardStudy.completeChoice")(function* (
    input: ChoiceContinuationInput,
    saved: typeof CapturedChoice.Type,
  ) {
    const originalBase = [
      JSON.stringify(input.source),
      JSON.stringify(input.operation),
      saved.commandId,
      saved.originalContinuationNonce,
    ];
    const token = yield* run((tx) =>
      one(
        tx,
        "owner-reward.choice.retry-hold",
        "SELECT resume_owner_guest_reward_choice_hold_v1($1::jsonb,$2::jsonb,$3,$4,$5) AS result",
        [...originalBase, randomHex()],
        AttemptToken,
      ),
    );
    const expectedFence = token?.attemptFence ?? null;
    return yield* run((tx) =>
      Effect.gen(function* () {
        const base = [
          JSON.stringify(input.source),
          JSON.stringify(input.operation),
          saved.commandId,
          saved.originalContinuationNonce,
        ];
        const retained = yield* one(
          tx,
          "owner-reward.choice.retained",
          "SELECT read_owner_guest_reward_choice_v1($1::jsonb,$2::jsonb,$3,$4) AS result",
          base,
          CapturedChoiceRead,
        );
        if (retained.state !== "candidate") return outcome(retained, input.operation, input);
        const candidate = retained.capture;
        yield* Effect.try({
          try: () =>
            check(
              retained.operationId === saved.operationId &&
                candidate.sourceOwnerId === input.source.ownerId &&
                candidate.communityId === input.communityId &&
                candidate.sessionId === input.sessionId &&
                candidate.sessionItemId === input.sessionItemId &&
                candidate.attemptNumber === input.attemptNumber,
            ),
          catch: () => invalid("owner-reward.choice.original"),
        });
        // Original grade is immutable; only the current locked review schedule is derived.
        const grade = retained.grade;
        const decision = {
          ...grade,
          review: scheduleStudyReviewV1(
            { ...candidate.review, reviewedAt: Date.parse(retained.effectiveReviewAt) },
            grade.correct ? (grade.firstPass ? "good" : "hard") : "again",
          ),
        };
        const schedule = serializedSchedule(decision);
        const applied = yield* one(
          tx,
          "owner-reward.choice.apply",
          "SELECT apply_owner_guest_reward_choice_v1($1::jsonb,$2::jsonb,$3,$4,$5::jsonb,$6::jsonb,$7) AS result",
          [...base, JSON.stringify(candidate), JSON.stringify(schedule), expectedFence],
          JsonApplied,
        );
        if (applied.state !== "mutated") return outcome(applied, input.operation, input);
        const continuation = (transition: unknown) =>
          statement(
            tx,
            "owner-reward.choice.transition",
            "SELECT transition_guest_json_answer_v1($1::jsonb,$2,$3::jsonb,$4::jsonb,$5::jsonb)",
            [
              base[1],
              retained.operationId,
              JSON.stringify(candidate),
              JSON.stringify(schedule),
              JSON.stringify(transition),
            ],
          );
        yield* continueStudyLessonMutation(
          { complete: continuation, advance: continuation, keepCurrent: continuation },
          {
            kind: decision.spent ? "advance" : "choice_retryable",
            priorPresentationCount: applied.priorPresentationCount,
            totalCards: applied.totalCards,
            remainingUnresolvedCards: applied.remainingCards,
          },
        );
        const done = yield* one(
          tx,
          "owner-reward.choice.finish",
          "SELECT finish_owner_guest_reward_choice_v1($1::jsonb,$2::jsonb,$3,$4,$5::jsonb,$6::jsonb,$7) AS result",
          [...base, JSON.stringify(candidate), JSON.stringify(schedule), expectedFence],
          Resolved,
        );
        return outcome(done, input.operation, input);
      }),
    );
  });
  return {
    recoverCapturedChoices: Effect.fn("GuestRewardStudy.recoverCapturedChoices")(function* (
      maximum: number,
    ) {
      const candidates = yield* run((tx) =>
        one(
          tx,
          "owner-reward.choice.recovery-list",
          "SELECT list_captured_owner_guest_reward_choices_v1($1::integer) AS result",
          [maximum],
          Schema.Array(RecoveryChoice),
        ),
      );
      // Each original owning protocol has its own bounded transactions. Failure or
      // unknown COMMIT retains the original capture; a later cron repeats its key.
      return yield* Effect.forEach(candidates, (c) => completeChoice(c, c.captured), {
        concurrency: 1,
      });
    }),
    submitAnswer: Effect.fn("GuestRewardStudy.submitAnswer")(function* (
      input: Input<"submitAnswer">,
    ) {
      if (input.source.kind !== "guest" || input.access.kind !== "guest")
        return yield* Effect.fail(rejected("owner-mismatch"));
      const access = {
        kind: input.access.kind,
        ownerId: input.access.ownerId,
        credentialId: input.access.credentialId,
        origin: input.access.origin,
      };
      const values = [
        JSON.stringify(access),
        JSON.stringify(input.operation),
        input.communityId,
        input.sessionId,
        input.sessionItemId,
        input.attemptNumber,
        JSON.stringify(input.answer),
      ];
      const existing = yield* run((tx) =>
        one(
          tx,
          "owner-reward.choice.find",
          "SELECT find_owner_guest_reward_choice_for_answer_v1($1::jsonb,$2::jsonb,$3,$4,$5,$6::integer,$7::jsonb) AS result",
          values,
          ChoiceLookup,
        ),
      );
      if (existing?.state === "practice_only") {
        if (practice.submitAnswer === undefined)
          return yield* Effect.fail(rejected("resource-policy-unavailable"));
        return yield* practice.submitAnswer(input);
      }
      if (existing !== null)
        return existing.state === "captured"
          ? yield* completeChoice(input, existing)
          : outcome(existing, input.operation, input);
      const captured = yield* run((tx) =>
        Effect.gen(function* () {
          const prepared = yield* one(
            tx,
            "owner-reward.choice.prepare",
            "SELECT prepare_guest_reward_json_answer_v1($1::jsonb,$2::jsonb,$3,$4,$5,$6::integer,$7::jsonb) AS result",
            [JSON.stringify(input.access), ...values.slice(1)],
            JsonPrepared,
          );
          if (prepared.state !== "candidate") return prepared;
          const margin = null;
          const decision = evaluateStudyChoice({
            submittedChoiceKey: prepared.answer.choice_key,
            correctChoiceKey: prepared.grader.correctChoiceKey,
            correctText: prepared.grader.correctText,
            explanation: prepared.grader.explanation ?? undefined,
            attemptNumber: prepared.attemptNumber,
            maximumAttempts: prepared.item.maximum_attempts,
            review: { ...prepared.review, reviewedAt: Date.parse(prepared.acceptedAt) },
          });
          return yield* one(
            tx,
            "owner-reward.choice.reserve",
            "SELECT reserve_guest_reward_choice_with_hold_v1($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::bytea,$12::integer) AS result",
            [
              JSON.stringify(input.access),
              values[1],
              JSON.stringify(prepared),
              JSON.stringify(serializedSchedule(decision)),
              `guest_answer_${crypto.randomUUID()}`,
              input.attemptId,
              `guest_choice_${crypto.randomUUID()}`,
              randomHex(),
              `owner_admission_${crypto.randomUUID()}`,
              randomHex(),
              saltBytes(randomHex()),
              margin,
            ],
            Schema.Union([CapturedChoice, Resolved]),
          );
        }),
      );
      return captured.state === "captured"
        ? yield* completeChoice(input, captured)
        : outcome(captured, input.operation, input);
    }),
    completeCapturedSpokenAnswer: Effect.fn("GuestRewardStudy.completeCapturedSpokenAnswer")(
      function* (
        input: Parameters<OwnerSpokenCapturedContinuationStore["completeCapturedSpokenAnswer"]>[0],
      ) {
        const values = [
          JSON.stringify(input.source),
          JSON.stringify(input.operation),
          input.checkpointId,
        ];
        const old = yield* run((tx) =>
          one(
            tx,
            "owner-reward.spoken.find",
            "SELECT find_guest_reward_spoken_hold_v1($1::jsonb,$2::jsonb,$3) AS result",
            values,
            Hold,
          ),
        );
        if (old.state === "practice_only")
          return yield* practice.completeCapturedSpokenAnswer(input);
        if (old.state === "completed" || old.state === "reserved" || old.state === "known_aborted")
          return outcome(old, input.operation);
        if (old.state === "prepare_required") {
          const margin = null;
          yield* run((tx) =>
            one(
              tx,
              "owner-reward.spoken.hold",
              "SELECT prepare_guest_reward_spoken_hold_v1($1,$2::jsonb,$3,$4,$5,$6::bytea,$7::integer) AS result",
              [
                input.source.ownerId,
                values[1],
                input.checkpointId,
                `owner_admission_${crypto.randomUUID()}`,
                randomHex(),
                saltBytes(randomHex()),
                margin,
              ],
              Hold,
            ),
          );
        }
        const token = yield* run((tx) =>
          one(
            tx,
            "owner-reward.spoken.retry-hold",
            "SELECT resume_owner_guest_reward_spoken_hold_v1($1::jsonb,$2::jsonb,$3,$4) AS result",
            [...values, randomHex()],
            AttemptToken,
          ),
        );
        return yield* originalSpoken.complete(input, token?.attemptFence ?? null);
      },
    ),
  };
};

/** Install into both foreground protocol and private closed-upload recovery.
 * Accepted checkpoint ACK is unchanged; every Guest owning completion takes
 * the original-draw preparation path, including config-free process recovery. */
export const composeGuestRewardCapturedContinuation = (
  accepted: OwnerSpokenCapturedContinuationStore,
  reward: ReturnType<typeof makeControlPlaneGuestRewardStudyContinuations>,
): OwnerSpokenCapturedContinuationStore => ({
  acknowledgeCapturedSpokenResult: accepted.acknowledgeCapturedSpokenResult,
  completeCapturedSpokenAnswer: reward.completeCapturedSpokenAnswer,
});
export const composeGuestRewardStudyMutationMethods = (
  base: Methods,
  reward: ReturnType<typeof makeControlPlaneGuestRewardStudyContinuations>,
): Methods => ({
  ...base,
  submitAnswer: reward.submitAnswer,
  completeSpokenAnswer: (input) =>
    reward.completeCapturedSpokenAnswer({
      source: input.source,
      operation: input.operation,
      checkpointId: input.checkpointId,
    }),
});
