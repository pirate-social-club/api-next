// Platform private adapter proposal; no endpoint or runtime grant.
import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
  GuestParticipationStoreRejected,
  gradeStudySpokenTranscript,
  type OwnerSpokenPreArchiveCheckpointStore,
  type OwnerSpokenPreArchiveSuccess,
  projectStudySpokenFeedback,
} from "@pirate/application";
import {
  GuestIdentifierV1,
  GuestSha256V1,
  StudyFeedbackV2,
  StudySessionItemV2,
  StudySpokenLanguageProvenanceV2,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

const Id = GuestIdentifierV1;
const Operation = Schema.Struct({
  sourceOwnerId: Id,
  kind: Schema.Literal("study_answer"),
  idempotencyKey: Id,
  requestHash: GuestSha256V1,
});
const Provider = Schema.Struct({
  transcript: Schema.String.check(Schema.isMaxLength(4096)),
  detectedLanguage: Schema.NullOr(Schema.String.check(Schema.isMaxLength(35))),
  detectedLanguageConfidence: Schema.NullOr(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
});
const Token = Schema.Struct({
  token: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  position: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});
const BoundedTokens = Schema.Array(Token).check(Schema.isMaxLength(256));
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
export const OwnerSpokenAssessmentSchema = Schema.Struct({
  policyRevision: Schema.Literal("study_spoken_rerecord_v1"),
  voiceOverlap: Schema.Struct({
    revision: Schema.Literal("study_spoken_voice_overlap_v1"),
    matchedTokens: Count,
    referenceTokens: Count,
    belowOneThird: Schema.Boolean,
  }),
  strongRemainder: Schema.Struct({
    revision: Schema.Literal("study_spoken_strong_remainder_v1"),
    matchedTokens: Count,
    referenceTokens: Count,
    strong: Schema.Boolean,
  }),
  languageMismatch: Schema.Struct({
    revision: Schema.Literal("study_spoken_language_mismatch_v1"),
    expectedLanguage: Schema.NullOr(Schema.String),
    detectedLanguage: Provider.fields.detectedLanguage,
    detectedConfidence: Provider.fields.detectedLanguageConfidence,
    clear: Schema.Boolean,
  }),
  candidateReason: Schema.NullOr(
    Schema.Literals(["language_mismatch", "low_voice_overlap", "single_insertion"]),
  ),
});
export const OwnerSpokenGradeSchema = Schema.Struct({
  correct: Schema.Boolean,
  matchKind: Schema.Literals(["exact", "phonetic", "none"]),
  heardTranscript: Schema.String.check(Schema.isMaxLength(4096)),
  matched: BoundedTokens,
  missing: BoundedTokens,
  extra: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(256),
  ),
  substituted: Schema.Array(
    Schema.Struct({
      expected: Token,
      heard: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    }),
  ).check(Schema.isMaxLength(256)),
  policyRevision: Schema.Literals([
    "script_aware_token_diff_v1",
    "script_aware_token_phonetic_v2",
    "script_aware_token_phonetic_v3",
    "script_aware_token_phonetic_v4",
  ]),
});
export const OwnerSpokenRetainedSuccessResultSchema = Schema.Struct({
  acceptedAt: Schema.String,
  artifactId: Id,
  attemptId: Id,
  attemptNumber: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  audioByteSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 524288 })),
  audioContentType: Schema.Literals(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"]),
  audioDigest: GuestSha256V1,
  audioDurationMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 })),
  commandId: Id,
  communityId: Id,
  grade: OwnerSpokenGradeSchema,
  languageProvenance: StudySpokenLanguageProvenanceV2,
  rerecordAssessment: OwnerSpokenAssessmentSchema,
  rerecordEnabled: Schema.Boolean,
  providerDetectedLanguage: Provider.fields.detectedLanguage,
  providerDetectedLanguageConfidence: Provider.fields.detectedLanguageConfidence,
  qualificationId: Id,
  requestHash: GuestSha256V1,
  sessionId: Id,
  sessionItemId: Id,
});
const SuccessResult = Schema.Struct({
  ...OwnerSpokenRetainedSuccessResultSchema.fields,
  leaseToken: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
});
const Source = Schema.Struct({ kind: Schema.Literal("guest"), ownerId: Id });
const Context = Schema.Struct({
  item: StudySessionItemV2,
  referenceText: Schema.String,
  dominantLanguage: Schema.NullOr(Schema.String),
  languageProvenance: StudySpokenLanguageProvenanceV2,
  rerecordEnabled: Schema.Boolean,
  communityId: Id,
  disclosureVersion: Id,
  disclosureAccepted: Schema.Literal(true),
});
const Capture = Schema.Struct({
  captureId: Id,
  sourceOwnerId: Id,
  commandId: Id,
  operation: Operation,
  sessionId: Id,
  sessionItemId: Id,
  attemptId: Id,
  artifactId: Id,
  attemptNumber: SuccessResult.fields.attemptNumber,
  resourceReservationId: Id,
  deletionFenceRevision: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  audioDigest: GuestSha256V1,
  audioContentType: SuccessResult.fields.audioContentType,
  audioByteSize: SuccessResult.fields.audioByteSize,
  audioDurationMs: SuccessResult.fields.audioDurationMs,
  gradingContext: Context,
});
const Loaded = Schema.Struct({
  checkpointId: Id,
  captureId: Id,
  uploadAttemptId: Id,
  source: Source,
  operation: Operation,
  commandId: Id,
  result: SuccessResult,
  providerResult: Provider,
  resourceReservationId: Id,
  deletionFenceRevision: Capture.fields.deletionFenceRevision,
});
const Receipt = Schema.Struct({
  state: Schema.Literal("completed"),
  outcome_id: Id,
  result: Schema.Struct({ checkpointId: Id }),
});
const decode = <S extends Schema.ConstraintDecoder<unknown>>(s: S, v: unknown): S["Type"] =>
  Schema.decodeUnknownSync(s, { onExcessProperty: "error" })(v);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const invalid = (label: string, started = false) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: started ? "completed" : "not-started",
  });
const check = (condition: boolean) => {
  if (!condition) throw new Error();
};
const query = <S extends Schema.ConstraintDecoder<unknown>>(
  db: ControlPlaneTransaction,
  label: string,
  text: string,
  values: readonly unknown[],
  schema: S,
  readonly: boolean,
) =>
  db.execute({ label, text, values, readonly }).pipe(
    Effect.flatMap((rows) =>
      Effect.try({
        try: () => {
          check(rows.rows.length === 1);
          const outer = decode(Schema.Struct({ result: Schema.Unknown }), rows.rows[0]);
          return decode(schema, outer.result);
        },
        catch: () => invalid(`${label}.decode`, true),
      }),
    ),
  );
const parameters = (
  input: Pick<OwnerSpokenPreArchiveSuccess, "source" | "operation" | "commandId">,
  lease: string,
) => {
  decode(Source, input.source);
  decode(Operation, input.operation);
  decode(Id, input.commandId);
  decode(SuccessResult.fields.leaseToken, lease);
  check(input.source.ownerId === input.operation.sourceOwnerId);
  return [JSON.stringify(input.source), JSON.stringify(input.operation), input.commandId, lease];
};
const toSuccess = (saved: typeof Loaded.Type): OwnerSpokenPreArchiveSuccess => ({
  source: saved.source,
  operation: saved.operation,
  commandId: saved.commandId,
  result: saved.result,
  providerResult: saved.providerResult,
  resourceReservationId: saved.resourceReservationId,
  deletionFenceRevision: saved.deletionFenceRevision,
});

/** INTERNAL strict recovery decoder. No grading/provider invocation or public projection. */
export const decodeOwnerSpokenSavedCheckpoint = (
  value: unknown,
): Readonly<{
  checkpointId: string;
  success: OwnerSpokenPreArchiveSuccess;
}> | null => {
  const saved = decode(Schema.NullOr(Loaded), value);
  if (saved === null) return null;
  check(
    saved.source.ownerId === saved.operation.sourceOwnerId &&
      saved.commandId === saved.result.commandId &&
      saved.operation.requestHash === saved.result.requestHash &&
      Number.isFinite(Date.parse(saved.result.acceptedAt)) &&
      saved.providerResult.transcript === saved.result.grade.heardTranscript &&
      saved.providerResult.detectedLanguage === saved.result.providerDetectedLanguage &&
      saved.providerResult.detectedLanguageConfidence ===
        saved.result.providerDetectedLanguageConfidence,
  );
  return { checkpointId: saved.checkpointId, success: toSuccess(saved) };
};

export function makeControlPlaneOwnerSpokenPreArchiveCheckpointStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): OwnerSpokenPreArchiveCheckpointStore {
  const run = <A>(
    label: string,
    action: (db: ControlPlaneTransaction) => Effect.Effect<A, ControlPlaneError>,
  ) =>
    Effect.fn(label)(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute({
            label: `${label}.bounds`,
            text: "SELECT set_config('transaction_timeout','3s',true),set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)",
            values: [],
            readonly: true,
          });
          const readback = yield* tx.execute({
            label: `${label}.bounds-readback`,
            text: "SELECT current_setting('transaction_timeout')='3s' AS transaction_bounded,current_setting('lock_timeout')='250ms' AS lock_bounded,current_setting('statement_timeout')='2s' AS statement_bounded,current_setting('idle_in_transaction_session_timeout')='2s' AS idle_bounded",
            values: [],
            readonly: true,
          });
          yield* Effect.try({
            try: () => {
              check(readback.rows.length === 1);
              const bounds = decode(
                Schema.Struct({
                  transaction_bounded: Schema.Literal(true),
                  lock_bounded: Schema.Literal(true),
                  statement_bounded: Schema.Literal(true),
                  idle_bounded: Schema.Literal(true),
                }),
                readback.rows[0],
              );
              check(
                bounds.transaction_bounded &&
                  bounds.lock_bounded &&
                  bounds.statement_bounded &&
                  bounds.idle_bounded,
              );
            },
            catch: () => invalid(`${label}.bounds-readback`, true),
          });
          return yield* action(tx);
        }),
      );
    })().pipe(
      Effect.catchTag("ControlPlaneStatementFailed", (failure) => {
        const reason =
          failure.sqlState === "GP005"
            ? "idempotency-conflict"
            : failure.sqlState === "GP006"
              ? "resource-policy-unavailable"
              : failure.sqlState === "GP003"
                ? "authority-conflict"
                : null;
        return Effect.fail(
          reason === null ? failure : new GuestParticipationStoreRejected({ reason }),
        );
      }),
      Effect.provide(runtime),
    );
  return {
    findBeforeArchive: (input) =>
      run("guest-spoken.checkpoint.find", (tx) =>
        Effect.gen(function* () {
          const values = yield* Effect.try({
            try: () => parameters(input, input.originalLeaseToken),
            catch: () => invalid("guest-spoken.checkpoint.find.input"),
          });
          const saved = yield* query(
            tx,
            "guest-spoken.checkpoint.find",
            "SELECT read_owner_guest_spoken_success_v1($1::jsonb,$2::jsonb,$3,$4) AS result",
            values,
            Schema.NullOr(Loaded),
            true,
          );
          if (saved === null) return null;
          yield* Effect.try({
            try: () =>
              check(
                same(saved.source, input.source) &&
                  same(saved.operation, input.operation) &&
                  saved.commandId === input.commandId &&
                  saved.result.leaseToken === input.originalLeaseToken,
              ),
            catch: () => invalid("guest-spoken.checkpoint.find.correlation"),
          });
          return { checkpointId: saved.checkpointId, success: toSuccess(saved) };
        }),
      ),
    persistBeforeArchive: (input) =>
      run("guest-spoken.checkpoint.persist", (tx) =>
        Effect.gen(function* () {
          const values = yield* Effect.try({
            try: () => {
              decode(SuccessResult, input.result);
              decode(Provider, input.providerResult);
              check(
                Number.isFinite(Date.parse(input.result.acceptedAt)) &&
                  input.result.commandId === input.commandId &&
                  input.result.requestHash === input.operation.requestHash,
              );
              return parameters(input, input.result.leaseToken);
            },
            catch: () => invalid("guest-spoken.checkpoint.persist.input"),
          });
          const old = yield* query(
            tx,
            "guest-spoken.checkpoint.replay",
            "SELECT read_owner_guest_spoken_success_v1($1::jsonb,$2::jsonb,$3,$4) AS result",
            values,
            Schema.NullOr(Loaded),
            true,
          );
          if (old !== null) {
            // Stored accepted facts win. Exact replay compares them WITHOUT grading,
            // provider invocation, archive, extra cost reservation or a live proof.
            yield* Effect.try({
              try: () => check(same(toSuccess(old), input)),
              catch: () => invalid("guest-spoken.checkpoint.replay.correlation"),
            });
            return {
              state: "completed" as const,
              operation: old.operation,
              outcomeId: old.checkpointId,
              result: { checkpointId: old.checkpointId },
            };
          }
          const captured = yield* query(
            tx,
            "guest-spoken.checkpoint.context",
            "SELECT read_owner_guest_spoken_capture_v1($1::jsonb,$2::jsonb,$3,$4) AS result",
            values,
            Capture,
            true,
          );
          yield* Effect.try({
            try: () => {
              check(
                captured.sourceOwnerId === input.source.ownerId &&
                  same(captured.operation, input.operation) &&
                  captured.commandId === input.commandId &&
                  captured.sessionId === input.result.sessionId &&
                  captured.sessionItemId === input.result.sessionItemId &&
                  captured.attemptId === input.result.attemptId &&
                  captured.artifactId === input.result.artifactId &&
                  captured.attemptNumber === input.result.attemptNumber &&
                  captured.resourceReservationId === input.resourceReservationId &&
                  captured.deletionFenceRevision === input.deletionFenceRevision &&
                  captured.audioDigest === input.result.audioDigest &&
                  captured.audioContentType === input.result.audioContentType &&
                  captured.audioByteSize === input.result.audioByteSize &&
                  captured.audioDurationMs === input.result.audioDurationMs &&
                  captured.gradingContext.communityId === input.result.communityId &&
                  captured.gradingContext.rerecordEnabled === input.result.rerecordEnabled &&
                  same(captured.gradingContext.languageProvenance, input.result.languageProvenance),
              );
              const gradeFacts = gradeStudySpokenTranscript({
                referenceText: captured.gradingContext.referenceText,
                transcript: input.providerResult.transcript,
                dominantLanguage: captured.gradingContext.dominantLanguage,
                policy: input.result.grade.policyRevision,
                languageProvenance: captured.gradingContext.languageProvenance,
                detectedLanguage: input.providerResult.detectedLanguage,
                detectedLanguageConfidence: input.providerResult.detectedLanguageConfidence,
              });
              check(
                input.result.grade.policyRevision ===
                  captured.gradingContext.item.grader_policy_revision &&
                  same(gradeFacts.grade, input.result.grade) &&
                  same(gradeFacts.rerecordAssessment, input.result.rerecordAssessment),
              );
              decode(StudyFeedbackV2, projectStudySpokenFeedback(gradeFacts.grade).feedback);
            },
            catch: () => invalid("guest-spoken.checkpoint.context.correlation"),
          });
          const { leaseToken: _privateLease, ...facts } = input.result;
          const receipt = yield* query(
            tx,
            "guest-spoken.checkpoint.persist",
            "SELECT persist_owner_guest_spoken_success_v1($1::jsonb,$2::jsonb,$3,$4,$5::jsonb,$6::jsonb) AS result",
            [...values, JSON.stringify(facts), JSON.stringify(input.providerResult)],
            Receipt,
            false,
          );
          yield* Effect.try({
            try: () => check(receipt.outcome_id === receipt.result.checkpointId),
            catch: () => invalid("guest-spoken.checkpoint.persist.correlation", true),
          });
          return {
            state: "completed" as const,
            operation: input.operation,
            outcomeId: receipt.outcome_id,
            result: receipt.result,
          };
        }),
      ),
  };
}
