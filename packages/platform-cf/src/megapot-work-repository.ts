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
  | "reward_payout"
  | "reward_refund";

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

export type MegapotAgedPendingFamily =
  | "chain_effects"
  | "funding_effects"
  | "drawings"
  | "credits"
  | "refund_liabilities";

export type MegapotAgedPending = Readonly<{
  family: MegapotAgedPendingFamily;
  count: number;
  oldestAgeSeconds: number;
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
  readonly loadRefunds: (
    limit: number,
  ) => Effect.Effect<readonly string[], MegapotWorkStorageFailed>;
  readonly loadChainEffects: (
    limit: number,
  ) => Effect.Effect<readonly MegapotChainEffectWork[], MegapotWorkStorageFailed>;
  readonly loadAgedPending: (
    thresholdSeconds: number,
  ) => Effect.Effect<readonly MegapotAgedPending[], MegapotWorkStorageFailed>;
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

function naturalNumber(row: Row, field: string): number {
  const value = row[field];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${field}`);
  return parsed;
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
    effectKind !== "reward_payout" &&
    effectKind !== "reward_refund"
  ) {
    throw new Error("invalid effect kind");
  }
  return { effectId: text(row, "effect_id"), effectKind };
}

function agedPending(row: Row): MegapotAgedPending {
  const family = text(row, "family");
  if (
    family !== "chain_effects" &&
    family !== "funding_effects" &&
    family !== "drawings" &&
    family !== "credits" &&
    family !== "refund_liabilities"
  ) {
    throw new Error("invalid aged pending family");
  }
  const count = naturalNumber(row, "count");
  const oldestAgeSeconds = naturalNumber(row, "oldest_age_seconds");
  if (count < 1) throw new Error("invalid aged pending count");
  return { family, count, oldestAgeSeconds };
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

    loadRefunds: (limit: number) =>
      mapped(
        Effect.gen(function* () {
          if (!validLimit(limit)) return yield* failed("invalid-row");
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "megapot-work.refunds.read",
            text: `WITH allocation_basis AS (
                    SELECT funding.funding_effect_id, funding.leg_id,
                           leg.funded_atomic-leg.spent_atomic-leg.fulfilled_atomic
                             AS refundable_total,
                           floor(
                             (leg.funded_atomic-leg.spent_atomic-leg.fulfilled_atomic)
                               * funding.confirmed_amount_atomic / leg.funded_atomic
                           ) AS base_amount,
                           mod(
                             (leg.funded_atomic-leg.spent_atomic-leg.fulfilled_atomic)
                               * funding.confirmed_amount_atomic, leg.funded_atomic
                           ) AS remainder_value
                      FROM song_reward_leg_funding_effects funding
                      JOIN song_reward_offer_legs leg ON leg.leg_id=funding.leg_id
                      JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id
                     WHERE funding.state='confirmed' AND leg.funded_atomic > 0
                       AND leg.status IN ('exhausted','ended')
                       AND (leg.funding_source='leg_budget' OR leg.kind='asset_bonus')
                       AND leg.reserved_atomic=0
                       AND offer.status IN ('exhausted','expired','ended')
                       AND leg.funded_atomic=(
                         SELECT sum(confirmed.confirmed_amount_atomic)
                           FROM song_reward_leg_funding_effects confirmed
                          WHERE confirmed.leg_id=leg.leg_id AND confirmed.state='confirmed'
                       )
                  ), allocations AS (
                    SELECT basis.*,
                           row_number() OVER (
                             PARTITION BY basis.leg_id
                             ORDER BY basis.remainder_value DESC,basis.funding_effect_id
                           ) AS remainder_rank,
                           sum(basis.base_amount) OVER (PARTITION BY basis.leg_id) AS base_total
                      FROM allocation_basis basis
                  )
                  SELECT allocation.funding_effect_id
                    FROM allocations allocation
                   WHERE allocation.refundable_total > 0
                     AND allocation.base_amount + CASE
                       WHEN allocation.remainder_rank <=
                         allocation.refundable_total-allocation.base_total
                       THEN 1 ELSE 0 END > 0
                     AND NOT EXISTS (
                       SELECT 1 FROM reward_refund_effects refund
                        WHERE refund.leg_id=allocation.leg_id
                          AND refund.funding_effect_id=allocation.funding_effect_id
                     )
                   ORDER BY allocation.leg_id,allocation.funding_effect_id LIMIT $1`,
            values: [limit],
            readonly: true,
          });
          return yield* Effect.try({
            try: () => result.rows.map((row) => text(row, "funding_effect_id")),
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
                      'usdc_approval','ticket_purchase','winnings_claim','reward_payout',
                      'reward_refund'
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

    loadAgedPending: (thresholdSeconds: number) =>
      mapped(
        Effect.gen(function* () {
          if (!Number.isSafeInteger(thresholdSeconds) || thresholdSeconds < 60) {
            return yield* failed("invalid-row");
          }
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "megapot-work.aged-pending.read",
            text: `WITH parameters AS (
                    SELECT clock_timestamp() AS observed_at,
                           make_interval(secs => $1::integer) AS threshold
                  ), candidates AS (
                    SELECT 'chain_effects'::text AS family,
                           effect.updated_at AS pending_since,
                           parameters.observed_at
                      FROM reward_chain_effects effect
                      CROSS JOIN parameters
                     WHERE effect.effect_kind IN (
                       'usdc_approval','ticket_purchase','winnings_claim','reward_payout',
                       'reward_refund'
                     )
                       AND effect.state IN (
                         'nonce_reserved','prepared','broadcast_pending','confirming',
                         'reconciliation_required'
                       )
                       AND effect.updated_at <= parameters.observed_at-parameters.threshold
                    UNION ALL
                    SELECT 'funding_effects', funding.updated_at, parameters.observed_at
                      FROM song_reward_leg_funding_effects funding
                      CROSS JOIN parameters
                     WHERE funding.state IN ('confirming','reconciliation_required')
                       AND funding.updated_at <= parameters.observed_at-parameters.threshold
                    UNION ALL
                    SELECT 'drawings',
                           CASE
                             WHEN drawing.status='entry_open' THEN drawing.entry_cutoff_at
                             WHEN drawing.status IN ('tickets_confirmed','drawing_pending')
                               THEN observation.drawing_time
                             ELSE drawing.updated_at
                           END,
                           parameters.observed_at
                      FROM megapot_pool_drawings drawing
                      JOIN megapot_drawing_observations observation
                        ON observation.observation_id=drawing.observation_id
                      CROSS JOIN parameters
                     WHERE drawing.status IN (
                       'entry_open','cutoff_frozen','committed','purchase_pending',
                       'tickets_confirmed','drawing_pending','winnings_detected',
                       'claim_pending','claimed','allocated'
                     )
                       AND CASE
                         WHEN drawing.status='entry_open' THEN drawing.entry_cutoff_at
                         WHEN drawing.status IN ('tickets_confirmed','drawing_pending')
                           THEN observation.drawing_time
                         ELSE drawing.updated_at
                       END <= parameters.observed_at-parameters.threshold
                    UNION ALL
                    SELECT 'credits', credit.updated_at, parameters.observed_at
                      FROM reward_ledger_credits credit
                      CROSS JOIN parameters
                     WHERE credit.state IN (
                       'credited','payout_reserved','payout_pending','reconciliation_required'
                     )
                       AND credit.updated_at <= parameters.observed_at-parameters.threshold
                    UNION ALL
                    SELECT 'refund_liabilities',
                           greatest(leg.updated_at,offer.terminal_at),
                           parameters.observed_at
                      FROM song_reward_offer_legs leg
                      JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id
                      CROSS JOIN parameters
                     WHERE leg.status IN ('exhausted','ended')
                       AND offer.status IN ('exhausted','expired','ended')
                       AND leg.reserved_atomic=0
                       AND leg.funded_atomic >
                         leg.spent_atomic+leg.fulfilled_atomic+leg.refunded_atomic
                       AND greatest(leg.updated_at,offer.terminal_at)
                         <= parameters.observed_at-parameters.threshold
                  )
                  SELECT family,count(*)::text AS count,
                         floor(extract(epoch FROM (
                           max(observed_at)-min(pending_since)
                         )))::text AS oldest_age_seconds
                    FROM candidates
                   GROUP BY family
                   ORDER BY family`,
            values: [thresholdSeconds],
            readonly: true,
          });
          return yield* Effect.try({
            try: () => result.rows.map(agedPending),
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
    loadRefunds: (limit) => provide(repository.loadRefunds(limit)),
    loadChainEffects: (limit) => provide(repository.loadChainEffects(limit)),
    loadAgedPending: (thresholdSeconds) => provide(repository.loadAgedPending(thresholdSeconds)),
  };
};
