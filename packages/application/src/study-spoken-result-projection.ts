// Exact public spoken metadata projection extracted from the retained Account
// adapter. No grading, authority, provider invocation or mutable lesson policy.
import type {
  StudySpokenLanguageProvenanceV2,
  StudySpokenResultMetadataV2,
} from "@pirate/contracts";
import type { StudySpokenRerecordAssessment } from "@pirate/domain";

export const projectStudySpokenResultMetadata = (
  input: Readonly<{
    languageProvenance: StudySpokenLanguageProvenanceV2;
    rerecordEnabled: boolean;
    rerecord: boolean;
    assessment: StudySpokenRerecordAssessment;
  }>,
): StudySpokenResultMetadataV2 => {
  const assessment = input.assessment;
  return {
    language_provenance: input.languageProvenance,
    rerecord_decision: {
      policy_revision: assessment.policyRevision,
      enabled: input.rerecordEnabled,
      kind: input.rerecord ? "ungraded_rerecord" : "graded",
      reason: input.rerecord ? assessment.candidateReason : null,
      voice_overlap: {
        revision: assessment.voiceOverlap.revision,
        matched_tokens: assessment.voiceOverlap.matchedTokens,
        reference_tokens: assessment.voiceOverlap.referenceTokens,
        below_one_third: assessment.voiceOverlap.belowOneThird,
      },
      strong_remainder: {
        revision: assessment.strongRemainder.revision,
        matched_tokens: assessment.strongRemainder.matchedTokens,
        reference_tokens: assessment.strongRemainder.referenceTokens,
        strong: assessment.strongRemainder.strong,
      },
      language_mismatch: {
        revision: assessment.languageMismatch.revision,
        expected_language: assessment.languageMismatch.expectedLanguage,
        detected_language: assessment.languageMismatch.detectedLanguage,
        detected_confidence: assessment.languageMismatch.detectedConfidence,
        clear: assessment.languageMismatch.clear,
      },
    },
  };
};
