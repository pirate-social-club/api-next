import { describe, expect, test } from "bun:test";
import {
  isMegapotStepChainAllowed,
  MEGAPOT_CHAIN_STEPS,
  type MegapotChainStep,
} from "./megapot-chain-policy.ts";

describe("Megapot step chain policy", () => {
  test("enumerates every current money-path gate", () => {
    expect(MEGAPOT_CHAIN_STEPS).toEqual([
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
    ]);
  });

  test("keeps every step on Sepolia in test and staging and disabled in production", () => {
    for (const step of MEGAPOT_CHAIN_STEPS) {
      for (const environment of ["test", "staging", "production"] as const) {
        for (const chainId of [84_532, 8_453]) {
          expect(isMegapotStepChainAllowed(step, environment, chainId)).toBe(
            environment !== "production" && chainId === 84_532,
          );
        }
      }
    }
    expect(isMegapotStepChainAllowed("unknown" as MegapotChainStep, "staging", 84_532)).toBe(false);
  });
});
