import type {
  RewardConfirmedRefund,
  RewardRefundCandidate,
  RewardRefundFailure,
  RewardRefundStore,
} from "@pirate/application";
import { Data, type Effect } from "effect";
import { type Hex, keccak256, toBytes } from "viem";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";
import type { RewardRunAuthority } from "./reward-operations-control.ts";
import { makeRewardTokenSendCoordinator } from "./reward-token-send-coordinator.ts";

export class RewardRefundCoordinatorFailed extends Data.TaggedError(
  "RewardRefundCoordinatorFailed",
)<{
  readonly reason:
    | "deployment_attestation_mismatch"
    | "gas_floor_insufficient"
    | "invalid_config"
    | "production_disabled"
    | "receipt_evidence_invalid"
    | "signer_mismatch"
    | "solvency_insufficient";
  readonly phase: "configuration" | "preflight" | "prepare" | "receipt";
}> {}

export type RewardRefundCoordinatorResult =
  | Readonly<{ kind: "submitted"; effectId: string; transactionHash: string }>
  | Readonly<{ kind: "reconciliation_required"; effectId: string; transactionHash: string }>
  | Readonly<{
      kind: "confirmed";
      effectId: string;
      fundingEffectId: string;
      legId: string;
      transactionHash: string;
      destinationAddress: string;
      amountAtomic: bigint;
      blockNumber: bigint;
      blockHash: string;
      confirmations: number;
    }>;

const failed = (
  reason: RewardRefundCoordinatorFailed["reason"],
  phase: RewardRefundCoordinatorFailed["phase"],
) => new RewardRefundCoordinatorFailed({ reason, phase });

export function deriveRewardRefundEffectId(fundingEffectId: string): Hex {
  if (fundingEffectId.length === 0 || fundingEffectId !== fundingEffectId.trim()) {
    throw failed("invalid_config", "configuration");
  }
  return keccak256(toBytes(`pirate.reward-refund.v1\u0000${fundingEffectId}`));
}

function confirmedResult(
  value: RewardConfirmedRefund,
): Extract<RewardRefundCoordinatorResult, { kind: "confirmed" }> {
  return {
    kind: "confirmed",
    effectId: value.effectId,
    fundingEffectId: value.fundingEffectId,
    legId: value.legId,
    transactionHash: value.transactionHash,
    destinationAddress: value.destinationAddress,
    amountAtomic: value.amountAtomic,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    confirmations: value.confirmations,
  };
}

export interface RewardRefundCoordinator {
  readonly refund: (
    fundingEffectId: string,
  ) => Effect.Effect<
    RewardRefundCoordinatorResult,
    RewardRefundCoordinatorFailed | RewardRefundFailure
  >;
  readonly reconcile: (
    effectId: string,
  ) => Effect.Effect<
    RewardRefundCoordinatorResult,
    RewardRefundCoordinatorFailed | RewardRefundFailure
  >;
}

export function makeRewardRefundCoordinator(input: {
  readonly store: RewardRefundStore;
  readonly rpc: MegapotV2RpcClient;
  readonly signer: MegapotV2TransactionSigner;
  readonly authority: RewardRunAuthority;
  readonly requiredConfirmations: number;
  readonly gasLimitMultiplierBps: number;
  readonly nativeGasReserveFloorWei: bigint;
  readonly now?: () => number;
}): RewardRefundCoordinator {
  const coordinator = makeRewardTokenSendCoordinator<
    RewardRefundCandidate,
    RewardConfirmedRefund,
    RewardRefundFailure,
    RewardRefundCoordinatorFailed,
    Extract<RewardRefundCoordinatorResult, { kind: "confirmed" }>
  >({
    ...input,
    family: "refund",
    failed,
    deriveEffectId: deriveRewardRefundEffectId,
    confirmedResult,
    confirmedFromReceipt: (candidate, result) => ({
      ...result,
      fundingEffectId: candidate.fundingEffectId,
      legId: candidate.legId,
    }),
  });
  return { refund: coordinator.send, reconcile: coordinator.reconcile };
}
