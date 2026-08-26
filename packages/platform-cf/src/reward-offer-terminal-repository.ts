import {
  ControlPlaneDb,
  type ControlPlaneError,
  RewardOfferTerminalStorageFailed,
  type RewardOfferTerminalStore,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const failed = (reason: RewardOfferTerminalStorageFailed["reason"]) =>
  new RewardOfferTerminalStorageFailed({ reason });

function mapError(error: ControlPlaneError): RewardOfferTerminalStorageFailed {
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") return failed("outcome-unknown");
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return failed("outcome-unknown");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState !== null) {
    return failed("constraint");
  }
  return failed("unavailable");
}

const mapped = <A, R>(
  effect: Effect.Effect<A, ControlPlaneError | RewardOfferTerminalStorageFailed, R>,
) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof RewardOfferTerminalStorageFailed ? error : mapError(error),
    ),
  );

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function instant(row: Row, field: string): string {
  const value = row[field];
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new Error(`invalid ${field}`);
}

const TERMINAL_DRAWING_STATUSES = [
  "no_win",
  "credited",
  "closed_no_entries",
  "closed_unfunded",
  "closed_fallback_ineligible",
  "closed_fallback_unavailable",
  "closed_fallback_ceiling",
] as const;

export function makeControlPlaneRewardOfferTerminalRepository() {
  return {
    closeExpired: (limit: number) =>
      mapped(
        Effect.gen(function* () {
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
            return yield* failed("invalid-row");
          }
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const candidates = yield* transaction.execute<Row>({
                label: "reward-offer-terminal.candidates.lock",
                text: `SELECT offer.offer_id, offer.status
                         FROM song_reward_offers offer
                        WHERE offer.status IN ('draft','active','paused','operational_hold')
                          AND offer.ends_at <= clock_timestamp()
                          AND NOT EXISTS (
                            SELECT 1 FROM song_reward_offer_legs leg
                             WHERE leg.offer_id=offer.offer_id AND leg.reserved_atomic <> 0
                          )
                          AND NOT EXISTS (
                            SELECT 1
                              FROM song_reward_offer_legs leg
                              JOIN song_reward_leg_funding_effects funding
                                ON funding.leg_id=leg.leg_id
                             WHERE leg.offer_id=offer.offer_id
                               AND funding.state IN ('confirming','reconciliation_required')
                          )
                          AND NOT EXISTS (
                            SELECT 1
                              FROM song_reward_offer_legs leg
                              JOIN megapot_pool_drawings drawing
                                ON drawing.pool_leg_id=leg.leg_id
                             WHERE leg.offer_id=offer.offer_id
                               AND drawing.status <> ALL($1::text[])
                          )
                        ORDER BY offer.ends_at,offer.offer_id
                        LIMIT $2 FOR UPDATE OF offer SKIP LOCKED`,
                values: [TERMINAL_DRAWING_STATUSES, limit],
                readonly: false,
              });
              const results = [];
              for (const candidate of candidates.rows) {
                const offerId = text(candidate, "offer_id");
                const priorStatus = text(candidate, "status");
                const clock = yield* transaction.execute<Row>({
                  label: "reward-offer-terminal.clock.read",
                  text: "SELECT clock_timestamp() AS terminal_at",
                  values: [],
                  readonly: false,
                });
                if (clock.rows.length !== 1) return yield* failed("invalid-row");
                const terminalAt = instant(clock.rows[0] as Row, "terminal_at");
                yield* transaction.execute({
                  label: "reward-offer-terminal.unbound-funding.close",
                  text: `UPDATE song_reward_leg_funding_effects funding
                            SET state='reclaimable_failed', failure_reason='offer_ended_unbound',
                                updated_at=$2::timestamptz
                           FROM song_reward_offer_legs leg
                          WHERE leg.offer_id=$1 AND funding.leg_id=leg.leg_id
                            AND funding.state='planned'`,
                  values: [offerId, terminalAt],
                  readonly: false,
                });
                const legs = yield* transaction.execute<Row>({
                  label: "reward-offer-terminal.legs.close",
                  text: `UPDATE song_reward_offer_legs
                            SET status='ended',
                                participation_ends_at=GREATEST(
                                  $2::timestamptz, participation_starts_at + INTERVAL '1 microsecond'
                                ),
                                updated_at=$2::timestamptz
                          WHERE offer_id=$1
                            AND status IN ('draft','funding','active','paused','operational_hold')
                      RETURNING leg_id`,
                  values: [offerId, terminalAt],
                  readonly: false,
                });
                const terminalStatus =
                  priorStatus === "active" || priorStatus === "paused" ? "expired" : "ended";
                const offer = yield* transaction.execute({
                  label: "reward-offer-terminal.offer.close",
                  text: `UPDATE song_reward_offers
                            SET status=$2, terminal_at=$3::timestamptz,
                                updated_at=$3::timestamptz
                          WHERE offer_id=$1 AND status=$4`,
                  values: [offerId, terminalStatus, terminalAt, priorStatus],
                  readonly: false,
                });
                if (offer.rowCount !== 1) return yield* failed("constraint");
                results.push({
                  offerId,
                  status: terminalStatus,
                  legIds: legs.rows.map((row) => text(row, "leg_id")).sort(),
                  terminalAt,
                } as const);
              }
              return results;
            }),
          );
        }),
      ),
  };
}

export const makeControlPlaneRewardOfferTerminalStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RewardOfferTerminalStore => {
  const repository = makeControlPlaneRewardOfferTerminalRepository();
  return {
    closeExpired: (limit) => mapped(Effect.provide(layer)(repository.closeExpired(limit))),
  };
};
