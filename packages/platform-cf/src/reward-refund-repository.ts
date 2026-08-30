import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type RewardConfirmedRefund,
  type RewardRefundCandidate,
  type RewardRefundFailure,
  type RewardRefundProgress,
  RewardRefundRejected,
  type RewardRefundReservation,
  RewardRefundStorageFailed,
  type RewardRefundStore,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: RewardRefundStorageFailed["reason"]) =>
  new RewardRefundStorageFailed({ reason });
const rejected = (reason: RewardRefundRejected["reason"]) => new RewardRefundRejected({ reason });

function mapError(error: ControlPlaneError): RewardRefundStorageFailed {
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

function instantMillis(row: Row, field: string): number {
  return Date.parse(instant(row, field));
}

const CANDIDATE_SELECT = `
  WITH allocation_basis AS (
    SELECT funding.funding_effect_id, funding.leg_id, funding.funder_account_id,
           funding.sender_address AS destination_address,
           funding.confirmed_amount_atomic AS pro_rata_numerator_atomic,
           leg.funded_atomic AS pro_rata_denominator_atomic,
           leg.funded_atomic-leg.spent_atomic-leg.fulfilled_atomic AS refundable_total,
           floor(
             (leg.funded_atomic-leg.spent_atomic-leg.fulfilled_atomic)
               * funding.confirmed_amount_atomic / leg.funded_atomic
           ) AS base_amount,
           mod(
             (leg.funded_atomic-leg.spent_atomic-leg.fulfilled_atomic)
               * funding.confirmed_amount_atomic, leg.funded_atomic
           ) AS remainder_value,
           leg.attestation_id, leg.chain_id, leg.token_address
      FROM song_reward_leg_funding_effects funding
      JOIN song_reward_offer_legs leg ON leg.leg_id=funding.leg_id
      JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id
     WHERE funding.state='confirmed' AND funding.confirmed_amount_atomic IS NOT NULL
       AND leg.status IN ('exhausted','ended')
       AND (leg.funding_source='leg_budget' OR leg.kind='asset_bonus')
       AND leg.refund_policy='refund_to_funders_pro_rata' AND leg.reserved_atomic=0
       AND leg.funded_atomic > 0
       AND offer.status IN ('exhausted','expired','ended')
  ), allocations AS (
    SELECT basis.*,
           row_number() OVER (
             PARTITION BY basis.leg_id
             ORDER BY basis.remainder_value DESC, basis.funding_effect_id
           ) AS remainder_rank,
           sum(basis.base_amount) OVER (PARTITION BY basis.leg_id) AS base_total
      FROM allocation_basis basis
  )
  SELECT allocation.funding_effect_id, allocation.leg_id,
         allocation.funder_account_id, allocation.destination_address,
         allocation.pro_rata_numerator_atomic, allocation.pro_rata_denominator_atomic,
         allocation.base_amount + CASE
           WHEN allocation.remainder_rank <= allocation.refundable_total-allocation.base_total
           THEN 1 ELSE 0 END AS amount_atomic,
         observation.observation_id AS solvency_observation_id,
         observation.balance_atomic AS custody_balance_before_atomic,
         observation.expires_at AS solvency_expires_at, observation.solvent,
         allocation.token_address,
         attestation.attestation_id, attestation.environment, attestation.chain_id,
         attestation.usdc_address, attestation.custody_address,
         attestation.jackpot_address, attestation.ticket_nft_address,
         attestation.referrer_address, attestation.jackpot_code_hash,
         attestation.usdc_code_hash, attestation.ticket_nft_code_hash
    FROM allocations allocation
    JOIN reward_asset_whitelist asset
      ON asset.chain_id=allocation.chain_id AND asset.token_address=allocation.token_address
    JOIN megapot_deployment_attestations attestation
      ON attestation.chain_id=allocation.chain_id
     AND attestation.environment=asset.environment
     AND attestation.status='active'
    LEFT JOIN LATERAL (
      SELECT observation_id, balance_atomic, expires_at, solvent
        FROM custody_solvency_observations
       WHERE attestation_id=attestation.attestation_id
         AND token_address=allocation.token_address
       ORDER BY block_number DESC, observation_id DESC LIMIT 1
    ) observation ON true`;

function candidateFromRow(row: Row): RewardRefundCandidate {
  const environment = text(row, "environment");
  if (environment !== "test" && environment !== "staging" && environment !== "production") {
    throw new Error("invalid environment");
  }
  const amountAtomic = bigint(row, "amount_atomic");
  if (amountAtomic === 0n) throw new Error("zero refund amount");
  return {
    fundingEffectId: text(row, "funding_effect_id"),
    legId: text(row, "leg_id"),
    funderAccountId: text(row, "funder_account_id"),
    amountAtomic,
    destinationAddress: text(row, "destination_address"),
    proRataNumeratorAtomic: bigint(row, "pro_rata_numerator_atomic"),
    proRataDenominatorAtomic: bigint(row, "pro_rata_denominator_atomic"),
    solvencyObservationId: text(row, "solvency_observation_id"),
    custodyBalanceBeforeAtomic: bigint(row, "custody_balance_before_atomic"),
    solvencyExpiresAt: instant(row, "solvency_expires_at"),
    attestationId: text(row, "attestation_id"),
    environment,
    chainId: integer(row, "chain_id"),
    tokenAddress: text(row, "token_address"),
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

function loadCandidateIn(
  transaction: ControlPlaneTransaction,
  input: { readonly fundingEffectId: string; readonly lock: boolean },
): Effect.Effect<RewardRefundCandidate, RewardRefundFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    if (input.lock) {
      yield* transaction.execute({
        label: "reward-refund.candidate.lock",
        text: `SELECT funding.funding_effect_id
                 FROM song_reward_leg_funding_effects funding
                 JOIN song_reward_offer_legs leg ON leg.leg_id=funding.leg_id
                WHERE funding.funding_effect_id=$1
                FOR UPDATE OF funding,leg`,
        values: [input.fundingEffectId],
        readonly: false,
      });
    }
    const result = yield* transaction.execute<Row>({
      label: "reward-refund.candidate.read",
      text: `${CANDIDATE_SELECT}
              WHERE allocation.funding_effect_id=$1
                AND allocation.refundable_total > 0
                AND allocation.pro_rata_denominator_atomic=(
                  SELECT sum(confirmed_amount_atomic)
                    FROM song_reward_leg_funding_effects confirmed
                   WHERE confirmed.leg_id=allocation.leg_id AND confirmed.state='confirmed'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM reward_refund_effects existing
                   WHERE existing.leg_id=allocation.leg_id
                     AND existing.funding_effect_id=allocation.funding_effect_id
                )`,
      values: [input.fundingEffectId],
      readonly: !input.lock,
    });
    if (result.rows.length === 0) {
      const exists = yield* transaction.execute<Row>({
        label: "reward-refund.contribution-exists.read",
        text: "SELECT state FROM song_reward_leg_funding_effects WHERE funding_effect_id=$1",
        values: [input.fundingEffectId],
        readonly: true,
      });
      return yield* rejected(
        exists.rows.length === 0 ? "not-found" : "contribution-not-refundable",
      );
    }
    if (result.rows.length !== 1) return yield* storage("invalid-row");
    const row = result.rows[0] as Row;
    if (nullableText(row, "solvency_observation_id") === null) {
      return yield* rejected("solvency-stale");
    }
    if (!bool(row, "solvent")) return yield* rejected("solvency-insufficient");
    return yield* Effect.try({
      try: () => candidateFromRow(row),
      catch: () => storage("invalid-row"),
    });
  });
}

const PROGRESS_SELECT = `
  SELECT effect.state, effect.version AS effect_version, effect.nonce,
         effect.calldata, effect.calldata_hash, effect.signed_transaction,
         effect.signed_transaction_hash, effect.transaction_hash,
         effect.receipt_block_number, effect.receipt_block_hash, effect.confirmations,
         refund.refund_effect_id, refund.funding_effect_id, refund.leg_id,
         refund.funder_account_id, refund.amount_atomic,
         refund.destination_address, refund.pro_rata_numerator_atomic,
         refund.pro_rata_denominator_atomic,
         refund.solvency_observation_id, refund.custody_balance_before_atomic,
         observation.expires_at AS solvency_expires_at,
         effect.target_address AS token_address,
         refund.attestation_id, attestation.environment, attestation.chain_id,
         attestation.usdc_address, attestation.custody_address,
         attestation.jackpot_address, attestation.ticket_nft_address,
         attestation.referrer_address, attestation.jackpot_code_hash,
         attestation.usdc_code_hash, attestation.ticket_nft_code_hash
    FROM reward_chain_effects effect
    JOIN reward_refund_effects refund ON refund.refund_effect_id=effect.effect_id
    JOIN custody_solvency_observations observation
      ON observation.observation_id=refund.solvency_observation_id
    JOIN megapot_deployment_attestations attestation
      ON attestation.attestation_id=refund.attestation_id`;

function reservationFromRow(row: Row): RewardRefundReservation {
  return {
    ...candidateFromRow(row),
    effectId: text(row, "refund_effect_id"),
    nonce: bigint(row, "nonce"),
    effectVersion: integer(row, "effect_version"),
  };
}

function progressFromRow(row: Row): RewardRefundProgress {
  const state = text(row, "state");
  const reservation = reservationFromRow(row);
  if (state === "nonce_reserved") return { state, reservation };
  if (state === "confirmed") {
    return {
      state,
      effectId: reservation.effectId,
      fundingEffectId: reservation.fundingEffectId,
      legId: reservation.legId,
      transactionHash: text(row, "transaction_hash"),
      destinationAddress: reservation.destinationAddress,
      amountAtomic: reservation.amountAtomic,
      blockNumber: bigint(row, "receipt_block_number"),
      blockHash: text(row, "receipt_block_hash"),
      confirmations: integer(row, "confirmations"),
    } satisfies RewardConfirmedRefund;
  }
  if (
    state !== "prepared" &&
    state !== "broadcast_pending" &&
    state !== "confirming" &&
    state !== "reconciliation_required"
  ) {
    throw new Error("invalid refund state");
  }
  const transactionHash = nullableText(row, "transaction_hash");
  if (state === "prepared" ? transactionHash !== null : transactionHash === null) {
    throw new Error("invalid refund transaction identity");
  }
  return {
    ...reservation,
    state,
    calldata: text(row, "calldata"),
    calldataHash: text(row, "calldata_hash"),
    signedTransaction: text(row, "signed_transaction"),
    signedTransactionHash: text(row, "signed_transaction_hash"),
    transactionHash,
  };
}

function sameCandidate(left: RewardRefundCandidate, right: RewardRefundCandidate): boolean {
  return (
    left.fundingEffectId === right.fundingEffectId &&
    left.legId === right.legId &&
    left.funderAccountId === right.funderAccountId &&
    left.amountAtomic === right.amountAtomic &&
    left.destinationAddress === right.destinationAddress &&
    left.proRataNumeratorAtomic === right.proRataNumeratorAtomic &&
    left.proRataDenominatorAtomic === right.proRataDenominatorAtomic &&
    left.solvencyObservationId === right.solvencyObservationId &&
    left.custodyBalanceBeforeAtomic === right.custodyBalanceBeforeAtomic &&
    left.attestationId === right.attestationId &&
    left.chainId === right.chainId &&
    left.tokenAddress === right.tokenAddress &&
    left.usdcAddress === right.usdcAddress &&
    left.custodyAddress === right.custodyAddress
  );
}

function reserveNonceIn(
  transaction: ControlPlaneTransaction,
  input: Parameters<RewardRefundStore["reserveNonce"]>[0],
) {
  return Effect.gen(function* () {
    const candidate = yield* loadCandidateIn(transaction, {
      fundingEffectId: input.candidate.fundingEffectId,
      lock: true,
    });
    if (!sameCandidate(candidate, input.candidate)) return yield* rejected("effect-conflict");
    const nonceResult = yield* transaction.execute<Row>({
      label: "reward-refund.nonce.read",
      text: `SELECT next_nonce, observed_block_number, observed_at
               FROM reward_signer_nonces
              WHERE chain_id=$1 AND signer_address=$2 FOR UPDATE`,
      values: [candidate.chainId, candidate.custodyAddress],
      readonly: false,
    });
    let nonce: bigint;
    if (nonceResult.rows.length === 0) {
      nonce = input.observedPendingNonce;
      yield* transaction.execute({
        label: "reward-refund.nonce.create",
        text: `INSERT INTO reward_signer_nonces (
                 chain_id, signer_address, next_nonce, observed_pending_nonce,
                 observed_block_number, observed_block_hash, observed_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        values: [
          candidate.chainId,
          candidate.custodyAddress,
          (nonce + 1n).toString(),
          input.observedPendingNonce.toString(),
          input.observedBlockNumber.toString(),
          input.observedBlockHash,
          input.observedAt,
        ],
        readonly: false,
      });
    } else {
      if (nonceResult.rows.length !== 1) return yield* storage("invalid-row");
      const row = nonceResult.rows[0] as Row;
      if (
        input.observedBlockNumber < bigint(row, "observed_block_number") ||
        Date.parse(input.observedAt) < instantMillis(row, "observed_at")
      ) {
        return yield* rejected("effect-conflict");
      }
      nonce = bigint(row, "next_nonce");
      if (input.observedPendingNonce > nonce) nonce = input.observedPendingNonce;
      yield* transaction.execute({
        label: "reward-refund.nonce.reserve",
        text: `UPDATE reward_signer_nonces
                  SET next_nonce=$3, observed_pending_nonce=$4,
                      observed_block_number=$5, observed_block_hash=$6,
                      observed_at=$7, fence_version=fence_version+1,
                      updated_at=clock_timestamp()
                WHERE chain_id=$1 AND signer_address=$2`,
        values: [
          candidate.chainId,
          candidate.custodyAddress,
          (nonce + 1n).toString(),
          input.observedPendingNonce.toString(),
          input.observedBlockNumber.toString(),
          input.observedBlockHash,
          input.observedAt,
        ],
        readonly: false,
      });
    }
    const effectReserved = yield* transaction.execute({
      label: "reward-refund.effect.create",
      text: `INSERT INTO reward_chain_effects (
               effect_id, effect_kind, state, chain_id, signer_address,
               target_address, reserved_amount_atomic
             ) VALUES ($1,'reward_refund','planned',$2,$3,$4,$5)`,
      values: [
        input.effectId,
        candidate.chainId,
        candidate.custodyAddress,
        candidate.tokenAddress,
        candidate.amountAtomic.toString(),
      ],
      readonly: false,
    });
    if (effectReserved.rowCount !== 1) return yield* rejected("effect-conflict");
    yield* transaction.execute({
      label: "reward-refund.nonce-transition.create",
      text: `INSERT INTO reward_chain_effect_transitions (
               effect_id, target_version, event_type, event
             ) VALUES ($1,2,'nonce_reserved',jsonb_build_object('nonce',$2::text))`,
      values: [input.effectId, nonce.toString()],
      readonly: false,
    });
    const nonceReserved = yield* transaction.execute({
      label: "reward-refund.effect.nonce-reserve",
      text: `UPDATE reward_chain_effects
                SET state='nonce_reserved', version=2, nonce=$2,
                    updated_at=clock_timestamp()
              WHERE effect_id=$1 AND state='planned' AND version=1`,
      values: [input.effectId, nonce.toString()],
      readonly: false,
    });
    if (nonceReserved.rowCount !== 1) return yield* rejected("effect-conflict");
    const detail = yield* transaction.execute({
      label: "reward-refund.detail.create",
      text: `INSERT INTO reward_refund_effects (
               refund_effect_id, attestation_id, leg_id, funding_effect_id,
               funder_account_id, destination_address, amount_atomic,
               pro_rata_numerator_atomic, pro_rata_denominator_atomic,
               solvency_observation_id,
               custody_balance_before_atomic
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      values: [
        input.effectId,
        candidate.attestationId,
        candidate.legId,
        candidate.fundingEffectId,
        candidate.funderAccountId,
        candidate.destinationAddress,
        candidate.amountAtomic.toString(),
        candidate.proRataNumeratorAtomic.toString(),
        candidate.proRataDenominatorAtomic.toString(),
        candidate.solvencyObservationId,
        candidate.custodyBalanceBeforeAtomic.toString(),
      ],
      readonly: false,
    });
    if (detail.rowCount !== 1) return yield* rejected("effect-conflict");
    return {
      ...candidate,
      effectId: input.effectId,
      nonce,
      effectVersion: 2,
    } satisfies RewardRefundReservation;
  });
}

export function makeControlPlaneRewardRefundRepository() {
  return {
    loadCandidate: (fundingEffectId: string) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* loadCandidateIn(db, { fundingEffectId, lock: false });
      }).pipe(mapped),
    findProgress: (effectId: string) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "reward-refund.progress.read",
          text: `${PROGRESS_SELECT} WHERE effect.effect_id=$1`,
          values: [effectId],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return yield* storage("invalid-row");
        return yield* Effect.try({
          try: () => progressFromRow(result.rows[0] as Row),
          catch: () => storage("invalid-row"),
        });
      }).pipe(mapped),
    reserveNonce: (input: Parameters<RewardRefundStore["reserveNonce"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) => reserveNonceIn(transaction, input));
      }).pipe(mapped),
    prepare: (input: Parameters<RewardRefundStore["prepare"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const submitted = yield* transaction.execute({
              label: "reward-refund.prepared-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,3,'prepared',jsonb_build_object(
                       'calldata_hash',$2::text,'signed_transaction_hash',$3::text
                     ))`,
              values: [input.reservation.effectId, input.calldataHash, input.signedTransactionHash],
              readonly: false,
            });
            if (submitted.rowCount !== 1) return yield* rejected("effect-conflict");
            const prepared = yield* transaction.execute({
              label: "reward-refund.effect.prepare",
              text: `UPDATE reward_chain_effects
                        SET state='prepared', version=3, calldata=$2,
                            calldata_hash=$3, signed_transaction=$4,
                            signed_transaction_hash=$5, prepared_at=$6,
                            updated_at=clock_timestamp()
                      WHERE effect_id=$1 AND state='nonce_reserved' AND version=2
                        AND nonce=$7`,
              values: [
                input.reservation.effectId,
                input.calldata,
                input.calldataHash,
                input.signedTransaction,
                input.signedTransactionHash,
                input.preparedAt,
                input.reservation.nonce.toString(),
              ],
              readonly: false,
            });
            if (prepared.rowCount !== 1) return yield* rejected("effect-conflict");
          }),
        );
      }).pipe(mapped),
    recordSubmission: (input: Parameters<RewardRefundStore["recordSubmission"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "reward-refund.submission.read",
              text: `SELECT effect.state, effect.version, effect.signed_transaction_hash
                       FROM reward_chain_effects effect
                       JOIN reward_refund_effects refund
                         ON refund.refund_effect_id=effect.effect_id
                      WHERE effect.effect_id=$1 FOR UPDATE OF effect`,
              values: [input.effectId],
              readonly: false,
            });
            if (result.rows.length !== 1) return yield* rejected("not-found");
            const row = result.rows[0] as Row;
            if (
              text(row, "state") !== "prepared" ||
              text(row, "signed_transaction_hash") !== input.transactionHash
            ) {
              return yield* rejected("effect-conflict");
            }
            const version = integer(row, "version") + 1;
            yield* transaction.execute({
              label: "reward-refund.submission-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,$2,'broadcast_submitted',jsonb_build_object(
                       'transaction_hash',$3::text
                     ))`,
              values: [input.effectId, version, input.transactionHash],
              readonly: false,
            });
            const submitted = yield* transaction.execute({
              label: "reward-refund.submission.record",
              text: `UPDATE reward_chain_effects
                        SET state='broadcast_pending', version=$2,
                            transaction_hash=$3, broadcast_at=$4,
                            updated_at=clock_timestamp()
                      WHERE effect_id=$1 AND state='prepared'`,
              values: [input.effectId, version, input.transactionHash, input.submittedAt],
              readonly: false,
            });
            if (submitted.rowCount !== 1) return yield* rejected("effect-conflict");
            const reason = input.failureReason?.trim();
            if (input.outcome === "uncertain" && (reason === undefined || reason.length === 0)) {
              return yield* rejected("effect-conflict");
            }
            if (input.outcome === "uncertain") {
              const uncertain = yield* transaction.execute({
                label: "reward-refund.uncertain-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,$2,'submission_uncertain',jsonb_build_object(
                         'failure_reason',$3::text
                       ))`,
                values: [input.effectId, version + 1, reason],
                readonly: false,
              });
              const uncertainEffect = yield* transaction.execute({
                label: "reward-refund.uncertain.record",
                text: `UPDATE reward_chain_effects
                          SET state='reconciliation_required', version=version+1,
                              failure_class='ambiguous_submission', failure_reason=$2,
                              updated_at=clock_timestamp()
                        WHERE effect_id=$1 AND state='broadcast_pending'`,
                values: [input.effectId, reason],
                readonly: false,
              });
              if (uncertain.rowCount !== 1) return yield* rejected("effect-conflict");
              if (uncertainEffect.rowCount !== 1) return yield* rejected("effect-conflict");
            }
          }),
        );
      }).pipe(mapped),
    requireReconciliation: (input: Parameters<RewardRefundStore["requireReconciliation"]>[0]) =>
      Effect.gen(function* () {
        const reason = input.reason.trim();
        if (reason.length === 0) return yield* rejected("effect-conflict");
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "reward-refund.reconciliation.read",
              text: `SELECT effect.state, effect.version, effect.transaction_hash
                       FROM reward_chain_effects effect
                       JOIN reward_refund_effects refund
                         ON refund.refund_effect_id=effect.effect_id
                      WHERE effect.effect_id=$1 FOR UPDATE OF effect`,
              values: [input.effectId],
              readonly: false,
            });
            if (result.rows.length !== 1) return yield* rejected("not-found");
            const row = result.rows[0] as Row;
            if (text(row, "transaction_hash") !== input.transactionHash) {
              return yield* rejected("effect-conflict");
            }
            if (text(row, "state") === "reconciliation_required") return;
            if (!["broadcast_pending", "confirming"].includes(text(row, "state"))) {
              return yield* rejected("effect-conflict");
            }
            const version = integer(row, "version") + 1;
            const reconciled = yield* transaction.execute({
              label: "reward-refund.reconciliation-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,$2,'receipt_requires_reconciliation',jsonb_build_object(
                       'failure_reason',$3::text
                     ))`,
              values: [input.effectId, version, reason],
              readonly: false,
            });
            if (reconciled.rowCount !== 1) return yield* rejected("effect-conflict");
            const reconciledEffect = yield* transaction.execute({
              label: "reward-refund.reconciliation.record",
              text: `UPDATE reward_chain_effects
                        SET state='reconciliation_required', version=$2,
                            failure_class='receipt_evidence_invalid', failure_reason=$3,
                            updated_at=clock_timestamp()
                      WHERE effect_id=$1 AND state IN ('broadcast_pending','confirming')`,
              values: [input.effectId, version, reason],
              readonly: false,
            });
            if (reconciledEffect.rowCount !== 1) return yield* rejected("effect-conflict");
          }),
        );
      }).pipe(mapped),
    confirm: (input: Parameters<RewardRefundStore["confirm"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "reward-refund.confirm.read",
              text: `SELECT effect.state, effect.version, effect.transaction_hash,
                            effect.target_address AS token_address,
                            refund.attestation_id, refund.funding_effect_id, refund.leg_id,
                            refund.destination_address, refund.amount_atomic,
                            attestation.usdc_address, attestation.custody_address
                       FROM reward_chain_effects effect
                       JOIN reward_refund_effects refund
                         ON refund.refund_effect_id=effect.effect_id
                       JOIN megapot_deployment_attestations attestation
                         ON attestation.attestation_id=refund.attestation_id
                      WHERE effect.effect_id=$1 FOR UPDATE OF effect`,
              values: [input.effectId],
              readonly: false,
            });
            if (result.rows.length !== 1) return yield* rejected("not-found");
            const row = result.rows[0] as Row;
            if (
              !["broadcast_pending", "confirming", "reconciliation_required"].includes(
                text(row, "state"),
              ) ||
              text(row, "transaction_hash") !== input.transactionHash ||
              bigint(row, "amount_atomic") !== input.amountAtomic
            ) {
              return yield* rejected("effect-conflict");
            }
            const version = integer(row, "version") + 1;
            yield* transaction.execute({
              label: "reward-refund.confirm-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,$2,'receipt_confirmed',jsonb_build_object(
                       'transaction_hash',$3::text,'amount_atomic',$4::text
                     ))`,
              values: [
                input.effectId,
                version,
                input.transactionHash,
                input.amountAtomic.toString(),
              ],
              readonly: false,
            });
            const confirmed = yield* transaction.execute({
              label: "reward-refund.effect.confirm",
              text: `UPDATE reward_chain_effects
                        SET state='confirmed', version=$2, settled_amount_atomic=$3,
                            receipt_status='success', receipt_block_number=$4,
                            receipt_block_hash=$5, receipt_hash=$6,
                            confirmations=$7, confirmed_at=$8,
                            failure_class=NULL, failure_reason=NULL,
                            updated_at=clock_timestamp()
                      WHERE effect_id=$1`,
              values: [
                input.effectId,
                version,
                input.amountAtomic.toString(),
                input.blockNumber.toString(),
                input.blockHash,
                input.receiptHash,
                input.confirmations,
                input.confirmedAt,
              ],
              readonly: false,
            });
            if (confirmed.rowCount !== 1) return yield* rejected("effect-conflict");
            yield* transaction.execute({
              label: "reward-refund.receipt-evidence.create",
              text: `INSERT INTO reward_erc20_transfer_receipt_evidence (
                       effect_id, transfer_purpose, attestation_id, token_address,
                       sender_address, recipient_address, amount_atomic,
                       transaction_hash, transfer_log_index,
                       custody_balance_after_atomic, block_number, block_hash,
                       receipt_hash, confirmations, confirmed_at
                     ) VALUES ($1,'reward_refund',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
              values: [
                input.effectId,
                text(row, "attestation_id"),
                text(row, "token_address"),
                text(row, "custody_address"),
                text(row, "destination_address"),
                input.amountAtomic.toString(),
                input.transactionHash,
                input.transferLogIndex,
                input.custodyBalanceAfterAtomic.toString(),
                input.blockNumber.toString(),
                input.blockHash,
                input.receiptHash,
                input.confirmations,
                input.confirmedAt,
              ],
              readonly: false,
            });
            const leg = yield* transaction.execute({
              label: "reward-refund.leg.confirm",
              text: `UPDATE song_reward_offer_legs
                        SET refunded_atomic=refunded_atomic+$2,
                            updated_at=clock_timestamp()
                      WHERE leg_id=$1 AND status IN ('exhausted','ended')
                        AND funded_atomic-reserved_atomic-spent_atomic
                          -fulfilled_atomic-refunded_atomic >= $2`,
              values: [text(row, "leg_id"), input.amountAtomic.toString()],
              readonly: false,
            });
            if (leg.rowCount !== 1) return yield* rejected("effect-conflict");
          }),
        );
      }).pipe(mapped),
  };
}

export const makeControlPlaneRewardRefundStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RewardRefundStore => {
  const repository = makeControlPlaneRewardRefundRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    loadCandidate: (fundingEffectId) => provide(repository.loadCandidate(fundingEffectId)),
    findProgress: (effectId) => provide(repository.findProgress(effectId)),
    reserveNonce: (input) => provide(repository.reserveNonce(input)),
    prepare: (input) => provide(repository.prepare(input)),
    recordSubmission: (input) => provide(repository.recordSubmission(input)),
    requireReconciliation: (input) => provide(repository.requireReconciliation(input)),
    confirm: (input) => provide(repository.confirm(input)),
  };
};
