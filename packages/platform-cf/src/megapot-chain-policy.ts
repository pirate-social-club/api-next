import type { MegapotV2Environment } from "./megapot-v2.ts";

export const MEGAPOT_CHAIN_STEPS = [
  "approval",
  "purchase",
  "drawing-observation",
  "sweep",
  "claim",
  "funding",
  "solvency",
  "allocation",
  "payout",
  "refund",
  "transaction-signing",
] as const;

export type MegapotChainStep = (typeof MEGAPOT_CHAIN_STEPS)[number];

/** Production needs a separately reviewed activation input before any step can run. */
export function isMegapotStepChainAllowed(
  step: MegapotChainStep,
  environment: MegapotV2Environment,
  chainId: number,
): boolean {
  if (!MEGAPOT_CHAIN_STEPS.includes(step)) return false;
  return (environment === "test" || environment === "staging") && chainId === 84_532;
}
