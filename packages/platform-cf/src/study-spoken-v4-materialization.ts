import { createHash } from "node:crypto";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export type AcceptedSpokenSource = Readonly<{
  communityId: string;
  postId: string;
  audioRevision: number;
  lyricsRevision: number;
  lineId: string;
  lineVersion: number;
  canonicalText: string;
  sourceHash: string;
  studyUnitId: string;
}>;

export const spokenV4ContentRevision = (audioRevision: number, lyricsRevision: number) => {
  const revision = (audioRevision * 1_000_000 + lyricsRevision) * 100 + 4;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError("invalid revision");
  return revision;
};

/** Build an immutable spoken exercise from accepted lyrics. */
export const acceptedSpokenV4Insert = (source: AcceptedSpokenSource) => {
  const reviewKey = `study-say-it-back:${source.postId}:${source.studyUnitId}`;
  return {
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
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,'say_it_back','spoken-recall-v2','en',NULL,
      NULL,$15,$10::jsonb,$11::jsonb,$12,NULL,'always_visible',
      'every_graded_attempt','script_aware_token_phonetic_v4','spoken-feedback-v1',
      'deterministic',$13,'accepted-lyrics-say-it-back-v2',NULL,
      'accepted-say-it-back-v4',$14,$8,'study-source-structure-v1',
      'study-source-semantic-v1','study-source-safety-v1',
      'study-source-quality-v1','accepted-source-v1',clock_timestamp(),
      clock_timestamp(),clock_timestamp()
    ) ON CONFLICT (exercise_review_key, content_revision) DO NOTHING`,
    values: [
      `study-exercise-${crypto.randomUUID()}`,
      source.communityId,
      source.postId,
      source.audioRevision,
      source.lyricsRevision,
      source.lineId,
      source.lineVersion,
      source.sourceHash,
      reviewKey,
      JSON.stringify({
        kind: "say_it_back",
        reference_text: source.canonicalText,
        capture: "microphone_audio",
      }),
      JSON.stringify({
        kind: "source_token_phonetic_v4",
        reference_text: source.canonicalText,
        tokenizer_policy_revision: "script_aware_token_phonetic_v4",
      }),
      source.studyUnitId,
      `study-source-${crypto.randomUUID()}`,
      sha256(
        JSON.stringify([
          "accepted_say_it_back_v4",
          source.postId,
          source.audioRevision,
          source.lyricsRevision,
          source.studyUnitId,
          source.lineVersion,
          source.sourceHash,
        ]),
      ),
      spokenV4ContentRevision(source.audioRevision, source.lyricsRevision),
    ],
  };
};
