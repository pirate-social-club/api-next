/** L1/L2/L3 rules over evidence verified by the EXISTING nonce/receipt interpreter.
 * This is not an RPC verifier, receipt discovery service, signer or outbound interpreter.
 */
export type PrincipalInstruction = Readonly<{
  chainId: number;
  sender: string;
  nonce: bigint;
  anchorBlock: bigint;
  expectedAmount: bigint;
  validFrom: number;
  deadline: number;
  fixedEnd: number;
  invalidatedAt: readonly number[];
}>;
export type VerifiedNonceEvidence =
  | Readonly<{ kind: "unknown" }>
  | Readonly<{
      kind: "transfer";
      chainId: number;
      sender: string;
      nonce: bigint;
      block: bigint;
      includedAt: number;
      finalized: boolean;
      exactInstruction: boolean;
      amount: bigint;
    }>
  | Readonly<{
      kind: "no_principal";
      chainId: number;
      sender: string;
      nonce: bigint;
      finalized: boolean;
      custodyScanComplete: boolean;
    }>;
export type PrincipalDisposition =
  | Readonly<{ kind: "unresolved"; retainLiability: true }>
  | Readonly<{ kind: "incident_hold"; retainLiability: true }>
  | Readonly<{ kind: "pool_principal"; amount: bigint }>
  | Readonly<{ kind: "late_principal"; amount: bigint }>
  | Readonly<{ kind: "no_principal" }>
  | Readonly<{ kind: "unattributed_asset"; retainLiability: true }>;

function effectiveFundingDeadline(instruction: PrincipalInstruction): number {
  return Math.min(instruction.deadline, instruction.fixedEnd, ...instruction.invalidatedAt);
}

export function classifyRewardPrincipal(
  instruction: PrincipalInstruction,
  evidence: VerifiedNonceEvidence,
  cohortSealed: boolean,
): PrincipalDisposition {
  if (
    ![
      instruction.validFrom,
      instruction.deadline,
      instruction.fixedEnd,
      ...instruction.invalidatedAt,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    instruction.expectedAmount <= 0n ||
    instruction.expectedAmount >= 1n << 256n
  )
    return { kind: "incident_hold", retainLiability: true };
  if (evidence.kind === "unknown" || !evidence.finalized)
    return { kind: "unresolved", retainLiability: true };
  if (
    evidence.chainId !== instruction.chainId ||
    evidence.sender !== instruction.sender ||
    evidence.nonce !== instruction.nonce
  )
    return { kind: "unattributed_asset", retainLiability: true };
  if (evidence.kind === "no_principal")
    return evidence.custodyScanComplete
      ? { kind: "no_principal" }
      : { kind: "unresolved", retainLiability: true };
  if (
    evidence.amount <= 0n ||
    evidence.amount >= 1n << 256n ||
    !Number.isSafeInteger(evidence.includedAt) ||
    evidence.includedAt < 0
  )
    return { kind: "incident_hold", retainLiability: true };
  const valid =
    evidence.exactInstruction &&
    evidence.amount === instruction.expectedAmount &&
    evidence.block > instruction.anchorBlock &&
    evidence.includedAt >= instruction.validFrom &&
    evidence.includedAt < effectiveFundingDeadline(instruction);
  if (valid && cohortSealed) return { kind: "incident_hold", retainLiability: true };
  return { kind: valid ? "pool_principal" : "late_principal", amount: evidence.amount };
}

/** Final interval closure frees capacity, NEVER the unresolved nonce/account liability. */
export function mayReleaseExpiredCapacity(input: {
  readonly effectiveDeadline: number;
  readonly finalizedCheckpointTime: number;
  readonly gapFreeCustodyScan: boolean;
  readonly allPredeadlineReceiptsClassified: boolean;
}): boolean {
  return (
    input.gapFreeCustodyScan &&
    input.allPredeadlineReceiptsClassified &&
    input.finalizedCheckpointTime > input.effectiveDeadline
  );
}

export type PrincipalBuckets = Readonly<{
  poolReceived: bigint;
  ticketSpent: bigint;
  ticketReserved: bigint;
  poolRefundPaid: bigint;
  poolRefundOwed: bigint;
  poolFree: bigint;
  lateReceived: bigint;
  lateRefundPaid: bigint;
  lateRefundOwed: bigint;
}>;
export function conservesRewardPrincipal(b: PrincipalBuckets): boolean {
  return (
    Object.values(b).every((n) => n >= 0n && n < 1n << 256n) &&
    b.poolReceived ===
      b.ticketSpent + b.ticketReserved + b.poolRefundPaid + b.poolRefundOwed + b.poolFree &&
    b.lateReceived === b.lateRefundPaid + b.lateRefundOwed
  );
}

/** Full-principal late return is an UNSELECTED policy, not a fee or signer default. */
export function latePrincipalReturnAmount(
  amount: bigint,
  acceptedPolicy: "full_principal" | null,
): bigint | null {
  return acceptedPolicy === "full_principal" && amount > 0n && amount < 1n << 256n ? amount : null;
}

/** Per-effect floors/largest remainders; aggregate identical senders only AFTER this. */
export function poolRefundShares(
  effects: readonly Readonly<{ effectId: string; sender: string; confirmedAmount: bigint }>[],
  remaining: bigint,
): readonly Readonly<{ effectId: string; sender: string; amount: bigint }>[] {
  const total = effects.reduce((sum, e) => sum + e.confirmedAmount, 0n);
  if (
    remaining < 0n ||
    remaining >= 1n << 256n ||
    remaining > total ||
    total <= 0n ||
    total >= 1n << 256n ||
    new Set(effects.map((e) => e.effectId)).size !== effects.length ||
    effects.some((e) => e.confirmedAmount <= 0n || e.confirmedAmount >= 1n << 256n)
  )
    throw new RangeError("Invalid sealed refund basis");
  const shares = effects.map((e) => ({
    ...e,
    amount: (remaining * e.confirmedAmount) / total,
    remainder: (remaining * e.confirmedAmount) % total,
  }));
  let dust = remaining - shares.reduce((sum, e) => sum + e.amount, 0n);
  const ranked = [...shares].sort((a, b) =>
    a.remainder === b.remainder
      ? a.effectId < b.effectId
        ? -1
        : a.effectId > b.effectId
          ? 1
          : 0
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (const share of ranked) {
    if (dust === 0n) break;
    share.amount += 1n;
    dust -= 1n;
  }
  return shares.map(({ effectId, sender, amount }) => ({ effectId, sender, amount }));
}
