import { Schema } from "effect";

const BoundedIdentifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value) =>
    value === value.trim() &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
      ? undefined
      : "Expected a bounded identifier",
  ),
);

const BoundedPromptText = Schema.NonEmptyString.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) =>
    ![...value].some(
      (character) => character.charCodeAt(0) === 0 || character.charCodeAt(0) === 0x7f,
    )
      ? undefined
      : "Expected bounded prompt text",
  ),
);

const PositiveRevision = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

export const StudyItemSongRevisionV1 = Schema.Struct({
  community_id: BoundedIdentifier,
  post_id: BoundedIdentifier,
  audio_revision: PositiveRevision,
  lyrics_revision: PositiveRevision,
});
export type StudyItemSongRevisionV1 = Schema.Schema.Type<typeof StudyItemSongRevisionV1>;

export const StudyItemChoiceV1 = Schema.Struct({
  choice_key: BoundedIdentifier,
  text: BoundedPromptText,
});
export type StudyItemChoiceV1 = Schema.Schema.Type<typeof StudyItemChoiceV1>;

const StudyItemChoicesV1 = Schema.NonEmptyArray(StudyItemChoiceV1).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(12),
  Schema.makeFilter((choices) =>
    new Set(choices.map(({ choice_key }) => choice_key)).size === choices.length
      ? undefined
      : "Study item choice keys must be unique",
  ),
);

export const StudyItemPromptV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text_response"),
    text: BoundedPromptText,
  }),
  Schema.Struct({
    kind: Schema.Literal("single_select"),
    text: BoundedPromptText,
    choices: StudyItemChoicesV1,
  }),
]);
export type StudyItemPromptV1 = Schema.Schema.Type<typeof StudyItemPromptV1>;

const AcceptedTextAnswersV1 = Schema.NonEmptyArray(BoundedPromptText).check(Schema.isMaxLength(12));

export const StudyItemAnswerKeyV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text_response"),
    comparison: Schema.Literal("unicode_casefold_whitespace_v1"),
    accepted_answers: AcceptedTextAnswersV1,
  }),
  Schema.Struct({
    kind: Schema.Literal("single_select"),
    correct_choice_key: BoundedIdentifier,
  }),
]);
export type StudyItemAnswerKeyV1 = Schema.Schema.Type<typeof StudyItemAnswerKeyV1>;

export const StudyItemSourceItemV1 = Schema.Struct({
  source_item_key: BoundedIdentifier,
  prompt: StudyItemPromptV1,
  answer_key: StudyItemAnswerKeyV1,
}).check(
  Schema.makeFilter(({ prompt, answer_key }) => {
    if (prompt.kind !== answer_key.kind) {
      return "Study item prompt and answer-key kinds must match";
    }
    if (
      prompt.kind === "single_select" &&
      answer_key.kind === "single_select" &&
      !prompt.choices.some(({ choice_key }) => choice_key === answer_key.correct_choice_key)
    ) {
      return "The correct Study choice must exist in the prompt";
    }
    return undefined;
  }),
);
export type StudyItemSourceItemV1 = Schema.Schema.Type<typeof StudyItemSourceItemV1>;

export const StudyItemSourceProvenanceV1 = Schema.Struct({
  kind: Schema.Literal("accepted_song_lyrics"),
  producer_id: BoundedIdentifier,
  producer_revision: BoundedIdentifier,
});
export type StudyItemSourceProvenanceV1 = Schema.Schema.Type<typeof StudyItemSourceProvenanceV1>;

const StudyItemSourceItemsV1 = Schema.NonEmptyArray(StudyItemSourceItemV1).check(
  Schema.isMaxLength(64),
  Schema.makeFilter((items) =>
    new Set(items.map(({ source_item_key }) => source_item_key)).size === items.length
      ? undefined
      : "Study source item keys must be unique within a source revision",
  ),
);

/** Internal, server-only source set. `answer_key` must never enter a wire projection. */
export const StudyItemSourceSetV1 = Schema.Struct({
  version: Schema.Literal("study_item_source_v1"),
  song_revision: StudyItemSongRevisionV1,
  source_revision: PositiveRevision,
  provenance: StudyItemSourceProvenanceV1,
  items: StudyItemSourceItemsV1,
});
export type StudyItemSourceSetV1 = Schema.Schema.Type<typeof StudyItemSourceSetV1>;

/** Structured identity; no account, persona, session, or mutable display field participates. */
export const StudyItemSourceIdentityV1 = Schema.Struct({
  ...StudyItemSongRevisionV1.fields,
  source_revision: PositiveRevision,
  source_item_key: BoundedIdentifier,
});
export type StudyItemSourceIdentityV1 = Schema.Schema.Type<typeof StudyItemSourceIdentityV1>;

export const studyItemSourceIdentityV1 = (
  source: StudyItemSourceSetV1,
  item: StudyItemSourceItemV1,
): StudyItemSourceIdentityV1 => ({
  ...source.song_revision,
  source_revision: source.source_revision,
  source_item_key: item.source_item_key,
});

/**
 * Prompt-only source projection for the later session snapshot. The rewards
 * slice adds session identity and presentation state; this boundary cannot
 * carry grading data by construction.
 */
export const StudyItemSourcePromptV1 = Schema.Struct({
  version: Schema.Literal("study_item_source_prompt_v1"),
  identity: StudyItemSourceIdentityV1,
  prompt: StudyItemPromptV1,
});
export type StudyItemSourcePromptV1 = Schema.Schema.Type<typeof StudyItemSourcePromptV1>;

export const studyItemSourcePromptV1 = (
  source: StudyItemSourceSetV1,
  item: StudyItemSourceItemV1,
): StudyItemSourcePromptV1 => ({
  version: "study_item_source_prompt_v1",
  identity: studyItemSourceIdentityV1(source, item),
  prompt: item.prompt,
});
