/**
 * @pirate/domain — pure entities, value objects, policies, reducers.
 *
 * Lane B owns this package (api-next 001 §4): verbatim-behavior ports of
 * the old API's pure reducers with their invariant suites. Zero I/O, zero
 * Effect service dependencies; `effect/Schema` and data types only.
 */
export const domain = "api-next/domain: lane B (001 §4)" as const;
export * from "./bookings/attendance.ts";
export * from "./bookings/settlement.ts";
export * from "./gates/country-codes.ts";
export * from "./gates/identity-evidence.ts";
export * from "./gates/policy.ts";
export * from "./handles/label-claim-rules.ts";
export * from "./handles/policy.ts";
export * from "./money/failure-fence.ts";
export * from "./money/state-machine.ts";
export * from "./rewards/capacity-freshness.ts";
export * from "./rewards/payout-fairness.ts";
export * from "./rewards/vault-revert.ts";
export * from "./story/story-settlement-step-state-machine.ts";
