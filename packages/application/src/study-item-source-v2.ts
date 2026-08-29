import {
  StudyExerciseTypeV2,
  StudyLanguageRolesV2,
  StudyLearnerBandV2,
  StudyLineBindingV2,
  StudyPresentationV2,
} from "@pirate/contracts";
import { Schema } from "effect";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Text = Schema.NonEmptyString.check(Schema.isMaxLength(4_096));
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

const AcceptedAnswers = Schema.NonEmptyArray(Text).check(
  Schema.isMaxLength(12),
  Schema.makeFilter((answers) =>
    new Set(answers).size === answers.length ? undefined : "Accepted answers must be unique",
  ),
);

export const StudyPrivateGraderV2 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("source_token_diff_v1"),
    reference_text: Text,
    tokenizer_policy_revision: Identifier,
  }),
  Schema.Struct({
    kind: Schema.Literal("exact_choice_v1"),
    correct_choice_key: Identifier,
    correct_text: Text,
    explanation: Schema.optional(Text),
  }),
  Schema.Struct({
    kind: Schema.Literal("accepted_text_v1"),
    canonical_answer: Text,
    accepted_answers: AcceptedAnswers,
    normalization_policy_revision: Identifier,
    explanation: Schema.optional(Text),
  }),
]);
export type StudyPrivateGraderV2 = Schema.Schema.Type<typeof StudyPrivateGraderV2>;

export const StudyGenerationProvenanceV2 = Schema.Struct({
  kind: Schema.Literals(["deterministic", "provider_generated"]),
  generation_run_id: Identifier,
  producer_id: Identifier,
  provider_model: Schema.NullOr(Identifier),
  prompt_revision: Identifier,
  request_hash: Identifier,
  quality_policy_revision: Identifier,
  generated_at: Schema.DateTimeUtcFromString,
  accepted_at: Schema.DateTimeUtcFromString,
}).check(
  Schema.makeFilter(({ kind, provider_model }) =>
    (kind === "deterministic") === (provider_model === null)
      ? undefined
      : "Only provider-generated Study items identify a provider model",
  ),
);

export const StudySourceItemV2 = Schema.Struct({
  source_item_key: Identifier,
  exercise_review_key: Identifier,
  exercise_version_id: Identifier,
  review_item_id: Identifier,
  exercise_type: StudyExerciseTypeV2,
  exercise_variant: Identifier,
  line: StudyLineBindingV2,
  languages: StudyLanguageRolesV2,
  learner_band: StudyLearnerBandV2,
  presentation: StudyPresentationV2,
  private_grader: StudyPrivateGraderV2,
  answer_visibility: Schema.Literals(["always_visible", "secret_until_spent"]),
  feedback_release: Schema.Literals(["every_graded_attempt", "spent_only"]),
  grader_policy_revision: Identifier,
  feedback_policy_revision: Identifier,
  provenance: StudyGenerationProvenanceV2,
}).check(
  Schema.makeFilter((item) => {
    if (item.exercise_type !== item.presentation.kind) {
      return "Exercise and presentation kinds must match";
    }
    const graderKind =
      item.exercise_type === "say_it_back"
        ? "source_token_diff_v1"
        : item.exercise_type === "translation_choice"
          ? "exact_choice_v1"
          : "accepted_text_v1";
    if (item.private_grader.kind !== graderKind) {
      return "Exercise and private grader kinds must match";
    }
    if (
      item.exercise_type === "translation_choice" &&
      item.private_grader.kind === "exact_choice_v1" &&
      item.presentation.kind === "translation_choice"
    ) {
      const correctChoiceKey = item.private_grader.correct_choice_key;
      const correctText = item.private_grader.correct_text;
      if (
        !item.presentation.choices.some(
          ({ choice_key, text }) => choice_key === correctChoiceKey && text === correctText,
        )
      ) {
        return "The private correct choice must exactly match one presented choice";
      }
    }
    if (
      item.exercise_type === "typed_cloze" &&
      item.private_grader.kind === "accepted_text_v1" &&
      !item.private_grader.accepted_answers.includes(item.private_grader.canonical_answer)
    ) {
      return "The canonical cloze answer must be accepted";
    }
    return undefined;
  }),
);
export type StudySourceItemV2 = Schema.Schema.Type<typeof StudySourceItemV2>;

export const StudySourceSetV2 = Schema.Struct({
  version: Schema.Literal("study_item_source_v2"),
  community_id: Identifier,
  source_set_revision: PositiveInteger,
  learning_language: Schema.Literal("en"),
  selection_policy_revision: Identifier,
  items: Schema.NonEmptyArray(StudySourceItemV2).check(
    Schema.isMaxLength(64),
    Schema.makeFilter((items) => {
      const sourceKeys = new Set(items.map(({ source_item_key }) => source_item_key));
      const versions = new Set(items.map(({ exercise_version_id }) => exercise_version_id));
      return sourceKeys.size === items.length && versions.size === items.length
        ? undefined
        : "Study source and exercise-version identities must be unique within a set";
    }),
  ),
});
export type StudySourceSetV2 = Schema.Schema.Type<typeof StudySourceSetV2>;

export const StudySourcePromptV2 = Schema.Struct({
  version: Schema.Literal("study_item_source_prompt_v2"),
  source_item_key: Identifier,
  exercise_review_key: Identifier,
  exercise_version_id: Identifier,
  exercise_type: StudyExerciseTypeV2,
  exercise_variant: Identifier,
  line: StudyLineBindingV2,
  languages: StudyLanguageRolesV2,
  learner_band: StudyLearnerBandV2,
  presentation: StudyPresentationV2,
  answer_visibility: Schema.Literals(["always_visible", "secret_until_spent"]),
  feedback_release: Schema.Literals(["every_graded_attempt", "spent_only"]),
  grader_policy_revision: Identifier,
  feedback_policy_revision: Identifier,
  generation_run_id: Identifier,
  producer_id: Identifier,
  provider_model: Schema.NullOr(Identifier),
  prompt_revision: Identifier,
  quality_policy_revision: Identifier,
});
export type StudySourcePromptV2 = Schema.Schema.Type<typeof StudySourcePromptV2>;

export const studySourcePromptV2 = (item: StudySourceItemV2): StudySourcePromptV2 => ({
  version: "study_item_source_prompt_v2",
  source_item_key: item.source_item_key,
  exercise_review_key: item.exercise_review_key,
  exercise_version_id: item.exercise_version_id,
  exercise_type: item.exercise_type,
  exercise_variant: item.exercise_variant,
  line: item.line,
  languages: item.languages,
  learner_band: item.learner_band,
  presentation: item.presentation,
  answer_visibility: item.answer_visibility,
  feedback_release: item.feedback_release,
  grader_policy_revision: item.grader_policy_revision,
  feedback_policy_revision: item.feedback_policy_revision,
  generation_run_id: item.provenance.generation_run_id,
  producer_id: item.provenance.producer_id,
  provider_model: item.provenance.provider_model,
  prompt_revision: item.provenance.prompt_revision,
  quality_policy_revision: item.provenance.quality_policy_revision,
});
