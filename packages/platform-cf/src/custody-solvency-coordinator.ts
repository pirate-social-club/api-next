import type {
  CustodySolvencyFailure,
  CustodySolvencyObservation,
  CustodySolvencyStore,
} from "@pirate/application";
import { Data, Effect } from "effect";
import { keccak256, toBytes } from "viem";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";

export class CustodySolvencyCoordinatorFailed extends Data.TaggedError(
  "CustodySolvencyCoordinatorFailed",
)<{
  readonly reason:
    | "deployment_attestation_mismatch"
    | "invalid_config"
    | "observation_invalid"
    | "production_disabled";
}> {}

const failed = (reason: CustodySolvencyCoordinatorFailed["reason"]) =>
  new CustodySolvencyCoordinatorFailed({ reason });

export function deriveCustodySolvencyObservationId(
  attestationId: string,
  blockNumber: bigint,
  blockHash: string,
): string {
  if (
    attestationId.length === 0 ||
    attestationId !== attestationId.trim() ||
    blockNumber < 0n ||
    !/^0x[0-9a-f]{64}$/u.test(blockHash)
  ) {
    throw failed("invalid_config");
  }
  return keccak256(
    toBytes(
      `pirate.custody-solvency-observation.v1\u0000${attestationId}\u0000${blockNumber}\u0000${blockHash}`,
    ),
  );
}

export interface CustodySolvencyCoordinator {
  readonly observe: (
    attestationId: string,
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
  const rpcEffect = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: () => failed("observation_invalid") });
  return {
    observe: Effect.fn("CustodySolvencyCoordinator.observe")(function* (attestationId) {
      const candidate = yield* input.store.loadCandidate(attestationId);
      if (candidate.environment === "production" || candidate.chainId !== 84_532) {
        return yield* failed("production_disabled");
      }
      const attested = yield* rpcEffect(() => input.rpc.attestDeployment());
      if (
        attested.jackpotCodeHash.toLowerCase() !== candidate.jackpotCodeHash.toLowerCase() ||
        attested.ticketNftCodeHash.toLowerCase() !== candidate.ticketNftCodeHash.toLowerCase() ||
        attested.usdcCodeHash.toLowerCase() !== candidate.usdcCodeHash.toLowerCase()
      ) {
        return yield* failed("deployment_attestation_mismatch");
      }
      const head = yield* rpcEffect(() => input.rpc.readHead());
      const confirmations = BigInt(input.requiredConfirmations);
      if (head.blockNumber + 1n < confirmations) return yield* failed("observation_invalid");
      const blockNumber = head.blockNumber - confirmations + 1n;
      const [block, balanceAtomic] = yield* rpcEffect(() =>
        Promise.all([
          input.rpc.readBlock(blockNumber),
          input.rpc.readUsdcBalance(candidate.custodyAddress, blockNumber),
        ]),
      );
      if (block.blockNumber !== blockNumber) return yield* failed("observation_invalid");
      const observationId = deriveCustodySolvencyObservationId(
        candidate.attestationId,
        blockNumber,
        block.blockHash,
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
    }),
  };
}
