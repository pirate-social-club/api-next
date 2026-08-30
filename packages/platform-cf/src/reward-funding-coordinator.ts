import type {
  RewardFundingFailure,
  RewardFundingIntent,
  RewardFundingStore,
} from "@pirate/application";
import { Data, Effect } from "effect";
import { keccak256, toBytes } from "viem";
import {
  type MegapotTransactionReceipt,
  type MegapotV2DeploymentAttestation,
  validateMegapotUsdcFundingReceipt,
} from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";

export class RewardFundingCoordinatorFailed extends Data.TaggedError(
  "RewardFundingCoordinatorFailed",
)<{
  readonly reason:
    | "deployment_attestation_mismatch"
    | "invalid_config"
    | "production_disabled"
    | "receipt_evidence_invalid";
}> {}

export type RewardFundingCoordinatorResult =
  | Readonly<{ kind: "planned"; intent: RewardFundingIntent }>
  | Readonly<{ kind: "confirming"; intent: RewardFundingIntent }>
  | Readonly<{ kind: "confirmed"; intent: RewardFundingIntent }>
  | Readonly<{ kind: "reverted"; intent: RewardFundingIntent }>
  | Readonly<{ kind: "reconciliation_required"; intent: RewardFundingIntent }>;

const failed = (reason: RewardFundingCoordinatorFailed["reason"]) =>
  new RewardFundingCoordinatorFailed({ reason });

function deployment(intent: RewardFundingIntent): MegapotV2DeploymentAttestation {
  return {
    environment: intent.environment,
    chainId: intent.chainId,
    jackpotAddress: intent.jackpotAddress,
    ticketNftAddress: intent.ticketNftAddress,
    usdcAddress: intent.usdcAddress,
    custodyAddress: intent.custodyAddress,
    referrerAddress: intent.referrerAddress,
    jackpotCodeHash: intent.jackpotCodeHash,
    ticketNftCodeHash: intent.ticketNftCodeHash,
    usdcCodeHash: intent.usdcCodeHash,
    attestationId: intent.attestationId,
  };
}

function assetDeployment(intent: RewardFundingIntent): MegapotV2DeploymentAttestation {
  return { ...deployment(intent), usdcAddress: intent.tokenAddress };
}

function canonicalReceipt(receipt: MegapotTransactionReceipt): string {
  return JSON.stringify({
    chainId: receipt.chainId,
    status: receipt.status,
    transactionHash: receipt.transactionHash,
    from: receipt.from,
    to: receipt.to,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    logs: receipt.logs.map((log) => ({
      address: log.address,
      topics: [...log.topics],
      data: log.data,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      blockHash: log.blockHash,
      blockNumber: log.blockNumber.toString(),
      removed: log.removed ?? false,
    })),
  });
}

const sha256Hex = Effect.fn("rewardFundingSha256Hex")(function* (input: string) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", toBytes(input)),
    catch: () => failed("receipt_evidence_invalid"),
  });
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export function deriveRewardFundingEffectId(input: {
  readonly legId: string;
  readonly funderAccountId: string;
  readonly idempotencyKey: string;
}): string {
  if (
    [input.legId, input.funderAccountId, input.idempotencyKey].some(
      (value) => value.length === 0 || value !== value.trim(),
    )
  ) {
    throw failed("invalid_config");
  }
  return keccak256(
    toBytes(
      `pirate.reward-funding.v1\u0000${input.legId}\u0000${input.funderAccountId}\u0000${input.idempotencyKey}`,
    ),
  );
}

function result(intent: RewardFundingIntent): RewardFundingCoordinatorResult {
  return { kind: intent.state, intent } as RewardFundingCoordinatorResult;
}

export interface RewardFundingCoordinator {
  readonly plan: (input: {
    readonly legId: string;
    readonly funderAccountId: string;
    readonly senderAddress: string;
    readonly expectedAmountAtomic: bigint;
    readonly requiredConfirmations: number;
    readonly idempotencyKey: string;
  }) => Effect.Effect<
    RewardFundingCoordinatorResult,
    RewardFundingCoordinatorFailed | RewardFundingFailure
  >;
  readonly observe: (input: {
    readonly fundingEffectId: string;
    readonly transactionHash: string;
  }) => Effect.Effect<
    RewardFundingCoordinatorResult,
    RewardFundingCoordinatorFailed | RewardFundingFailure
  >;
  readonly reconcile: (
    fundingEffectId: string,
  ) => Effect.Effect<
    RewardFundingCoordinatorResult,
    RewardFundingCoordinatorFailed | RewardFundingFailure
  >;
}

export function makeRewardFundingCoordinator(input: {
  readonly store: RewardFundingStore;
  readonly rpc: MegapotV2RpcClient;
  readonly now?: () => number;
}): RewardFundingCoordinator {
  const now = input.now ?? Date.now;
  const rpcEffect = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: () => failed("receipt_evidence_invalid") });

  const attest = Effect.fn("RewardFundingCoordinator.attest")(function* (
    intent: RewardFundingIntent,
  ) {
    if (intent.environment === "production" || intent.chainId !== 84_532) {
      return yield* failed("production_disabled");
    }
    yield* rpcEffect(() => input.rpc.attestDeployment());
  });

  const reconcileIntent = Effect.fn("RewardFundingCoordinator.reconcileIntent")(function* (
    intent: RewardFundingIntent,
  ) {
    if (intent.state === "confirmed" || intent.state === "reverted") return result(intent);
    if (intent.transactionHash === null) return result(intent);
    const transactionHash = intent.transactionHash;
    yield* attest(intent);
    const receipt = yield* rpcEffect(() => input.rpc.readReceipt(transactionHash));
    if (receipt === null) return result(intent);
    const [receiptBlock, head] = yield* rpcEffect(() =>
      Promise.all([input.rpc.readBlock(receipt.blockNumber), input.rpc.readHead()]),
    );
    if (
      receiptBlock.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      head.blockNumber < receipt.blockNumber
    ) {
      yield* input.store.requireReconciliation({
        fundingEffectId: intent.fundingEffectId,
        transactionHash,
        reason: "funding_receipt_reorg",
      });
      const updated = yield* input.store.find(intent.fundingEffectId);
      if (updated === null) return yield* failed("receipt_evidence_invalid");
      return result(updated);
    }
    const confirmations = head.blockNumber - receipt.blockNumber + 1n;
    if (confirmations < BigInt(intent.requiredConfirmations)) return result(intent);
    const observationHash = yield* sha256Hex(canonicalReceipt(receipt));
    if (receipt.status === "reverted") {
      yield* input.store.revert({
        fundingEffectId: intent.fundingEffectId,
        transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        observationHash,
      });
    } else {
      let evidence: ReturnType<typeof validateMegapotUsdcFundingReceipt>;
      try {
        evidence = validateMegapotUsdcFundingReceipt({
          deployment: assetDeployment(intent),
          receipt,
          sender: intent.senderAddress,
          amountAtomic: intent.expectedAmountAtomic,
        });
      } catch {
        yield* input.store.requireReconciliation({
          fundingEffectId: intent.fundingEffectId,
          transactionHash,
          reason: "funding_receipt_evidence_invalid",
        });
        const updated = yield* input.store.find(intent.fundingEffectId);
        if (updated === null) return yield* failed("receipt_evidence_invalid");
        return result(updated);
      }
      yield* input.store.confirm({
        fundingEffectId: intent.fundingEffectId,
        transactionHash,
        transferLogIndex: evidence.transferLogIndex,
        amountAtomic: evidence.amountAtomic,
        blockNumber: evidence.blockNumber,
        blockHash: evidence.blockHash,
        observationHash,
        confirmedAt: new Date(now()).toISOString(),
      });
    }
    const updated = yield* input.store.find(intent.fundingEffectId);
    if (updated === null) return yield* failed("receipt_evidence_invalid");
    return result(updated);
  });

  const plan = Effect.fn("RewardFundingCoordinator.plan")(function* (request: {
    readonly legId: string;
    readonly funderAccountId: string;
    readonly senderAddress: string;
    readonly expectedAmountAtomic: bigint;
    readonly requiredConfirmations: number;
    readonly idempotencyKey: string;
  }) {
    const fundingEffectId = deriveRewardFundingEffectId(request);
    const existing = yield* input.store.find(fundingEffectId);
    if (existing !== null) return result(existing);
    const intent = yield* input.store.plan({ ...request, fundingEffectId });
    yield* attest(intent);
    return result(intent);
  });

  const observe = Effect.fn("RewardFundingCoordinator.observe")(function* (request: {
    readonly fundingEffectId: string;
    readonly transactionHash: string;
  }) {
    const intent = yield* input.store.bindTransaction(request);
    return yield* reconcileIntent(intent);
  });

  const reconcile = Effect.fn("RewardFundingCoordinator.reconcile")(function* (
    fundingEffectId: string,
  ) {
    const intent = yield* input.store.find(fundingEffectId);
    if (intent === null) return yield* failed("invalid_config");
    return yield* reconcileIntent(intent);
  });

  return { plan, observe, reconcile };
}
