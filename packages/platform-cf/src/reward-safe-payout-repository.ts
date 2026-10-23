import {
  ControlPlaneDb,
  type ControlPlaneError,
  type RewardPayoutCandidate,
  RewardPayoutRejected,
  RewardPayoutStorageFailed,
} from "@pirate/application";
import { Effect } from "effect";
import type { Hex } from "viem";
import { mapRewardReservationFailure } from "./control-plane-error-classification.ts";
import { loadCandidateIn } from "./reward-payout-repository.ts";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: RewardPayoutStorageFailed["reason"]) =>
  new RewardPayoutStorageFailed({ reason });
const rejected = (reason: RewardPayoutRejected["reason"]) => new RewardPayoutRejected({ reason });

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      mapRewardReservationFailure<E, RewardPayoutStorageFailed>(error, storage),
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

function sameCandidate(left: RewardPayoutCandidate, right: RewardPayoutCandidate): boolean {
  return (
    left.creditId === right.creditId &&
    left.accountId === right.accountId &&
    left.payoutPersonaId === right.payoutPersonaId &&
    left.amountAtomic === right.amountAtomic &&
    left.walletAssignmentId === right.walletAssignmentId &&
    left.destinationAddress === right.destinationAddress &&
    left.solvencyObservationId === right.solvencyObservationId &&
    left.custodyBalanceBeforeAtomic === right.custodyBalanceBeforeAtomic &&
    left.attestationId === right.attestationId &&
    left.chainId === right.chainId &&
    left.tokenAddress === right.tokenAddress &&
    left.custodyAddress === right.custodyAddress
  );
}

/**
 * Owner-executed Safe payouts. A prepared payout is a USDC transfer the owner executes
 * in Safe{Wallet}; it holds the credit as payout_pending from preparation because the
 * call is then outside Pirate's control. Confirmation reuses the ordinary payout
 * repository once reconciliation has recorded the Safe execution.
 */
export function makeControlPlaneRewardSafePayoutStore() {
  return {
    /** What settlement needs for one Safe payout that reconciliation has bound to an execution. */
    loadSettlement: (effectId: string) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-safe-payout.settlement.read",
            text: `SELECT effect.state, effect.transaction_hash, effect.safe_nonce,
                          effect.broadcast_at,
                          effect.calldata, effect.target_address AS token_address,
                          effect.safe_execution_outcome,
                          payout.destination_address, payout.amount_atomic,
                          attestation.attestation_id, attestation.environment,
                          attestation.chain_id, attestation.jackpot_address,
                          attestation.ticket_nft_address, attestation.usdc_address,
                          attestation.custody_address, attestation.referrer_address,
                          attestation.jackpot_code_hash, attestation.ticket_nft_code_hash,
                          attestation.usdc_code_hash
                     FROM reward_chain_effects effect
                     JOIN reward_payout_effects payout
                       ON payout.payout_effect_id=effect.effect_id
                     JOIN megapot_deployment_attestations attestation
                       ON attestation.attestation_id=payout.attestation_id
                    WHERE effect.effect_id=$1 AND effect.execution_mode='safe_owner_v1'
                      AND effect.state='confirming'`,
            values: [effectId],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          const row = result.rows[0] as Row;
          return yield* Effect.try({
            try: () => {
              const environment = text(row, "environment");
              if (
                environment !== "test" &&
                environment !== "staging" &&
                environment !== "production"
              ) {
                throw new Error("invalid environment");
              }
              return {
                effectId,
                transactionHash: text(row, "transaction_hash"),
                observedAt: new Date(row.broadcast_at as string | Date).toISOString(),
                safeNonce: bigint(row, "safe_nonce"),
                calldata: text(row, "calldata") as Hex,
                tokenAddress: text(row, "token_address"),
                outcome: text(row, "safe_execution_outcome") as "success" | "failure",
                destinationAddress: text(row, "destination_address"),
                amountAtomic: bigint(row, "amount_atomic"),
                deployment: {
                  attestationId: text(row, "attestation_id"),
                  environment,
                  chainId: Number(bigint(row, "chain_id")),
                  jackpotAddress: text(row, "jackpot_address"),
                  ticketNftAddress: text(row, "ticket_nft_address"),
                  usdcAddress: text(row, "usdc_address"),
                  custodyAddress: text(row, "custody_address"),
                  referrerAddress: text(row, "referrer_address"),
                  jackpotCodeHash: text(row, "jackpot_code_hash"),
                  ticketNftCodeHash: text(row, "ticket_nft_code_hash"),
                  usdcCodeHash: text(row, "usdc_code_hash"),
                },
              } as const;
            },
            catch: () => storage("invalid-row"),
          });
        }),
      ),

    prepare: (input: {
      readonly effectId: string;
      readonly candidate: RewardPayoutCandidate;
      readonly calldata: Hex;
      readonly calldataHash: string;
      readonly headBlockNumber: bigint;
    }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const candidate = yield* loadCandidateIn(transaction, {
                creditId: input.candidate.creditId,
                lock: true,
              });
              if (!sameCandidate(candidate, input.candidate)) {
                return yield* rejected("effect-conflict");
              }
              const authority = yield* transaction.execute<Row>({
                label: "reward-safe-payout.authority.read",
                text: `SELECT nonce_authority FROM reward_signer_nonces
                        WHERE chain_id=$1 AND signer_address=$2`,
                values: [candidate.chainId, candidate.custodyAddress],
                readonly: false,
              });
              if (
                authority.rows.length !== 1 ||
                (authority.rows[0] as Row).nonce_authority !== "safe_owner_v1"
              ) {
                return yield* rejected("effect-conflict");
              }
              yield* transaction.execute({
                label: "reward-safe-payout.cursor.create",
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
              // Serializes with a running scan, which locks the same row. A call can never
              // fall behind the cursor, so a finished scan cannot have skipped it.
              const cursor = yield* transaction.execute<Row>({
                label: "reward-safe-payout.cursor.lock",
                text: `SELECT next_block_number FROM reward_safe_execution_cursors
                        WHERE chain_id=$1 AND safe_address=$2 FOR UPDATE`,
                values: [candidate.chainId, candidate.custodyAddress],
                readonly: false,
              });
              if (cursor.rows.length !== 1) return yield* storage("invalid-row");
              const cursorBlock = bigint(cursor.rows[0] as Row, "next_block_number");
              // The first block in which an execution may be this call: never the mined
              // head, which already held any identical transfer before this call existed.
              const firstEligibleBlock = input.headBlockNumber + 1n;
              const preparedBlock =
                cursorBlock > firstEligibleBlock ? cursorBlock : firstEligibleBlock;
              const created = yield* transaction.execute({
                label: "reward-safe-payout.effect.create",
                text: `INSERT INTO reward_chain_effects (
                         effect_id, effect_kind, state, chain_id, signer_address,
                         target_address, reserved_amount_atomic, execution_mode
                       ) VALUES ($1,'reward_payout','planned',$2,$3,$4,$5,'safe_owner_v1')`,
                values: [
                  input.effectId,
                  candidate.chainId,
                  candidate.custodyAddress,
                  candidate.tokenAddress,
                  candidate.amountAtomic.toString(),
                ],
                readonly: false,
              });
              if (created.rowCount !== 1) return yield* rejected("effect-conflict");
              yield* transaction.execute({
                label: "reward-safe-payout.prepared-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,2,'safe_call_prepared',jsonb_build_object(
                         'calldata_hash',$2::text,'safe_prepared_block_number',$3::text
                       ))`,
                values: [input.effectId, input.calldataHash, preparedBlock.toString()],
                readonly: false,
              });
              const prepared = yield* transaction.execute({
                label: "reward-safe-payout.effect.prepare",
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
              if (prepared.rowCount !== 1) return yield* rejected("effect-conflict");
              const reserved = yield* transaction.execute({
                label: "reward-safe-payout.credit.reserve",
                text: `UPDATE reward_ledger_credits
                          SET state='payout_reserved', reserved_atomic=$2,
                              updated_at=clock_timestamp()
                        WHERE credit_id=$1 AND state='credited' AND reserved_atomic=0`,
                values: [candidate.creditId, candidate.amountAtomic.toString()],
                readonly: false,
              });
              if (reserved.rowCount !== 1) return yield* rejected("credit-not-payable");
              yield* transaction.execute({
                label: "reward-safe-payout.detail.create",
                text: `INSERT INTO reward_payout_effects (
                         payout_effect_id, attestation_id, credit_id, account_id,
                         payout_persona_id, destination_address, amount_atomic,
                         wallet_assignment_id, solvency_observation_id,
                         custody_balance_before_atomic
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                values: [
                  input.effectId,
                  candidate.attestationId,
                  candidate.creditId,
                  candidate.accountId,
                  candidate.payoutPersonaId,
                  candidate.destinationAddress,
                  candidate.amountAtomic.toString(),
                  candidate.walletAssignmentId,
                  candidate.solvencyObservationId,
                  candidate.custodyBalanceBeforeAtomic.toString(),
                ],
                readonly: false,
              });
              const pending = yield* transaction.execute({
                label: "reward-safe-payout.credit.pending",
                text: `UPDATE reward_ledger_credits
                          SET state='payout_pending', updated_at=clock_timestamp()
                        WHERE credit_id=$1 AND state='payout_reserved'`,
                values: [candidate.creditId],
                readonly: false,
              });
              if (pending.rowCount !== 1) return yield* rejected("effect-conflict");
              return preparedBlock;
            }),
          );
        }),
      ),

    /**
     * A confirmed Safe ExecutionFailure spent the nonce without moving USDC. The effect
     * is recorded as reverted with its successful outer receipt, and the credit returns
     * to credited so a new call can be prepared.
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
                label: "reward-safe-payout.failure.read",
                text: `SELECT effect.state, effect.version, effect.transaction_hash,
                              effect.safe_execution_outcome, payout.credit_id
                         FROM reward_chain_effects effect
                         JOIN reward_payout_effects payout
                           ON payout.payout_effect_id=effect.effect_id
                        WHERE effect.effect_id=$1 AND effect.execution_mode='safe_owner_v1'
                        FOR UPDATE OF effect`,
                values: [input.effectId],
                readonly: false,
              });
              if (result.rows.length !== 1) return yield* rejected("not-found");
              const row = result.rows[0] as Row;
              if (
                !["confirming", "reconciliation_required"].includes(text(row, "state")) ||
                text(row, "transaction_hash") !== input.transactionHash ||
                row.safe_execution_outcome !== "failure"
              ) {
                return yield* rejected("effect-conflict");
              }
              const version = Number(bigint(row, "version")) + 1;
              yield* transaction.execute({
                label: "reward-safe-payout.failure-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,$2,'safe_execution_failed',jsonb_build_object(
                         'transaction_hash',$3::text
                       ))`,
                values: [input.effectId, version, input.transactionHash],
                readonly: false,
              });
              const reverted = yield* transaction.execute({
                label: "reward-safe-payout.effect.revert",
                text: `UPDATE reward_chain_effects
                          SET state='reverted', version=$2, receipt_status='success',
                              receipt_block_number=$3, receipt_block_hash=$4,
                              receipt_hash=$5, confirmations=$6, confirmed_at=$7,
                              failure_class=NULL, failure_reason=NULL,
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
              if (reverted.rowCount !== 1) return yield* rejected("effect-conflict");
              const creditId = text(row, "credit_id");
              yield* transaction.execute({
                label: "reward-safe-payout.credit.hold",
                text: `UPDATE reward_ledger_credits
                          SET state='reconciliation_required', updated_at=clock_timestamp()
                        WHERE credit_id=$1 AND state='payout_pending'`,
                values: [creditId],
                readonly: false,
              });
              const released = yield* transaction.execute({
                label: "reward-safe-payout.credit.release",
                text: `UPDATE reward_ledger_credits
                          SET state='credited', reserved_atomic=0, updated_at=clock_timestamp()
                        WHERE credit_id=$1 AND state='reconciliation_required'`,
                values: [creditId],
                readonly: false,
              });
              if (released.rowCount !== 1) return yield* rejected("effect-conflict");
            }),
          );
        }),
      ),
  };
}
