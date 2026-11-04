import type {
  RewardConfirmedPayout,
  RewardPayoutCandidate,
  RewardPayoutFailure,
  RewardPayoutStore,
} from "@pirate/application";
import { Data, type Effect } from "effect";
import { type Hex, keccak256, toBytes } from "viem";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";
import type { RewardRunAuthority } from "./reward-operations-control.ts";
import { makeRewardTokenSendCoordinator } from "./reward-token-send-coordinator.ts";

export class RewardPayoutCoordinatorFailed extends Data.TaggedError(
  "RewardPayoutCoordinatorFailed",
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

export type RewardPayoutCoordinatorResult =
  | Readonly<{ kind: "submitted"; effectId: string; transactionHash: string }>
  | Readonly<{ kind: "reconciliation_required"; effectId: string; transactionHash: string }>
  | Readonly<{
      kind: "confirmed";
      effectId: string;
      creditId: string;
      transactionHash: string;
      destinationAddress: string;
      amountAtomic: bigint;
      blockNumber: bigint;
      blockHash: string;
      confirmations: number;
    }>;

const failed = (
  reason: RewardPayoutCoordinatorFailed["reason"],
  phase: RewardPayoutCoordinatorFailed["phase"],
) => new RewardPayoutCoordinatorFailed({ reason, phase });

export function deriveRewardPayoutEffectId(creditId: string): Hex {
  if (creditId.length === 0 || creditId !== creditId.trim()) {
    throw failed("invalid_config", "configuration");
  }
  return keccak256(toBytes(`pirate.reward-payout.v1\u0000${creditId}`));
}

function confirmedResult(
  value: RewardConfirmedPayout,
): Extract<RewardPayoutCoordinatorResult, { kind: "confirmed" }> {
  return {
    kind: "confirmed",
    effectId: value.effectId,
    creditId: value.creditId,
    transactionHash: value.transactionHash,
    destinationAddress: value.destinationAddress,
    amountAtomic: value.amountAtomic,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    confirmations: value.confirmations,
  };
}

export interface RewardPayoutCoordinator {
  readonly payout: (
    creditId: string,
  ) => Effect.Effect<
    RewardPayoutCoordinatorResult,
    RewardPayoutCoordinatorFailed | RewardPayoutFailure
  >;
  readonly reconcile: (
    effectId: string,
  ) => Effect.Effect<
    RewardPayoutCoordinatorResult,
    RewardPayoutCoordinatorFailed | RewardPayoutFailure
  >;
}

export function makeRewardPayoutCoordinator(input: {
  readonly store: RewardPayoutStore;
  readonly rpc: MegapotV2RpcClient;
  readonly signer: MegapotV2TransactionSigner;
  readonly authority: RewardRunAuthority;
  readonly requiredConfirmations: number;
  readonly gasLimitMultiplierBps: number;
  readonly nativeGasReserveFloorWei: bigint;
  readonly now?: () => number;
}): RewardPayoutCoordinator {
  const coordinator = makeRewardTokenSendCoordinator<
    RewardPayoutCandidate,
    RewardConfirmedPayout,
    RewardPayoutFailure,
    RewardPayoutCoordinatorFailed,
    Extract<RewardPayoutCoordinatorResult, { kind: "confirmed" }>
  >({
    ...input,
    family: "payout",
    failed,
    deriveEffectId: deriveRewardPayoutEffectId,
    confirmedResult,
    confirmedFromReceipt: (candidate, result) => ({ ...result, creditId: candidate.creditId }),
  });
  return { payout: coordinator.send, reconcile: coordinator.reconcile };
}
