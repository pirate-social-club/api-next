import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Data, Effect } from "effect";
import type { Hex } from "viem";
import { mapMegapotStorageFailure } from "./control-plane-error-classification.ts";
import { rewardSafeCall } from "./reward-safe-command.ts";
import type { RewardSafeExecutionFinding } from "./reward-safe-reconciliation.ts";

type Row = Readonly<Record<string, unknown>>;

export class RewardSafeExecutionStoreFailed extends Data.TaggedError(
  "RewardSafeExecutionStoreFailed",
)<{
  readonly reason:
    | "conflict"
    | "constraint"
    | "effect-conflict"
    | "invalid-row"
    | "outcome-unknown"
    | "scan-conflict"
    | "unavailable";
}> {}

const failed = (reason: RewardSafeExecutionStoreFailed["reason"]) =>
  new RewardSafeExecutionStoreFailed({ reason });

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      mapMegapotStorageFailure<E, RewardSafeExecutionStoreFailed>(error, failed),
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

/** A prepared Safe call still waiting for, or being reconciled against, an execution. */
type RewardSafeOpenCall = Readonly<{
  effectId: string;
  effectKind: string;
  to: Hex;
  data: Hex;
  notBeforeBlock: bigint;
}>;

type RewardSafeScanState = Readonly<{
  nextBlockNumber: bigint;
  calls: readonly RewardSafeOpenCall[];
}>;

const failureClass = {
  nonconforming: "safe_execution_nonconforming",
  hash_mismatch: "safe_execution_hash_mismatch",
} as const;

export function makeControlPlaneRewardSafeExecutionStore() {
  return {
    /**
     * The scan cursor and every prepared call for one Safe, read in one snapshot. Null
     * when no call has ever been prepared, so there is nothing to scan for.
     */
    loadScanState: (input: { readonly chainId: number; readonly safeAddress: string }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const cursor = yield* transaction.execute<Row>({
                label: "reward-safe-execution.cursor.read",
                text: `SELECT next_block_number FROM reward_safe_execution_cursors
                        WHERE chain_id=$1 AND safe_address=$2`,
                values: [input.chainId, input.safeAddress.toLowerCase()],
                readonly: true,
              });
              if (cursor.rows.length === 0) return null;
              const open = yield* transaction.execute<Row>({
                label: "reward-safe-execution.open-calls.read",
                text: `SELECT effect_id, effect_kind, target_address, calldata,
                              safe_prepared_block_number
                         FROM reward_chain_effects
                        WHERE chain_id=$1 AND signer_address=$2
                          AND execution_mode='safe_owner_v1' AND state='prepared'
                        ORDER BY safe_prepared_block_number, effect_id`,
                values: [input.chainId, input.safeAddress.toLowerCase()],
                readonly: true,
              });
              return yield* Effect.try({
                try: () =>
                  ({
                    nextBlockNumber: bigint(cursor.rows[0] as Row, "next_block_number"),
                    calls: open.rows.map((row) => {
                      const call = rewardSafeCall({
                        effectId: text(row, "effect_id"),
                        to: text(row, "target_address"),
                        data: text(row, "calldata"),
                      });
                      return {
                        ...call,
                        effectKind: text(row, "effect_kind"),
                        notBeforeBlock: bigint(row, "safe_prepared_block_number"),
                      };
                    }),
                  }) satisfies RewardSafeScanState,
                catch: () => failed("invalid-row"),
              });
            }),
          );
        }),
      ),

    /**
     * Persist the findings of one scanned window and advance the cursor past it. The
     * window must start exactly at the stored cursor, and no call prepared at or before
     * its end may be missing from the scan's snapshot; otherwise the scan is refused
     * and repeated, so an execution is never skipped.
     */
    recordScan: (input: {
      readonly chainId: number;
      readonly safeAddress: string;
      readonly fromBlock: bigint;
      readonly throughBlock: bigint;
      readonly scannedEffectIds: readonly string[];
      readonly findings: readonly RewardSafeExecutionFinding[];
    }) =>
      mapped(
        Effect.gen(function* () {
          if (input.throughBlock < input.fromBlock) return yield* failed("scan-conflict");
          const safe = input.safeAddress.toLowerCase();
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const cursor = yield* transaction.execute<Row>({
                label: "reward-safe-execution.cursor.lock",
                text: `SELECT next_block_number FROM reward_safe_execution_cursors
                        WHERE chain_id=$1 AND safe_address=$2 FOR UPDATE`,
                values: [input.chainId, safe],
                readonly: false,
              });
              if (
                cursor.rows.length !== 1 ||
                bigint(cursor.rows[0] as Row, "next_block_number") !== input.fromBlock
              ) {
                return yield* failed("scan-conflict");
              }
              const unseen = yield* transaction.execute<Row>({
                label: "reward-safe-execution.unseen-calls.read",
                text: `SELECT count(*)::text AS unseen FROM reward_chain_effects
                        WHERE chain_id=$1 AND signer_address=$2
                          AND execution_mode='safe_owner_v1' AND state='prepared'
                          AND safe_prepared_block_number <= $3
                          AND NOT (effect_id = ANY($4::text[]))`,
                values: [
                  input.chainId,
                  safe,
                  input.throughBlock.toString(),
                  [...input.scannedEffectIds],
                ],
                readonly: false,
              });
              if (bigint(unseen.rows[0] as Row, "unseen") !== 0n) {
                return yield* failed("scan-conflict");
              }
              for (const finding of input.findings) {
                if (finding.kind === "undecodable") {
                  yield* transaction.execute({
                    label: "reward-safe-execution.unbound.create",
                    text: `INSERT INTO reward_safe_unbound_executions (
                             chain_id, safe_address, transaction_hash, log_index,
                             block_number, block_hash, safe_transaction_hash, outcome, reason
                           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'undecodable')
                           ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING`,
                    values: [
                      input.chainId,
                      safe,
                      finding.log.transactionHash.toLowerCase(),
                      finding.log.logIndex,
                      finding.log.blockNumber.toString(),
                      finding.log.blockHash.toLowerCase(),
                      finding.log.safeTransactionHash.toLowerCase(),
                      finding.log.outcome,
                    ],
                    readonly: false,
                  });
                  continue;
                }
                const current = yield* transaction.execute<Row>({
                  label: "reward-safe-execution.effect.lock",
                  text: `SELECT state, version, effect_kind, safe_transaction_hash
                           FROM reward_chain_effects
                          WHERE effect_id=$1 AND chain_id=$2 AND signer_address=$3
                            AND execution_mode='safe_owner_v1'
                          FOR UPDATE`,
                  values: [finding.call.effectId, input.chainId, safe],
                  readonly: false,
                });
                if (current.rows.length !== 1) return yield* failed("effect-conflict");
                const row = current.rows[0] as Row;
                if (text(row, "state") !== "prepared") {
                  // A repeated scan of an already recorded execution changes nothing.
                  if (row.safe_transaction_hash === finding.log.safeTransactionHash.toLowerCase()) {
                    continue;
                  }
                  return yield* failed("effect-conflict");
                }
                const version = Number(bigint(row, "version")) + 1;
                const target =
                  finding.kind === "matched" ? "confirming" : "reconciliation_required";
                const reason =
                  finding.kind === "matched"
                    ? null
                    : `${failureClass[finding.kind]} at nonce ${finding.safeNonce}`;
                yield* transaction.execute({
                  label: "reward-safe-execution.transition.create",
                  text: `INSERT INTO reward_chain_effect_transitions (
                           effect_id, target_version, event_type, event
                         ) VALUES ($1,$2,$3,jsonb_build_object(
                           'transaction_hash',$4::text,'safe_transaction_hash',$5::text,
                           'safe_nonce',$6::text,'outcome',$7::text,'finding',$8::text
                         ))`,
                  values: [
                    finding.call.effectId,
                    version,
                    finding.kind === "matched" ? "safe_execution_observed" : "safe_execution_held",
                    finding.log.transactionHash.toLowerCase(),
                    finding.log.safeTransactionHash.toLowerCase(),
                    finding.safeNonce.toString(),
                    finding.log.outcome,
                    finding.kind,
                  ],
                  readonly: false,
                });
                const updated = yield* transaction.execute({
                  label: "reward-safe-execution.effect.observe",
                  text: `UPDATE reward_chain_effects
                            SET state=$2, version=$3, transaction_hash=$4,
                                broadcast_at=clock_timestamp(),
                                safe_nonce=$5, safe_transaction_hash=$6,
                                safe_executor_address=$7, safe_execution_outcome=$8,
                                safe_execution_log_index=$9,
                                failure_class=$10, failure_reason=$11,
                                updated_at=clock_timestamp()
                          WHERE effect_id=$1 AND state='prepared'`,
                  values: [
                    finding.call.effectId,
                    target,
                    version,
                    finding.log.transactionHash.toLowerCase(),
                    finding.safeNonce.toString(),
                    finding.log.safeTransactionHash.toLowerCase(),
                    finding.executor.toLowerCase(),
                    finding.log.outcome,
                    finding.log.logIndex,
                    finding.kind === "matched" ? null : failureClass[finding.kind],
                    reason,
                  ],
                  readonly: false,
                });
                if (updated.rowCount !== 1) return yield* failed("effect-conflict");
                if (text(row, "effect_kind") === "reward_payout" && finding.kind !== "matched") {
                  const credit = yield* transaction.execute({
                    label: "reward-safe-execution.payout-credit.hold",
                    text: `UPDATE reward_ledger_credits credit
                              SET state='reconciliation_required', updated_at=clock_timestamp()
                             FROM reward_payout_effects payout
                            WHERE payout.payout_effect_id=$1
                              AND credit.credit_id=payout.credit_id
                              AND credit.state='payout_pending'`,
                    values: [finding.call.effectId],
                    readonly: false,
                  });
                  if (credit.rowCount !== 1) return yield* failed("effect-conflict");
                }
              }
              const advanced = yield* transaction.execute({
                label: "reward-safe-execution.cursor.advance",
                text: `UPDATE reward_safe_execution_cursors
                          SET next_block_number=$3, updated_at=clock_timestamp()
                        WHERE chain_id=$1 AND safe_address=$2 AND next_block_number=$4`,
                values: [
                  input.chainId,
                  safe,
                  (input.throughBlock + 1n).toString(),
                  input.fromBlock.toString(),
                ],
                readonly: false,
              });
              if (advanced.rowCount !== 1) return yield* failed("scan-conflict");
            }),
          );
        }),
      ),
  };
}
