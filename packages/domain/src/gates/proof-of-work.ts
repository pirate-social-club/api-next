import type { AtomEvaluation, RequiredActionNode } from "./policy";

export type ProofOfWorkEvaluationMode = "preview" | "enforce" | "diagnose";

export type ProofOfWorkEvidence = {
  readonly actorUserId: string;
  readonly scope: string;
  readonly action: string;
  readonly verified?: boolean;
};

export type ProofOfWorkAtom = { readonly type: "altcha_pow" };

/**
 * Evaluate proof-of-work facts only. Preview and diagnose deliberately never
 * consume evidence; consumption belongs to the application boundary.
 */
export function evaluateProofOfWorkAtom(input: {
  readonly atom: ProofOfWorkAtom;
  readonly mode: ProofOfWorkEvaluationMode;
  readonly actorUserId: string;
  readonly scope: string;
  readonly action: string;
  readonly verifiedEvidence: ProofOfWorkEvidence | null;
}): AtomEvaluation {
  if (
    input.mode === "enforce" &&
    input.verifiedEvidence != null &&
    input.verifiedEvidence.verified !== false &&
    input.verifiedEvidence.actorUserId === input.actorUserId &&
    input.verifiedEvidence.scope === input.scope &&
    input.verifiedEvidence.action === input.action
  ) {
    return { outcome: "passed", passed: true, requiredAction: null };
  }
  return {
    outcome: "action_required",
    passed: false,
    requiredAction: proofOfWorkAction(input.scope),
  };
}

export const evaluateProofOfWorkGate = evaluateProofOfWorkAtom;

function proofOfWorkAction(scope: string): RequiredActionNode {
  return {
    kind: "action",
    provider: "altcha",
    capability: "altcha_pow",
    scope,
  };
}
