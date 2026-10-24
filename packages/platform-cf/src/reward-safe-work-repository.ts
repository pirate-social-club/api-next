import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Data, Effect, type Layer } from "effect";
import type { Hex } from "viem";

type Row = Readonly<Record<string, unknown>>;

export class RewardSafeWorkStorageFailed extends Data.TaggedError("RewardSafeWorkStorageFailed")<{
  readonly reason: "invalid-row" | "unavailable";
}> {}

const failed = (reason: RewardSafeWorkStorageFailed["reason"]) =>
  new RewardSafeWorkStorageFailed({ reason });

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 500;
}

/** One Safe and its pilot attestation. */
type RewardSafeCustody = Readonly<{
  attestationId: string;
  chainId: number;
  safeAddress: string;
}>;

/** Read-only work listings for the Safe pilot cycle and the owner's call export. */
export function makeControlPlaneRewardSafeWorkStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  const read = <A>(
    label: string,
    text: string,
    values: readonly unknown[],
    parse: (rows: readonly Row[]) => A,
  ) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({ label, text, values: [...values], readonly: true });
      return yield* Effect.try({
        try: () => parse(result.rows as readonly Row[]),
        catch: () => failed("invalid-row"),
      });
    }).pipe(
      Effect.provide(layer),
      Effect.mapError((error) =>
        error instanceof RewardSafeWorkStorageFailed ? error : failed("unavailable"),
      ),
    );

  return {
    /** Active ticket-first legs on the pilot attestation, which may need a ticket. */
    loadLegs: (custody: RewardSafeCustody, limit: number) =>
      validLimit(limit)
        ? read(
            "reward-safe-work.legs.read",
            `SELECT leg.leg_id FROM song_reward_offer_legs leg
               JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id
              WHERE leg.purchase_order='ticket_first_v1' AND leg.kind='megapot_pool'
                AND leg.status='active' AND offer.status='active'
                AND leg.attestation_id=$1
              ORDER BY leg.leg_id LIMIT $2`,
            [custody.attestationId, limit],
            (rows) => rows.map((row) => text(row, "leg_id")),
          )
        : Effect.fail(failed("invalid-row")),

    /** Purchases and payouts whose owner execution the scan has bound. */
    loadBoundEffects: (custody: RewardSafeCustody, limit: number) =>
      validLimit(limit)
        ? read(
            "reward-safe-work.bound-effects.read",
            `SELECT effect_id, effect_kind FROM reward_chain_effects
              WHERE execution_mode='safe_owner_v1' AND state='confirming'
                AND effect_kind IN ('ticket_purchase','reward_payout')
                AND chain_id=$1 AND signer_address=$2
              ORDER BY updated_at, effect_id LIMIT $3`,
            [custody.chainId, custody.safeAddress, limit],
            (rows) =>
              rows.map((row) => {
                const kind = text(row, "effect_kind");
                if (kind !== "ticket_purchase" && kind !== "reward_payout") {
                  throw new Error("invalid effect_kind");
                }
                return { effectId: text(row, "effect_id"), kind } as const;
              }),
          )
        : Effect.fail(failed("invalid-row")),

    /** Every prepared call the owner has not executed yet, oldest first. */
    loadPreparedCalls: (custody: RewardSafeCustody) =>
      read(
        "reward-safe-work.prepared-calls.read",
        `SELECT effect_id, effect_kind, target_address, calldata
           FROM reward_chain_effects
          WHERE execution_mode='safe_owner_v1' AND state='prepared'
            AND chain_id=$1 AND signer_address=$2
          ORDER BY prepared_at, effect_id`,
        [custody.chainId, custody.safeAddress],
        (rows) =>
          rows.map((row) => ({
            effectId: text(row, "effect_id"),
            kind: text(row, "effect_kind"),
            to: text(row, "target_address"),
            data: text(row, "calldata") as Hex,
          })),
      ),
  };
}
