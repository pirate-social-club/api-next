import { createHash } from "node:crypto";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  STUDY_TRANSLATION_PROMPT_V2,
  STUDY_TRANSLATION_VALIDATOR_V2,
  type StudyTranslationGenerationOutcome,
  type StudyTranslationGenerationRequest,
  type StudyTranslationGenerationStore,
  StudyTranslationGenerationStoreFailed,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const RIGHTS_POLICY_REVISION = "translated_lyrics_acr_original_v1" as const;
const GENERATOR_POLICY_REVISION = "study_translation_generation_v1" as const;
const SEMANTIC_VALIDATOR_REVISION = "study_translation_semantic_review_v1" as const;
const SAFETY_VALIDATOR_REVISION = "study_translation_safety_v1" as const;
const TRANSLATION_POLICY_REVISION = "study_translation_choice_v1" as const;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`invalid ${key}`);
  return value;
};

const nullableText = (row: Row, key: string): string | null =>
  row[key] === null ? null : text(row, key);

const integer = (row: Row, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid ${key}`);
  return value;
};

const json = (value: unknown): unknown =>
  typeof value === "string" ? (JSON.parse(value) as unknown) : value;

const stringArray = (value: unknown): readonly string[] => {
  const parsed = json(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new TypeError("invalid string array");
  }
  return parsed;
};

const failed = (reason: StudyTranslationGenerationStoreFailed["reason"]) =>
  new StudyTranslationGenerationStoreFailed({ reason });

const mapControlPlaneError = (error: ControlPlaneError): StudyTranslationGenerationStoreFailed => {
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

const authorityRows = (
  db: ControlPlaneTransaction,
  input: { communityId: string; postId: string; targetLanguage: string },
) =>
  db.execute<Row>({
    label: "study-translation.authority",
    text: `SELECT projection.submission_id, projection.audio_revision,
                  projection.analysis_revision, submission.current_lyrics_revision AS lyrics_revision,
                  lyrics.lyrics_sha256, analysis.acr_evidence_ref,
                  profile.language_profile_revision, quality.quality_policy_revision
             FROM media_publication_projections projection
             JOIN media_post_submissions submission
               ON submission.submission_id=projection.submission_id
              AND submission.community_id=projection.community_id
              AND submission.post_id=projection.post_id
             JOIN media_song_lyrics_revisions lyrics
               ON lyrics.submission_id=submission.submission_id
              AND lyrics.lyrics_revision=submission.current_lyrics_revision
             JOIN media_analysis_evidence analysis
               ON analysis.submission_id=submission.submission_id
              AND analysis.analysis_revision=projection.analysis_revision
             JOIN LATERAL (
               SELECT candidate.language_profile_revision, candidate.source_hash
                 FROM study_language_profiles candidate
                WHERE candidate.community_id=projection.community_id
                  AND candidate.post_id=projection.post_id
                  AND candidate.lyrics_revision=submission.current_lyrics_revision
                  AND candidate.source_hash=lyrics.lyrics_sha256
                ORDER BY candidate.language_profile_revision DESC
                LIMIT 1
             ) profile ON TRUE
             JOIN study_translation_quality_registry registry
               ON registry.target_language=$3
             JOIN study_translation_quality_policies quality
               ON quality.target_language=registry.target_language
              AND quality.quality_policy_revision=registry.quality_policy_revision
            WHERE projection.community_id=$1 AND projection.post_id=$2
              AND submission.status='published' AND submission.song_type='original'
              AND submission.audio_revision=projection.audio_revision
              AND submission.analysis_revision=projection.analysis_revision
              AND analysis.audio_revision=projection.audio_revision
              AND analysis.acr_decision='allow'
              AND quality.release_state='active'`,
    values: [input.communityId, input.postId, input.targetLanguage],
    readonly: false,
  });

const unitRows = (
  db: ControlPlaneTransaction,
  input: {
    communityId: string;
    postId: string;
    lyricsRevision: number;
    languageProfileRevision: number;
  },
) =>
  db.execute<Row>({
    label: "study-translation.units",
    text: `WITH ordered AS (
            SELECT membership.ordinal, membership.lyric_line_id,
                   membership.line_version, membership.source_hash,
                   version.canonical_text, unit.study_unit_id,
                   lag(version.canonical_text) OVER (ORDER BY membership.ordinal) AS previous_context,
                   lead(version.canonical_text) OVER (ORDER BY membership.ordinal) AS next_context
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
          ), representative AS (
            SELECT ordered.*, row_number() OVER (
                     PARTITION BY ordered.study_unit_id ORDER BY ordered.ordinal
                   ) AS unit_rank
              FROM ordered
          )
          SELECT representative.*, fact.detected_languages, fact.dominant_language,
                 fact.mixed, fact.vocable_only, fact.proper_name_only
            FROM representative
            JOIN study_language_profile_units fact
              ON fact.community_id=$1 AND fact.post_id=$2
             AND fact.lyrics_revision=$3 AND fact.language_profile_revision=$4
             AND fact.study_unit_id=representative.study_unit_id
           WHERE representative.unit_rank=1
           ORDER BY representative.ordinal`,
    values: [input.communityId, input.postId, input.lyricsRevision, input.languageProfileRevision],
    readonly: false,
  });

const contextRows = (
  db: ControlPlaneTransaction,
  input: { communityId: string; postId: string; lyricsRevision: number },
) =>
  db.execute<Row>({
    label: "study-translation.context-lines",
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

const outcomeFor = (
  generationRunId: string,
  status: StudyTranslationGenerationOutcome["status"],
  rows: readonly Row[],
): StudyTranslationGenerationOutcome => ({
  generationRunId,
  status,
  readyCount: rows.filter((row) => row.status === "ready").length,
  notApplicableCount: rows.filter((row) => row.status === "not_applicable").length,
  skippedCount: rows.filter((row) => row.status === "skipped").length,
});

const staleRun = (
  db: ControlPlaneTransaction,
  input: { generationRunId: string; acceptedAt: string; reason: string },
) =>
  db.execute({
    label: "study-translation.run.stale",
    text: `UPDATE study_translation_generation_runs
              SET status='stale', lease_token=NULL, lease_expires_at=NULL,
                  retryable=FALSE, failure_reason=$2, updated_at=$3::timestamptz,
                  completed_at=$3::timestamptz
            WHERE generation_run_id=$1 AND status='leased'`,
    values: [input.generationRunId, input.reason, input.acceptedAt],
    readonly: false,
  });

export const makeControlPlaneStudyTranslationRepository = () => ({
  reserve: (input: Parameters<StudyTranslationGenerationStore["reserve"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const authority = yield* authorityRows(transaction, input);
            if (authority.rows.length !== 1) return yield* failed("policy-blocked");
            const row = authority.rows[0] as Row;
            const identity = yield* transaction.execute<Row>({
              label: "study-translation.run.latest",
              text: `SELECT generation_run_id, status, retryable, attempt_number
                       FROM study_translation_generation_runs
                      WHERE community_id=$1 AND post_id=$2 AND lyrics_revision=$3
                        AND language_profile_revision=$4 AND target_language=$5
                        AND learner_band=$6 AND generator_policy_revision=$7
                        AND prompt_revision=$8 AND quality_policy_revision=$9
                      ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`,
              values: [
                input.communityId,
                input.postId,
                integer(row, "lyrics_revision"),
                integer(row, "language_profile_revision"),
                input.targetLanguage,
                input.learnerBand,
                GENERATOR_POLICY_REVISION,
                STUDY_TRANSLATION_PROMPT_V2,
                text(row, "quality_policy_revision"),
              ],
              readonly: false,
            });
            const prior = identity.rows[0];
            if (prior !== undefined && prior.status === "succeeded") {
              const items = yield* transaction.execute<Row>({
                label: "study-translation.run.completed-items",
                text: `SELECT status FROM study_translation_generation_items
                        WHERE generation_run_id=$1 ORDER BY item_ordinal`,
                values: [text(prior, "generation_run_id")],
                readonly: false,
              });
              return {
                state: "terminal" as const,
                outcome: outcomeFor(text(prior, "generation_run_id"), "succeeded", items.rows),
              };
            }
            if (
              prior !== undefined &&
              (prior.status === "pending" || prior.status === "leased" || prior.retryable === false)
            ) {
              return yield* failed("unavailable");
            }

            const lyricsRevision = integer(row, "lyrics_revision");
            const languageProfileRevision = integer(row, "language_profile_revision");
            const units = yield* unitRows(transaction, {
              communityId: input.communityId,
              postId: input.postId,
              lyricsRevision,
              languageProfileRevision,
            });
            if (units.rows.length === 0 || units.rows.length > 256) {
              return yield* failed("invalid-row");
            }
            const context = yield* contextRows(transaction, {
              communityId: input.communityId,
              postId: input.postId,
              lyricsRevision,
            });
            if (context.rows.length === 0 || context.rows.length > 1_024) {
              return yield* failed("invalid-row");
            }
            const request: StudyTranslationGenerationRequest = {
              generationRunId: input.generationRunId,
              communityId: input.communityId,
              postId: input.postId,
              lyricsRevision,
              lyricsSourceHash: text(row, "lyrics_sha256"),
              languageProfileRevision,
              learningLanguage: "en",
              targetLanguage: input.targetLanguage,
              learnerBand: input.learnerBand,
              promptRevision: STUDY_TRANSLATION_PROMPT_V2,
              qualityPolicyRevision: text(row, "quality_policy_revision"),
              rightsPolicyRevision: RIGHTS_POLICY_REVISION,
              contextLines: context.rows.map((line) => ({
                ordinal: integer(line, "ordinal"),
                lyricLineId: text(line, "lyric_line_id"),
                lineVersion: integer(line, "line_version"),
                studyUnitId: text(line, "study_unit_id"),
                sourceText: text(line, "canonical_text"),
              })),
              units: units.rows.map((unit) => ({
                studyUnitId: text(unit, "study_unit_id"),
                lyricLineId: text(unit, "lyric_line_id"),
                lineVersion: integer(unit, "line_version"),
                sourceHash: text(unit, "source_hash"),
                sourceText: text(unit, "canonical_text"),
                previousContext: nullableText(unit, "previous_context"),
                nextContext: nullableText(unit, "next_context"),
                language: {
                  detectedLanguages: stringArray(unit.detected_languages),
                  dominantLanguage: nullableText(unit, "dominant_language"),
                  mixed: unit.mixed === true,
                  vocableOnly: unit.vocable_only === true,
                  properNameOnly: unit.proper_name_only === true,
                },
              })),
            };
            const requestHash = sha256(JSON.stringify(request));
            const attemptNumber = prior === undefined ? 1 : integer(prior, "attempt_number") + 1;
            yield* transaction.execute({
              label: "study-translation.run.insert",
              text: `INSERT INTO study_translation_generation_runs (
                generation_run_id, community_id, post_id, submission_id, audio_revision,
                analysis_revision, lyrics_revision, lyrics_source_hash,
                language_profile_revision, learning_language, target_language, learner_band,
                generator_policy_revision, prompt_revision, structural_validator_revision,
                semantic_validator_revision, safety_validator_revision, quality_policy_revision,
                rights_policy_revision, rights_evidence_ref, request_hash, status, attempt_number,
                lease_token, lease_expires_at, created_at, updated_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'en',$10,$11,$12,$13,$14,$15,$16,$17,
                        $18,$19,$20,'leased',$21,$22,$23::timestamptz,$24::timestamptz,$24::timestamptz)`,
              values: [
                input.generationRunId,
                input.communityId,
                input.postId,
                text(row, "submission_id"),
                integer(row, "audio_revision"),
                integer(row, "analysis_revision"),
                lyricsRevision,
                request.lyricsSourceHash,
                languageProfileRevision,
                input.targetLanguage,
                input.learnerBand,
                GENERATOR_POLICY_REVISION,
                STUDY_TRANSLATION_PROMPT_V2,
                STUDY_TRANSLATION_VALIDATOR_V2,
                SEMANTIC_VALIDATOR_REVISION,
                SAFETY_VALIDATOR_REVISION,
                request.qualityPolicyRevision,
                RIGHTS_POLICY_REVISION,
                text(row, "acr_evidence_ref"),
                requestHash,
                attemptNumber,
                input.leaseToken,
                input.leaseExpiresAt,
                input.requestedAt,
              ],
              readonly: false,
            });
            return { state: "leased" as const, leaseToken: input.leaseToken, request };
          }),
        );
      }),
    ),

  complete: (input: Parameters<StudyTranslationGenerationStore["complete"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const selected = yield* transaction.execute<Row>({
              label: "study-translation.run.lock",
              text: `SELECT * FROM study_translation_generation_runs
                      WHERE generation_run_id=$1 FOR UPDATE`,
              values: [input.request.generationRunId],
              readonly: false,
            });
            if (selected.rows.length !== 1) return yield* failed("invalid-row");
            const run = selected.rows[0] as Row;
            if (
              run.status !== "leased" ||
              nullableText(run, "lease_token") !== input.leaseToken ||
              new Date(String(run.lease_expires_at)).getTime() <=
                new Date(input.acceptedAt).getTime()
            ) {
              return yield* failed("stale");
            }
            const authority = yield* authorityRows(transaction, {
              communityId: input.request.communityId,
              postId: input.request.postId,
              targetLanguage: input.request.targetLanguage,
            });
            const current = authority.rows[0];
            const exactAuthority =
              authority.rows.length === 1 &&
              current !== undefined &&
              text(current, "submission_id") === text(run, "submission_id") &&
              integer(current, "audio_revision") === integer(run, "audio_revision") &&
              integer(current, "analysis_revision") === integer(run, "analysis_revision") &&
              integer(current, "lyrics_revision") === integer(run, "lyrics_revision") &&
              text(current, "lyrics_sha256") === text(run, "lyrics_source_hash") &&
              integer(current, "language_profile_revision") ===
                integer(run, "language_profile_revision") &&
              text(current, "quality_policy_revision") === text(run, "quality_policy_revision") &&
              text(current, "acr_evidence_ref") === text(run, "rights_evidence_ref");
            if (!exactAuthority) {
              yield* staleRun(transaction, {
                generationRunId: input.request.generationRunId,
                acceptedAt: input.acceptedAt,
                reason: "authority_snapshot_changed",
              });
              return outcomeFor(input.request.generationRunId, "stale", []);
            }

            for (const [ordinal, unit] of input.proposal.units.entries()) {
              const expected = input.request.units[ordinal];
              if (expected === undefined) return yield* failed("invalid-row");
              const resultDigest = sha256(JSON.stringify(unit));
              if (unit.status !== "ready") {
                yield* transaction.execute({
                  label: "study-translation.item.disposition",
                  text: `INSERT INTO study_translation_generation_items (
                    generation_run_id, community_id, post_id, study_unit_id, lyric_line_id,
                    line_version, source_hash, item_ordinal, status, disposition_reason,
                    result_digest, accepted_at
                  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)`,
                  values: [
                    input.request.generationRunId,
                    input.request.communityId,
                    input.request.postId,
                    expected.studyUnitId,
                    expected.lyricLineId,
                    expected.lineVersion,
                    expected.sourceHash,
                    ordinal,
                    unit.status,
                    unit.reason,
                    resultDigest,
                    input.acceptedAt,
                  ],
                  readonly: false,
                });
                continue;
              }

              const sourceLanguage = expected.language.dominantLanguage;
              if (sourceLanguage === null) return yield* failed("invalid-row");
              yield* transaction.execute({
                label: "study-translation.source-unit.insert",
                text: `INSERT INTO localization_source_units (
                  source_unit_kind, source_unit_id, field_key, source_revision,
                  source_language, source_language_policy_version, source_hash,
                  hash_policy_version, canonical_value
                ) VALUES ('lyric_line',$1,'lyrics',$2,$3,'study-language-profile-v1',$4,
                          'lyric-line-source-hash-v1',$5)
                ON CONFLICT (source_unit_kind, source_unit_id, field_key, source_revision, source_hash)
                DO NOTHING`,
                values: [
                  expected.lyricLineId,
                  expected.lineVersion,
                  sourceLanguage,
                  expected.sourceHash,
                  expected.sourceText,
                ],
                readonly: false,
              });
              const versions = yield* transaction.execute<Row>({
                label: "study-translation.version.next",
                text: `SELECT coalesce(max(version_number),0)::bigint AS version_number
                         FROM localization_translation_versions
                        WHERE source_unit_kind='lyric_line' AND source_unit_id=$1
                          AND field_key='lyrics' AND source_revision=$2 AND source_hash=$3
                          AND target_language=$4 AND translation_policy_version=$5`,
                values: [
                  expected.lyricLineId,
                  expected.lineVersion,
                  expected.sourceHash,
                  input.request.targetLanguage,
                  TRANSLATION_POLICY_REVISION,
                ],
                readonly: false,
              });
              const versionNumber = integer(versions.rows[0] as Row, "version_number") + 1;
              const translationVersionId = `study_translation_version_${crypto.randomUUID()}`;
              yield* transaction.execute({
                label: "study-translation.version.insert",
                text: `INSERT INTO localization_translation_versions (
                  translation_version_id, source_unit_kind, source_unit_id, field_key,
                  source_revision, source_hash, target_language, translation_policy_version,
                  version_number, translated_value, translation_origin, provider_id, model_id,
                  prompt_revision, generation_run_id, quality_policy_revision, moderation_result
                ) VALUES ($1,'lyric_line',$2,'lyrics',$3,$4,$5,$6,$7,$8,'machine',$9,$10,$11,
                          $12,$13,'allow')`,
                values: [
                  translationVersionId,
                  expected.lyricLineId,
                  expected.lineVersion,
                  expected.sourceHash,
                  input.request.targetLanguage,
                  TRANSLATION_POLICY_REVISION,
                  versionNumber,
                  unit.translation,
                  input.proposal.provider_id,
                  input.proposal.provider_model,
                  input.proposal.prompt_revision,
                  input.request.generationRunId,
                  input.request.qualityPolicyRevision,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "study-translation.selection.upsert",
                text: `INSERT INTO localization_translation_selections (
                  source_unit_kind, source_unit_id, field_key, source_revision, source_hash,
                  target_language, translation_policy_version, selected_translation_version_id,
                  selected_at, selected_by
                ) VALUES ('lyric_line',$1,'lyrics',$2,$3,$4,$5,$6,$7::timestamptz,$8)
                ON CONFLICT (
                  source_unit_kind, source_unit_id, field_key, source_revision, source_hash,
                  target_language, translation_policy_version
                ) DO UPDATE SET selected_translation_version_id=EXCLUDED.selected_translation_version_id,
                                selected_at=EXCLUDED.selected_at, selected_by=EXCLUDED.selected_by`,
                values: [
                  expected.lyricLineId,
                  expected.lineVersion,
                  expected.sourceHash,
                  input.request.targetLanguage,
                  TRANSLATION_POLICY_REVISION,
                  translationVersionId,
                  input.acceptedAt,
                  SEMANTIC_VALIDATOR_REVISION,
                ],
                readonly: false,
              });

              const choiceTexts = [unit.translation, ...unit.distractors];
              const choices = choiceTexts
                .map((choiceText, index) => ({
                  choice_key: `choice_${crypto.randomUUID()}`,
                  text: choiceText,
                  correct: index === 0,
                  order: sha256(
                    `${input.request.generationRunId}:${expected.studyUnitId}:${choiceText}`,
                  ),
                }))
                .sort((left, right) => left.order.localeCompare(right.order));
              const correct = choices.find(({ correct }) => correct);
              if (correct === undefined) return yield* failed("invalid-row");
              const exerciseReviewKey = [
                "study-translation-choice",
                input.request.postId,
                expected.studyUnitId,
                input.request.targetLanguage,
                input.request.learnerBand,
              ].join(":");
              const revisions = yield* transaction.execute<Row>({
                label: "study-translation.exercise.next",
                text: `SELECT coalesce(max(content_revision),0)::bigint AS content_revision
                         FROM study_exercise_versions WHERE exercise_review_key=$1`,
                values: [exerciseReviewKey],
                readonly: false,
              });
              const contentRevision = integer(revisions.rows[0] as Row, "content_revision") + 1;
              const exerciseVersionId = `study_exercise_${crypto.randomUUID()}`;
              yield* transaction.execute({
                label: "study-translation.exercise.insert",
                text: `INSERT INTO study_exercise_versions (
                  exercise_version_id, community_id, post_id, audio_revision, lyrics_revision,
                  lyric_line_id, line_version, line_source_hash, exercise_review_key,
                  exercise_type, exercise_variant, learning_language, target_language,
                  learner_band, content_revision, presentation, private_grader, study_unit_id,
                  language_profile_revision, answer_visibility, feedback_release,
                  grader_policy_revision, feedback_policy_revision, generation_kind,
                  generation_run_id, producer_id, provider_model, prompt_revision, request_hash,
                  raw_result_digest, structural_validator_revision, semantic_validator_revision,
                  safety_validator_revision, quality_validator_revision, quality_policy_revision,
                  generated_at, validated_at, accepted_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'translation_choice','whole-line-v1','en',$10,
                          $11,$12,$13::jsonb,$14::jsonb,$15,$16,'secret_until_spent','spent_only',
                          'exact_choice_v1','choice-reveal-v1','provider_generated',$17,$18,$19,$20,
                          $21,$22,$23,$24,$25,$26,$27,$28::timestamptz,$28::timestamptz,$28::timestamptz)`,
                values: [
                  exerciseVersionId,
                  input.request.communityId,
                  input.request.postId,
                  integer(run, "audio_revision"),
                  input.request.lyricsRevision,
                  expected.lyricLineId,
                  expected.lineVersion,
                  expected.sourceHash,
                  exerciseReviewKey,
                  input.request.targetLanguage,
                  input.request.learnerBand,
                  contentRevision,
                  JSON.stringify({
                    kind: "translation_choice",
                    source_text: expected.sourceText,
                    question: unit.question,
                    choices: choices.map(({ choice_key, text }) => ({ choice_key, text })),
                    capture: "choice_selection",
                  }),
                  JSON.stringify({
                    kind: "exact_choice_v1",
                    correct_choice_key: correct.choice_key,
                    correct_text: correct.text,
                    explanation: unit.explanation,
                  }),
                  expected.studyUnitId,
                  input.request.languageProfileRevision,
                  input.request.generationRunId,
                  input.proposal.provider_id,
                  input.proposal.provider_model,
                  input.proposal.prompt_revision,
                  text(run, "request_hash"),
                  resultDigest,
                  STUDY_TRANSLATION_VALIDATOR_V2,
                  SEMANTIC_VALIDATOR_REVISION,
                  SAFETY_VALIDATOR_REVISION,
                  STUDY_TRANSLATION_VALIDATOR_V2,
                  input.request.qualityPolicyRevision,
                  input.acceptedAt,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "study-translation.item.ready",
                text: `INSERT INTO study_translation_generation_items (
                  generation_run_id, community_id, post_id, study_unit_id, lyric_line_id,
                  line_version, source_hash, item_ordinal, status, translation_version_id,
                  exercise_version_id, result_digest, accepted_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready',$9,$10,$11,$12::timestamptz)`,
                values: [
                  input.request.generationRunId,
                  input.request.communityId,
                  input.request.postId,
                  expected.studyUnitId,
                  expected.lyricLineId,
                  expected.lineVersion,
                  expected.sourceHash,
                  ordinal,
                  translationVersionId,
                  exerciseVersionId,
                  resultDigest,
                  input.acceptedAt,
                ],
                readonly: false,
              });
            }

            yield* transaction.execute({
              label: "study-translation.run.complete",
              text: `UPDATE study_translation_generation_runs
                        SET status='succeeded', lease_token=NULL, lease_expires_at=NULL,
                            provider_id=$2, provider_model=$3, updated_at=$4::timestamptz,
                            completed_at=$4::timestamptz
                      WHERE generation_run_id=$1 AND status='leased'`,
              values: [
                input.request.generationRunId,
                input.proposal.provider_id,
                input.proposal.provider_model,
                input.acceptedAt,
              ],
              readonly: false,
            });
            return outcomeFor(
              input.request.generationRunId,
              "succeeded",
              input.proposal.units.map(({ status }) => ({ status })),
            );
          }),
        );
      }),
    ),

  fail: (input: Parameters<StudyTranslationGenerationStore["fail"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.execute({
          label: "study-translation.run.fail",
          text: `UPDATE study_translation_generation_runs
                    SET status='failed', lease_token=NULL, lease_expires_at=NULL,
                        retryable=$3, failure_reason=$4, updated_at=$5::timestamptz,
                        completed_at=$5::timestamptz
                  WHERE generation_run_id=$1 AND status='leased' AND lease_token=$2`,
          values: [
            input.generationRunId,
            input.leaseToken,
            input.retryable,
            input.failureReason,
            input.failedAt,
          ],
          readonly: false,
        });
      }),
    ),
});

export const makeControlPlaneStudyTranslationStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): StudyTranslationGenerationStore => {
  const repository = makeControlPlaneStudyTranslationRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E | ControlPlaneError, ControlPlaneDb>) =>
    mapErrors(Effect.provide(runtime)(effect));
  return {
    reserve: (input) => provide(repository.reserve(input)),
    complete: (input) => provide(repository.complete(input)),
    fail: (input) => provide(repository.fail(input)),
  };
};
