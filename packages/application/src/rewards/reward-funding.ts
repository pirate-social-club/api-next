import { Data, type Effect } from "effect";

export class RewardFundingStorageFailed extends Data.TaggedError("RewardFundingStorageFailed")<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class RewardFundingRejected extends Data.TaggedError("RewardFundingRejected")<{
  readonly reason:
    | "effect-conflict"
    | "fallback-sponsor-mismatch"
    | "funding-not-allowed"
    | "not-found"
    | "sender-not-owned";
}> {}

export type RewardFundingFailure = RewardFundingRejected | RewardFundingStorageFailed;

export type RewardFundingIntent = Readonly<{
  fundingEffectId: string;
  legId: string;
  legKind: "megapot_pool" | "asset_bonus";
  funderAccountId: string;
  senderAddress: string;
  recipientAddress: string;
  expectedAmountAtomic: bigint;
  requiredConfirmations: number;
  state:
    | "planned"
    | "confirming"
    | "confirmed"
    | "reverted"
    | "reclaimable_failed"
    | "reconciliation_required";
  transactionHash: string | null;
  confirmedAmountAtomic: bigint | null;
  transferLogIndex: number | null;
  blockNumber: bigint | null;
  blockHash: string | null;
  attestationId: string;
  environment: "test" | "staging" | "production";
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  usdcAddress: string;
  custodyAddress: string;
  jackpotAddress: string;
  ticketNftAddress: string;
  referrerAddress: string;
  jackpotCodeHash: string;
  usdcCodeHash: string;
  ticketNftCodeHash: string;
}>;

export interface RewardFundingStore {
  readonly plan: (input: {
    readonly fundingEffectId: string;
    readonly legId: string;
    readonly funderAccountId: string;
    readonly senderAddress: string;
    readonly expectedAmountAtomic: bigint;
    readonly requiredConfirmations: number;
  }) => Effect.Effect<RewardFundingIntent, RewardFundingFailure>;
  readonly find: (
    fundingEffectId: string,
  ) => Effect.Effect<RewardFundingIntent | null, RewardFundingStorageFailed>;
  readonly bindTransaction: (input: {
    readonly fundingEffectId: string;
    readonly transactionHash: string;
  }) => Effect.Effect<RewardFundingIntent, RewardFundingFailure>;
  readonly confirm: (input: {
    readonly fundingEffectId: string;
    readonly transactionHash: string;
    readonly transferLogIndex: number;
    readonly amountAtomic: bigint;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly observationHash: string;
    readonly confirmedAt: string;
  }) => Effect.Effect<void, RewardFundingFailure>;
  readonly revert: (input: {
    readonly fundingEffectId: string;
    readonly transactionHash: string;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly observationHash: string;
  }) => Effect.Effect<void, RewardFundingFailure>;
  readonly requireReconciliation: (input: {
    readonly fundingEffectId: string;
    readonly transactionHash: string;
    readonly reason: string;
  }) => Effect.Effect<void, RewardFundingFailure>;
}
