import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Data, Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

export type MegapotDrawingWorkStatus =
  | "cutoff_frozen"
  | "committed"
  | "purchase_pending"
  | "tickets_confirmed"
  | "drawing_pending"
  | "winnings_detected"
  | "claim_pending"
  | "claimed"
  | "allocated";

export type MegapotChainEffectKind =
  | "usdc_approval"
  | "ticket_purchase"
  | "winnings_claim"
  | "reward_payout";

export type MegapotDrawingWork = Readonly<{
  poolLegId: string;
  drawingId: bigint;
  status: MegapotDrawingWorkStatus;
  attestationId: string;
  ticketPriceAtomic: bigint;
}>;

export type MegapotChainEffectWork = Readonly<{
  effectId: string;
  effectKind: MegapotChainEffectKind;
}>;

export class MegapotWorkStorageFailed extends Data.TaggedError("MegapotWorkStorageFailed")<{
  readonly reason: "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export interface MegapotWorkStore {
  readonly loadDrawings: (input: {
    readonly statuses: readonly MegapotDrawingWorkStatus[];
    readonly limit: number;
  }) => Effect.Effect<readonly MegapotDrawingWork[], MegapotWorkStorageFailed>;
  readonly loadCredits: (
    limit: number,
  ) => Effect.Effect<readonly string[], MegapotWorkStorageFailed>;
  readonly loadChainEffects: (
    limit: number,
  ) => Effect.Effect<readonly MegapotChainEffectWork[], MegapotWorkStorageFailed>;
}

const failed = (reason: MegapotWorkStorageFailed["reason"]) =>
  new MegapotWorkStorageFailed({ reason });

function mapError(error: ControlPlaneError): MegapotWorkStorageFailed {
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") return failed("outcome-unknown");
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return failed("outcome-unknown");
  }
  return failed("unavailable");
}

const mapped = <A, R>(effect: Effect.Effect<A, ControlPlaneError | MegapotWorkStorageFailed, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof MegapotWorkStorageFailed ? error : mapError(error),
    ),
  );

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function bigint(row: Row, field: string): bigint {
  const value = row[field];
  if (
    (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") ||
    !/^[0-9]+$/u.test(String(value))
  ) {
    throw new Error(`invalid ${field}`);
  }
  return BigInt(value);
}

function drawing(row: Row): MegapotDrawingWork {
  const status = text(row, "status");
  if (
    status !== "cutoff_frozen" &&
    status !== "committed" &&
    status !== "purchase_pending" &&
    status !== "tickets_confirmed" &&
    status !== "drawing_pending" &&
    status !== "winnings_detected" &&
    status !== "claim_pending" &&
    status !== "claimed" &&
    status !== "allocated"
  ) {
    throw new Error("invalid status");
  }
  return {
    poolLegId: text(row, "pool_leg_id"),
    drawingId: bigint(row, "drawing_id"),
    status,
    attestationId: text(row, "attestation_id"),
    ticketPriceAtomic: bigint(row, "ticket_price_atomic"),
  };
}

function chainEffect(row: Row): MegapotChainEffectWork {
  const effectKind = text(row, "effect_kind");
  if (
    effectKind !== "usdc_approval" &&
    effectKind !== "ticket_purchase" &&
    effectKind !== "winnings_claim" &&
    effectKind !== "reward_payout"
  ) {
    throw new Error("invalid effect kind");
  }
  return { effectId: text(row, "effect_id"), effectKind };
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 500;
}

export function makeControlPlaneMegapotWorkRepository() {
  return {
    loadDrawings: (input: {
      readonly statuses: readonly MegapotDrawingWorkStatus[];
      readonly limit: number;
    }) =>
      mapped(
        Effect.gen(function* () {
          if (!validLimit(input.limit) || input.statuses.length === 0) {
            return yield* failed("invalid-row");
          }
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "megapot-work.drawings.read",
            text: `SELECT drawing.pool_leg_id,drawing.drawing_id,drawing.status,
                          leg.attestation_id,observation.ticket_price_atomic
                     FROM megapot_pool_drawings drawing
                     JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
                     JOIN megapot_drawing_observations observation
                       ON observation.observation_id=drawing.observation_id
                    WHERE drawing.status=ANY($1::text[])
                    ORDER BY drawing.updated_at,drawing.pool_leg_id,drawing.drawing_id
                    LIMIT $2`,
            values: [input.statuses, input.limit],
            readonly: true,
          });
          return yield* Effect.try({
            try: () => result.rows.map(drawing),
            catch: () => failed("invalid-row"),
          });
        }),
      ),

    loadCredits: (limit: number) =>
      mapped(
        Effect.gen(function* () {
          if (!validLimit(limit)) return yield* failed("invalid-row");
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "megapot-work.credits.read",
            text: `SELECT credit_id FROM reward_ledger_credits
                    WHERE state='credited'
                    ORDER BY created_at,credit_id LIMIT $1`,
            values: [limit],
            readonly: true,
          });
          return yield* Effect.try({
            try: () => result.rows.map((row) => text(row, "credit_id")),
            catch: () => failed("invalid-row"),
          });
        }),
      ),

    loadChainEffects: (limit: number) =>
      mapped(
        Effect.gen(function* () {
          if (!validLimit(limit)) return yield* failed("invalid-row");
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "megapot-work.chain-effects.read",
            text: `SELECT effect_id,effect_kind FROM reward_chain_effects
                    WHERE effect_kind IN (
                      'usdc_approval','ticket_purchase','winnings_claim','reward_payout'
                    ) AND state IN (
                      'nonce_reserved','prepared','broadcast_pending','confirming',
                      'reconciliation_required'
                    )
                    ORDER BY updated_at,effect_id LIMIT $1`,
            values: [limit],
            readonly: true,
          });
          return yield* Effect.try({
            try: () => result.rows.map(chainEffect),
            catch: () => failed("invalid-row"),
          });
        }),
      ),
  };
}

export const makeControlPlaneMegapotWorkStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): MegapotWorkStore => {
  const repository = makeControlPlaneMegapotWorkRepository();
  const provide = <A>(effect: Effect.Effect<A, MegapotWorkStorageFailed, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    loadDrawings: (input) => provide(repository.loadDrawings(input)),
    loadCredits: (limit) => provide(repository.loadCredits(limit)),
    loadChainEffects: (limit) => provide(repository.loadChainEffects(limit)),
  };
};
