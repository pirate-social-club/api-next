import type {
  CustodySolvencyFailure,
  CustodySolvencyObservation,
  CustodySolvencyStore,
} from "@pirate/application";
import { Data, Effect } from "effect";
import { keccak256, toBytes } from "viem";
import { type MegapotV2RpcClient, MegapotV2RpcFailed } from "./megapot-v2-rpc.ts";

type CustodySolvencyRpcStage =
  | "deployment_attestation"
  | "head"
  | "confirmed_block"
  | "confirmed_balance";

export class CustodySolvencyCoordinatorFailed extends Data.TaggedError(
  "CustodySolvencyCoordinatorFailed",
)<{
  readonly reason:
    | "deployment_attestation_mismatch"
    | "invalid_config"
    | "observation_invalid"
    | "production_disabled";
  readonly stage?: CustodySolvencyRpcStage;
  readonly rpcReason?: MegapotV2RpcFailed["reason"] | "unknown";
}> {
  override get message(): string {
    return [this.reason, this.stage, this.rpcReason].filter(Boolean).join(":");
  }
}

const failed = (
  reason: CustodySolvencyCoordinatorFailed["reason"],
  stage?: CustodySolvencyRpcStage,
  rpcReason?: CustodySolvencyCoordinatorFailed["rpcReason"],
) =>
  new CustodySolvencyCoordinatorFailed({
    reason,
    ...(stage === undefined ? {} : { stage }),
    ...(rpcReason === undefined ? {} : { rpcReason }),
  });

export function deriveCustodySolvencyObservationId(
  attestationId: string,
  blockNumber: bigint,
  blockHash: string,
  tokenAddress?: string,
): string {
  if (
    attestationId.length === 0 ||
    attestationId !== attestationId.trim() ||
    blockNumber < 0n ||
    !/^0x[0-9a-f]{64}$/u.test(blockHash) ||
    (tokenAddress !== undefined && !/^0x[0-9a-f]{40}$/u.test(tokenAddress))
  ) {
    throw failed("invalid_config");
  }
  const identity =
    tokenAddress === undefined
      ? `pirate.custody-solvency-observation.v1\u0000${attestationId}\u0000${blockNumber}\u0000${blockHash}`
      : `pirate.custody-solvency-observation.v2\u0000${attestationId}\u0000${tokenAddress}\u0000${blockNumber}\u0000${blockHash}`;
  return keccak256(toBytes(identity));
}

export interface CustodySolvencyCoordinator {
  readonly observe: (
    attestationId: string,
    tokenAddress?: string,
  ) => Effect.Effect<
    CustodySolvencyObservation,
    CustodySolvencyCoordinatorFailed | CustodySolvencyFailure
  >;
}

export function makeCustodySolvencyCoordinator(input: {
  readonly store: CustodySolvencyStore;
  readonly rpc: MegapotV2RpcClient;
  readonly requiredConfirmations: number;
  readonly ttlSeconds?: number;
  readonly now?: () => number;
}): CustodySolvencyCoordinator {
  const ttlSeconds = input.ttlSeconds ?? 900;
  if (
    !Number.isSafeInteger(input.requiredConfirmations) ||
    input.requiredConfirmations < 1 ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > 900
  ) {
    throw failed("invalid_config");
  }
  const now = input.now ?? Date.now;
  const rpcEffect = <A>(stage: CustodySolvencyRpcStage, operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (error) =>
        failed(
          "observation_invalid",
          stage,
          error instanceof MegapotV2RpcFailed ? error.reason : "unknown",
        ),
    });
  return {
    observe: Effect.fn("CustodySolvencyCoordinator.observe")(
      function* (attestationId, tokenAddress) {
        const candidate = yield* input.store.loadCandidate(attestationId, tokenAddress);
        if (candidate.environment === "production" || candidate.chainId !== 84_532) {
          return yield* failed("production_disabled");
        }
        const attested = yield* rpcEffect("deployment_attestation", () =>
          input.rpc.attestDeployment(),
        );
        if (
          attested.jackpotCodeHash.toLowerCase() !== candidate.jackpotCodeHash.toLowerCase() ||
          attested.ticketNftCodeHash.toLowerCase() !== candidate.ticketNftCodeHash.toLowerCase() ||
          attested.usdcCodeHash.toLowerCase() !== candidate.usdcCodeHash.toLowerCase()
        ) {
          return yield* failed("deployment_attestation_mismatch");
        }
        const head = yield* rpcEffect("head", () => input.rpc.readHead());
        const confirmations = BigInt(input.requiredConfirmations);
        if (head.blockNumber + 1n < confirmations) return yield* failed("observation_invalid");
        const blockNumber = head.blockNumber - confirmations + 1n;
        const block = yield* rpcEffect("confirmed_block", () => input.rpc.readBlock(blockNumber));
        const balanceAtomic = yield* rpcEffect("confirmed_balance", () =>
          candidate.tokenAddress.toLowerCase() === candidate.usdcAddress.toLowerCase()
            ? input.rpc.readUsdcBalance(candidate.custodyAddress, blockNumber)
            : input.rpc.readErc20Balance === undefined
              ? Promise.reject(new Error("generic ERC20 balance reader unavailable"))
              : input.rpc.readErc20Balance(
                  candidate.tokenAddress,
                  candidate.custodyAddress,
                  blockNumber,
                ),
        );
        if (block.blockNumber !== blockNumber) return yield* failed("observation_invalid");
        const observationId = deriveCustodySolvencyObservationId(
          candidate.attestationId,
          blockNumber,
          block.blockHash,
          candidate.tokenAddress.toLowerCase() === candidate.usdcAddress.toLowerCase()
            ? undefined
            : candidate.tokenAddress,
        );
        const existing = yield* input.store.findObservation(observationId);
        if (existing !== null) return existing;
        const observedAt = new Date(now()).toISOString();
        return yield* input.store.record({
          candidate,
          observationId,
          balanceAtomic,
          blockNumber,
          blockHash: block.blockHash,
          observedAt,
          expiresAt: new Date(Date.parse(observedAt) + ttlSeconds * 1_000).toISOString(),
        });
      },
    ),
  };
}
