/**
 * @pirate/domain — pure entities, value objects, policies, reducers.
 *
 * Lane B owns this package (api-next 001 §4): verbatim-behavior ports of
 * the old API's pure reducers with their invariant suites. Zero I/O, zero
 * Effect service dependencies; `effect/Schema` and data types only.
 */
export const domain = "api-next/domain: lane B (001 §4)" as const;
export * from "./auth/profile-projection.ts";
export * from "./auth/session-policy.ts";
export * from "./bookings/attendance.ts";
export * from "./bookings/settlement.ts";
export * from "./canonical-json.ts";
export * from "./community/canonical-route.ts";
export * from "./community/creation-intent.ts";
export * from "./community/creation-provider-binding.ts";
export * from "./community/creation-requirement.ts";
export * from "./community/creation-requirements.ts";
export * from "./community/gate-policy-compiler.ts";
export * from "./community/join-intent-binding.ts";
export * from "./content/text-moderation.ts";
export * from "./gates/country-codes.ts";
export * from "./gates/erc721.ts";
export * from "./gates/identity-evidence.ts";
export * from "./gates/open-participation.ts";
export * from "./gates/policy.ts";
export * from "./gates/policy-validation.ts";
export * from "./gates/proof-of-work.ts";
export * from "./gates/verification-eligibility.ts";
export * from "./gates/wallet-score.ts";
export type {
  CuratedAge18Evaluation,
  CuratedAge18EvaluatorInput,
  CuratedAge18Fail,
  CuratedAge18Indeterminate,
  CuratedAge18NeedsEvidence,
  CuratedAge18Pass,
  CuratedAge18Policy,
  CuratedAgeEvaluation,
  CuratedAgeEvaluatorInput,
  CuratedAgeFail,
  CuratedAgeIndeterminate,
  CuratedAgeNeedsEvidence,
  CuratedAgePass,
  CuratedAgePolicy,
  CuratedHumanMembershipEvaluation,
  CuratedHumanMembershipEvaluatorInput,
  CuratedHumanMembershipFail,
  CuratedHumanMembershipIndeterminate,
  CuratedHumanMembershipNeedsEvidence,
  CuratedHumanMembershipPass,
  CuratedHumanMembershipPolicy,
  EvaluatorReason,
  EvaluatorWitness,
  EvidenceAvailability,
  EvidenceUnavailableReason,
  GatesV2EvaluationOutcome,
  HumanMembershipRequiredClaim,
  RequiredClaim,
} from "./gates-v2/index.ts";
export {
  CURATED_AGE_18_POLICY,
  CURATED_AGE_18_POLICY_CANONICAL_PREIMAGE,
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  CURATED_HUMAN_MEMBERSHIP_POLICY_CANONICAL_PREIMAGE,
  evaluateAge18,
  evaluateCuratedAge,
  evaluateCuratedAge18,
  evaluateCuratedHumanMembership,
  humanMembershipPolicyCanonicalPreimage,
  policyCanonicalPreimage,
} from "./gates-v2/index.ts";
export * from "./handles/label-claim-rules.ts";
export * from "./handles/policy.ts";
export * from "./money/community-purchase-funding.ts";
export * from "./money/failure-fence.ts";
export * from "./money/interpreter-contract.ts";
export * from "./money/reconciliation-backoff.ts";
export * from "./money/state-machine.ts";
export * from "./rewards/capacity-freshness.ts";
export * from "./rewards/payout-fairness.ts";
export * from "./rewards/vault-revert.ts";
export * from "./story/story-settlement-step-state-machine.ts";
