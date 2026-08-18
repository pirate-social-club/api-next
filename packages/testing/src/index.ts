/**
 * @pirate/testing — test layers, fixtures, harnesses.
 *
 * Lane B owns this package (api-next 001 §4). Structurally a second
 * platform: it implements application ports for tests. Production code
 * never imports it (000 §4 dependency matrix).
 */
export const testing = "api-next/testing: lane B (001 §4)" as const;
export * from "./community-schema.ts";
