import {
  ControlPlaneDb,
  type ControlPlaneError,
  type MegapotClaimCandidate,
} from "@pirate/application";
import { Data, Effect } from "effect";
import type { Hex } from "viem";
import { mapRewardReservationFailure } from "./control-plane-error-classification.ts";
import { confirmClaimIn, loadClaimCandidateIn } from "./megapot-claim-repository.ts";

type Row = Readonly<Record<string, unknown>>;

export class RewardSafeClaimStoreFailed extends Data.TaggedError("RewardSafeClaimStoreFailed")<{
  readonly reason:
    | "conflict"
    | "constraint"
    | "effect-conflict"
    | "invalid-row"
    | "not-found"
    | "not-safe-custody"
    | "outcome-unknown"
    | "ticket-not-claimable"
    | "unavailable";
}> {}

const failed = (reason: RewardSafeClaimStoreFailed["reason"]) =>
  new RewardSafeClaimStoreFailed({ reason });

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      mapRewardReservationFailure<E, RewardSafeClaimStoreFailed>(error, failed),
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
    (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") ||
    !/^[0-9]+$/u.test(String(value))
  ) {
    throw new Error(`invalid ${field}`);
  }
  return BigInt(value);
}

function instant(row: Row, field: string): string {
  const value = row[field];
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ${field}`);
  return date.toISOString();
}

function sameCandidate(left: MegapotClaimCandidate, right: MegapotClaimCandidate): boolean {
  return (
    left.poolLegId === right.poolLegId &&
    left.drawingId === right.drawingId &&
    left.drawingVersion === right.drawingVersion &&
    left.sweepId === right.sweepId &&
    left.ticketId === right.ticketId &&
    left.expectedNetWinningsAtomic === right.expectedNetWinningsAtomic &&
    left.attestationId === right.attestationId
  );
}

/**
 * Persistence for owner-executed Safe winnings claims. A claim call is recorded alone
 * when it is prepared; the ticket, claim detail and drawing move only when the
 * owner's bound execution settles, because the custody balances a claim detail
 * records are read around that execution, not at preparation.
 */
export function makeControlPlaneRewardSafeClaimStore() {
  return {
    loadCandidate: (input: { readonly poolLegId: string; readonly drawingId: bigint }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* loadClaimCandidateIn(db, {
            ...input,
            lock: false,
            purchaseOrder: "ticket_first_v1",
          });
        }),
      ),

    /** Where one claim attempt stands; null when that attempt was never prepared. */
    loadAttempt: (effectId: string) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-safe-claim.attempt.read",
            text: `SELECT state, calldata_hash, safe_prepared_block_number
                     FROM reward_chain_effects
                    WHERE effect_id=$1 AND effect_kind='winnings_claim'
                      AND execution_mode='safe_owner_v1'`,
            values: [effectId],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          const row = result.rows[0] as Row;
          return yield* Effect.try({
            try: () => ({
              state: text(row, "state"),
              calldataHash: text(row, "calldata_hash"),
              preparedBlockNumber: bigint(row, "safe_prepared_block_number"),
            }),
            catch: () => failed("invalid-row"),
          });
        }),
      ),

    /** Record one prepared claim call for a winning ticket-first drawing. */
    prepare: (input: {
      readonly effectId: string;
      readonly candidate: MegapotClaimCandidate;
      readonly calldata: Hex;
      readonly calldataHash: string;
      readonly headBlockNumber: bigint;
    }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const { candidate } = input;
              const current = yield* loadClaimCandidateIn(transaction, {
                poolLegId: candidate.poolLegId,
                drawingId: candidate.drawingId,
                lock: true,
                purchaseOrder: "ticket_first_v1",
              });
              if (!sameCandidate(current, candidate)) return yield* failed("effect-conflict");
              const authority = yield* transaction.execute<Row>({
                label: "reward-safe-claim.authority.read",
                text: `SELECT nonce_authority FROM reward_signer_nonces
                        WHERE chain_id=$1 AND signer_address=$2`,
                values: [candidate.chainId, candidate.custodyAddress],
                readonly: false,
              });
              if (
                authority.rows.length !== 1 ||
                (authority.rows[0] as Row).nonce_authority !== "safe_owner_v1"
              ) {
                return yield* failed("not-safe-custody");
              }
              yield* transaction.execute({
                label: "reward-safe-claim.cursor.create",
                text: `INSERT INTO reward_safe_execution_cursors (
                         chain_id, safe_address, next_block_number
                       ) VALUES ($1,$2,$3)
                       ON CONFLICT (chain_id, safe_address) DO NOTHING`,
                values: [
                  candidate.chainId,
                  candidate.custodyAddress,
                  input.headBlockNumber.toString(),
                ],
                readonly: false,
              });
              const cursor = yield* transaction.execute<Row>({
                label: "reward-safe-claim.cursor.lock",
                text: `SELECT next_block_number FROM reward_safe_execution_cursors
                        WHERE chain_id=$1 AND safe_address=$2 FOR UPDATE`,
                values: [candidate.chainId, candidate.custodyAddress],
                readonly: false,
              });
              if (cursor.rows.length !== 1) return yield* failed("invalid-row");
              const cursorBlock = bigint(cursor.rows[0] as Row, "next_block_number");
              const preparedBlock =
                cursorBlock > input.headBlockNumber ? cursorBlock : input.headBlockNumber;
              const created = yield* transaction.execute({
                label: "reward-safe-claim.effect.create",
                text: `INSERT INTO reward_chain_effects (
                         effect_id, effect_kind, state, chain_id, signer_address,
                         target_address, reserved_amount_atomic, execution_mode
                       ) VALUES ($1,'winnings_claim','planned',$2,$3,$4,0,'safe_owner_v1')`,
                values: [
                  input.effectId,
                  candidate.chainId,
                  candidate.custodyAddress,
                  candidate.jackpotAddress,
                ],
                readonly: false,
              });
              if (created.rowCount !== 1) return yield* failed("effect-conflict");
              yield* transaction.execute({
                label: "reward-safe-claim.prepared-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,2,'safe_call_prepared',jsonb_build_object(
                         'calldata_hash',$2::text,'pool_leg_id',$3::text,
                         'drawing_id',$4::text,'ticket_id',$5::text,
                         'safe_prepared_block_number',$6::text
                       ))`,
                values: [
                  input.effectId,
                  input.calldataHash,
                  candidate.poolLegId,
                  candidate.drawingId.toString(),
                  candidate.ticketId.toString(),
                  preparedBlock.toString(),
                ],
                readonly: false,
              });
              const prepared = yield* transaction.execute({
                label: "reward-safe-claim.effect.prepare",
                text: `UPDATE reward_chain_effects
                          SET state='prepared', version=2, calldata=$2, calldata_hash=$3,
                              prepared_at=clock_timestamp(), safe_prepared_block_number=$4,
                              updated_at=clock_timestamp()
                        WHERE effect_id=$1 AND state='planned' AND version=1`,
                values: [
                  input.effectId,
                  input.calldata,
                  input.calldataHash,
                  preparedBlock.toString(),
                ],
                readonly: false,
              });
              if (prepared.rowCount !== 1) return yield* failed("effect-conflict");
              return preparedBlock;
            }),
          );
        }),
      ),

    /** A claim call that reconciliation has bound to an owner execution. */
    loadSettlement: (effectId: string) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-safe-claim.settlement.read",
            text: `SELECT transaction_hash, safe_nonce, calldata, safe_execution_outcome,
                          broadcast_at
                     FROM reward_chain_effects
                    WHERE effect_id=$1 AND effect_kind='winnings_claim'
                      AND execution_mode='safe_owner_v1' AND state='confirming'`,
            values: [effectId],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          const row = result.rows[0] as Row;
          return yield* Effect.try({
            try: () => ({
              transactionHash: text(row, "transaction_hash"),
              safeNonce: bigint(row, "safe_nonce"),
              calldata: text(row, "calldata") as Hex,
              outcome: text(row, "safe_execution_outcome") as "success" | "failure",
              observedAt: instant(row, "broadcast_at"),
            }),
            catch: () => failed("invalid-row"),
          });
        }),
      ),

    /**
     * Settle a validated successful execution in one transaction: reserve the ticket,
     * record the claim detail with the custody and referral balances read at the
     * execution's parent block, move the drawing to claim_pending, and confirm the
     * claim exactly as an EOA claim is confirmed.
     */
    settle: (input: {
      readonly effectId: string;
      readonly candidate: MegapotClaimCandidate;
      readonly custodyBalanceBeforeAtomic: bigint;
      readonly referralBalanceBeforeAtomic: bigint;
      readonly preflightBlockNumber: bigint;
      readonly preflightBlockHash: string;
      readonly confirmation: Parameters<typeof confirmClaimIn>[1];
    }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const { candidate } = input;
              if (input.confirmation.effectId !== input.effectId) {
                return yield* failed("effect-conflict");
              }
              const current = yield* loadClaimCandidateIn(transaction, {
                poolLegId: candidate.poolLegId,
                drawingId: candidate.drawingId,
                lock: true,
                purchaseOrder: "ticket_first_v1",
              });
              if (!sameCandidate(current, candidate)) return yield* failed("effect-conflict");
              const effect = yield* transaction.execute<Row>({
                label: "reward-safe-claim.effect.read",
                text: `SELECT safe_execution_outcome FROM reward_chain_effects
                        WHERE effect_id=$1 AND effect_kind='winnings_claim'
                          AND execution_mode='safe_owner_v1' AND state='confirming'
                        FOR UPDATE`,
                values: [input.effectId],
                readonly: false,
              });
              if (
                effect.rows.length !== 1 ||
                (effect.rows[0] as Row).safe_execution_outcome !== "success"
              ) {
                return yield* failed("effect-conflict");
              }
              const ticket = yield* transaction.execute({
                label: "reward-safe-claim.ticket.reserve",
                text: `UPDATE megapot_ticket_inventory
                          SET status='claim_pending', updated_at=clock_timestamp()
                        WHERE attestation_id=$1 AND ticket_id=$2 AND status='custodied'`,
                values: [candidate.attestationId, candidate.ticketId.toString()],
                readonly: false,
              });
              if (ticket.rowCount !== 1) return yield* failed("ticket-not-claimable");
              yield* transaction.execute({
                label: "reward-safe-claim.detail.create",
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
                  input.preflightBlockNumber.toString(),
                  input.preflightBlockHash,
                ],
                readonly: false,
              });
              const nextVersion = candidate.drawingVersion + 1;
              yield* transaction.execute({
                label: "reward-safe-claim.drawing-transition.create",
                text: `INSERT INTO megapot_pool_drawing_transitions (
                         pool_leg_id, drawing_id, target_version, event_type, event
                       ) VALUES ($1,$2,$3,'claim_pending',jsonb_build_object(
                         'claim_effect_id',$4::text,'ticket_id',$5::text
                       ))`,
                values: [
                  candidate.poolLegId,
                  candidate.drawingId.toString(),
                  nextVersion,
                  input.effectId,
                  candidate.ticketId.toString(),
                ],
                readonly: false,
              });
              const drawing = yield* transaction.execute({
                label: "reward-safe-claim.drawing.reserve",
                text: `UPDATE megapot_pool_drawings
                          SET status='claim_pending', version=$3, claim_effect_id=$4,
                              updated_at=clock_timestamp()
                        WHERE pool_leg_id=$1 AND drawing_id=$2
                          AND status='winnings_detected' AND version=$5`,
                values: [
                  candidate.poolLegId,
                  candidate.drawingId.toString(),
                  nextVersion,
                  input.effectId,
                  candidate.drawingVersion,
                ],
                readonly: false,
              });
              if (drawing.rowCount !== 1) return yield* failed("effect-conflict");
              yield* confirmClaimIn(transaction, input.confirmation);
            }),
          );
        }),
      ),

    /**
     * An ExecutionFailure spent the Safe nonce and claimed nothing. The attempt is
     * reverted and the drawing stays winnings_detected, so a later attempt can be
     * prepared; Megapot burns a claimed ticket, so no attempt can pay twice.
     */
    releaseFailedExecution: (input: {
      readonly effectId: string;
      readonly transactionHash: string;
      readonly blockNumber: bigint;
      readonly blockHash: string;
      readonly receiptHash: string;
      readonly confirmations: number;
      readonly confirmedAt: string;
    }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const result = yield* transaction.execute<Row>({
                label: "reward-safe-claim.failure.read",
                text: `SELECT version, transaction_hash, safe_execution_outcome
                         FROM reward_chain_effects
                        WHERE effect_id=$1 AND effect_kind='winnings_claim'
                          AND execution_mode='safe_owner_v1' AND state='confirming'
                        FOR UPDATE`,
                values: [input.effectId],
                readonly: false,
              });
              if (result.rows.length !== 1) return yield* failed("effect-conflict");
              const row = result.rows[0] as Row;
              if (
                text(row, "transaction_hash") !== input.transactionHash ||
                row.safe_execution_outcome !== "failure"
              ) {
                return yield* failed("effect-conflict");
              }
              const version = Number(bigint(row, "version")) + 1;
              yield* transaction.execute({
                label: "reward-safe-claim.failure-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,$2,'safe_execution_failed',jsonb_build_object(
                         'transaction_hash',$3::text
                       ))`,
                values: [input.effectId, version, input.transactionHash],
                readonly: false,
              });
              const reverted = yield* transaction.execute({
                label: "reward-safe-claim.effect.revert",
                text: `UPDATE reward_chain_effects
                          SET state='reverted', version=$2, receipt_status='success',
                              receipt_block_number=$3, receipt_block_hash=$4,
                              receipt_hash=$5, confirmations=$6, confirmed_at=$7,
                              updated_at=clock_timestamp()
                        WHERE effect_id=$1`,
                values: [
                  input.effectId,
                  version,
                  input.blockNumber.toString(),
                  input.blockHash,
                  input.receiptHash,
                  input.confirmations,
                  input.confirmedAt,
                ],
                readonly: false,
              });
              if (reverted.rowCount !== 1) return yield* failed("effect-conflict");
            }),
          );
        }),
      ),

    /** Hold a winning drawing whose claim evidence needs the owner's review. */
    holdDrawing: (input: {
      readonly poolLegId: string;
      readonly drawingId: bigint;
      readonly reason: string;
    }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const result = yield* transaction.execute<Row>({
                label: "reward-safe-claim.hold.read",
                text: `SELECT version FROM megapot_pool_drawings
                        WHERE pool_leg_id=$1 AND drawing_id=$2
                          AND purchase_order='ticket_first_v1'
                          AND status='winnings_detected'
                        FOR UPDATE`,
                values: [input.poolLegId, input.drawingId.toString()],
                readonly: false,
              });
              if (result.rows.length !== 1) return;
              const version = Number(bigint(result.rows[0] as Row, "version")) + 1;
              yield* transaction.execute({
                label: "reward-safe-claim.hold-transition.create",
                text: `INSERT INTO megapot_pool_drawing_transitions (
                         pool_leg_id, drawing_id, target_version, event_type, event
                       ) VALUES ($1,$2,$3,'operational_hold',jsonb_build_object(
                         'reason',$4::text
                       ))`,
                values: [input.poolLegId, input.drawingId.toString(), version, input.reason],
                readonly: false,
              });
              const held = yield* transaction.execute({
                label: "reward-safe-claim.drawing.hold",
                text: `UPDATE megapot_pool_drawings
                          SET status='operational_hold', version=$3, terminal_reason=$4,
                              terminal_at=clock_timestamp(), updated_at=clock_timestamp()
                        WHERE pool_leg_id=$1 AND drawing_id=$2 AND version=$3-1`,
                values: [input.poolLegId, input.drawingId.toString(), version, input.reason],
                readonly: false,
              });
              if (held.rowCount !== 1) return yield* failed("effect-conflict");
            }),
          );
        }),
      ),
  };
}
