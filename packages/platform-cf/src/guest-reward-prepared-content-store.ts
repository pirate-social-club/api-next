import {
  ControlPlaneDb,
  type ControlPlaneError,
  GuestParticipationStoreRejected,
  type PreparedGuestStudyContentStore,
} from "@pirate/application";
import {
  GuestIdentifierV1,
  GuestRewardTermsV1,
  GuestSha256V1,
  GuestStudyPreparedContentV2,
  GuestStudyPreparedContentV1,
  LanguageTagV1,
  StudyExerciseTypeV2,
  StudyLearnerBandV2,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

type Input = Parameters<PreparedGuestStudyContentStore["get"]>[0];
import { projectPreparedGuestStudyContent } from "./guest-prepared-study-content-store.ts";
type Disclosure = GuestStudyPreparedContentV1["disclosure"];
const reject = (reason: GuestParticipationStoreRejected["reason"]) =>
  new GuestParticipationStoreRejected({ reason });
const Language = LanguageTagV1.check(Schema.isMaxLength(64));
const Request = Schema.Struct({
  communityId: GuestIdentifierV1,
  postId: GuestIdentifierV1,
  targetLanguage: Schema.NullOr(Language),
  learnerBand: Schema.NullOr(StudyLearnerBandV2),
});
const Source = Schema.Struct({
  lyrics_ready: Schema.Boolean,
  language_ready: Schema.Boolean,
  stems_ready: Schema.Boolean,
});
const Snapshot = Schema.Struct({
  accessible: Schema.Boolean,
  reward_preview: Schema.NullOr(GuestRewardTermsV1),
  reward_preview_terms_hash:Schema.NullOr(GuestSha256V1),
  source_rows: Schema.Array(Source).check(Schema.isMaxLength(1)),
  prepared_rows: Schema.Array(Schema.Unknown),
});
const PreparedRows = Schema.Array(
  Schema.Struct({
    exercise_type: StudyExerciseTypeV2,
    learning_language: Schema.Literal("en"),
    target_language: Schema.NullOr(Language),
    learner_band: Schema.NullOr(StudyLearnerBandV2),
    count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  }).check(
    Schema.makeFilter((row) =>
      (row.exercise_type === "say_it_back" &&
        row.target_language === null &&
        row.learner_band === null) ||
      (row.exercise_type === "translation_choice" &&
        row.target_language !== null &&
        row.target_language !== row.learning_language &&
        row.learner_band !== null)
        ? undefined
        : "Prepared exercise language/band must retain its stored source shape",
    ),
  ),
);
const Catalogue = Schema.Struct({
  exercise_types: Schema.Array(StudyExerciseTypeV2).check(Schema.isMaxLength(2)),
  target_languages: Schema.Array(Language).check(Schema.isMaxLength(128)),
  learner_bands: Schema.Array(StudyLearnerBandV2).check(Schema.isMaxLength(6)),
});
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

// One read-only PostgreSQL statement: the public predicate, current source,
// stem readiness and complete prepared catalogue share one MVCC snapshot.
const PREPARED_SNAPSHOT_SQL = "SELECT read_guest_reward_prepared_content_v1($1,$2,$3,$4::integer) AS snapshot";

export const makeControlPlanePreparedGuestRewardContentRepository = (
  disclosure: Disclosure | null,
  rawPurchaseSafetyMarginSeconds:unknown,
) => ({
  get: Effect.fn("PreparedGuestStudyContentStore.get")(function* (raw: Input) {
    const configured = yield* Effect.try({
      try: () => ({
        input: decode(Request, raw),
        disclosure: decode(GuestStudyPreparedContentV1.fields.disclosure, disclosure),
      }),
      catch: () => reject("resource-policy-unavailable"),
    });
    const safetyMargin=yield* Effect.try({try:()=>decode(Schema.Int.check(Schema.isBetween({minimum:1,maximum:86400})),rawPurchaseSafetyMarginSeconds),
     catch:()=>reject("resource-policy-unavailable")}).pipe(Effect.catchAll(()=>Effect.succeed(null)));
    const { input } = configured;
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute({
      label: "guest-study.prepared.snapshot",
      text: PREPARED_SNAPSHOT_SQL,
      values: [input.communityId, input.postId,configured.disclosure.version,safetyMargin],
      readonly: true,
    });
    const snapshot = yield* Effect.try({
      try: () => {
        if (result.rows.length !== 1) throw new TypeError("invalid public snapshot cardinality");
        const outer=decode(Schema.Struct({snapshot:Schema.Unknown}),result.rows[0]);
        return decode(Snapshot, outer.snapshot);
      },
      catch: () => reject("resource-policy-unavailable"),
    });
    if (!snapshot.accessible) return yield* reject("not-found");
    return yield* Effect.try({
      try: () => {
        const source = snapshot.source_rows[0];
        const reason =
          source === undefined
            ? "lyrics_not_accepted"
            : !source.stems_ready
              ? "stems_missing"
              : !source.lyrics_ready
                ? "lyrics_not_accepted"
                : !source.language_ready
                  ? "learning_language_unsupported"
                  : null;
        if (reason === null) {
          const content=projectPreparedGuestStudyContent(input,configured.disclosure,snapshot.prepared_rows);
          return decode(GuestStudyPreparedContentV2,{...content,object:"guest_study_prepared_content_v2",reward_preview:content.availability.state==="ready"?snapshot.reward_preview:null,
           reward_preview_terms_hash:content.availability.state==="ready"?snapshot.reward_preview_terms_hash:null});
        }
        return decode(GuestStudyPreparedContentV2, {
          object: "guest_study_prepared_content_v2",
          availability: { state: "unavailable", reason },
          disclosure: configured.disclosure,
          reward_preview: null,
          reward_preview_terms_hash:null,
        });
      },
      catch: () => reject("resource-policy-unavailable"),
    });
  }),
});

export const makeControlPlanePreparedGuestRewardContentStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  disclosure: Disclosure | null,
  rawPurchaseSafetyMarginSeconds:unknown,
) => {
  const repository = makeControlPlanePreparedGuestRewardContentRepository(disclosure, rawPurchaseSafetyMarginSeconds);
  return { get: (input) => repository.get(input).pipe(Effect.provide(runtime)) };
};
