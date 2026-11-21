import type { FrozenSongMegapotDrawing } from "../../application/src/rewards/song-megapot-frozen-plan.ts";
import type { MegapotV2DeploymentAttestation, MegapotV2DrawingState } from "./megapot-v2.ts";

/** Opt-in staging rule for the verified Jackpot implementation. Its settlement
 * advances the ID once and sets time to old drawingTime + mutable duration;
 * ticketPrice is copied from the mutable global setting. Both settings must be
 * pinned and the actual initialized drawing must match before any purchase. */
export const SHARED_SONG_SUCCESSOR_RULE_ID = "megapot-v2-base-sepolia-successor-v1";
export const SHARED_SONG_SUCCESSOR_RULE = {
  chainId: 84532,
  jackpotAddress: "0x465da3c859f193a3807386387bee941b2a4c3279",
  jackpotCodeHash: "0x8d3104deb8a3fb663c67f8d4a2da43a15aaf5ad8b0e1d303ceed09f582dd4bc9",
  durationSeconds: 1800,
  entryCutoffSeconds: 120,
  purchaseLeadSeconds: 900,
  minimumEntrySeconds: 600,
  minimumFundingWindowSeconds: 1800,
  selection: "immediate_successor_only",
  initialization: "conditional_exact_recheck",
} as const;
export const SHARED_SONG_SUCCESSOR_PRICE_RULE = {
  source: "pinned_global_ticketPrice_then_exact_initialized_recheck",
  ticketAtomic: "10000",
} as const;

/** Does not read or fabricate an initialized future row. The attested contract
 * has only one currentDrawingId mutation: ++ during successor initialization. */
export function projectSharedSongSuccessor(input: {
  deployment: MegapotV2DeploymentAttestation;
  currentId: bigint;
  current: Pick<MegapotV2DrawingState, "drawingTime" | "ticketPrice" | "jackpotLock">;
  recurrence: { durationSeconds: bigint; ticketPrice: bigint };
}): FrozenSongMegapotDrawing | null {
  const rule = SHARED_SONG_SUCCESSOR_RULE;
  if (
    input.deployment.environment === "production" ||
    input.deployment.chainId !== rule.chainId ||
    input.deployment.jackpotAddress !== rule.jackpotAddress ||
    input.deployment.jackpotCodeHash !== rule.jackpotCodeHash ||
    input.currentId <= 0n ||
    input.currentId >= (1n << 256n) - 1n ||
    input.current.drawingTime <= 0n ||
    input.current.ticketPrice <= 0n ||
    input.current.jackpotLock ||
    input.recurrence.durationSeconds !== BigInt(rule.durationSeconds) ||
    input.recurrence.ticketPrice !== BigInt(SHARED_SONG_SUCCESSOR_PRICE_RULE.ticketAtomic)
  )
    return null;
  const time = Number((input.current.drawingTime + input.recurrence.durationSeconds) * 1000n);
  if (!Number.isSafeInteger(time) || time > 8640000000000000) return null;
  return {
    drawingId: (input.currentId + 1n).toString(),
    drawingTimeMs: time,
    entryCutoffAtMs: time - rule.entryCutoffSeconds * 1000,
    purchaseDeadlineAtMs: time - rule.purchaseLeadSeconds * 1000,
    priceAtomic: input.recurrence.ticketPrice,
    proofKind: "attested_recurrence",
  };
}

/** Called at the final observation, after all provider reads. Leave a full
 * funding window even if quote acceptance uses its entire permitted age. */
export function hasSharedSongSuccessorFundingWindow(input: {
  plan: FrozenSongMegapotDrawing;
  observedAtMs: number;
  quoteMaxAgeMs: number;
  reservationMs: number;
  safetyMarginMs: number;
}): boolean {
  if (
    ![input.observedAtMs, input.quoteMaxAgeMs, input.reservationMs, input.safetyMarginMs].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    input.quoteMaxAgeMs === 0 ||
    input.reservationMs === 0
  )
    return false;
  const rule = SHARED_SONG_SUCCESSOR_RULE;
  const deadline = Math.min(
    input.plan.purchaseDeadlineAtMs,
    input.plan.entryCutoffAtMs - rule.minimumEntrySeconds * 1000,
  );
  const needed =
    input.observedAtMs +
    rule.minimumFundingWindowSeconds * 1000 +
    input.quoteMaxAgeMs +
    input.reservationMs +
    input.safetyMarginMs;
  return Number.isSafeInteger(needed) && needed <= deadline;
}
