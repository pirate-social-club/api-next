import { createHash } from "node:crypto";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  STUDY_LANGUAGE_PROFILE_PROMPT_V1,
  STUDY_LANGUAGE_PROFILE_VALIDATOR_V1,
  type StudyLanguageProfileOutcome,
  type StudyLanguageProfileRequest,
  type StudyLanguageProfileStore,
  StudyLanguageProfileStoreFailed,
  validateStudyLanguageProfile,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const failed = (reason: StudyLanguageProfileStoreFailed["reason"]) =>
  new StudyLanguageProfileStoreFailed({ reason });

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`invalid ${key}`);
  return value;
};
const nullableText = (row: Row, key: string): string | null =>
  row[key] === null ? null : text(row, key);
const positiveInteger = (row: Row, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid ${key}`);
  return value;
};
const nonnegativeInteger = (row: Row, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid ${key}`);
  return value;
};
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const mapControlPlaneError = (error: ControlPlaneError): StudyLanguageProfileStoreFailed => {
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") return failed("outcome-unknown");
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return failed("outcome-unknown");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState !== null) {
    return failed("constraint");
  }
  return failed("unavailable");
};

const mapErrors = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      typeof error === "object" && error !== null && "_tag" in error
        ? error._tag === "ControlPlaneAcquireFailed" ||
          error._tag === "ControlPlaneOperationTimedOut" ||
          error._tag === "ControlPlaneStatementFailed" ||
          error._tag === "ControlPlaneTransactionOutcomeUnknown"
          ? mapControlPlaneError(error as ControlPlaneError)
          : (error as E)
        : (error as E),
    ),
  );

const authority = (
  db: ControlPlaneTransaction,
  input: { readonly communityId: string; readonly postId: string },
) =>
  db.execute<Row>({
    label: "study-language-profile.authority",
    text: `SELECT projection.lyrics_revision, lyrics.lyrics_sha256,
                  projection.primary_language_bcp47, projection.secondary_language_bcp47
             FROM media_publication_projections projection
             JOIN media_post_submissions submission
               ON submission.submission_id=projection.submission_id
              AND submission.community_id=projection.community_id
              AND submission.post_id=projection.post_id
             JOIN media_song_lyrics_revisions lyrics
               ON lyrics.submission_id=submission.submission_id
              AND lyrics.lyrics_revision=projection.lyrics_revision
            WHERE projection.community_id=$1 AND projection.post_id=$2
              AND projection.lyrics_status='ready'
              AND projection.lyrics_revision IS NOT NULL
              AND submission.status='published'
              AND submission.current_lyrics_revision=projection.lyrics_revision`,
    values: [input.communityId, input.postId],
    readonly: false,
  });

const accepted = (
  db: ControlPlaneTransaction,
  input: {
    readonly communityId: string;
    readonly postId: string;
    readonly lyricsRevision: number;
    readonly sourceHash: string;
  },
) =>
  db.execute<Row>({
    label: "study-language-profile.accepted",
    text: `SELECT language_profile_revision
             FROM study_language_profiles
            WHERE community_id=$1 AND post_id=$2 AND lyrics_revision=$3
              AND source_hash=$4 AND prompt_revision=$5 AND validator_revision=$6
            ORDER BY language_profile_revision DESC LIMIT 1`,
    values: [
      input.communityId,
      input.postId,
      input.lyricsRevision,
      input.sourceHash,
      STUDY_LANGUAGE_PROFILE_PROMPT_V1,
      STUDY_LANGUAGE_PROFILE_VALIDATOR_V1,
    ],
    readonly: false,
  });

const lineRows = (
  db: ControlPlaneTransaction,
  input: { readonly communityId: string; readonly postId: string; readonly lyricsRevision: number },
) =>
  db.execute<Row>({
    label: "study-language-profile.lines",
    text: `SELECT membership.ordinal, membership.lyric_line_id, membership.line_version,
                  unit.study_unit_id, version.canonical_text
             FROM localization_lyrics_revision_lines membership
              JOIN localization_lyric_line_versions version
                ON version.community_id=membership.community_id
               AND version.post_id=membership.post_id
               AND version.lyric_line_id=membership.lyric_line_id
               AND version.line_version=membership.line_version
              JOIN localization_lyric_line_study_units unit
                ON unit.community_id=membership.community_id
               AND unit.post_id=membership.post_id
               AND unit.lyric_line_id=membership.lyric_line_id
               AND unit.line_version=membership.line_version
             WHERE membership.community_id=$1 AND membership.post_id=$2
               AND membership.lyrics_revision=$3
            ORDER BY membership.ordinal`,
    values: [input.communityId, input.postId, input.lyricsRevision],
    readonly: false,
  });

const outcome = (
  request: StudyLanguageProfileRequest,
  languageProfileRevision: number,
): StudyLanguageProfileOutcome => ({
  communityId: request.communityId,
  postId: request.postId,
  lyricsRevision: request.lyricsRevision,
  sourceHash: request.sourceHash,
  languageProfileRevision,
  state: "ready",
});

export const makeControlPlaneStudyLanguageProfileRepository = () => ({
  resolve: (input: Parameters<StudyLanguageProfileStore["resolve"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const selected = yield* authority(transaction, input);
            if (selected.rows.length !== 1) return yield* failed("unavailable");
            const row = selected.rows[0] as Row;
            const requestIdentity = {
              communityId: input.communityId,
              postId: input.postId,
              lyricsRevision: positiveInteger(row, "lyrics_revision"),
              sourceHash: text(row, "lyrics_sha256"),
            };
            const existing = yield* accepted(transaction, requestIdentity);
            const existingRow = existing.rows[0];
            if (existingRow !== undefined) {
              return {
                state: "ready" as const,
                outcome: outcome(
                  {
                    ...requestIdentity,
                    primaryLanguageHint: nullableText(row, "primary_language_bcp47"),
                    secondaryLanguageHint: nullableText(row, "secondary_language_bcp47"),
                    contextLines: [],
                    units: [],
                  },
                  positiveInteger(existingRow, "language_profile_revision"),
                ),
              };
            }
            const lines = yield* lineRows(transaction, requestIdentity);
            if (lines.rows.length === 0 || lines.rows.length > 1_024) {
              return yield* failed("unavailable");
            }
            const seen = new Set<string>();
            const units = lines.rows.flatMap((unit) => {
              const studyUnitId = text(unit, "study_unit_id");
              if (seen.has(studyUnitId)) return [];
              seen.add(studyUnitId);
              return [{ studyUnitId, sourceText: text(unit, "canonical_text") }];
            });
            if (units.length > 256) return yield* failed("unavailable");
            return {
              state: "generate" as const,
              request: {
                ...requestIdentity,
                primaryLanguageHint: nullableText(row, "primary_language_bcp47"),
                secondaryLanguageHint: nullableText(row, "secondary_language_bcp47"),
                contextLines: lines.rows.map((line) => ({
                  ordinal: nonnegativeInteger(line, "ordinal"),
                  lyricLineId: text(line, "lyric_line_id"),
                  lineVersion: positiveInteger(line, "line_version"),
                  studyUnitId: text(line, "study_unit_id"),
                  sourceText: text(line, "canonical_text"),
                })),
                units,
              },
            };
          }),
        );
      }),
    ),

  accept: (input: Parameters<StudyLanguageProfileStore["accept"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        yield* validateStudyLanguageProfile(input.request, input.analysis).pipe(
          Effect.mapError(() => failed("constraint")),
        );
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute({
              label: "study-language-profile.post-lock",
              text: "SELECT 1 FROM posts WHERE community_id=$1 AND post_id=$2 FOR UPDATE",
              values: [input.request.communityId, input.request.postId],
              readonly: false,
            });
            const selected = yield* authority(transaction, input.request);
            const row = selected.rows[0];
            if (
              selected.rows.length !== 1 ||
              row === undefined ||
              positiveInteger(row, "lyrics_revision") !== input.request.lyricsRevision ||
              text(row, "lyrics_sha256") !== input.request.sourceHash
            ) {
              return yield* failed("stale");
            }
            const existing = yield* accepted(transaction, input.request);
            const existingRow = existing.rows[0];
            if (existingRow !== undefined) {
              return outcome(
                input.request,
                positiveInteger(existingRow, "language_profile_revision"),
              );
            }
            const next = yield* transaction.execute<Row>({
              label: "study-language-profile.next-revision",
              text: `SELECT coalesce(max(language_profile_revision),0)+1 AS next_revision
                       FROM study_language_profiles
                      WHERE community_id=$1 AND post_id=$2 AND lyrics_revision=$3`,
              values: [
                input.request.communityId,
                input.request.postId,
                input.request.lyricsRevision,
              ],
              readonly: false,
            });
            const languageProfileRevision = positiveInteger(next.rows[0] as Row, "next_revision");
            yield* transaction.execute({
              label: "study-language-profile.insert",
              text: `INSERT INTO study_language_profiles (
                     community_id, post_id, lyrics_revision, language_profile_revision,
                     source_hash, provider_id, provider_model, prompt_revision,
                     validator_revision, request_hash, accepted_at
                   ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)`,
              values: [
                input.request.communityId,
                input.request.postId,
                input.request.lyricsRevision,
                languageProfileRevision,
                input.request.sourceHash,
                input.analysis.providerId,
                input.analysis.providerModel,
                input.analysis.promptRevision,
                input.analysis.validatorRevision,
                sha256(JSON.stringify(input.request)),
                input.acceptedAt,
              ],
              readonly: false,
            });
            for (const unit of input.analysis.units) {
              yield* transaction.execute({
                label: "study-language-profile.unit.insert",
                text: `INSERT INTO study_language_profile_units (
                       community_id, post_id, lyrics_revision, language_profile_revision,
                       study_unit_id, detected_languages, dominant_language, mixed,
                       vocable_only, confidence
                     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
                values: [
                  input.request.communityId,
                  input.request.postId,
                  input.request.lyricsRevision,
                  languageProfileRevision,
                  unit.studyUnitId,
                  JSON.stringify(unit.detectedLanguages),
                  unit.dominantLanguage,
                  unit.mixed,
                  unit.vocableOnly,
                  unit.confidence,
                ],
                readonly: false,
              });
            }
            return outcome(input.request, languageProfileRevision);
          }),
        );
      }),
    ),
});

export const makeControlPlaneStudyLanguageProfileStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): StudyLanguageProfileStore => {
  const repository = makeControlPlaneStudyLanguageProfileRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E | ControlPlaneError, ControlPlaneDb>) =>
    mapErrors(Effect.provide(runtime)(effect));
  return {
    resolve: (input) => provide(repository.resolve(input)),
    accept: (input) => provide(repository.accept(input)),
  };
};
