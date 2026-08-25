import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type RewardFundingIntent,
  RewardFundingRejected,
  RewardFundingStorageFailed,
  type RewardFundingStore,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: RewardFundingStorageFailed["reason"]) =>
  new RewardFundingStorageFailed({ reason });
const rejected = (reason: RewardFundingRejected["reason"]) => new RewardFundingRejected({ reason });

function mapError(error: ControlPlaneError): RewardFundingStorageFailed {
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

function nullableText(row: Row, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function integer(row: Row, field: string): number {
  const value = row[field];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${field}`);
  return parsed;
}

function nullableInteger(row: Row, field: string): number | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  return integer(row, field);
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
  const value = row[field];
  if (value === null || value === undefined) return null;
  return bigint(row, field);
}

const INTENT_SELECT = `
  SELECT funding.funding_effect_id, funding.leg_id, funding.funder_account_id,
         funding.sender_address, funding.recipient_address,
         funding.expected_amount_atomic, funding.required_confirmations,
         funding.state, funding.transaction_hash, funding.confirmed_amount_atomic,
         funding.log_index, funding.block_number, funding.block_hash,
         attestation.attestation_id, attestation.environment, attestation.chain_id,
         attestation.usdc_address, attestation.custody_address,
         attestation.jackpot_address, attestation.ticket_nft_address,
         attestation.referrer_address, attestation.jackpot_code_hash,
         attestation.usdc_code_hash, attestation.ticket_nft_code_hash
    FROM song_reward_leg_funding_effects funding
    JOIN song_reward_offer_legs leg ON leg.leg_id=funding.leg_id
    JOIN megapot_deployment_attestations attestation
      ON attestation.attestation_id=leg.attestation_id`;

function intentFromRow(row: Row): RewardFundingIntent {
  const state = text(row, "state");
  const environment = text(row, "environment");
  if (
    !["planned", "confirming", "confirmed", "reverted", "reconciliation_required"].includes(
      state,
    ) ||
    (environment !== "test" && environment !== "staging" && environment !== "production")
  ) {
    throw new Error("invalid funding intent");
  }
  return {
    fundingEffectId: text(row, "funding_effect_id"),
    legId: text(row, "leg_id"),
    funderAccountId: text(row, "funder_account_id"),
    senderAddress: text(row, "sender_address"),
    recipientAddress: text(row, "recipient_address"),
    expectedAmountAtomic: bigint(row, "expected_amount_atomic"),
    requiredConfirmations: integer(row, "required_confirmations"),
    state: state as RewardFundingIntent["state"],
    transactionHash: nullableText(row, "transaction_hash"),
    confirmedAmountAtomic: nullableBigint(row, "confirmed_amount_atomic"),
    transferLogIndex: nullableInteger(row, "log_index"),
    blockNumber: nullableBigint(row, "block_number"),
    blockHash: nullableText(row, "block_hash"),
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

function readIntent(
  db: ControlPlaneTransaction,
  fundingEffectId: string,
): Effect.Effect<RewardFundingIntent | null, RewardFundingStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* db.execute<Row>({
      label: "reward-funding.intent.read",
      text: `${INTENT_SELECT} WHERE funding.funding_effect_id=$1`,
      values: [fundingEffectId],
      readonly: true,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return yield* storage("invalid-row");
    return yield* Effect.try({
      try: () => intentFromRow(result.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });
}

export function makeControlPlaneRewardFundingRepository() {
  return {
    plan: (input: Parameters<RewardFundingStore["plan"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const replay = yield* readIntent(transaction, input.fundingEffectId);
            if (replay !== null) return replay;
            const authority = yield* transaction.execute<Row>({
              label: "reward-funding.authority.read",
              text: `SELECT leg.leg_id, leg.funder_account_id AS frozen_funder_account_id,
                            leg.empty_pool_policy, leg.funding_source, leg.chain_id,
                            leg.token_address, leg.status, attestation.attestation_id,
                            attestation.custody_address
                       FROM song_reward_offer_legs leg
                       JOIN megapot_deployment_attestations attestation
                         ON attestation.attestation_id=leg.attestation_id
                      WHERE leg.leg_id=$1 AND leg.kind='megapot_pool'
                        AND attestation.status='active' FOR SHARE OF leg, attestation`,
              values: [input.legId],
              readonly: false,
            });
            if (authority.rows.length === 0) return yield* rejected("not-found");
            if (authority.rows.length !== 1) return yield* storage("invalid-row");
            const row = authority.rows[0] as Row;
            if (
              text(row, "funding_source") !== "leg_budget" ||
              !["funding", "active"].includes(text(row, "status"))
            ) {
              return yield* rejected("funding-not-allowed");
            }
            if (
              text(row, "empty_pool_policy") === "funder_fallback" &&
              text(row, "frozen_funder_account_id") !== input.funderAccountId
            ) {
              return yield* rejected("fallback-sponsor-mismatch");
            }
            const wallet = yield* transaction.execute<Row>({
              label: "reward-funding.sender-authority.read",
              text: `SELECT assignment_id FROM persona_wallet_assignments
                      WHERE account_id=$1 AND address=$2 AND status='active'
                      LIMIT 2`,
              values: [input.funderAccountId, input.senderAddress],
              readonly: true,
            });
            if (wallet.rows.length !== 1) return yield* rejected("sender-not-owned");
            yield* transaction.execute({
              label: "reward-funding.intent.create",
              text: `INSERT INTO song_reward_leg_funding_effects (
                       funding_effect_id, leg_id, funder_account_id, chain_id,
                       token_address, sender_address, recipient_address,
                       expected_amount_atomic, required_confirmations, state
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'planned')`,
              values: [
                input.fundingEffectId,
                input.legId,
                input.funderAccountId,
                integer(row, "chain_id"),
                text(row, "token_address"),
                input.senderAddress,
                text(row, "custody_address"),
                input.expectedAmountAtomic.toString(),
                input.requiredConfirmations,
              ],
              readonly: false,
            });
            const created = yield* readIntent(transaction, input.fundingEffectId);
            if (created === null) return yield* storage("invalid-row");
            return created;
          }),
        );
      }).pipe(mapped),
    find: (fundingEffectId: string) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* readIntent(db, fundingEffectId);
      }).pipe(mapped),
    bindTransaction: (input: Parameters<RewardFundingStore["bindTransaction"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const current = yield* transaction.execute<Row>({
              label: "reward-funding.bind.read",
              text: `SELECT state, transaction_hash FROM song_reward_leg_funding_effects
                      WHERE funding_effect_id=$1 FOR UPDATE`,
              values: [input.fundingEffectId],
              readonly: false,
            });
            if (current.rows.length === 0) return yield* rejected("not-found");
            if (current.rows.length !== 1) return yield* storage("invalid-row");
            const row = current.rows[0] as Row;
            const existingHash = nullableText(row, "transaction_hash");
            if (existingHash !== null && existingHash !== input.transactionHash) {
              return yield* rejected("effect-conflict");
            }
            if (text(row, "state") === "planned") {
              const updated = yield* transaction.execute({
                label: "reward-funding.bind.record",
                text: `UPDATE song_reward_leg_funding_effects
                          SET state='confirming', transaction_hash=$2,
                              updated_at=clock_timestamp()
                        WHERE funding_effect_id=$1 AND state='planned'`,
                values: [input.fundingEffectId, input.transactionHash],
                readonly: false,
              });
              if (updated.rowCount !== 1) return yield* rejected("effect-conflict");
            }
            const bound = yield* readIntent(transaction, input.fundingEffectId);
            if (bound === null) return yield* storage("invalid-row");
            return bound;
          }),
        );
      }).pipe(mapped),
    confirm: (input: Parameters<RewardFundingStore["confirm"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const current = yield* transaction.execute<Row>({
              label: "reward-funding.confirm.read",
              text: `SELECT state, transaction_hash, expected_amount_atomic, leg_id
                       FROM song_reward_leg_funding_effects
                      WHERE funding_effect_id=$1 FOR UPDATE`,
              values: [input.fundingEffectId],
              readonly: false,
            });
            if (current.rows.length !== 1) return yield* rejected("not-found");
            const row = current.rows[0] as Row;
            if (
              !["confirming", "reconciliation_required"].includes(text(row, "state")) ||
              text(row, "transaction_hash") !== input.transactionHash ||
              bigint(row, "expected_amount_atomic") !== input.amountAtomic
            ) {
              return yield* rejected("effect-conflict");
            }
            const updated = yield* transaction.execute({
              label: "reward-funding.confirm.record",
              text: `UPDATE song_reward_leg_funding_effects
                        SET state='confirmed', confirmed_amount_atomic=$2,
                            log_index=$3, block_number=$4, block_hash=$5,
                            observation_hash=$6, failure_reason=NULL,
                            confirmed_at=$7, updated_at=clock_timestamp()
                      WHERE funding_effect_id=$1`,
              values: [
                input.fundingEffectId,
                input.amountAtomic.toString(),
                input.transferLogIndex,
                input.blockNumber.toString(),
                input.blockHash,
                input.observationHash,
                input.confirmedAt,
              ],
              readonly: false,
            });
            if (updated.rowCount !== 1) return yield* rejected("effect-conflict");
            const leg = yield* transaction.execute({
              label: "reward-funding.leg.credit",
              text: `UPDATE song_reward_offer_legs
                        SET funded_atomic=funded_atomic+$2, updated_at=clock_timestamp()
                      WHERE leg_id=$1 AND status IN ('funding','active')`,
              values: [text(row, "leg_id"), input.amountAtomic.toString()],
              readonly: false,
            });
            if (leg.rowCount !== 1) return yield* rejected("funding-not-allowed");
            yield* transaction.execute({
              label: "reward-funding.leg.activate-no-purchase",
              text: `UPDATE song_reward_offer_legs leg
                        SET status='active', activated_at=clock_timestamp(),
                            updated_at=clock_timestamp()
                       FROM song_reward_offers offer
                      WHERE leg.leg_id=$1 AND leg.offer_id=offer.offer_id
                        AND leg.kind='megapot_pool' AND leg.status='funding'
                        AND leg.empty_pool_policy='no_purchase'
                        AND leg.funded_atomic >= leg.max_ticket_price_atomic
                        AND offer.status='active' AND offer.starts_at <= clock_timestamp()
                        AND offer.ends_at > clock_timestamp()`,
              values: [text(row, "leg_id")],
              readonly: false,
            });
          }),
        );
      }).pipe(mapped),
    revert: (input: Parameters<RewardFundingStore["revert"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const updated = yield* db.execute({
          label: "reward-funding.revert.record",
          text: `UPDATE song_reward_leg_funding_effects
                    SET state='reverted', block_number=$3, block_hash=$4,
                        observation_hash=$5, updated_at=clock_timestamp()
                  WHERE funding_effect_id=$1 AND transaction_hash=$2
                    AND state IN ('confirming','reconciliation_required')`,
          values: [
            input.fundingEffectId,
            input.transactionHash,
            input.blockNumber.toString(),
            input.blockHash,
            input.observationHash,
          ],
          readonly: false,
        });
        if (updated.rowCount !== 1) return yield* rejected("effect-conflict");
      }).pipe(mapped),
    requireReconciliation: (input: Parameters<RewardFundingStore["requireReconciliation"]>[0]) =>
      Effect.gen(function* () {
        const reason = input.reason.trim();
        if (reason.length === 0) return yield* rejected("effect-conflict");
        const db = yield* ControlPlaneDb;
        const updated = yield* db.execute({
          label: "reward-funding.reconciliation.record",
          text: `UPDATE song_reward_leg_funding_effects
                    SET state='reconciliation_required', failure_reason=$3,
                        updated_at=clock_timestamp()
                  WHERE funding_effect_id=$1 AND transaction_hash=$2
                    AND state='confirming'`,
          values: [input.fundingEffectId, input.transactionHash, reason],
          readonly: false,
        });
        if (updated.rowCount !== 1) {
          const current = yield* readIntent(db, input.fundingEffectId);
          if (current?.state !== "reconciliation_required") {
            return yield* rejected("effect-conflict");
          }
        }
      }).pipe(mapped),
  };
}

export const makeControlPlaneRewardFundingStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RewardFundingStore => {
  const repository = makeControlPlaneRewardFundingRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    plan: (input) => provide(repository.plan(input)),
    find: (fundingEffectId) => provide(repository.find(fundingEffectId)),
    bindTransaction: (input) => provide(repository.bindTransaction(input)),
    confirm: (input) => provide(repository.confirm(input)),
    revert: (input) => provide(repository.revert(input)),
    requireReconciliation: (input) => provide(repository.requireReconciliation(input)),
  };
};
