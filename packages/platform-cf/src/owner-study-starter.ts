// REVIEW PROPOSAL ONLY. This implements exactly three frozen methods and is not
// a complete OwnerAwareStudyV2Store or activated HTTP composition. No port edit.
import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
  canonicalBodyHash,
  type DurableParticipationOutcome,
  type GuestParticipationStoreFailure,
  GuestParticipationStoreRejected,
  type GuestResourceAdmissionPolicy,
  type OwnerAwareStudyV2Store,
  type OwnerStudySession,
} from "@pirate/application";
import type {
  OwnerGuestAtomicStarter,
  OwnerGuestAtomicStartInput,
  OwnerGuestAtomicStartOutcome,
} from "@pirate/application/owner-guest-atomic-start";
import {
  GuestIdentifierV1,
  GuestRewardTermsV1,
  GuestSha256V1,
  GuestStudyPreparedContentV1,
  GuestStudySessionV1,
  GuestStudyStartOperationV1,
  StudySessionItemV2,
  StudySessionV2,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { projectPreparedGuestStudyContent } from "./guest-prepared-study-content-store.ts";
import { readGuestResourceAdmissionPolicy } from "./guest-resource-policy.ts";
import { projectStudySessionItemV2 } from "./study-v2-item-projection.ts";

type Methods = Pick<OwnerAwareStudyV2Store, "startSession" | "getSession" | "findStartOperation">;
type Input<K extends keyof Methods> = Parameters<Methods[K]>[0];
type StartIntent = Omit<Input<"startSession">, "resourceReservationId">;
// One application-owned private seam; these aliases preserve local naming only.
export type GuestAtomicStudyStartInput = OwnerGuestAtomicStartInput;
export type GuestAtomicStudyStartOutcome = OwnerGuestAtomicStartOutcome;
type Disclosure = GuestStudyPreparedContentV1["disclosure"];
const reject = (reason: GuestParticipationStoreRejected["reason"]) =>
  new GuestParticipationStoreRejected({ reason });
const invalid = (label: string) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });
const OwnerSession = Schema.Union([
  Schema.Struct({
    source: Schema.Struct({
      kind: Schema.Literal("guest"),
      ownerId: GuestIdentifierV1,
    }),
    session: GuestStudySessionV1,
  }),
  Schema.Struct({
    source: Schema.Struct({
      kind: Schema.Literal("account"),
      ownerId: GuestIdentifierV1,
      accountId: GuestIdentifierV1,
      personaId: GuestIdentifierV1,
    }),
    session: StudySessionV2,
  }),
]);
// The private SELECT must have exactly its accepted public whitelist.
const Item = StudySessionItemV2.fields;
const Line = Item.line.fields;
const Languages = Item.languages.fields;
const PreparedRow = Schema.Struct({
  exercise_version_id: Item.exercise_version_id,
  exercise_review_key: Item.exercise_review_key,
  exercise_type: Item.exercise_type,
  exercise_variant: Item.exercise_variant,
  community_id: StudySessionV2.fields.community_id,
  post_id: Line.post_id,
  audio_revision: Line.audio_revision,
  lyrics_revision: Line.lyrics_revision,
  lyric_line_id: Line.lyric_line_id,
  line_version: Line.line_version,
  line_source_hash: Line.line_source_hash,
  study_unit_id: Line.study_unit_id,
  learning_language: Schema.Literal("en"),
  target_language: Languages.target_language,
  learner_band: Item.learner_band,
  language_profile_revision: Line.audio_revision,
  presentation: Item.presentation,
  answer_visibility: Item.answer_visibility,
  feedback_release: Item.feedback_release,
  grader_policy_revision: Item.grader_policy_revision,
  feedback_policy_revision: Item.feedback_policy_revision,
  quality_policy_revision: Item.quality_policy_revision,
  ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
}).check(
  Schema.makeFilter((row) =>
    (row.exercise_type === "say_it_back" &&
      row.target_language === null &&
      row.learner_band === null) ||
    (row.exercise_type === "translation_choice" &&
      row.target_language !== null &&
      row.learner_band !== null)
      ? undefined
      : "Exact prepared source language/band shape",
  ),
);
const LimitsRow = Schema.Struct({
  transaction: Schema.Literal("3s"),
  lock: Schema.Literal("250ms"),
  statement: Schema.Literal("2s"),
  idle: Schema.Literal("2s"),
});
const Candidate = Schema.Struct({
  state: Schema.Literal("candidate"),
  reservationId: GuestIdentifierV1,
  sourceOwnerId: GuestIdentifierV1,
  sessionId: GuestIdentifierV1,
  targetLanguage: Languages.target_language,
  learnerBand: Item.learner_band,
  paidAttemptUnits: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 40 })),
  catalogue: Schema.Array(Schema.Unknown),
  rows: Schema.Array(PreparedRow).check(Schema.isMinLength(4), Schema.isMaxLength(10)),
});
const Resolved = Schema.Struct({
  state: Schema.Literals(["completed", "reserved", "known_aborted"]),
  operationId: GuestIdentifierV1,
  result: Schema.NullOr(OwnerSession),
}).check(
  Schema.makeFilter((value) =>
    (value.state === "completed") === (value.result !== null)
      ? undefined
      : "Immutable start outcome shape",
  ),
);
const SelectedPlan = Schema.Struct({
  targetLanguage: Candidate.fields.targetLanguage,
  learnerBand: Candidate.fields.learnerBand,
  paidAttemptUnits: Candidate.fields.paidAttemptUnits,
  catalogue: Candidate.fields.catalogue,
  rows: Candidate.fields.rows,
});
const StartOperation = Schema.Struct({
  sourceOwnerId: GuestIdentifierV1,
  kind: Schema.Literal("study_start"),
  idempotencyKey: GuestIdentifierV1,
  requestHash: GuestSha256V1,
});
const AtomicReservedResource = Schema.Struct({
  state: Schema.Literal("completed"),
  outcome_id: GuestIdentifierV1,
  result: Schema.Struct({
    state: Schema.Literal("reserved"),
    reservationId: GuestIdentifierV1,
    sourceOwnerId: GuestIdentifierV1,
    operation: StartOperation,
    remainingUnits: Candidate.fields.paidAttemptUnits,
    policyVersion: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
    costPolicyVersion: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  }),
});
const AtomicRefusedResource = Schema.Struct({
  state: Schema.Literal("completed"),
  outcome_id: GuestIdentifierV1,
  result: Schema.Struct({
    state: Schema.Literals(["rate_limited", "budget_refused"]),
    retryAfterSeconds: Schema.NullOr(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
    ),
  }),
});
const AtomicPreparation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("start_outcome"), outcome: Resolved }),
  Schema.Struct({
    kind: Schema.Literal("reservation"),
    reservation: AtomicReservedResource,
    plan: Schema.NullOr(SelectedPlan),
    operationId: Schema.NullOr(GuestIdentifierV1),
  }),
  Schema.Struct({
    kind: Schema.Literal("resource_refused"),
    reservation: AtomicRefusedResource,
    plan: Schema.NullOr(SelectedPlan),
    operationId: Schema.NullOr(GuestIdentifierV1),
  }),
]);
const Prepared = Schema.Union([Candidate, Resolved]);
const sqlRejection = (error: ControlPlaneStatementFailed) => {
  const reasons = {
    GP001: "proof-revoked",
    GP002: "owner-mismatch",
    GP003: "authority-conflict",
    GP005: "idempotency-conflict",
    GP006: "resource-policy-unavailable",
    GP007: "lease-expired",
    GP009: "deletion-in-progress",
    GP010: "not-found",
  } as const;
  const code = error.sqlState;
  return code !== null && Object.hasOwn(reasons, code)
    ? reject(reasons[code as keyof typeof reasons])
    : error;
};
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const one = <S extends Schema.ConstraintDecoder<unknown>>(
  transaction: ControlPlaneTransaction,
  label: string,
  text: string,
  values: readonly unknown[],
  schema: S,
) =>
  transaction.execute({ label, text, values, readonly: false }).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => {
          if (result.rows.length !== 1) throw new Error();
          const envelope = decode(Schema.Struct({ result: Schema.Unknown }), result.rows[0]);
          return decode(schema, envelope.result);
        },
        catch: () => invalid(`${label}.decode`),
      }),
    ),
  );
const limits = Effect.fn("OwnerStudyStarter.limits")(function* (
  transaction: ControlPlaneTransaction,
) {
  yield* transaction.execute({
    label: "guest-study.limits.set",
    text: "SELECT set_config('transaction_timeout','3s',true),set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)",
    values: [],
    readonly: true,
  });
  const actual = yield* transaction.execute({
    label: "guest-study.limits.verify",
    text: "SELECT current_setting('transaction_timeout') AS transaction,current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement,current_setting('idle_in_transaction_session_timeout') AS idle",
    values: [],
    readonly: true,
  });
  yield* Effect.try({
    try: () => {
      if (actual.rows.length !== 1) throw new Error();
      decode(LimitsRow, actual.rows[0]);
    },
    catch: () => invalid("guest-study.limits.verify.decode"),
  });
});
const assertGuestResult = (
  result: OwnerStudySession,
  input: StartIntent,
  expectedSessionId?: string,
) => {
  if (
    result.source.kind !== "guest" ||
    result.session.object !== "guest_study_session_v1" ||
    (expectedSessionId !== undefined && result.session.session_id !== expectedSessionId) ||
    result.source.ownerId !== input.source.ownerId ||
    result.session.owner_id !== input.source.ownerId ||
    result.session.community_id !== input.communityId ||
    result.session.post_id !== input.postId ||
    result.session.reward_mode !== input.rewardMode
  )
    throw new Error();
  if (result.session.reward_mode === "megapot_guest_v1") {
    const original = decode(GuestRewardTermsV1, input.rewardTerms);
    const stored = decode(GuestRewardTermsV1, result.session.reward_terms);
    if (
      !Object.entries(original).every(([key, value]) =>
        Object.entries(stored).some(([other, otherValue]) => key === other && value === otherValue),
      )
    )
      throw new Error();
  } else if (result.session.reward_terms !== null) throw new Error();
};
const assertReadResult = (result: OwnerStudySession | null, input: Input<"getSession">) => {
  if (result === null) return;
  if (
    result.session.session_id !== input.sessionId ||
    result.session.community_id !== input.communityId
  )
    throw new Error();
  if (result.source.kind === "guest") {
    // Current packet has no accepted account-to-Guest association reader.
    if (
      result.session.object !== "guest_study_session_v1" ||
      input.access.kind !== "guest" ||
      result.source.ownerId !== input.access.ownerId ||
      result.session.owner_id !== result.source.ownerId
    )
      throw new Error();
  } else {
    if (
      result.session.object !== "study_session_v2" ||
      input.access.kind !== "account" ||
      result.source.accountId !== input.access.accountId ||
      result.source.personaId !== result.session.persona_id
    )
      throw new Error();
  }
};
const assertLookupResult = (
  result: GuestStudyStartOperationV1,
  input: Input<"findStartOperation">,
) => {
  if (input.access.kind !== "guest") throw new Error();
  // Abort/absence on an original empty alias is authorized by the proved SQL
  // root. Only completed sessions expose an immutable established source.
  if (result.state !== "completed") return;
  if (
    result.session.owner_id !== input.sourceOwnerId ||
    result.session.owner_id !== input.access.ownerId ||
    result.session.community_id !== input.communityId ||
    result.session.post_id !== input.postId
  )
    throw new Error();
};
const outcome = (
  reply: Schema.Schema.Type<typeof Resolved>,
  input: StartIntent,
): DurableParticipationOutcome<OwnerStudySession> => {
  if (reply.state === "known_aborted")
    return { state: "known_aborted", operation: input.operation };
  if (reply.state === "reserved")
    return {
      state: "pending_confirmation",
      operation: input.operation,
      outcomeId: reply.operationId,
    };
  if (reply.result === null) throw new Error();
  assertGuestResult(reply.result, input);
  return {
    state: "completed",
    operation: input.operation,
    outcomeId: reply.operationId,
    result: reply.result,
  };
};

export const makeControlPlaneOwnerStudyStarter = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  disclosure: Disclosure | null,
  rawPolicy: unknown,
  newOperationId: () => string = () => `guest_start_${crypto.randomUUID()}`,
  rawPurchaseSafetyMarginSeconds?: unknown,
): Methods & OwnerGuestAtomicStarter => {
  // Explicit reviewed server composition inputs, no invented production defaults.
  const configuredDisclosure =
    disclosure === null ? null : decode(GuestStudyPreparedContentV1.fields.disclosure, disclosure);
  const policy = readGuestResourceAdmissionPolicy(rawPolicy);
  const provide = <A>(effect: Effect.Effect<A, GuestParticipationStoreFailure, ControlPlaneDb>) =>
    effect.pipe(
      Effect.catchTag("ControlPlaneStatementFailed", (error) => Effect.fail(sqlRejection(error))),
      Effect.provide(runtime),
    );
  const validateIntent = Effect.fn("GuestStudyStarter.validateIntent")(function* (
    input: StartIntent,
    acceptedRewardPreviewTermsHash?: string,
  ) {
    if (acceptedRewardPreviewTermsHash !== undefined) {
      if (input.rewardMode !== "megapot_guest_v1")
        return yield* reject("resource-policy-unavailable");
      yield* Effect.try({
        try: () => decode(GuestSha256V1, acceptedRewardPreviewTermsHash),
        catch: () => reject("resource-policy-unavailable"),
      });
    }
    // Practice-only still has paid spoken work. Missing policy cannot yield
    // a NEW candidate; SQL may only recover an already accepted exact receipt.
    if (
      (input.rewardMode === "practice_only" && input.rewardTerms !== null) ||
      (input.rewardMode === "megapot_guest_v1" &&
        input.rewardTerms === null &&
        acceptedRewardPreviewTermsHash === undefined) ||
      (input.rewardMode !== "practice_only" && input.rewardMode !== "megapot_guest_v1")
    )
      return yield* reject("resource-policy-unavailable");
    if (
      input.source.kind !== "guest" ||
      input.access.kind !== "guest" ||
      input.operation.kind !== "study_start" ||
      input.operation.sourceOwnerId !== input.source.ownerId ||
      input.access.ownerId !== input.source.ownerId ||
      input.operation.idempotencyKey !== input.idempotencyKey ||
      input.operation.requestHash !== input.requestHash
    )
      return yield* reject("owner-mismatch");
  });
  // ONE accepted projection/capture implementation for frozen and atomic callers.
  const startInTransaction = Effect.fn("GuestStudyStarter.startInTransaction")(function* (
    transaction: ControlPlaneTransaction,
    input: Input<"startSession">,
    activePolicy: GuestResourceAdmissionPolicy | null,
    expectedPlan: Schema.Schema.Type<typeof SelectedPlan> | null = null,
    capturedOperationId?: string,
    acceptedRewardPreviewTermsHash?: string,
  ) {
    const values = [
      JSON.stringify(input.access),
      JSON.stringify(input.operation),
      input.communityId,
      input.postId,
      input.resourceReservationId,
      input.targetLanguage,
      input.learnerBand,
      JSON.stringify(activePolicy),
    ];
    const prepared = yield* one(
      transaction,
      "guest-study.start.prepare",
      "SELECT prepare_guest_study_start_v1($1::jsonb,$2::jsonb,$3,$4,$5,$6,$7,$8::jsonb) AS result",
      values,
      Prepared,
    );
    if (prepared.state === "candidate" && expectedPlan !== null) {
      const hashes = yield* Effect.all([
        canonicalBodyHash(expectedPlan),
        canonicalBodyHash({
          targetLanguage: prepared.targetLanguage,
          learnerBand: prepared.learnerBand,
          paidAttemptUnits: prepared.paidAttemptUnits,
          catalogue: prepared.catalogue,
          rows: prepared.rows,
        }),
      ]).pipe(Effect.mapError(() => invalid("guest-study.start.atomic-plan")));
      if (hashes[0] !== hashes[1])
        return yield* Effect.fail(invalid("guest-study.start.atomic-plan"));
    }
    if (prepared.state !== "candidate")
      return yield* Effect.try({
        try: () => outcome(prepared, input),
        catch: () => invalid("guest-study.start.replay"),
      });
    // Current missing config cannot invalidate an original accepted outcome.
    // NEW only: fail before public projection/capture; atomic resource rolls back.
    if (configuredDisclosure === null) return yield* reject("resource-policy-unavailable");
    const items = yield* Effect.try({
      try: () => {
        if (
          prepared.sourceOwnerId !== input.source.ownerId ||
          prepared.reservationId !== input.resourceReservationId
        )
          throw new Error();
        const firstRow = prepared.rows[0];
        if (
          firstRow === undefined ||
          prepared.rows.some(
            (row) =>
              row.community_id !== input.communityId ||
              row.post_id !== input.postId ||
              row.audio_revision !== firstRow.audio_revision ||
              row.lyrics_revision !== firstRow.lyrics_revision ||
              (row.exercise_type === "translation_choice" &&
                (row.target_language !== prepared.targetLanguage ||
                  row.learner_band !== prepared.learnerBand)),
          )
        )
          throw new Error();
        const readiness = projectPreparedGuestStudyContent(
          {
            communityId: input.communityId,
            postId: input.postId,
            targetLanguage: input.targetLanguage,
            learnerBand: input.learnerBand,
          },
          configuredDisclosure,
          prepared.catalogue,
        );
        if (readiness.availability.state !== "ready") throw new Error();
        // Reservation's immutable original session candidate wins on retry.
        // input.sessionId and input.createdAt are deliberately not used here.
        return prepared.rows.map((row, ordinal) =>
          projectStudySessionItemV2(row, prepared.sessionId, ordinal),
        );
      },
      catch: () => invalid("guest-study.start.shared-projection"),
    });
    // The trusted current disclosure is required for NEW capture only. An
    // immutable same-key accepted start above keeps its original consent.
    if (
      input.disclosure.accepted !== true ||
      input.disclosure.version !== configuredDisclosure.version
    )
      return yield* reject("resource-policy-unavailable");
    const safetyMargin =
      input.rewardMode === "practice_only"
        ? null
        : yield* Effect.try({
            try: () =>
              decode(
                Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86400 })),
                rawPurchaseSafetyMarginSeconds,
              ),
            catch: () => reject("resource-policy-unavailable"),
          });
    let acceptedTerms = input.rewardTerms;
    if (input.rewardMode === "megapot_guest_v1" && acceptedRewardPreviewTermsHash !== undefined) {
      const first = prepared.rows[0];
      if (first === undefined) return yield* reject("resource-policy-unavailable");
      const quote = yield* one(
        transaction,
        "owner-reward.start.original-terms",
        "SELECT read_guest_reward_start_terms_v1($1,$2,$3::bigint,$4::bigint,$5,$6::integer) AS result",
        [
          input.communityId,
          input.postId,
          first.audio_revision,
          first.lyrics_revision,
          configuredDisclosure.version,
          safetyMargin,
        ],
        Schema.NullOr(
          Schema.Struct({ terms: GuestRewardTermsV1, reward_preview_terms_hash: GuestSha256V1 }),
        ),
      );
      if (quote === null || quote.reward_preview_terms_hash !== acceptedRewardPreviewTermsHash)
        return yield* reject("resource-policy-unavailable");
      acceptedTerms = quote.terms;
    }
    const operationId = capturedOperationId ?? newOperationId();
    const committed = yield* one(
      transaction,
      "guest-study.start.commit",
      input.rewardMode === "practice_only"
        ? "SELECT commit_guest_study_start_v1($1::jsonb,$2::jsonb,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15) AS result"
        : "SELECT commit_guest_study_start_with_rewards_v1($1::jsonb,$2::jsonb,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::integer) AS result",
      [
        ...values,
        JSON.stringify(prepared),
        JSON.stringify(items),
        operationId,
        input.timezone,
        configuredDisclosure.version,
        input.disclosure.version,
        input.disclosure.accepted,
        ...(input.rewardMode === "practice_only"
          ? []
          : [
              input.rewardMode,
              JSON.stringify(decode(GuestRewardTermsV1, acceptedTerms)),
              safetyMargin,
            ]),
      ],
      Resolved,
    );
    return yield* Effect.try({
      try: () => {
        if (committed.state === "completed" && committed.result !== null) {
          if (committed.operationId !== operationId) throw new Error();
          assertGuestResult(
            committed.result,
            { ...input, rewardTerms: acceptedTerms },
            prepared.sessionId,
          );
        }
        return outcome(committed, input);
      },
      catch: () => invalid("guest-study.start.outcome"),
    });
  });
  return {
    startSession: (input) =>
      provide(
        Effect.gen(function* () {
          yield* validateIntent(input);
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* limits(transaction);
              return yield* startInTransaction(transaction, input, policy);
            }),
          );
        }),
      ),
    startPreparedSession: (input) =>
      provide(
        Effect.gen(function* () {
          yield* validateIntent(input, input.acceptedRewardPreviewTermsHash);
          if (input.trustedEdge.kind !== "trusted_edge")
            return yield* Effect.fail(reject("resource-policy-unavailable"));
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* limits(transaction);
              const prepared = yield* one(
                transaction,
                "guest-study.start.atomic-reserve",
                "SELECT reserve_guest_prepared_study_start_v1($1::jsonb,$2::jsonb,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) AS result",
                [
                  JSON.stringify(input.access),
                  JSON.stringify(input.operation),
                  input.communityId,
                  input.postId,
                  input.sessionId,
                  input.targetLanguage,
                  input.learnerBand,
                  input.trustedEdge.fingerprint,
                  JSON.stringify(input.policy),
                  input.freshRefusalOperationId,
                ],
                AtomicPreparation,
              );
              if (prepared.kind === "start_outcome")
                return yield* Effect.try({
                  try: (): GuestAtomicStudyStartOutcome => ({
                    kind: "start",
                    outcome: outcome(
                      prepared.outcome,
                      input.rewardMode === "megapot_guest_v1" &&
                        input.rewardTerms === null &&
                        prepared.outcome.result !== null &&
                        prepared.outcome.result.session.object === "guest_study_session_v1"
                        ? { ...input, rewardTerms: prepared.outcome.result.session.reward_terms }
                        : input,
                    ),
                  }),
                  catch: () => invalid("guest-study.start.atomic-replay"),
                });
              if (prepared.kind === "resource_refused") {
                // Returning normally commits the real refusal witness. Only AFTER the
                // owning adapter acknowledges COMMIT may the application map this tag.
                return {
                  kind: "resource_refused" as const,
                  outcome: {
                    state: "completed" as const,
                    operation: input.operation,
                    outcomeId: prepared.reservation.outcome_id,
                    result: prepared.reservation.result,
                  },
                };
              }
              yield* Effect.try({
                try: () => {
                  const r = prepared.reservation;
                  if (
                    r.outcome_id !== r.result.reservationId ||
                    r.result.sourceOwnerId !== input.source.ownerId ||
                    r.result.operation.sourceOwnerId !== input.operation.sourceOwnerId ||
                    r.result.operation.kind !== input.operation.kind ||
                    r.result.operation.idempotencyKey !== input.operation.idempotencyKey ||
                    r.result.operation.requestHash !== input.operation.requestHash ||
                    (prepared.plan !== null &&
                      r.result.remainingUnits !== prepared.plan.paidAttemptUnits)
                  )
                    throw new Error();
                },
                catch: () => invalid("guest-study.start.atomic-resource"),
              });
              const result = yield* startInTransaction(
                transaction,
                { ...input, resourceReservationId: prepared.reservation.outcome_id },
                input.policy,
                prepared.plan,
                input.freshRefusalOperationId,
                input.acceptedRewardPreviewTermsHash,
              );
              return { kind: "start" as const, outcome: result };
            }),
          );
        }),
      ),
    getSession: (input) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* limits(transaction);
              const result = yield* one(
                transaction,
                "guest-study.session.read",
                "SELECT read_owner_study_session_snapshot_v1($1::jsonb,$2,$3) AS result",
                [JSON.stringify(input.access), input.communityId, input.sessionId],
                Schema.NullOr(OwnerSession),
              );
              return yield* Effect.try({
                try: () => {
                  assertReadResult(result, input);
                  return result;
                },
                catch: () => invalid("guest-study.session.read.correlation"),
              });
            }),
          );
        }),
      ),
    findStartOperation: (input) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* limits(transaction);
              const result = yield* one(
                transaction,
                "guest-study.start.lookup",
                "SELECT find_guest_study_start_operation_v1($1::jsonb,$2,$3,$4,$5) AS result",
                [
                  JSON.stringify(input.access),
                  input.sourceOwnerId,
                  input.communityId,
                  input.postId,
                  input.idempotencyKey,
                ],
                GuestStudyStartOperationV1,
              );
              return yield* Effect.try({
                try: () => {
                  assertLookupResult(result, input);
                  return result;
                },
                catch: () => invalid("guest-study.start.lookup.correlation"),
              });
            }),
          );
        }),
      ),
  };
};
