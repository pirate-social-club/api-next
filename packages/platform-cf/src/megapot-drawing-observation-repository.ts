import {
  ControlPlaneDb,
  type ControlPlaneError,
  type MegapotDrawingObservationRecord,
  MegapotDrawingObservationRejected,
  type MegapotDrawingObservationResult,
  MegapotDrawingObservationStorageFailed,
  type MegapotDrawingObservationStore,
  type MegapotDrawingObserverCandidate,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: MegapotDrawingObservationStorageFailed["reason"]) =>
  new MegapotDrawingObservationStorageFailed({ reason });
const rejected = (reason: MegapotDrawingObservationRejected["reason"]) =>
  new MegapotDrawingObservationRejected({ reason });

function mapError(error: ControlPlaneError): MegapotDrawingObservationStorageFailed {
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") return storage("outcome-unknown");
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return storage("outcome-unknown");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState === "23505") {
    return storage("conflict");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState !== null) {
    return storage("constraint");
  }
  return storage("unavailable");
}

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      typeof error === "object" && error !== null && "_tag" in error
        ? error._tag === "ControlPlaneAcquireFailed" ||
          error._tag === "ControlPlaneOperationTimedOut" ||
          error._tag === "ControlPlaneStatementFailed" ||
          error._tag === "ControlPlaneTransactionOutcomeUnknown"
          ? mapError(error as ControlPlaneError)
          : (error as E)
        : (error as E),
    ),
  );

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function integer(row: Row, field: string): number {
  const value = row[field];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${field}`);
  return parsed;
}

function bigint(row: Row, field: string): bigint {
  const value = row[field];
  if (
    (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") ||
    !/^[0-9]+$/u.test(String(value))
  ) {
    throw new Error(`invalid ${field}`);
  }
  return BigInt(value);
}

function nullableBigint(row: Row, field: string): bigint | null {
  return row[field] === null || row[field] === undefined ? null : bigint(row, field);
}

function bool(row: Row, field: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
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

function candidateFromRow(row: Row): MegapotDrawingObserverCandidate {
  const environment = text(row, "environment");
  if (environment !== "test" && environment !== "staging" && environment !== "production") {
    throw new Error("invalid environment");
  }
  return {
    attestationId: text(row, "attestation_id"),
    environment,
    chainId: integer(row, "chain_id"),
    jackpotAddress: text(row, "jackpot_address"),
    usdcAddress: text(row, "usdc_address"),
    ticketNftAddress: text(row, "ticket_nft_address"),
    custodyAddress: text(row, "custody_address"),
    referrerAddress: text(row, "referrer_address"),
    sourceTag: text(row, "source_tag"),
    jackpotCodeHash: text(row, "jackpot_code_hash"),
    usdcCodeHash: text(row, "usdc_code_hash"),
    ticketNftCodeHash: text(row, "ticket_nft_code_hash"),
    attestationBlockNumber: bigint(row, "attestation_block_number"),
    attestationBlockHash: text(row, "attestation_block_hash"),
    verifiedAt: instant(row, "verified_at"),
  };
}

function observationFromRow(
  row: Row,
  openedPoolLegIds: readonly string[],
): MegapotDrawingObservationResult {
  const grossPrizePoolAtomic = nullableBigint(row, "gross_prize_pool_atomic");
  const globalTicketsBought = nullableBigint(row, "global_tickets_bought");
  if ((grossPrizePoolAtomic === null) !== (globalTicketsBought === null)) {
    throw new Error("invalid jackpot observation pair");
  }
  return {
    observationId: text(row, "observation_id"),
    attestationId: text(row, "attestation_id"),
    chainId: integer(row, "chain_id"),
    drawingId: bigint(row, "drawing_id"),
    grossPrizePoolAtomic,
    globalTicketsBought,
    ticketPriceAtomic: bigint(row, "ticket_price_atomic"),
    drawingTime: instant(row, "drawing_time"),
    ballMax: integer(row, "ball_max"),
    bonusballMax: integer(row, "bonusball_max"),
    drawingLocked: bool(row, "drawing_locked"),
    referralFeeWei: bigint(row, "referral_fee_wei"),
    referralWinShareWei: bigint(row, "referral_win_share_wei"),
    blockNumber: bigint(row, "block_number"),
    blockHash: text(row, "block_hash"),
    blockTimestamp: instant(row, "block_timestamp"),
    confirmations: integer(row, "confirmations"),
    observedAt: instant(row, "observed_at"),
    expiresAt: instant(row, "expires_at"),
    rawStateHash: text(row, "raw_state_hash"),
    openedPoolLegIds,
  };
}

const OBSERVATION_SELECT = `
  SELECT observation_id, attestation_id, chain_id, drawing_id,
         gross_prize_pool_atomic, global_tickets_bought,
         ticket_price_atomic, drawing_time, ball_max, bonusball_max,
         drawing_locked, referral_fee_wei, referral_win_share_wei,
         block_number, block_hash, block_timestamp, confirmations,
         observed_at, expires_at, raw_state_hash
    FROM megapot_drawing_observations`;

export function makeControlPlaneMegapotDrawingObservationRepository() {
  return {
    loadCandidate: (attestationId: string) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "megapot-drawing-observation.attestation.read",
            text: `SELECT attestation_id, environment, chain_id, jackpot_address,
                          usdc_address, ticket_nft_address, custody_address,
                          referrer_address, source_tag, jackpot_code_hash,
                          usdc_code_hash, ticket_nft_code_hash,
                          attestation_block_number, attestation_block_hash, verified_at
                     FROM megapot_deployment_attestations
                    WHERE attestation_id=$1 AND status='active'`,
            values: [attestationId],
            readonly: true,
          });
          if (result.rows.length === 0) return yield* rejected("attestation-not-found");
          if (result.rows.length !== 1) return yield* storage("invalid-row");
          return yield* Effect.try({
            try: () => candidateFromRow(result.rows[0] as Row),
            catch: () => storage("invalid-row"),
          });
        }),
      ),

    recordAndOpen: (observation: MegapotDrawingObservationRecord) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const authority = yield* transaction.execute<Row>({
                label: "megapot-drawing-observation.attestation.lock",
                text: `SELECT chain_id FROM megapot_deployment_attestations
                        WHERE attestation_id=$1 AND status='active' FOR SHARE`,
                values: [observation.attestationId],
                readonly: false,
              });
              if (authority.rows.length === 0) return yield* rejected("attestation-not-found");
              if (
                authority.rows.length !== 1 ||
                integer(authority.rows[0] as Row, "chain_id") !== observation.chainId
              ) {
                return yield* rejected("deployment-attestation-mismatch");
              }
              yield* transaction.execute({
                label: "megapot-drawing-observation.create",
                text: `INSERT INTO megapot_drawing_observations (
                         observation_id, attestation_id, chain_id, drawing_id,
                         gross_prize_pool_atomic, global_tickets_bought,
                         ticket_price_atomic, drawing_time, ball_max, bonusball_max,
                         drawing_locked, referral_fee_wei, referral_win_share_wei,
                         block_number, block_hash, block_timestamp, confirmations,
                         observed_at, expires_at, raw_state_hash
                       ) VALUES (
                         $1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12,$13,$14,$15,
                         $16::timestamptz,$17,$18::timestamptz,$19::timestamptz,$20
                       ) ON CONFLICT (attestation_id, drawing_id, block_hash) DO NOTHING`,
                values: [
                  observation.observationId,
                  observation.attestationId,
                  observation.chainId,
                  observation.drawingId.toString(),
                  observation.grossPrizePoolAtomic.toString(),
                  observation.globalTicketsBought.toString(),
                  observation.ticketPriceAtomic.toString(),
                  observation.drawingTime,
                  observation.ballMax,
                  observation.bonusballMax,
                  observation.drawingLocked,
                  observation.referralFeeWei.toString(),
                  observation.referralWinShareWei.toString(),
                  observation.blockNumber.toString(),
                  observation.blockHash,
                  observation.blockTimestamp,
                  observation.confirmations,
                  observation.observedAt,
                  observation.expiresAt,
                  observation.rawStateHash,
                ],
                readonly: false,
              });
              const persisted = yield* transaction.execute<Row>({
                label: "megapot-drawing-observation.persisted.read",
                text: `${OBSERVATION_SELECT}
                        WHERE attestation_id=$1 AND drawing_id=$2 AND block_hash=$3 FOR SHARE`,
                values: [
                  observation.attestationId,
                  observation.drawingId.toString(),
                  observation.blockHash,
                ],
                readonly: false,
              });
              if (persisted.rows.length !== 1) return yield* storage("invalid-row");
              const row = persisted.rows[0] as Row;
              const persistedRawStateHash = text(row, "raw_state_hash");
              const legacyReplay =
                row.gross_prize_pool_atomic === null &&
                row.global_tickets_bought === null &&
                persistedRawStateHash === observation.legacyRawStateHash;
              if (persistedRawStateHash !== observation.rawStateHash && !legacyReplay) {
                return yield* storage("conflict");
              }
              const opened = yield* transaction.execute<Row>({
                label: "megapot-drawing-observation.pool-drawings.open",
                text: `INSERT INTO megapot_pool_drawings (
                         pool_leg_id, drawing_id, observation_id, status,
                         entry_cutoff_at, ticket_price_ceiling_atomic
                       )
                       SELECT leg.leg_id, observation.drawing_id, observation.observation_id,
                              'entry_open',
                              observation.drawing_time
                                - make_interval(secs => leg.entry_cutoff_seconds),
                              leg.max_ticket_price_atomic
                         FROM song_reward_offer_legs leg
                         JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id
                         JOIN megapot_drawing_observations observation
                           ON observation.observation_id=$1
                        WHERE leg.kind='megapot_pool' AND leg.status='active'
                          AND offer.status='active'
                          AND leg.attestation_id=observation.attestation_id
                          AND observation.drawing_id >= leg.participation_starts_drawing_id
                          AND NOT observation.drawing_locked
                          AND observation.expires_at > clock_timestamp()
                          AND observation.drawing_time
                                - make_interval(secs => leg.entry_cutoff_seconds)
                              > clock_timestamp()
                          AND observation.drawing_time
                                - make_interval(secs => leg.entry_cutoff_seconds)
                              <= offer.ends_at
                       ON CONFLICT (pool_leg_id, drawing_id) DO NOTHING
                       RETURNING pool_leg_id`,
                values: [text(row, "observation_id")],
                readonly: false,
              });
              return yield* Effect.try({
                try: () =>
                  observationFromRow(
                    row,
                    opened.rows.map((openedRow) => text(openedRow, "pool_leg_id")).sort(),
                  ),
                catch: () => storage("invalid-row"),
              });
            }),
          );
        }),
      ),
  };
}

export const makeControlPlaneMegapotDrawingObservationStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): MegapotDrawingObservationStore => {
  const repository = makeControlPlaneMegapotDrawingObservationRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    loadCandidate: (attestationId) => provide(repository.loadCandidate(attestationId)),
    recordAndOpen: (observation) => provide(repository.recordAndOpen(observation)),
  };
};
