import {
  ControlPlaneDb,
  type ControlPlaneError,
  GuestParticipationStoreRejected,
  type PreparedGuestStudyContentStore,
} from "@pirate/application";
import {
  GuestIdentifierV1,
  GuestStudyPreparedContentV1,
  LanguageTagV1,
  StudyExerciseTypeV2,
  StudyLearnerBandV2,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

type Input = Parameters<PreparedGuestStudyContentStore["get"]>[0];
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

/** No economics port is accepted: this learning tranche is explicitly practice-only. */
export const projectPreparedGuestStudyContent = (
  input: Input,
  disclosure: Disclosure,
  prepared: unknown,
): GuestStudyPreparedContentV1 => {
  const rows = decode(PreparedRows, prepared);
  // Validate the complete current catalogue before applying request selection.
  // A large catalogue is refused; it is never silently sliced to fit the wire.
  const catalogue = decode(Catalogue, {
    exercise_types: [...new Set(rows.map((row) => row.exercise_type))].sort(),
    target_languages: [
      ...new Set(
        rows.flatMap((row) => (row.target_language === null ? [] : [row.target_language])),
      ),
    ].sort(),
    learner_bands: [
      ...new Set(rows.flatMap((row) => (row.learner_band === null ? [] : [row.learner_band]))),
    ].sort(),
  });
  const spoken = rows.filter((row) => row.exercise_type === "say_it_back");
  const translations = rows.filter(
    (row) =>
      row.exercise_type === "translation_choice" &&
      (input.targetLanguage === null || row.target_language === input.targetLanguage) &&
      (input.learnerBand === null || row.learner_band === input.learnerBand),
  );
  const sourceCount = spoken.reduce((sum, row) => sum + row.count, 0);
  // Never pool different helper languages or bands into a fictitious lesson.
  // The guest start selector must include null-band source cards separately
  // from the selected helper/band; the existing account selector is unchanged.
  const ready = sourceCount >= 4 || translations.some((row) => sourceCount + row.count >= 4);
  const available = [
    ...new Set([...spoken, ...translations].map((row) => row.exercise_type)),
  ].sort();
  const availability = ready
    ? {
        state: "ready",
        available_exercise_types: available,
        learning_language: "en",
        target_languages: catalogue.target_languages,
        learner_bands: catalogue.learner_bands,
      }
    : available.length === 0
      ? { state: "unavailable", reason: "insufficient_exercises" }
      : { state: "processing", available_exercise_types: available, pending_exercise_types: [] };
  return decode(GuestStudyPreparedContentV1, {
    object: "guest_study_prepared_content_v1",
    availability,
    disclosure,
    reward_preview: null,
  });
};

// One read-only PostgreSQL statement: the public predicate, current source,
// stem readiness and complete prepared catalogue share one MVCC snapshot.
const PREPARED_SNAPSHOT_SQL = `WITH public_resource AS (
  SELECT can_guest_access_activity_song_v1($1,$2) AS accessible
), source AS (
SELECT coalesce(publication.lyrics_status='ready'
                    AND submission.status='published'
                    AND publication.audio_revision=submission.audio_revision
                    AND publication.lyrics_revision=submission.current_lyrics_revision
                    AND lyrics.lyrics_revision IS NOT NULL, false) AS lyrics_ready,
                    coalesce(publication.language_status='ready', false) AS language_ready,
                    EXISTS(SELECT 1 FROM media_song_stems stem
                      WHERE stem.submission_id=publication.submission_id
                        AND stem.community_id=publication.community_id
                        AND stem.slot='instrumental_audio')
                    AND EXISTS(SELECT 1 FROM media_song_stems stem
                      WHERE stem.submission_id=publication.submission_id
                        AND stem.community_id=publication.community_id
                        AND stem.slot='vocal_audio') AS stems_ready
               FROM media_publication_projections publication
               JOIN media_post_submissions submission
                 ON submission.submission_id=publication.submission_id
                AND submission.community_id=publication.community_id
                AND submission.post_id=publication.post_id
               LEFT JOIN media_song_lyrics_revisions lyrics
                 ON lyrics.submission_id=submission.submission_id
                AND lyrics.lyrics_revision=publication.lyrics_revision
              WHERE publication.community_id=$1 AND publication.post_id=$2
                AND (SELECT accessible FROM public_resource)
), latest AS (
            SELECT DISTINCT ON (exercise.exercise_review_key)
              exercise.exercise_review_key, exercise.exercise_type, exercise.learning_language,
              exercise.target_language, exercise.learner_band
              FROM study_exercise_versions exercise
              JOIN media_publication_projections publication
                ON publication.community_id=exercise.community_id AND publication.post_id=exercise.post_id
              JOIN media_post_submissions submission
                ON submission.submission_id=publication.submission_id
               AND submission.community_id=publication.community_id AND submission.post_id=publication.post_id
               AND submission.audio_revision=exercise.audio_revision
               AND submission.current_lyrics_revision=exercise.lyrics_revision
              JOIN media_song_lyrics_revisions lyrics
                ON lyrics.submission_id=submission.submission_id AND lyrics.lyrics_revision=exercise.lyrics_revision
              JOIN localization_lyrics_revision_lines membership
                ON membership.community_id=exercise.community_id AND membership.post_id=exercise.post_id
               AND membership.lyrics_revision=exercise.lyrics_revision AND membership.lyric_line_id=exercise.lyric_line_id
               AND membership.line_version=exercise.line_version
              JOIN localization_lyric_line_versions line
                ON line.community_id=membership.community_id AND line.post_id=membership.post_id
               AND line.lyric_line_id=membership.lyric_line_id AND line.line_version=membership.line_version
               AND line.source_hash=exercise.line_source_hash
              JOIN localization_lyric_line_study_units unit_binding
                ON unit_binding.community_id=membership.community_id AND unit_binding.post_id=membership.post_id
               AND unit_binding.lyric_line_id=membership.lyric_line_id AND unit_binding.line_version=membership.line_version
               AND unit_binding.study_unit_id=exercise.study_unit_id
              JOIN LATERAL (
                SELECT profile.language_profile_revision FROM study_language_profiles profile
                 WHERE profile.community_id=exercise.community_id AND profile.post_id=exercise.post_id
                   AND profile.lyrics_revision=exercise.lyrics_revision AND profile.source_hash=lyrics.lyrics_sha256
                   AND (exercise.language_profile_revision IS NULL OR profile.language_profile_revision=exercise.language_profile_revision)
                 ORDER BY profile.language_profile_revision DESC LIMIT 1
              ) accepted_profile ON TRUE
              JOIN study_language_profile_units unit
                ON unit.community_id=exercise.community_id AND unit.post_id=exercise.post_id
               AND unit.lyrics_revision=exercise.lyrics_revision AND unit.study_unit_id=exercise.study_unit_id
               AND unit.language_profile_revision=accepted_profile.language_profile_revision
             WHERE exercise.community_id=$1 AND exercise.post_id=$2 AND exercise.retired_at IS NULL
               AND publication.audio_revision=exercise.audio_revision AND publication.lyrics_revision=exercise.lyrics_revision
               AND publication.lyrics_status='ready' AND submission.status='published'
               AND EXISTS(SELECT 1 FROM source WHERE lyrics_ready AND language_ready AND stems_ready)
               AND (SELECT accessible FROM public_resource)
             ORDER BY exercise.exercise_review_key, exercise.content_revision DESC
), catalogue AS (
  SELECT exercise_type, learning_language, target_language, learner_band,
                   count(DISTINCT exercise_review_key)::integer AS count
              FROM latest GROUP BY exercise_type, learning_language, target_language, learner_band
             ORDER BY exercise_type, target_language NULLS FIRST, learner_band NULLS FIRST
)
SELECT public_resource.accessible,
       coalesce((SELECT jsonb_agg(source) FROM source), '[]'::jsonb) AS source_rows,
       coalesce((SELECT jsonb_agg(catalogue ORDER BY exercise_type,
                   target_language NULLS FIRST, learner_band NULLS FIRST)
                   FROM catalogue), '[]'::jsonb) AS prepared_rows
  FROM public_resource`;

export const makeControlPlanePreparedGuestStudyContentRepository = (
  disclosure: Disclosure | null,
) => ({
  get: Effect.fn("PreparedGuestStudyContentStore.get")(function* (raw: Input) {
    const configured = yield* Effect.try({
      try: () => ({
        input: decode(Request, raw),
        disclosure: decode(GuestStudyPreparedContentV1.fields.disclosure, disclosure),
      }),
      catch: () => reject("resource-policy-unavailable"),
    });
    const { input } = configured;
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute({
      label: "guest-study.prepared.snapshot",
      text: PREPARED_SNAPSHOT_SQL,
      values: [input.communityId, input.postId],
      readonly: true,
    });
    const snapshot = yield* Effect.try({
      try: () => {
        if (result.rows.length !== 1) throw new TypeError("invalid public snapshot cardinality");
        return decode(Snapshot, result.rows[0]);
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
          return projectPreparedGuestStudyContent(
            input,
            configured.disclosure,
            snapshot.prepared_rows,
          );
        }
        return decode(GuestStudyPreparedContentV1, {
          object: "guest_study_prepared_content_v1",
          availability: { state: "unavailable", reason },
          disclosure: configured.disclosure,
          reward_preview: null,
        });
      },
      catch: () => reject("resource-policy-unavailable"),
    });
  }),
});

export const makeControlPlanePreparedGuestStudyContentStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  disclosure: Disclosure | null,
): PreparedGuestStudyContentStore => {
  const repository = makeControlPlanePreparedGuestStudyContentRepository(disclosure);
  return { get: (input) => repository.get(input).pipe(Effect.provide(runtime)) };
};
