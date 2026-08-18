export type {
  CuratedAge18Evaluation,
  CuratedAge18EvaluatorInput,
  CuratedAge18Fail,
  CuratedAge18Indeterminate,
  CuratedAge18NeedsEvidence,
  CuratedAge18Pass,
  CuratedAge18Policy,
  EvaluatorReason,
  EvaluatorWitness,
  EvidenceAvailability,
  EvidenceUnavailableReason,
  GatesV2EvaluationOutcome,
} from "./evaluator.ts";
export {
  CURATED_AGE_18_POLICY,
  evaluateAge18,
  evaluateCuratedAge18,
} from "./evaluator.ts";
export {
  SELF_STAGING_18_PLUS_DEVELOPMENT_EVIDENCE,
  SELF_STAGING_18_PLUS_EVALUATION_NOW,
} from "./fixtures/self-staging-18-plus.ts";
