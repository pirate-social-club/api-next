import type { ControlPlaneTransaction } from "@pirate/application";
import { Effect, Schema } from "effect";
import { SongContributionFailure } from "../../application/src/rewards/song-megapot-contributions.ts";
import {
  type FrozenSongMegapotDrawing,
  frozenSongMegapotPurchaseDeadline,
  resolveFrozenSongMegapotDrawing,
} from "../../application/src/rewards/song-megapot-frozen-plan.ts";
import type { MegapotV2DeploymentAttestation } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import { rewardSafeFailed } from "./reward-safe-settlement.ts";

const Plan = Schema.Struct({
  target: Schema.Unknown,
  terms: Schema.Unknown,
  originContext: Schema.Unknown,
});

/** The private reader follows the original contribution -> snapshot -> witness.
 * It grants no table access and never refreshes or replaces the frozen quote. */
export const loadFrozenSharedSongDrawing = Effect.fn("loadFrozenSharedSongDrawing")(function* (
  db: Pick<ControlPlaneTransaction, "execute">,
  legId: string,
  drawingId: bigint,
) {
  const result = yield* db.execute<{ packet: unknown }>({
    label: "shared-song.frozen-plan.read",
    text: "SELECT load_shared_song_frozen_plan_v2($1) AS packet",
    values: [legId],
    readonly: true,
  });
  if (result.rows.length !== 1 || result.rows[0] === undefined)
    return yield* new SongContributionFailure({ code: "schedule_unproven" });
  const packet = result.rows[0].packet;
  if (packet === null) return null;
  const parsed = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Plan, { onExcessProperty: "error" })(packet),
    catch: () => new SongContributionFailure({ code: "schedule_unproven" }),
  });
  return yield* resolveFrozenSongMegapotDrawing({ ...parsed, drawingId: drawingId.toString() });
});

/** Read-only canonical proof outside SQL locks. The same check is used before
 * preparation and immediately before execution; a historical drawing ID is not
 * evidence that buyTickets will purchase that drawing now. */
export const verifyCurrentFrozenSharedSongDrawing = Effect.fn(
  "verifyCurrentFrozenSharedSongDrawing",
)(function* (input: {
  rpc: MegapotV2RpcClient;
  deployment: MegapotV2DeploymentAttestation;
  head: Awaited<ReturnType<MegapotV2RpcClient["readHead"]>>;
  plan: FrozenSongMegapotDrawing;
  entryCutoffSeconds: number;
  minimumEntrySeconds: number;
  now: () => number;
}) {
  const { rpc, head, deployment } = input;
  const attest = rpc.attestDeploymentAt;
  if (
    attest === undefined ||
    rpc.deployment === undefined ||
    (
      [
        "attestationId",
        "environment",
        "chainId",
        "jackpotAddress",
        "ticketNftAddress",
        "usdcAddress",
        "custodyAddress",
        "referrerAddress",
        "jackpotCodeHash",
        "ticketNftCodeHash",
        "usdcCodeHash",
      ] as const
    ).some((key) => rpc.deployment?.[key] !== deployment[key])
  )
    return yield* rewardSafeFailed("rpc_unavailable");
  const read = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({
      try: f,
      catch: () => rewardSafeFailed("rpc_unavailable"),
    });
  yield* read(() => attest(head.blockNumber));
  const currentId = yield* read(() => rpc.readCurrentDrawingId(head.blockNumber));
  if (currentId.toString() !== input.plan.drawingId) return null;
  const drawing = yield* read(() => rpc.readDrawing(currentId, head.blockNumber));
  const after = yield* read(() => rpc.readBlock(head.blockNumber));
  const observed = input.now();
  const headMs = head.blockTimestamp === undefined ? NaN : Number(head.blockTimestamp * 1000n);
  if (
    head.blockNumber !== after.blockNumber ||
    head.blockHash !== after.blockHash ||
    head.blockTimestamp !== after.blockTimestamp ||
    !Number.isSafeInteger(headMs) ||
    !Number.isSafeInteger(observed) ||
    observed < headMs ||
    observed - headMs > 120_000
  )
    return yield* rewardSafeFailed("rpc_unavailable");
  const deadline = frozenSongMegapotPurchaseDeadline(
    input.plan,
    {
      drawingId: currentId,
      drawingTime: drawing.drawingTime,
      ticketPrice: drawing.ticketPrice,
      jackpotLock: drawing.jackpotLock,
      entryCutoffSeconds: input.entryCutoffSeconds,
    },
    input.minimumEntrySeconds,
  );
  return deadline === null || observed >= deadline ? null : { deadline, drawing };
});
