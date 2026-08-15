/**
 * @pirate/domain — pure entities, value objects, policies, reducers.
 *
 * Lane B owns this package (api-next 001 §4): verbatim-behavior ports of
 * the old API's pure reducers with their invariant suites. Zero I/O, zero
 * Effect service dependencies; `effect/Schema` and data types only.
 */
export const domain = "api-next/domain: lane B (001 §4)" as const;
export * from "./bookings/attendance.ts";
export * from "./money/failure-fence.ts";
export * from "./money/state-machine.ts";
export * from "./story/story-settlement-step-state-machine.ts";
