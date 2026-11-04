import { StudySessionItemV2 } from "@pirate/contracts";
import { Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${key}`);
  return value;
};
const nullableText = (row: Row, key: string): string | null =>
  row[key] === null ? null : text(row, key);
const integer = (row: Row, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new Error(`invalid ${key}`);
  return value;
};
const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

// One exact public item projection for account and guest lesson selection.
// Private grader/review fields are deliberately absent from the whitelist.
export const projectStudySessionItemV2 = (
  row: Row,
  sessionId: string,
  ordinal: number,
): StudySessionItemV2 =>
  decode(StudySessionItemV2, {
    object: "study_session_item_v2",
    session_item_id: `${sessionId}_item_${ordinal + 1}`,
    ordinal,
    exercise_review_key: text(row, "exercise_review_key"),
    exercise_version_id: text(row, "exercise_version_id"),
    exercise_type: text(row, "exercise_type"),
    exercise_variant: text(row, "exercise_variant"),
    line: {
      post_id: text(row, "post_id"),
      audio_revision: integer(row, "audio_revision"),
      lyrics_revision: integer(row, "lyrics_revision"),
      lyric_line_id: text(row, "lyric_line_id"),
      study_unit_id: text(row, "study_unit_id"),
      line_version: integer(row, "line_version"),
      line_source_hash: text(row, "line_source_hash"),
    },
    languages: {
      learning_language: text(row, "learning_language"),
      target_language: nullableText(row, "target_language"),
    },
    learner_band: nullableText(row, "learner_band"),
    language_profile_revision:
      row.language_profile_revision === null ? null : integer(row, "language_profile_revision"),
    presentation: json(row.presentation),
    answer_visibility: text(row, "answer_visibility"),
    feedback_release: text(row, "feedback_release"),
    grader_policy_revision: text(row, "grader_policy_revision"),
    feedback_policy_revision: text(row, "feedback_policy_revision"),
    quality_policy_revision: text(row, "quality_policy_revision"),
    maximum_attempts: 3,
  });
