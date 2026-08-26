import {
  ControlPlaneDb,
  type ControlPlaneError,
  type CustodySolvencyCandidate,
  type CustodySolvencyObservation,
  CustodySolvencyRejected,
  CustodySolvencyStorageFailed,
  type CustodySolvencyStore,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: CustodySolvencyStorageFailed["reason"]) =>
  new CustodySolvencyStorageFailed({ reason });
const rejected = (reason: CustodySolvencyRejected["reason"]) =>
  new CustodySolvencyRejected({ reason });

function mapError(error: ControlPlaneError): CustodySolvencyStorageFailed {
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

function candidateFromRow(row: Row): CustodySolvencyCandidate {
  const environment = text(row, "environment");
  if (environment !== "test" && environment !== "staging" && environment !== "production") {
    throw new Error("invalid environment");
  }
  return {
    attestationId: text(row, "attestation_id"),
    environment,
    chainId: integer(row, "chain_id"),
    usdcAddress: text(row, "usdc_address"),
    custodyAddress: text(row, "custody_address"),
    jackpotAddress: text(row, "jackpot_address"),
    ticketNftAddress: text(row, "ticket_nft_address"),
    referrerAddress: text(row, "referrer_address"),
    jackpotCodeHash: text(row, "jackpot_code_hash"),
    usdcCodeHash: text(row, "usdc_code_hash"),
    ticketNftCodeHash: text(row, "ticket_nft_code_hash"),
  };
}

function observationFromRow(row: Row): CustodySolvencyObservation {
  return {
    observationId: text(row, "observation_id"),
    attestationId: text(row, "attestation_id"),
    balanceAtomic: bigint(row, "balance_atomic"),
    reservedPurchaseAtomic: bigint(row, "reserved_purchase_atomic"),
    outstandingCreditAtomic: bigint(row, "outstanding_credit_atomic"),
    pendingRefundAtomic: bigint(row, "pending_refund_atomic"),
    sharedSponsorshipAtomic: bigint(row, "shared_sponsorship_atomic"),
    solvent: bool(row, "solvent"),
    blockNumber: bigint(row, "block_number"),
    blockHash: text(row, "block_hash"),
    observedAt: instant(row, "observed_at"),
    expiresAt: instant(row, "expires_at"),
  };
}

const OBSERVATION_SELECT = `SELECT observation_id, attestation_id, balance_atomic,
  reserved_purchase_atomic, outstanding_credit_atomic, pending_refund_atomic,
  shared_sponsorship_atomic, solvent, block_number, block_hash, observed_at, expires_at
  FROM custody_solvency_observations`;

export function makeControlPlaneCustodySolvencyRepository() {
  return {
    loadCandidate: (attestationId: string) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "custody-solvency.candidate.read",
          text: `SELECT attestation_id, environment, chain_id, usdc_address,
                        custody_address, jackpot_address, ticket_nft_address,
                        referrer_address, jackpot_code_hash, usdc_code_hash,
                        ticket_nft_code_hash
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
      }).pipe(mapped),
    findObservation: (observationId: string) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "custody-solvency.observation.read",
          text: `${OBSERVATION_SELECT} WHERE observation_id=$1`,
          values: [observationId],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return yield* storage("invalid-row");
        return yield* Effect.try({
          try: () => observationFromRow(result.rows[0] as Row),
          catch: () => storage("invalid-row"),
        });
      }).pipe(mapped),
    record: (input: Parameters<CustodySolvencyStore["record"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const replay = yield* transaction.execute<Row>({
              label: "custody-solvency.observation-replay.read",
              text: `${OBSERVATION_SELECT} WHERE observation_id=$1`,
              values: [input.observationId],
              readonly: true,
            });
            if (replay.rows.length === 1) {
              return yield* Effect.try({
                try: () => observationFromRow(replay.rows[0] as Row),
                catch: () => storage("invalid-row"),
              });
            }
            const authority = yield* transaction.execute<Row>({
              label: "custody-solvency.authority.read",
              text: `SELECT attestation_id, environment, chain_id, usdc_address,
                            custody_address, jackpot_address, ticket_nft_address,
                            referrer_address, jackpot_code_hash, usdc_code_hash,
                            ticket_nft_code_hash
                       FROM megapot_deployment_attestations
                      WHERE attestation_id=$1 AND status='active' FOR SHARE`,
              values: [input.candidate.attestationId],
              readonly: false,
            });
            if (authority.rows.length !== 1) return yield* rejected("attestation-not-found");
            const candidate = yield* Effect.try({
              try: () => candidateFromRow(authority.rows[0] as Row),
              catch: () => storage("invalid-row"),
            });
            if (JSON.stringify(candidate) !== JSON.stringify(input.candidate)) {
              return yield* rejected("observation-conflict");
            }
            const totals = yield* transaction.execute<Row>({
              label: "custody-solvency.liabilities.read",
              text: `SELECT
                (SELECT COALESCE(sum(reserved_atomic),0)::text
                   FROM song_reward_offer_legs
                  WHERE kind='megapot_pool' AND funding_source='leg_budget'
                    AND chain_id=$1 AND token_address=$2) AS reserved_purchase_atomic,
                (SELECT COALESCE(sum(amount_atomic-paid_atomic),0)::text
                   FROM reward_ledger_credits
                  WHERE state <> 'sent' AND chain_id=$1 AND token_address=$2)
                  AS outstanding_credit_atomic,
                (SELECT COALESCE(sum(funded_atomic-reserved_atomic-spent_atomic
                    -fulfilled_atomic-refunded_atomic),0)::text
                   FROM song_reward_offer_legs
                  WHERE funding_source='leg_budget' AND chain_id=$1 AND token_address=$2)
                  AS pending_refund_atomic,
                (SELECT COALESCE(sum(funded_atomic+winnings_credited_atomic
                    -spent_atomic-withdrawn_atomic),0)::text
                   FROM platform_sponsorship_budgets
                  WHERE chain_id=$1 AND token_address=$2) AS shared_sponsorship_atomic`,
              values: [candidate.chainId, candidate.usdcAddress],
              readonly: true,
            });
            if (totals.rows.length !== 1) return yield* storage("invalid-row");
            const row = totals.rows[0] as Row;
            yield* transaction.execute({
              label: "custody-solvency.observation.create",
              text: `INSERT INTO custody_solvency_observations (
                       observation_id, attestation_id, chain_id, custody_address,
                       token_address, balance_atomic, reserved_purchase_atomic,
                       outstanding_credit_atomic, pending_refund_atomic,
                       shared_sponsorship_atomic, block_number, block_hash,
                       observed_at, expires_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
              values: [
                input.observationId,
                candidate.attestationId,
                candidate.chainId,
                candidate.custodyAddress,
                candidate.usdcAddress,
                input.balanceAtomic.toString(),
                text(row, "reserved_purchase_atomic"),
                text(row, "outstanding_credit_atomic"),
                text(row, "pending_refund_atomic"),
                text(row, "shared_sponsorship_atomic"),
                input.blockNumber.toString(),
                input.blockHash,
                input.observedAt,
                input.expiresAt,
              ],
              readonly: false,
            });
            const created = yield* transaction.execute<Row>({
              label: "custody-solvency.observation-created.read",
              text: `${OBSERVATION_SELECT} WHERE observation_id=$1`,
              values: [input.observationId],
              readonly: true,
            });
            if (created.rows.length !== 1) return yield* storage("invalid-row");
            return yield* Effect.try({
              try: () => observationFromRow(created.rows[0] as Row),
              catch: () => storage("invalid-row"),
            });
          }),
        );
      }).pipe(mapped),
  };
}

export const makeControlPlaneCustodySolvencyStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CustodySolvencyStore => {
  const repository = makeControlPlaneCustodySolvencyRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    loadCandidate: (attestationId) => provide(repository.loadCandidate(attestationId)),
    findObservation: (observationId) => provide(repository.findObservation(observationId)),
    record: (input) => provide(repository.record(input)),
  };
};
