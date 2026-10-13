import {Schema} from 'effect';
import {OwnerAccountStudySessionV1,GuestStudyPreparedContentV2} from '@pirate/contracts';
const instant = "2026-10-11T10:00:00.000Z";
const item = (ordinal: number) => ({
  object: "study_session_item_v2",
  session_item_id: `item-${ordinal}`,
  ordinal,
  exercise_review_key: `review-${ordinal}`,
  exercise_version_id: `version-${ordinal}`,
  exercise_type: "say_it_back",
  exercise_variant: "spoken-recall-v1",
  line: {
    post_id: "post-1",
    audio_revision: 1,
    lyrics_revision: 1,
    lyric_line_id: `line-${ordinal}`,
    study_unit_id: `unit-${ordinal}`,
    line_version: 1,
    line_source_hash: "a".repeat(64),
  },
  languages: { learning_language: "en", target_language: null },
  learner_band: null,
  language_profile_revision: null,
  presentation: { kind: "say_it_back", reference_text: "Hold on", capture: "microphone_audio" },
  answer_visibility: "always_visible",
  feedback_release: "every_graded_attempt",
  grader_policy_revision: "script-aware-token-diff-v1",
  feedback_policy_revision: "spoken-feedback-v1",
  quality_policy_revision: "study-quality-v1",
  maximum_attempts: 1,
});
const session = () => ({
  object: "study_session_v2",
  persona_id: "persona-1",
  session_id: "session-1",
  community_id: "community-1",
  post_id: "post-1",
  audio_revision: 1,
  lyrics_revision: 1,
  languages: { learning_language: "en", target_language: null },
  learner_band: null,
  study_profile_revision: 1,
  language_profile_revision: null,
  source_set_revision: 1,
  selection_policy_revision: "selection-v1",
  qualification_policy_revision: "study_session_first_pass_v2@1",
  timezone: "UTC",
  status: "active",
  items: Array.from({ length: 4 }, (_, ordinal) => item(ordinal)),
  progress: {
    qualifying_exercise_count: 4,
    answered_exercise_count: 0,
    first_pass_correct: 0,
    required_correct: 3,
    score_bps: null,
  },
  lesson: {
    current: {
      session_item_id: "item-0",
      presentation_number: 1,
      is_reappearance: false,
      presented_at: instant,
    },
    resolved_card_count: 0,
    total_card_count: 4,
    presentation_count: 0,
    presentation_cap: 12,
    completion_reason: null,
  },
  created_at: instant,
  completed_at: null,
});
const terms = {
 community_id: "community-1", post_id: "post-1", audio_revision: 1, lyrics_revision: 1,
 offer_id: "offer-1", pool_leg_id: "leg-1", original_drawing_id: "7",
 qualification_policy_version_id: "study_session_first_pass_v2@1", policy_hash: "a".repeat(64),
 terms_hash: "b".repeat(64), entry_cutoff_at: instant, disclosure_version: "disclosure-v1",
};
const publicPractice = {
 object: "guest_study_prepared_content_v1", reward_preview: null,
 disclosure: {version: "disclosure-v1", text: "Actual server disclosure"},
 availability: {state: "ready", available_exercise_types: ["say_it_back"], learning_language: "en", target_languages: ["es"], learner_bands: ["A1"]},
};

export const ownerSession=Schema.decodeUnknownSync(OwnerAccountStudySessionV1,{onExcessProperty:'error'})({object:'owner_account_study_session_v1',session:session(),reward_terms:terms,participation:{state:'not_yet_qualified'}});
export const publicPrepared=Schema.decodeUnknownSync(GuestStudyPreparedContentV2,{onExcessProperty:'error'})({...publicPractice,object:'guest_study_prepared_content_v2',reward_preview_terms_hash:null});
