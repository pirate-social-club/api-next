import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type MegapotClaimCandidate,
  type MegapotClaimFailure,
  type MegapotClaimProgress,
  MegapotClaimRejected,
  MegapotClaimStorageFailed,
  type MegapotClaimStore,
  type MegapotReservedClaim,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;
const storage = (reason: MegapotClaimStorageFailed["reason"]) =>
  new MegapotClaimStorageFailed({ reason });
const rejected = (reason: MegapotClaimRejected["reason"]) => new MegapotClaimRejected({ reason });

function mapError(error: ControlPlaneError): MegapotClaimStorageFailed {
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
function instantMillis(row: Row, field: string): number {
  const value = row[field];
  const millis = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(millis)) throw new Error(`invalid ${field}`);
  return millis;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function candidateFromRow(row: Row): MegapotClaimCandidate {
  const environment = text(row, "environment");
  if (environment !== "test" && environment !== "staging" && environment !== "production") {
    throw new Error("invalid environment");
  }
  return {
    poolLegId: text(row, "pool_leg_id"),
    drawingId: bigint(row, "drawing_id"),
    drawingVersion: integer(row, "drawing_version"),
    snapshotId: text(row, "snapshot_id"),
    sweepId: text(row, "sweep_id"),
    ticketId: bigint(row, "ticket_id"),
    expectedGrossWinningsAtomic: bigint(row, "expected_gross_winnings_atomic"),
    expectedReferralAccrualAtomic: bigint(row, "expected_referral_accrual_atomic"),
    expectedNetWinningsAtomic: bigint(row, "expected_net_winnings_atomic"),
    referralAllocationVersion: text(row, "referral_allocation_version"),
    attestationId: text(row, "attestation_id"),
    environment,
    chainId: integer(row, "chain_id"),
    jackpotAddress: text(row, "jackpot_address"),
    usdcAddress: text(row, "usdc_address"),
    ticketNftAddress: text(row, "ticket_nft_address"),
    custodyAddress: text(row, "custody_address"),
    referrerAddress: text(row, "referrer_address"),
    jackpotCodeHash: text(row, "jackpot_code_hash"),
    usdcCodeHash: text(row, "usdc_code_hash"),
    ticketNftCodeHash: text(row, "ticket_nft_code_hash"),
  };
}

const CANDIDATE_SELECT = `
  SELECT drawing.pool_leg_id, drawing.drawing_id,
         drawing.version AS drawing_version, drawing.snapshot_id,
         sweep.sweep_id, ticket.ticket_id,
         sweep_evidence.gross_winnings_atomic AS expected_gross_winnings_atomic,
         sweep_evidence.referral_accrual_atomic AS expected_referral_accrual_atomic,
         sweep_evidence.net_winnings_atomic AS expected_net_winnings_atomic,
         COALESCE(leg.referral_allocation_version, 'platform_referral_v1')
           AS referral_allocation_version,
         attestation.attestation_id, attestation.environment,
         attestation.chain_id, attestation.jackpot_address,
         attestation.usdc_address, attestation.ticket_nft_address,
         attestation.custody_address, attestation.referrer_address,
         attestation.jackpot_code_hash, attestation.usdc_code_hash,
         attestation.ticket_nft_code_hash
    FROM megapot_pool_drawings drawing
    JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
    JOIN megapot_drawing_sweeps sweep
      ON sweep.pool_leg_id=drawing.pool_leg_id AND sweep.drawing_id=drawing.drawing_id
    JOIN megapot_sweep_ticket_evidence sweep_evidence ON sweep_evidence.sweep_id=sweep.sweep_id
    JOIN megapot_ticket_inventory ticket
      ON ticket.attestation_id=sweep_evidence.attestation_id
     AND ticket.ticket_id=sweep_evidence.ticket_id
    JOIN megapot_deployment_attestations attestation
      ON attestation.attestation_id=ticket.attestation_id`;

function loadCandidateIn(
  transaction: ControlPlaneTransaction,
  input: { readonly poolLegId: string; readonly drawingId: bigint; readonly lock: boolean },
): Effect.Effect<MegapotClaimCandidate, MegapotClaimFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "megapot-claim.candidate.read",
      text: `${CANDIDATE_SELECT}
              WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=$2
                AND drawing.status='winnings_detected'
                AND sweep.state='complete' AND sweep_evidence.tier_id NOT IN (0,2)
                AND sweep_evidence.gross_winnings_atomic > 0
                AND sweep_evidence.net_winnings_atomic > 0
                AND ticket.status='custodied' AND attestation.status='active'
              ${input.lock ? "FOR UPDATE OF drawing, ticket" : ""}`,
      values: [input.poolLegId, input.drawingId.toString()],
      readonly: !input.lock,
    });
    if (result.rows.length === 0) return yield* rejected("ticket-not-claimable");
    if (result.rows.length !== 1) return yield* storage("invalid-row");
    return yield* Effect.try({
      try: () => candidateFromRow(result.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });
}

const PROGRESS_SELECT = `
  SELECT effect.effect_id, effect.state, effect.version AS effect_version,
         effect.nonce, effect.calldata, effect.calldata_hash,
         effect.signed_transaction, effect.signed_transaction_hash,
         effect.transaction_hash, claim.pool_leg_id, claim.drawing_id,
         drawing.version - 1 AS drawing_version, drawing.snapshot_id,
         claim.sweep_id, claim.ticket_id,
         claim.expected_gross_winnings_atomic,
         claim.expected_referral_accrual_atomic,
         claim.expected_net_winnings_atomic,
         claim.custody_balance_before_atomic,
         claim.referral_balance_before_atomic,
         claim.preflight_block_number, claim.preflight_block_hash,
         COALESCE(leg.referral_allocation_version, 'platform_referral_v1')
           AS referral_allocation_version,
         attestation.attestation_id, attestation.environment,
         attestation.chain_id, attestation.jackpot_address,
         attestation.usdc_address, attestation.ticket_nft_address,
         attestation.custody_address, attestation.referrer_address,
         attestation.jackpot_code_hash, attestation.usdc_code_hash,
         attestation.ticket_nft_code_hash,
         evidence.block_number AS receipt_block_number,
         evidence.block_hash AS receipt_block_hash,
         evidence.confirmations AS receipt_confirmations
    FROM reward_chain_effects effect
    JOIN megapot_claim_effects claim ON claim.claim_effect_id=effect.effect_id
    JOIN megapot_pool_drawings drawing
      ON drawing.pool_leg_id=claim.pool_leg_id AND drawing.drawing_id=claim.drawing_id
    JOIN song_reward_offer_legs leg ON leg.leg_id=claim.pool_leg_id
    JOIN megapot_deployment_attestations attestation
      ON attestation.attestation_id=claim.attestation_id
    LEFT JOIN megapot_claim_receipt_evidence evidence
      ON evidence.claim_effect_id=effect.effect_id`;

function progressFromRow(row: Row): MegapotClaimProgress {
  const state = text(row, "state");
  const effectId = text(row, "effect_id");
  const candidate = candidateFromRow(row);
  if (state === "confirmed") {
    return {
      state,
      effectId,
      poolLegId: candidate.poolLegId,
      drawingId: candidate.drawingId,
      ticketId: candidate.ticketId,
      transactionHash: text(row, "transaction_hash"),
      grossWinningsAtomic: candidate.expectedGrossWinningsAtomic,
      referralAccrualAtomic: candidate.expectedReferralAccrualAtomic,
      netWinningsAtomic: candidate.expectedNetWinningsAtomic,
      blockNumber: bigint(row, "receipt_block_number"),
      blockHash: text(row, "receipt_block_hash"),
      confirmations: integer(row, "receipt_confirmations"),
    };
  }
  const reservation: MegapotReservedClaim = {
    ...candidate,
    effectId,
    nonce: bigint(row, "nonce"),
    effectVersion: integer(row, "effect_version"),
    custodyBalanceBeforeAtomic: bigint(row, "custody_balance_before_atomic"),
    referralBalanceBeforeAtomic: bigint(row, "referral_balance_before_atomic"),
    preflightBlockNumber: bigint(row, "preflight_block_number"),
    preflightBlockHash: text(row, "preflight_block_hash"),
  };
  if (state === "nonce_reserved") return { state, reservation };
  if (
    state !== "prepared" &&
    state !== "broadcast_pending" &&
    state !== "confirming" &&
    state !== "reconciliation_required"
  ) {
    throw new Error("invalid claim effect state");
  }
  const transactionHash = nullableText(row, "transaction_hash");
  if (state === "prepared" ? transactionHash !== null : transactionHash === null) {
    throw new Error("invalid claim transaction identity");
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

function sameCandidate(left: MegapotClaimCandidate, right: MegapotClaimCandidate): boolean {
  return (
    left.poolLegId === right.poolLegId &&
    left.drawingId === right.drawingId &&
    left.drawingVersion === right.drawingVersion &&
    left.snapshotId === right.snapshotId &&
    left.sweepId === right.sweepId &&
    left.ticketId === right.ticketId &&
    left.expectedGrossWinningsAtomic === right.expectedGrossWinningsAtomic &&
    left.expectedReferralAccrualAtomic === right.expectedReferralAccrualAtomic &&
    left.expectedNetWinningsAtomic === right.expectedNetWinningsAtomic &&
    left.attestationId === right.attestationId &&
    left.chainId === right.chainId &&
    left.custodyAddress === right.custodyAddress
  );
}

function requireReviewIn(
  transaction: ControlPlaneTransaction,
  input: Parameters<MegapotClaimStore["requireReview"]>[0],
): Effect.Effect<void, MegapotClaimFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    const stateResult = yield* transaction.execute<Row>({
      label: "megapot-claim.review-state.read",
      text: `SELECT drawing.status AS drawing_status, drawing.version AS drawing_version,
                    drawing.claim_effect_id, ticket.status AS ticket_status,
                    ticket.pool_leg_id, ticket.drawing_id, ticket.custody_address
               FROM megapot_pool_drawings drawing
               JOIN megapot_ticket_inventory ticket
                 ON ticket.pool_leg_id=drawing.pool_leg_id
                AND ticket.drawing_id=drawing.drawing_id
              WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=$2
                AND ticket.attestation_id=$3 AND ticket.ticket_id=$4
              FOR UPDATE OF drawing, ticket`,
      values: [
        input.candidate.poolLegId,
        input.candidate.drawingId.toString(),
        input.candidate.attestationId,
        input.candidate.ticketId.toString(),
      ],
      readonly: false,
    });
    if (stateResult.rows.length !== 1) return yield* rejected("ticket-not-claimable");
    const state = stateResult.rows[0] as Row;
    if (
      text(state, "pool_leg_id") !== input.candidate.poolLegId ||
      bigint(state, "drawing_id") !== input.candidate.drawingId ||
      !sameAddress(text(state, "custody_address"), input.candidate.custodyAddress)
    ) {
      return yield* rejected("effect-conflict");
    }
    const drawingStatus = text(state, "drawing_status");
    const ticketStatus = text(state, "ticket_status");
    const drawingVersion = integer(state, "drawing_version");
    if (input.claimEffectId === null) {
      if (
        drawingStatus !== "winnings_detected" ||
        drawingVersion !== input.candidate.drawingVersion ||
        ticketStatus !== "custodied" ||
        nullableText(state, "claim_effect_id") !== null
      ) {
        return yield* rejected("effect-conflict");
      }
    } else {
      if (
        drawingStatus !== "claim_pending" ||
        ticketStatus !== "claim_pending" ||
        nullableText(state, "claim_effect_id") !== input.claimEffectId
      ) {
        return yield* rejected("effect-conflict");
      }
      const effectResult = yield* transaction.execute<Row>({
        label: "megapot-claim.review-effect.read",
        text: `SELECT effect.state, effect.version, claim.attestation_id,
                      claim.ticket_id, claim.pool_leg_id, claim.drawing_id
                 FROM reward_chain_effects effect
                 JOIN megapot_claim_effects claim ON claim.claim_effect_id=effect.effect_id
                WHERE effect.effect_id=$1 FOR UPDATE OF effect, claim`,
        values: [input.claimEffectId],
        readonly: false,
      });
      if (effectResult.rows.length !== 1) return yield* rejected("effect-conflict");
      const effectRow = effectResult.rows[0] as Row;
      if (
        text(effectRow, "state") !== "nonce_reserved" ||
        text(effectRow, "attestation_id") !== input.candidate.attestationId ||
        bigint(effectRow, "ticket_id") !== input.candidate.ticketId ||
        text(effectRow, "pool_leg_id") !== input.candidate.poolLegId ||
        bigint(effectRow, "drawing_id") !== input.candidate.drawingId
      ) {
        return yield* rejected("effect-conflict");
      }
      const effectVersion = integer(effectRow, "version") + 1;
      yield* transaction.execute({
        label: "megapot-claim.review-effect-transition.create",
        text: `INSERT INTO reward_chain_effect_transitions (
                 effect_id, target_version, event_type, event
               ) VALUES ($1,$2,'preflight_integrity_hold',jsonb_build_object(
                 'reason',$3::text,'review_id',$4::text,
                 'observation_block_number',$5::text,
                 'observation_block_hash',$6::text,'observed_owner_address',$7::text
               ))`,
        values: [
          input.claimEffectId,
          effectVersion,
          input.reason,
          input.reviewId,
          input.observationBlockNumber.toString(),
          input.observationBlockHash,
          input.observedOwnerAddress,
        ],
        readonly: false,
      });
      const effect = yield* transaction.execute({
        label: "megapot-claim.review-effect.fail",
        text: `UPDATE reward_chain_effects
                  SET state='terminal_failed', version=$2,
                      failure_class='claim_preflight_integrity', failure_reason=$3,
                      updated_at=clock_timestamp()
                WHERE effect_id=$1 AND state='nonce_reserved' AND version=$4`,
        values: [input.claimEffectId, effectVersion, input.reason, effectVersion - 1],
        readonly: false,
      });
      if (effect.rowCount !== 1) return yield* rejected("effect-conflict");
    }
    const ticket = yield* transaction.execute({
      label: "megapot-claim.review-ticket.record",
      text: `UPDATE megapot_ticket_inventory
                SET status='needs_review', terminal_at=$3, updated_at=clock_timestamp()
              WHERE attestation_id=$1 AND ticket_id=$2 AND status=$4`,
      values: [
        input.candidate.attestationId,
        input.candidate.ticketId.toString(),
        input.observedAt,
        ticketStatus,
      ],
      readonly: false,
    });
    if (ticket.rowCount !== 1) return yield* rejected("ticket-not-claimable");
    const nextDrawingVersion = drawingVersion + 1;
    yield* transaction.execute({
      label: "megapot-claim.review-drawing-transition.create",
      text: `INSERT INTO megapot_pool_drawing_transitions (
               pool_leg_id, drawing_id, target_version, event_type, event
             ) VALUES ($1,$2,$3,'operational_hold',jsonb_build_object(
               'reason',$4::text,'review_id',$5::text,'ticket_id',$6::text,
               'claim_effect_id',$7::text,'observation_block_number',$8::text,
               'observation_block_hash',$9::text,'observed_owner_address',$10::text
             ))`,
      values: [
        input.candidate.poolLegId,
        input.candidate.drawingId.toString(),
        nextDrawingVersion,
        input.reason,
        input.reviewId,
        input.candidate.ticketId.toString(),
        input.claimEffectId,
        input.observationBlockNumber.toString(),
        input.observationBlockHash,
        input.observedOwnerAddress,
      ],
      readonly: false,
    });
    const drawing = yield* transaction.execute({
      label: "megapot-claim.review-drawing.hold",
      text: `UPDATE megapot_pool_drawings
                SET status='operational_hold', version=$3, terminal_reason=$4,
                    terminal_at=$5, updated_at=clock_timestamp()
              WHERE pool_leg_id=$1 AND drawing_id=$2 AND status=$6 AND version=$7`,
      values: [
        input.candidate.poolLegId,
        input.candidate.drawingId.toString(),
        nextDrawingVersion,
        input.reason,
        input.observedAt,
        drawingStatus,
        drawingVersion,
      ],
      readonly: false,
    });
    if (drawing.rowCount !== 1) return yield* rejected("effect-conflict");
    yield* transaction.execute({
      label: "megapot-claim.review-evidence.create",
      text: `INSERT INTO megapot_ticket_review_evidence (
               review_id, attestation_id, ticket_id, pool_leg_id, drawing_id,
               source_kind, source_operation_id, claim_effect_id, reason,
               observation_block_number, observation_block_hash,
               observed_owner_address, observed_at
             ) VALUES ($1,$2,$3,$4,$5,'claim',$1,$6,$7,$8,$9,$10,$11)`,
      values: [
        input.reviewId,
        input.candidate.attestationId,
        input.candidate.ticketId.toString(),
        input.candidate.poolLegId,
        input.candidate.drawingId.toString(),
        input.claimEffectId,
        input.reason,
        input.observationBlockNumber.toString(),
        input.observationBlockHash,
        input.observedOwnerAddress,
        input.observedAt,
      ],
      readonly: false,
    });
  });
}

function reserveNonceIn(
  transaction: ControlPlaneTransaction,
  input: Parameters<MegapotClaimStore["reserveNonce"]>[0],
) {
  return Effect.gen(function* () {
    const candidate = yield* loadCandidateIn(transaction, {
      poolLegId: input.candidate.poolLegId,
      drawingId: input.candidate.drawingId,
      lock: true,
    });
    if (!sameCandidate(candidate, input.candidate)) return yield* rejected("effect-conflict");
    const nonceResult = yield* transaction.execute<Row>({
      label: "megapot-claim.nonce.read",
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
        label: "megapot-claim.nonce.create",
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
        return yield* rejected("nonce-observation-stale");
      }
      nonce = bigint(row, "next_nonce");
      if (input.observedPendingNonce > nonce) nonce = input.observedPendingNonce;
      yield* transaction.execute({
        label: "megapot-claim.nonce.reserve",
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
    yield* transaction.execute({
      label: "megapot-claim.effect.create",
      text: `INSERT INTO reward_chain_effects (
               effect_id, effect_kind, state, chain_id, signer_address,
               target_address, reserved_amount_atomic
             ) VALUES ($1,'winnings_claim','planned',$2,$3,$4,0)`,
      values: [
        input.effectId,
        candidate.chainId,
        candidate.custodyAddress,
        candidate.jackpotAddress,
      ],
      readonly: false,
    });
    yield* transaction.execute({
      label: "megapot-claim.nonce-transition.create",
      text: `INSERT INTO reward_chain_effect_transitions (
               effect_id, target_version, event_type, event
             ) VALUES ($1,2,'nonce_reserved',jsonb_build_object('nonce',$2::text))`,
      values: [input.effectId, nonce.toString()],
      readonly: false,
    });
    const effect = yield* transaction.execute({
      label: "megapot-claim.effect.nonce-reserve",
      text: `UPDATE reward_chain_effects
                SET state='nonce_reserved', version=2, nonce=$2,
                    updated_at=clock_timestamp()
              WHERE effect_id=$1 AND state='planned' AND version=1`,
      values: [input.effectId, nonce.toString()],
      readonly: false,
    });
    if (effect.rowCount !== 1) return yield* rejected("effect-conflict");
    const ticket = yield* transaction.execute({
      label: "megapot-claim.ticket.reserve",
      text: `UPDATE megapot_ticket_inventory
                SET status='claim_pending', updated_at=clock_timestamp()
              WHERE attestation_id=$1 AND ticket_id=$2 AND status='custodied'`,
      values: [candidate.attestationId, candidate.ticketId.toString()],
      readonly: false,
    });
    if (ticket.rowCount !== 1) return yield* rejected("ticket-not-claimable");
    yield* transaction.execute({
      label: "megapot-claim.detail.create",
      text: `INSERT INTO megapot_claim_effects (
               claim_effect_id, attestation_id, ticket_id, pool_leg_id,
               drawing_id, sweep_id, expected_gross_winnings_atomic,
               expected_net_winnings_atomic, expected_referral_accrual_atomic,
               custody_balance_before_atomic, referral_balance_before_atomic,
               preflight_block_number, preflight_block_hash
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      values: [
        input.effectId,
        candidate.attestationId,
        candidate.ticketId.toString(),
        candidate.poolLegId,
        candidate.drawingId.toString(),
        candidate.sweepId,
        candidate.expectedGrossWinningsAtomic.toString(),
        candidate.expectedNetWinningsAtomic.toString(),
        candidate.expectedReferralAccrualAtomic.toString(),
        input.custodyBalanceBeforeAtomic.toString(),
        input.referralBalanceBeforeAtomic.toString(),
        input.observedBlockNumber.toString(),
        input.observedBlockHash,
      ],
      readonly: false,
    });
    const nextDrawingVersion = candidate.drawingVersion + 1;
    yield* transaction.execute({
      label: "megapot-claim.drawing-transition.create",
      text: `INSERT INTO megapot_pool_drawing_transitions (
               pool_leg_id, drawing_id, target_version, event_type, event
             ) VALUES ($1,$2,$3,'claim_pending',jsonb_build_object(
               'claim_effect_id',$4::text,'ticket_id',$5::text
             ))`,
      values: [
        candidate.poolLegId,
        candidate.drawingId.toString(),
        nextDrawingVersion,
        input.effectId,
        candidate.ticketId.toString(),
      ],
      readonly: false,
    });
    const drawing = yield* transaction.execute({
      label: "megapot-claim.drawing.reserve",
      text: `UPDATE megapot_pool_drawings
                SET status='claim_pending', version=$3, claim_effect_id=$4,
                    updated_at=clock_timestamp()
              WHERE pool_leg_id=$1 AND drawing_id=$2
                AND status='winnings_detected' AND version=$5`,
      values: [
        candidate.poolLegId,
        candidate.drawingId.toString(),
        nextDrawingVersion,
        input.effectId,
        candidate.drawingVersion,
      ],
      readonly: false,
    });
    if (drawing.rowCount !== 1) return yield* rejected("effect-conflict");
    return {
      ...candidate,
      effectId: input.effectId,
      nonce,
      effectVersion: 2,
      custodyBalanceBeforeAtomic: input.custodyBalanceBeforeAtomic,
      referralBalanceBeforeAtomic: input.referralBalanceBeforeAtomic,
      preflightBlockNumber: input.observedBlockNumber,
      preflightBlockHash: input.observedBlockHash,
    } satisfies MegapotReservedClaim;
  });
}

export function makeControlPlaneMegapotClaimRepository() {
  return {
    findProgress: (effectId: string) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "megapot-claim.progress.read",
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
    loadCandidate: (input: Parameters<MegapotClaimStore["loadCandidate"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* loadCandidateIn(db, { ...input, lock: false });
      }).pipe(mapped),
    requireReview: (input: Parameters<MegapotClaimStore["requireReview"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) => requireReviewIn(transaction, input));
      }).pipe(mapped),
    reserveNonce: (input: Parameters<MegapotClaimStore["reserveNonce"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) => reserveNonceIn(transaction, input));
      }).pipe(mapped),
    prepare: (input: Parameters<MegapotClaimStore["prepare"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute({
              label: "megapot-claim.prepared-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,3,'prepared',jsonb_build_object(
                       'calldata_hash',$2::text,'signed_transaction_hash',$3::text
                     ))`,
              values: [input.reservation.effectId, input.calldataHash, input.signedTransactionHash],
              readonly: false,
            });
            const prepared = yield* transaction.execute({
              label: "megapot-claim.effect.prepare",
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
    recordSubmission: (input: Parameters<MegapotClaimStore["recordSubmission"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const rowResult = yield* transaction.execute<Row>({
              label: "megapot-claim.submission.read",
              text: `SELECT state, version, signed_transaction_hash
                       FROM reward_chain_effects WHERE effect_id=$1 FOR UPDATE`,
              values: [input.effectId],
              readonly: false,
            });
            if (rowResult.rows.length !== 1) return yield* rejected("not-found");
            const row = rowResult.rows[0] as Row;
            if (
              text(row, "state") !== "prepared" ||
              text(row, "signed_transaction_hash") !== input.transactionHash
            ) {
              return yield* rejected("effect-conflict");
            }
            const version = integer(row, "version") + 1;
            yield* transaction.execute({
              label: "megapot-claim.submission-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,$2,'broadcast_submitted',jsonb_build_object(
                       'transaction_hash',$3::text
                     ))`,
              values: [input.effectId, version, input.transactionHash],
              readonly: false,
            });
            const submitted = yield* transaction.execute({
              label: "megapot-claim.submission.record",
              text: `UPDATE reward_chain_effects
                        SET state='broadcast_pending', version=$2,
                            transaction_hash=$3, broadcast_at=$4,
                            updated_at=clock_timestamp()
                      WHERE effect_id=$1 AND state='prepared'`,
              values: [input.effectId, version, input.transactionHash, input.submittedAt],
              readonly: false,
            });
            if (submitted.rowCount !== 1) return yield* rejected("effect-conflict");
            if (input.outcome === "uncertain") {
              const reason = input.failureReason?.trim();
              if (reason === undefined || reason.length === 0) {
                return yield* rejected("effect-conflict");
              }
              yield* transaction.execute({
                label: "megapot-claim.uncertain-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,$2,'submission_uncertain',jsonb_build_object(
                         'failure_reason',$3::text
                       ))`,
                values: [input.effectId, version + 1, reason],
                readonly: false,
              });
              yield* transaction.execute({
                label: "megapot-claim.uncertain.record",
                text: `UPDATE reward_chain_effects
                          SET state='reconciliation_required', version=version+1,
                              failure_class='ambiguous_submission', failure_reason=$2,
                              updated_at=clock_timestamp()
                        WHERE effect_id=$1 AND state='broadcast_pending'`,
                values: [input.effectId, reason],
                readonly: false,
              });
            }
          }),
        );
      }).pipe(mapped),
    requireReconciliation: (input: Parameters<MegapotClaimStore["requireReconciliation"]>[0]) =>
      Effect.gen(function* () {
        const reason = input.reason.trim();
        if (reason.length === 0) return yield* rejected("effect-conflict");
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "megapot-claim.reconciliation.read",
              text: `SELECT state, version, transaction_hash
                       FROM reward_chain_effects WHERE effect_id=$1 FOR UPDATE`,
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
            yield* transaction.execute({
              label: "megapot-claim.reconciliation-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,$2,'receipt_requires_reconciliation',jsonb_build_object(
                       'failure_reason',$3::text
                     ))`,
              values: [input.effectId, version, reason],
              readonly: false,
            });
            const updated = yield* transaction.execute({
              label: "megapot-claim.reconciliation.record",
              text: `UPDATE reward_chain_effects
                        SET state='reconciliation_required', version=$2,
                            failure_class='receipt_evidence_invalid', failure_reason=$3,
                            updated_at=clock_timestamp()
                      WHERE effect_id=$1 AND state IN ('broadcast_pending','confirming')`,
              values: [input.effectId, version, reason],
              readonly: false,
            });
            if (updated.rowCount !== 1) return yield* rejected("effect-conflict");
          }),
        );
      }).pipe(mapped),
    confirm: (input: Parameters<MegapotClaimStore["confirm"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "megapot-claim.confirm.read",
              text: `SELECT effect.state, effect.version, effect.transaction_hash,
                            claim.attestation_id, claim.ticket_id, claim.pool_leg_id,
                            claim.drawing_id, claim.expected_gross_winnings_atomic,
                            claim.expected_net_winnings_atomic,
                            claim.expected_referral_accrual_atomic,
                            claim.custody_balance_before_atomic,
                            claim.referral_balance_before_atomic,
                            COALESCE(leg.referral_allocation_version, 'platform_referral_v1')
                              AS referral_allocation_version
                       FROM reward_chain_effects effect
                       JOIN megapot_claim_effects claim
                         ON claim.claim_effect_id=effect.effect_id
                       JOIN song_reward_offer_legs leg ON leg.leg_id=claim.pool_leg_id
                      WHERE effect.effect_id=$1 FOR UPDATE OF effect, leg`,
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
              bigint(row, "expected_gross_winnings_atomic") !== input.grossWinningsAtomic ||
              bigint(row, "expected_net_winnings_atomic") !== input.netWinningsAtomic ||
              bigint(row, "expected_referral_accrual_atomic") !== input.referralAccrualAtomic ||
              bigint(row, "custody_balance_before_atomic") + input.netWinningsAtomic !==
                input.custodyBalanceAfterAtomic ||
              bigint(row, "referral_balance_before_atomic") + input.referralAccrualAtomic !==
                input.referralBalanceAfterAtomic
            ) {
              return yield* rejected("effect-conflict");
            }
            const version = integer(row, "version") + 1;
            yield* transaction.execute({
              label: "megapot-claim.confirm-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,$2,'receipt_confirmed',jsonb_build_object(
                       'transaction_hash',$3::text,'received_atomic',$4::text
                     ))`,
              values: [
                input.effectId,
                version,
                input.transactionHash,
                input.netWinningsAtomic.toString(),
              ],
              readonly: false,
            });
            const confirmed = yield* transaction.execute({
              label: "megapot-claim.effect.confirm",
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
                input.netWinningsAtomic.toString(),
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
              label: "megapot-claim.detail.observe",
              text: `UPDATE megapot_claim_effects
                        SET received_atomic=$2, referral_accrual_atomic=$3,
                            claim_log_index=$4, burn_log_index=$5,
                            referral_log_index=$6, transfer_log_index=$7
                      WHERE claim_effect_id=$1 AND received_atomic IS NULL`,
              values: [
                input.effectId,
                input.netWinningsAtomic.toString(),
                input.referralAccrualAtomic.toString(),
                input.claimLogIndex,
                input.burnLogIndex,
                input.referralLogIndex,
                input.transferLogIndex,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "megapot-claim.receipt-evidence.create",
              text: `INSERT INTO megapot_claim_receipt_evidence (
                       claim_effect_id, attestation_id, ticket_id, transaction_hash,
                       claim_log_index, burn_log_index, referral_log_index,
                       transfer_log_index, gross_winnings_atomic,
                       referral_accrual_atomic, net_winnings_atomic,
                       custody_balance_before_atomic, custody_balance_after_atomic,
                       referral_balance_before_atomic, referral_balance_after_atomic,
                       block_number, block_hash, receipt_hash, confirmations, confirmed_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
              values: [
                input.effectId,
                text(row, "attestation_id"),
                bigint(row, "ticket_id").toString(),
                input.transactionHash,
                input.claimLogIndex,
                input.burnLogIndex,
                input.referralLogIndex,
                input.transferLogIndex,
                input.grossWinningsAtomic.toString(),
                input.referralAccrualAtomic.toString(),
                input.netWinningsAtomic.toString(),
                bigint(row, "custody_balance_before_atomic").toString(),
                input.custodyBalanceAfterAtomic.toString(),
                bigint(row, "referral_balance_before_atomic").toString(),
                input.referralBalanceAfterAtomic.toString(),
                input.blockNumber.toString(),
                input.blockHash,
                input.receiptHash,
                input.confirmations,
                input.confirmedAt,
              ],
              readonly: false,
            });
            if (input.referralAccrualAtomic > 0n) {
              yield* transaction.execute({
                label: "megapot-claim.referral-revenue.create",
                text: `INSERT INTO platform_referral_revenue_ledger (
                         revenue_entry_id, attestation_id, pool_leg_id, drawing_id,
                         ticket_id, revenue_kind, amount_atomic,
                         allocation_policy_version, observation_hash
                       ) VALUES ($1,$2,$3,$4,$5,'win_share',$6,$7,$8)`,
                values: [
                  `claim-referral:${input.effectId}`,
                  text(row, "attestation_id"),
                  text(row, "pool_leg_id"),
                  bigint(row, "drawing_id").toString(),
                  bigint(row, "ticket_id").toString(),
                  input.referralAccrualAtomic.toString(),
                  text(row, "referral_allocation_version"),
                  input.receiptHash,
                ],
                readonly: false,
              });
            }
            const ticket = yield* transaction.execute({
              label: "megapot-claim.ticket.confirm",
              text: `UPDATE megapot_ticket_inventory
                        SET status='claimed', claimed_transaction_hash=$3,
                            terminal_at=$4, updated_at=clock_timestamp()
                      WHERE attestation_id=$1 AND ticket_id=$2 AND status='claim_pending'`,
              values: [
                text(row, "attestation_id"),
                bigint(row, "ticket_id").toString(),
                input.transactionHash,
                input.confirmedAt,
              ],
              readonly: false,
            });
            if (ticket.rowCount !== 1) return yield* rejected("ticket-not-claimable");
            const drawingResult = yield* transaction.execute<Row>({
              label: "megapot-claim.drawing-confirm.read",
              text: `SELECT version FROM megapot_pool_drawings
                      WHERE pool_leg_id=$1 AND drawing_id=$2
                        AND status='claim_pending' AND claim_effect_id=$3 FOR UPDATE`,
              values: [
                text(row, "pool_leg_id"),
                bigint(row, "drawing_id").toString(),
                input.effectId,
              ],
              readonly: false,
            });
            if (drawingResult.rows.length !== 1) return yield* rejected("effect-conflict");
            const drawingVersion = integer(drawingResult.rows[0] as Row, "version") + 1;
            yield* transaction.execute({
              label: "megapot-claim.drawing-confirm-transition.create",
              text: `INSERT INTO megapot_pool_drawing_transitions (
                       pool_leg_id, drawing_id, target_version, event_type, event
                     ) VALUES ($1,$2,$3,'claimed',jsonb_build_object(
                       'claim_effect_id',$4::text,'received_atomic',$5::text
                     ))`,
              values: [
                text(row, "pool_leg_id"),
                bigint(row, "drawing_id").toString(),
                drawingVersion,
                input.effectId,
                input.netWinningsAtomic.toString(),
              ],
              readonly: false,
            });
            const drawing = yield* transaction.execute({
              label: "megapot-claim.drawing.confirm",
              text: `UPDATE megapot_pool_drawings
                        SET status='claimed', version=$3, updated_at=clock_timestamp()
                      WHERE pool_leg_id=$1 AND drawing_id=$2 AND status='claim_pending'`,
              values: [
                text(row, "pool_leg_id"),
                bigint(row, "drawing_id").toString(),
                drawingVersion,
              ],
              readonly: false,
            });
            if (drawing.rowCount !== 1) return yield* rejected("effect-conflict");
          }),
        );
      }).pipe(mapped),
  };
}

export const makeControlPlaneMegapotClaimStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): MegapotClaimStore => {
  const repository = makeControlPlaneMegapotClaimRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    findProgress: (effectId) => provide(repository.findProgress(effectId)),
    loadCandidate: (input) => provide(repository.loadCandidate(input)),
    requireReview: (input) => provide(repository.requireReview(input)),
    reserveNonce: (input) => provide(repository.reserveNonce(input)),
    prepare: (input) => provide(repository.prepare(input)),
    recordSubmission: (input) => provide(repository.recordSubmission(input)),
    requireReconciliation: (input) => provide(repository.requireReconciliation(input)),
    confirm: (input) => provide(repository.confirm(input)),
  };
};
