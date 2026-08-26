import {
  type MegapotDrawingObservationFailure,
  MegapotDrawingObservationRejected,
  type MegapotDrawingObservationResult,
  MegapotDrawingObservationStorageFailed,
  type MegapotDrawingObservationStore,
  type MegapotDrawingObserverCandidate,
} from "@pirate/application";
import { Effect } from "effect";
import { sha256, toBytes } from "viem";
import type { MegapotV2DeploymentAttestation } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";

const BASE_SEPOLIA_CHAIN_ID = 84_532;

const rejected = (reason: MegapotDrawingObservationRejected["reason"]) =>
  new MegapotDrawingObservationRejected({ reason });
const storage = (reason: MegapotDrawingObservationStorageFailed["reason"]) =>
  new MegapotDrawingObservationStorageFailed({ reason });

const canonicalAddress = (value: string): string => value.toLowerCase();

function deployment(candidate: MegapotDrawingObserverCandidate): MegapotV2DeploymentAttestation {
  return {
    attestationId: candidate.attestationId,
    environment: candidate.environment,
    chainId: candidate.chainId,
    jackpotAddress: candidate.jackpotAddress,
    ticketNftAddress: candidate.ticketNftAddress,
    usdcAddress: candidate.usdcAddress,
    custodyAddress: candidate.custodyAddress,
    referrerAddress: candidate.referrerAddress,
    jackpotCodeHash: candidate.jackpotCodeHash,
    ticketNftCodeHash: candidate.ticketNftCodeHash,
    usdcCodeHash: candidate.usdcCodeHash,
  };
}

function sameDeployment(
  left: MegapotV2DeploymentAttestation,
  right: MegapotV2DeploymentAttestation,
): boolean {
  return (
    left.attestationId === right.attestationId &&
    left.environment === right.environment &&
    left.chainId === right.chainId &&
    canonicalAddress(left.jackpotAddress) === canonicalAddress(right.jackpotAddress) &&
    canonicalAddress(left.ticketNftAddress) === canonicalAddress(right.ticketNftAddress) &&
    canonicalAddress(left.usdcAddress) === canonicalAddress(right.usdcAddress) &&
    canonicalAddress(left.custodyAddress) === canonicalAddress(right.custodyAddress) &&
    canonicalAddress(left.referrerAddress) === canonicalAddress(right.referrerAddress) &&
    left.jackpotCodeHash.toLowerCase() === right.jackpotCodeHash.toLowerCase() &&
    left.ticketNftCodeHash.toLowerCase() === right.ticketNftCodeHash.toLowerCase() &&
    left.usdcCodeHash.toLowerCase() === right.usdcCodeHash.toLowerCase()
  );
}

function instantFromSeconds(value: bigint): string | null {
  if (value < 0n || value > BigInt(Math.floor(8_640_000_000_000_000 / 1_000))) return null;
  const milliseconds = Number(value) * 1_000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function canonicalState(input: {
  readonly attestationId: string;
  readonly drawingId: bigint;
  readonly state: Awaited<ReturnType<MegapotV2RpcClient["readDrawing"]>>;
  readonly blockNumber: bigint;
  readonly blockHash: string;
}): string {
  return JSON.stringify({
    domain: "pirate.megapot-drawing-observation.v1",
    attestation_id: input.attestationId,
    drawing_id: input.drawingId.toString(),
    ticket_price_atomic: input.state.ticketPrice.toString(),
    drawing_time: input.state.drawingTime.toString(),
    ball_max: input.state.ballMax,
    bonusball_max: input.state.bonusballMax,
    drawing_locked: input.state.jackpotLock,
    referral_fee_wei: input.state.referralFee.toString(),
    referral_win_share_wei: input.state.referralWinShare.toString(),
    block_number: input.blockNumber.toString(),
    block_hash: input.blockHash.toLowerCase(),
  });
}

export interface MegapotDrawingObserver {
  readonly observe: (
    attestationId: string,
  ) => Effect.Effect<MegapotDrawingObservationResult, MegapotDrawingObservationFailure>;
}

export function makeMegapotDrawingObserver(input: {
  readonly store: MegapotDrawingObservationStore;
  readonly rpc: MegapotV2RpcClient;
  readonly observationTtlMs: number;
  readonly now?: () => number;
}): MegapotDrawingObserver {
  const now = input.now ?? Date.now;
  const rpcEffect = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: () => storage("unavailable") });

  return {
    observe: Effect.fn("MegapotDrawingObserver.observe")(function* (attestationId: string) {
      if (!Number.isSafeInteger(input.observationTtlMs) || input.observationTtlMs <= 0) {
        return yield* storage("invalid-row");
      }
      const candidate = yield* input.store.loadCandidate(attestationId);
      if (candidate.environment === "production" || candidate.chainId !== BASE_SEPOLIA_CHAIN_ID) {
        return yield* rejected("production-disabled");
      }
      const expectedDeployment = deployment(candidate);
      if (
        input.rpc.deployment === undefined ||
        !sameDeployment(expectedDeployment, input.rpc.deployment)
      ) {
        return yield* rejected("deployment-attestation-mismatch");
      }
      yield* rpcEffect(() => input.rpc.attestDeployment());
      const head = yield* rpcEffect(() => input.rpc.readHead());
      if (head.blockTimestamp === undefined) return yield* rejected("invalid-block-time");
      const drawingId = yield* rpcEffect(() => input.rpc.readCurrentDrawingId(head.blockNumber));
      const state = yield* rpcEffect(() => input.rpc.readDrawing(drawingId, head.blockNumber));
      const observedMilliseconds = now();
      const blockTimestamp = instantFromSeconds(head.blockTimestamp);
      const drawingTime = instantFromSeconds(state.drawingTime);
      if (
        !Number.isFinite(observedMilliseconds) ||
        blockTimestamp === null ||
        drawingTime === null ||
        observedMilliseconds < Date.parse(blockTimestamp)
      ) {
        return yield* rejected("invalid-block-time");
      }
      if (
        state.drawingTime <= head.blockTimestamp ||
        Date.parse(drawingTime) <= observedMilliseconds ||
        state.jackpotLock
      ) {
        return yield* rejected("drawing-closed");
      }
      const rawState = canonicalState({
        attestationId,
        drawingId,
        state,
        blockNumber: head.blockNumber,
        blockHash: head.blockHash,
      });
      const rawStateHash = sha256(toBytes(rawState)).slice(2);
      const observedAt = new Date(observedMilliseconds).toISOString();
      return yield* input.store.recordAndOpen({
        observationId: `drawing_observation_${rawStateHash}`,
        attestationId,
        chainId: candidate.chainId,
        drawingId,
        ticketPriceAtomic: state.ticketPrice,
        drawingTime,
        ballMax: state.ballMax,
        bonusballMax: state.bonusballMax,
        drawingLocked: state.jackpotLock,
        referralFeeWei: state.referralFee,
        referralWinShareWei: state.referralWinShare,
        blockNumber: head.blockNumber,
        blockHash: head.blockHash.toLowerCase(),
        blockTimestamp,
        confirmations: 1,
        observedAt,
        expiresAt: new Date(observedMilliseconds + input.observationTtlMs).toISOString(),
        rawStateHash,
      });
    }),
  };
}
