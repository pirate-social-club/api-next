import { Data, type Effect } from "effect";

export class RewardSafeSettlementFailedV1 extends Data.TaggedError("RewardSafeSettlementFailedV1")<{
  readonly reason: "invalid" | "conflict" | "unavailable" | "authority" | "production-disabled";
  readonly stage?: string;
}> {}

/** Separate versioned boundary. No phase0 port or historical direct-send contract changes. */
export type RewardSafePolicyV1 = Readonly<{
  policyId: string;
  version: "safe_credit_v1";
  posture: "local_only";
  attestationId: string;
  collectionRoot: string;
  safeRoot: string;
  token: string;
  module: string;
  moduleCodeHash: string;
  safeCodeHash: string;
  safeSingleton: string;
  safeSingletonCodeHash: string;
  relayer: string;
  creditAuthority: string;
  aggregateCapAtomic: bigint;
}>;
export type RewardSafeCandidateV1 = Readonly<{
  creditId: string;
  accountId: string;
  personaId: string;
  walletAssignmentId: string;
  recipient: string;
  amountAtomic: bigint;
}>;
export type RewardSafeAuthorizationV1 = Readonly<{
  digest: string;
  signature: string;
  validUntil: bigint;
  issuerKeyId: string;
}>;
export interface IndependentRewardCreditIssuerV1 {
  readonly authorize: (
    candidate: RewardSafeCandidateV1,
    policy: RewardSafePolicyV1,
  ) => Effect.Effect<RewardSafeAuthorizationV1, RewardSafeSettlementFailedV1>;
}
export type RewardSafeUnsignedV1 = Readonly<{
  chainId: 8453;
  signerAddress: string;
  targetAddress: string;
  nonce: string;
  data: string;
  valueWei: "0";
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}>;
export type RewardSafeSignedV1 = Readonly<{ rawTransaction: string; transactionHash: string }>;
/** The adapter must retain one result per key. Unknown signing is lookup-only. */
export interface RewardSafeSignerV1 {
  readonly sign: (
    key: string,
    request: RewardSafeUnsignedV1,
  ) => Effect.Effect<RewardSafeSignedV1, RewardSafeSettlementFailedV1>;
  readonly lookup: (
    key: string,
  ) => Effect.Effect<RewardSafeSignedV1 | null, RewardSafeSettlementFailedV1>;
}
export type RewardSafeRecordV1 = Readonly<{
  candidate: RewardSafeCandidateV1;
  policy: RewardSafePolicyV1;
  authorization: RewardSafeAuthorizationV1;
  state:
    | "authorized"
    | "signing"
    | "signed"
    | "broadcast_unknown"
    | "submitted"
    | "confirmed"
    | "held";
  unsigned: RewardSafeUnsignedV1 | null;
  signed: RewardSafeSignedV1 | null;
  preparationOwner: string | null;
}>;
export type RewardSafeSolvencyV1 = Readonly<{
  policyId: string;
  blockNumber: bigint;
  blockHash: string;
  collectionBalanceAtomic: bigint;
  safeBalanceAtomic: bigint;
  reservedPurchaseAtomic: bigint;
  outstandingCreditAtomic: bigint;
  pendingRefundAtomic: bigint;
  sharedSponsorshipAtomic: bigint;
  reservedSafeAtomic: bigint;
  solvent: boolean;
}>;
export interface RewardSafeSettlementStoreV1 {
  readonly recordSolvency: (
    observation: Pick<
      RewardSafeSolvencyV1,
      "policyId" | "blockNumber" | "blockHash" | "collectionBalanceAtomic" | "safeBalanceAtomic"
    >,
  ) => Effect.Effect<RewardSafeSolvencyV1, RewardSafeSettlementFailedV1>;
  readonly policy: (
    policyId: string,
  ) => Effect.Effect<RewardSafePolicyV1, RewardSafeSettlementFailedV1>;
  readonly candidate: (
    creditId: string,
    policyId: string,
  ) => Effect.Effect<RewardSafeCandidateV1, RewardSafeSettlementFailedV1>;
  readonly find: (
    creditId: string,
  ) => Effect.Effect<RewardSafeRecordV1 | null, RewardSafeSettlementFailedV1>;
  readonly reserve: (
    candidate: RewardSafeCandidateV1,
    policy: RewardSafePolicyV1,
    authorization: RewardSafeAuthorizationV1,
  ) => Effect.Effect<RewardSafeRecordV1, RewardSafeSettlementFailedV1>;
  readonly prepare: (
    creditId: string,
    unsigned: RewardSafeUnsignedV1,
    observedBlock: bigint,
    observedHash: string,
    preparationOwner: string,
  ) => Effect.Effect<Readonly<{record:RewardSafeRecordV1; ownership:"acquired"|"lookup_only"}>, RewardSafeSettlementFailedV1>;
  readonly signed: (
    creditId: string,
    signed: RewardSafeSignedV1,
  ) => Effect.Effect<RewardSafeRecordV1, RewardSafeSettlementFailedV1>;
  readonly transition: (
    creditId: string,
    from: RewardSafeRecordV1["state"],
    to: "broadcast_unknown" | "submitted" | "held",
  ) => Effect.Effect<RewardSafeRecordV1, RewardSafeSettlementFailedV1>;
  readonly confirm: (
    creditId: string,
    evidence: {
      transactionHash: string;
      moduleLogIndex: number;
      transferLogIndex: number;
      blockNumber: bigint;
      blockHash: string;
      receiptHash: string;
    },
  ) => Effect.Effect<RewardSafeRecordV1, RewardSafeSettlementFailedV1>;
}
