import { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import {
  type MegapotV2DeploymentAttestation,
  validateMegapotV2DeploymentAttestation,
} from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import {
  loadFrozenSharedSongDrawing,
  verifyCurrentFrozenSharedSongDrawing,
} from "./shared-song-frozen-plan.ts";

const Packet = Schema.Struct({
  shared: Schema.Boolean,
  ready: Schema.Boolean,
  to: C.AddressV2,
  data: Schema.String,
  legId: Schema.Union([C.IdV2, Schema.Null]),
  drawingId: Schema.Union([C.UIntV2, Schema.Null]),
  priceAtomic: Schema.Union([C.AtomicV2, Schema.Null]),
  entryCutoffSeconds: Schema.Union([Schema.Int, Schema.Null]),
  entryCutoffAt: Schema.Union([C.InstantV2, Schema.Null]),
  deployment: Schema.Unknown,
});

/** A cached export is not lasting execution authority. Re-read the exact server
 * call and, for a shared-song purchase, its original plan and current chain state.
 * This function is read-only and must run directly before the owner's broadcast. */
export const verifyPreparedSafeCall = Effect.fn("verifyPreparedSafeCall")(function* (input: {
  attestationId: string;
  call: Readonly<{ effectId: string; to: string; data: string }>;
  minimumEntrySeconds?: number | undefined;
  rpcFor?: ((deployment: MegapotV2DeploymentAttestation) => MegapotV2RpcClient) | undefined;
  now?: (() => number) | undefined;
}) {
  const db = yield* ControlPlaneDb;
  const statement = {
    label: "shared-song.prepared-call.read",
    text: `SELECT jsonb_build_object(
      'shared',coalesce(leg.qualification_family_v2='shared_song',false),
      'ready',CASE WHEN effect.effect_kind='ticket_purchase' THEN
        purchase.pool_leg_id IS NOT NULL AND leg.leg_id IS NOT NULL
        AND purchase.attestation_id=a.attestation_id AND leg.attestation_id=a.attestation_id AND
        (leg.qualification_family_v2 IS DISTINCT FROM 'shared_song' OR
          (leg.status='active' AND offer.status='active' AND a.status='active' AND a.retired_at IS NULL
            AND purchase.ticket_price_atomic=effect.reserved_amount_atomic
            AND drawing.purchase_order='ticket_first_v1' AND drawing.status='ticket_pending'
            AND drawing.reserved_ticket_cost_atomic=effect.reserved_amount_atomic)) ELSE true END,
      'to',effect.target_address,'data',effect.calldata,'legId',purchase.pool_leg_id,
      'drawingId',purchase.drawing_id::text,'priceAtomic',purchase.ticket_price_atomic::text,
      'entryCutoffSeconds',leg.entry_cutoff_seconds,
      'entryCutoffAt',to_char(drawing.entry_cutoff_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'deployment',jsonb_build_object('attestationId',a.attestation_id,'environment',a.environment,
        'chainId',a.chain_id,'jackpotAddress',a.jackpot_address,'ticketNftAddress',a.ticket_nft_address,
        'usdcAddress',a.usdc_address,'custodyAddress',a.custody_address,'referrerAddress',a.referrer_address,
        'jackpotCodeHash',a.jackpot_code_hash,'ticketNftCodeHash',a.ticket_nft_code_hash,'usdcCodeHash',a.usdc_code_hash)) packet
      FROM reward_chain_effects effect
      JOIN megapot_deployment_attestations a ON a.attestation_id=$2
        AND a.chain_id=effect.chain_id AND a.custody_address=effect.signer_address
      LEFT JOIN megapot_ticket_purchase_effects purchase ON purchase.purchase_effect_id=effect.effect_id
      LEFT JOIN song_reward_offer_legs leg ON leg.leg_id=purchase.pool_leg_id
      LEFT JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id
      LEFT JOIN megapot_pool_drawings drawing ON drawing.pool_leg_id=purchase.pool_leg_id
        AND drawing.drawing_id=purchase.drawing_id AND drawing.purchase_effect_id=effect.effect_id
        AND drawing.observation_id=purchase.drawing_observation_id
      WHERE effect.effect_id=$1 AND effect.execution_mode='safe_owner_v1' AND effect.state='prepared'`,
    values: [input.call.effectId, input.attestationId],
    readonly: true,
  };
  const result = yield* db.execute<{ packet: unknown }>(statement);
  if (result.rows.length !== 1 || result.rows[0] === undefined) return null;
  const decoded = Schema.decodeUnknownExit(Packet, { onExcessProperty: "error" })(
    result.rows[0].packet,
  );
  if (decoded._tag !== "Success") return null;
  const p = decoded.value;
  if (!p.ready || p.to.toLowerCase() !== input.call.to.toLowerCase() || p.data !== input.call.data)
    return null;
  if (!p.shared) return { executeBeforeMs: null };
  if (
    p.legId === null ||
    p.drawingId === null ||
    p.priceAtomic === null ||
    p.entryCutoffSeconds === null ||
    p.entryCutoffAt === null ||
    input.minimumEntrySeconds === undefined ||
    input.rpcFor === undefined
  )
    return null;
  const plan = yield* loadFrozenSharedSongDrawing(db, p.legId, BigInt(p.drawingId));
  if (
    plan === null ||
    plan.priceAtomic.toString() !== p.priceAtomic ||
    p.entryCutoffAt !== new Date(plan.entryCutoffAtMs).toISOString()
  )
    return null;
  const deployment = yield* Effect.try({
    try: () =>
      validateMegapotV2DeploymentAttestation(p.deployment as MegapotV2DeploymentAttestation),
    catch: () => new Error("prepared_call_attestation_unavailable"),
  });
  if (p.to !== deployment.jackpotAddress) return null;
  const rpc = input.rpcFor(deployment);
  const head = yield* Effect.tryPromise({
    try: () => rpc.readHead(),
    catch: () => new Error("prepared_call_rpc_unavailable"),
  });
  const verified = yield* verifyCurrentFrozenSharedSongDrawing({
    rpc,
    deployment,
    head,
    plan,
    entryCutoffSeconds: p.entryCutoffSeconds,
    minimumEntrySeconds: input.minimumEntrySeconds,
    now: input.now ?? Date.now,
  });
  if (verified === null) return null;
  // The provider reads can wait while the server holds or retires this drawing.
  // Recheck the exact call and its scope after those reads, outside a SQL lock.
  const current = yield* db.execute<{ packet: unknown }>(statement);
  if (
    current.rows.length !== 1 ||
    current.rows[0] === undefined ||
    JSON.stringify(current.rows[0].packet) !== JSON.stringify(result.rows[0].packet)
  )
    return null;
  return { executeBeforeMs: verified.deadline };
});

/** The final pause/lease read can itself wait. Check the verified deadline after
 * that read, immediately before handing control to the owner's broadcast. */
export async function stopBeforePreparedSafeCall(input: {
  verify: () => Promise<{ executeBeforeMs: number | null } | null>;
  stopped: () => Promise<boolean>;
  now?: () => number;
}): Promise<boolean> {
  try {
    if (await input.stopped()) return true;
    const current = await input.verify();
    if (current === null || (await input.stopped())) return true;
    if (current.executeBeforeMs === null) return false;
    const now = (input.now ?? Date.now)();
    return (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(current.executeBeforeMs) ||
      now >= current.executeBeforeMs
    );
  } catch {
    return true;
  }
}
