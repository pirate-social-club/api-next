// Direct repository fixtures use empty token diffs and keep the rerecord gate
// off. The full service supplies this evidence from the actual grade.
export const defaultStudySpokenEvidence = {
  languageProvenance: { kind: "no_authoritative_evidence" },
  rerecordEnabled: false,
  rerecordAssessment: {
    policyRevision: "study_spoken_rerecord_v1",
    voiceOverlap: {
      revision: "study_spoken_voice_overlap_v1",
      matchedTokens: 0,
      referenceTokens: 0,
      belowOneThird: false,
    },
    strongRemainder: {
      revision: "study_spoken_strong_remainder_v1",
      matchedTokens: 0,
      referenceTokens: 0,
      strong: false,
    },
    languageMismatch: {
      revision: "study_spoken_language_mismatch_v1",
      expectedLanguage: null,
      detectedLanguage: "en",
      detectedConfidence: 0.99,
      clear: false,
    },
    candidateReason: null,
  },
} as const;
