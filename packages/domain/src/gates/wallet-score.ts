import type { AtomEvaluation } from "./policy";

export type WalletScoreEvidence = {
  readonly state: "verified" | "unverified" | "expired";
  readonly provider: string | null;
  readonly score_decimal: string | number | null;
  readonly passing_score: boolean | null;
};

export type WalletScoreAtom = {
  readonly type: "wallet_score";
  readonly provider: "passport";
  readonly minimum_score: number;
};

export type WalletScoreEvaluation = AtomEvaluation & {
  readonly actualScore: number | null;
};

/** Evaluate normalized Passport evidence without performing provider I/O. */
export function evaluateWalletScoreAtom(input: {
  readonly atom: WalletScoreAtom;
  readonly evidence: WalletScoreEvidence | null;
}): WalletScoreEvaluation {
  const { atom, evidence } = input;
  const actualScore = finiteScore(evidence?.score_decimal);
  const requiredAction = {
    kind: "action" as const,
    provider: "passport",
    capability: "wallet_score",
    minimum_score: atom.minimum_score,
    actual_score: actualScore,
  };

  if (evidence?.state !== "verified" || evidence?.provider !== "passport") {
    return { outcome: "action_required", passed: false, requiredAction, actualScore };
  }

  if (actualScore == null || evidence.passing_score !== true || actualScore < atom.minimum_score) {
    return { outcome: "terminal_mismatch", passed: false, requiredAction: null, actualScore };
  }

  return { outcome: "passed", passed: true, requiredAction: null, actualScore };
}

export const evaluateWalletScoreGate = evaluateWalletScoreAtom;

function finiteScore(value: string | number | null | undefined): number | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
