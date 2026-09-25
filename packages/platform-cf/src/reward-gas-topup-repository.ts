import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type RewardGasTopupCandidate,
  type RewardGasTopupFailure,
  type RewardGasTopupProgress,
  RewardGasTopupRejected,
  type RewardGasTopupRequestContext,
  type RewardGasTopupRequestStore,
  type RewardGasTopupReservation,
  type RewardGasTopupReservedEffect,
  type RewardGasTopupSendStore,
  RewardGasTopupStorageFailed,
  type RewardGasTopupView,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: RewardGasTopupStorageFailed["reason"]) =>
  new RewardGasTopupStorageFailed({ reason });
const rejected = (reason: RewardGasTopupRejected["reason"]) =>
  new RewardGasTopupRejected({ reason });

function mapError(error: ControlPlaneError): RewardGasTopupStorageFailed {
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
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return Date.parse(value);
  throw new Error(`invalid ${field}`);
}

const parse = <A>(build: () => A) =>
  Effect.try({ try: build, catch: () => storage("invalid-row") });

const VIEW_SELECT = `
  SELECT topup.topup_id, topup.credit_id, topup.status, topup.amount_wei,
         effect.transaction_hash
    FROM reward_gas_topups topup
    LEFT JOIN reward_chain_effects effect ON effect.effect_id=topup.effect_id`;

function viewFromRow(row: Row): RewardGasTopupView {
  const status = text(row, "status");
  if (
    status !== "requested" &&
    status !== "broadcast" &&
    status !== "confirmed" &&
    status !== "released"
  ) {
    throw new Error("invalid status");
  }
  return {
    topupId: text(row, "topup_id"),
    creditId: text(row, "credit_id"),
    status,
    amountWei: bigint(row, "amount_wei"),
    transactionHash: nullableText(row, "transaction_hash"),
  };
}

function oneView(rows: readonly Row[]) {
  if (rows.length === 0) return Effect.succeed(null);
  if (rows.length !== 1) return Effect.fail(storage("invalid-row"));
  return parse(() => viewFromRow(rows[0] as Row));
}

function findByKeyIn(
  executor: Pick<ControlPlaneTransaction, "execute">,
  input: { readonly accountId: string; readonly idempotencyKey: string },
  lock: boolean,
) {
  return Effect.gen(function* () {
    const result = yield* executor.execute<Row>({
      label: "reward-gas-topup.idempotency.read",
      text: `${VIEW_SELECT} WHERE topup.account_id=$1 AND topup.idempotency_key=$2`,
      values: [input.accountId, input.idempotencyKey],
      readonly: !lock,
    });
    return yield* oneView(result.rows);
  });
}

function reserveIn(
  transaction: ControlPlaneTransaction,
  input: Parameters<RewardGasTopupRequestStore["reserve"]>[0],
): Effect.Effect<RewardGasTopupReservation, RewardGasTopupFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    const { context } = input;
    const dayResult = yield* transaction.execute<Row>({
      label: "reward-gas-topup.budget-day.read",
      text: "SELECT ((clock_timestamp() AT TIME ZONE 'UTC')::date)::text AS budget_day",
      values: [],
      readonly: true,
    });
    const budgetDay = yield* parse(() => text(dayResult.rows[0] as Row, "budget_day"));
    yield* transaction.execute({
      label: "reward-gas-topup.budget.create",
      text: `INSERT INTO reward_gas_topup_daily_budgets (chain_id, budget_day, ceiling_wei)
             VALUES ($1,$2::date,$3)
             ON CONFLICT (chain_id, budget_day) DO NOTHING`,
      values: [context.chainId, budgetDay, input.platformDailyWei.toString()],
      readonly: false,
    });
    // The budget row lock serializes every request for this chain and day, so
    // the per-account count, the open-recipient check and the budget are exact.
    yield* transaction.execute({
      label: "reward-gas-topup.budget.lock",
      text: `SELECT 1 FROM reward_gas_topup_daily_budgets
              WHERE chain_id=$1 AND budget_day=$2::date FOR UPDATE`,
      values: [context.chainId, budgetDay],
      readonly: false,
    });
    const replayed = yield* findByKeyIn(
      transaction,
      { accountId: context.accountId, idempotencyKey: input.idempotencyKey },
      true,
    );
    if (replayed !== null) return { kind: "replayed", topup: replayed } as const;
    const open = yield* transaction.execute<Row>({
      label: "reward-gas-topup.open-recipient.read",
      text: `${VIEW_SELECT}
              WHERE topup.chain_id=$1 AND topup.recipient_address=$2
                AND topup.status IN ('requested','broadcast')
              ORDER BY topup.created_at, topup.topup_id LIMIT 1`,
      values: [context.chainId, context.recipientAddress],
      readonly: false,
    });
    const openTopup = yield* oneView(open.rows);
    if (openTopup !== null) return { kind: "open", topup: openTopup } as const;
    const count = yield* transaction.execute<Row>({
      label: "reward-gas-topup.account-day.count",
      text: `SELECT count(*)::integer AS topups FROM reward_gas_topups
              WHERE account_id=$1 AND budget_day=$2::date AND status <> 'released'`,
      values: [context.accountId, budgetDay],
      readonly: false,
    });
    const used = yield* parse(() => integer(count.rows[0] as Row, "topups"));
    if (used >= input.accountDailyCount) return { kind: "limit_reached" } as const;
    const budget = yield* transaction.execute({
      label: "reward-gas-topup.budget.reserve",
      text: `UPDATE reward_gas_topup_daily_budgets
                SET ceiling_wei=$3, reserved_wei=reserved_wei+$4,
                    updated_at=clock_timestamp()
              WHERE chain_id=$1 AND budget_day=$2::date
                AND reserved_wei + confirmed_wei + $4 <= $3`,
      values: [
        context.chainId,
        budgetDay,
        input.platformDailyWei.toString(),
        input.amountWei.toString(),
      ],
      readonly: false,
    });
    if (budget.rowCount !== 1) return { kind: "limit_reached" } as const;
    yield* transaction.execute({
      label: "reward-gas-topup.create",
      text: `INSERT INTO reward_gas_topups (
               topup_id, account_id, persona_id, credit_id, wallet_assignment_id,
               recipient_address, chain_id, balance_before_wei, target_balance_wei,
               amount_wei, budget_day, idempotency_key, status
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,'requested')`,
      values: [
        input.topupId,
        context.accountId,
        context.personaId,
        context.creditId,
        context.walletAssignmentId,
        context.recipientAddress,
        context.chainId,
        input.balanceBeforeWei.toString(),
        input.targetBalanceWei.toString(),
        input.amountWei.toString(),
        budgetDay,
        input.idempotencyKey,
      ],
      readonly: false,
    });
    return {
      kind: "reserved",
      topup: {
        topupId: input.topupId,
        creditId: context.creditId,
        status: "requested",
        amountWei: input.amountWei,
        transactionHash: null,
      },
    } as const;
  });
}

function contextFromRow(row: Row): RewardGasTopupRequestContext {
  return {
    creditId: text(row, "credit_id"),
    accountId: text(row, "account_id"),
    personaId: text(row, "payout_persona_id"),
    walletAssignmentId: text(row, "assignment_id"),
    recipientAddress: text(row, "address"),
    chainId: integer(row, "chain_id"),
  };
}

export function makeControlPlaneRewardGasTopupRequestRepository() {
  return {
    findByIdempotencyKey: (
      input: Parameters<RewardGasTopupRequestStore["findByIdempotencyKey"]>[0],
    ) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* findByKeyIn(db, input, false);
        }),
      ),
    loadRequestContext: (input: Parameters<RewardGasTopupRequestStore["loadRequestContext"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-gas-topup.context.read",
            text: `SELECT credit.credit_id, credit.account_id, credit.payout_persona_id,
                          credit.chain_id, credit.source_kind, credit.state,
                          EXISTS (
                            SELECT 1 FROM megapot_participant_claims claim
                             WHERE claim.credit_id=credit.credit_id
                               AND claim.status='accepted'
                          ) AS claimed,
                          wallet.assignment_id, wallet.address,
                          gas.signer_address AS gas_signer_address
                     FROM reward_ledger_credits credit
                     LEFT JOIN LATERAL (
                       SELECT assignment_id, address
                         FROM persona_wallet_assignments
                        WHERE account_id=credit.account_id
                          AND persona_id=credit.payout_persona_id
                          AND chain_account_kind='evm' AND status='active'
                        ORDER BY assigned_at, assignment_id LIMIT 1
                     ) wallet ON true
                     LEFT JOIN reward_gas_topup_wallets gas
                       ON gas.chain_id=credit.chain_id AND gas.status='active'
                    WHERE credit.credit_id=$1 AND credit.account_id=$2`,
            values: [input.creditId, input.accountId],
            readonly: true,
          });
          if (result.rows.length === 0) return yield* rejected("not-found");
          if (result.rows.length !== 1) return yield* storage("invalid-row");
          const row = result.rows[0] as Row;
          if (
            row.source_kind !== "megapot_allocation" ||
            row.state !== "sent" ||
            row.claimed !== true
          ) {
            return yield* rejected("credit-not-eligible");
          }
          if (row.assignment_id === null || row.address === null) {
            return yield* rejected("recipient-pending");
          }
          if (row.gas_signer_address === null) return yield* rejected("gas-wallet-unavailable");
          return yield* parse(() => contextFromRow(row));
        }),
      ),
    reserve: (input: Parameters<RewardGasTopupRequestStore["reserve"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) => reserveIn(transaction, input));
        }),
      ),
    get: (input: Parameters<RewardGasTopupRequestStore["get"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-gas-topup.view.read",
            text: `${VIEW_SELECT} WHERE topup.account_id=$1 AND topup.topup_id=$2`,
            values: [input.accountId, input.topupId],
            readonly: true,
          });
          return yield* oneView(result.rows);
        }),
      ),
  };
}

export const makeControlPlaneRewardGasTopupRequestStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RewardGasTopupRequestStore => {
  const repository = makeControlPlaneRewardGasTopupRequestRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    findByIdempotencyKey: (input) => provide(repository.findByIdempotencyKey(input)),
    loadRequestContext: (input) => provide(repository.loadRequestContext(input)),
    reserve: (input) => provide(repository.reserve(input)),
    get: (input) => provide(repository.get(input)),
  };
};

/* Send side. */

const PROGRESS_SELECT = `
  SELECT effect.state, effect.version AS effect_version, effect.nonce,
         effect.signer_address, effect.signed_transaction,
         effect.signed_transaction_hash, effect.transaction_hash,
         effect.effect_id, topup.topup_id, topup.account_id, topup.credit_id,
         topup.recipient_address, topup.chain_id, topup.amount_wei,
         topup.target_balance_wei
    FROM reward_chain_effects effect
    JOIN reward_gas_topups topup ON topup.effect_id=effect.effect_id`;

function candidateFromRow(row: Row, signerField: string): RewardGasTopupCandidate {
  return {
    topupId: text(row, "topup_id"),
    accountId: text(row, "account_id"),
    creditId: text(row, "credit_id"),
    recipientAddress: text(row, "recipient_address"),
    chainId: integer(row, "chain_id"),
    amountWei: bigint(row, "amount_wei"),
    targetBalanceWei: bigint(row, "target_balance_wei"),
    signerAddress: text(row, signerField),
  };
}

function progressFromRow(row: Row): RewardGasTopupProgress {
  const state = text(row, "state");
  if (state === "confirmed") {
    return {
      state,
      effectId: text(row, "effect_id"),
      topupId: text(row, "topup_id"),
      transactionHash: nullableText(row, "transaction_hash"),
    };
  }
  if (state === "reverted" || state === "terminal_failed" || state === "reclaimable_failed") {
    return {
      state: "released",
      effectId: text(row, "effect_id"),
      topupId: text(row, "topup_id"),
      transactionHash: nullableText(row, "transaction_hash"),
    };
  }
  const reservation: RewardGasTopupReservedEffect = {
    ...candidateFromRow(row, "signer_address"),
    effectId: text(row, "effect_id"),
    nonce: bigint(row, "nonce"),
    effectVersion: integer(row, "effect_version"),
  };
  if (state === "nonce_reserved") return { state, reservation };
  if (
    state !== "prepared" &&
    state !== "broadcast_pending" &&
    state !== "confirming" &&
    state !== "reconciliation_required"
  ) {
    throw new Error("invalid gas top-up effect state");
  }
  const transactionHash = nullableText(row, "transaction_hash");
  if (state === "prepared" ? transactionHash !== null : transactionHash === null) {
    throw new Error("invalid gas top-up transaction identity");
  }
  return {
    ...reservation,
    state,
    signedTransaction: text(row, "signed_transaction"),
    signedTransactionHash: text(row, "signed_transaction_hash"),
    transactionHash,
  };
}

function releaseBudgetIn(transaction: ControlPlaneTransaction, topupId: string, confirm: boolean) {
  return Effect.gen(function* () {
    const budget = yield* transaction.execute({
      label: confirm ? "reward-gas-topup.budget.confirm" : "reward-gas-topup.budget.release",
      text: confirm
        ? `UPDATE reward_gas_topup_daily_budgets budget
              SET reserved_wei=budget.reserved_wei-topup.amount_wei,
                  confirmed_wei=budget.confirmed_wei+topup.amount_wei,
                  updated_at=clock_timestamp()
             FROM reward_gas_topups topup
            WHERE topup.topup_id=$1 AND budget.chain_id=topup.chain_id
              AND budget.budget_day=topup.budget_day
              AND budget.reserved_wei >= topup.amount_wei`
        : `UPDATE reward_gas_topup_daily_budgets budget
              SET reserved_wei=budget.reserved_wei-topup.amount_wei,
                  updated_at=clock_timestamp()
             FROM reward_gas_topups topup
            WHERE topup.topup_id=$1 AND budget.chain_id=topup.chain_id
              AND budget.budget_day=topup.budget_day
              AND budget.reserved_wei >= topup.amount_wei`,
      values: [topupId],
      readonly: false,
    });
    if (budget.rowCount !== 1) return yield* rejected("effect-conflict");
  });
}

function reserveNonceIn(
  transaction: ControlPlaneTransaction,
  input: Parameters<RewardGasTopupSendStore["reserveNonce"]>[0],
) {
  return Effect.gen(function* () {
    const { candidate } = input;
    const locked = yield* transaction.execute<Row>({
      label: "reward-gas-topup.candidate.lock",
      text: `SELECT topup.topup_id, topup.account_id, topup.credit_id,
                    topup.recipient_address, topup.chain_id, topup.amount_wei,
                    topup.target_balance_wei, topup.status, topup.effect_id,
                    gas.signer_address AS gas_signer_address
               FROM reward_gas_topups topup
               LEFT JOIN reward_gas_topup_wallets gas
                 ON gas.chain_id=topup.chain_id AND gas.status='active'
              WHERE topup.topup_id=$1 FOR UPDATE OF topup`,
      values: [candidate.topupId],
      readonly: false,
    });
    if (locked.rows.length !== 1) return yield* rejected("not-found");
    const row = locked.rows[0] as Row;
    if (row.status !== "requested" || row.effect_id !== null) {
      return yield* rejected("effect-conflict");
    }
    if (row.gas_signer_address === null) return yield* rejected("gas-wallet-unavailable");
    const current = yield* parse(() => candidateFromRow(row, "gas_signer_address"));
    if (
      current.recipientAddress !== candidate.recipientAddress ||
      current.amountWei !== candidate.amountWei ||
      current.chainId !== candidate.chainId ||
      current.signerAddress !== candidate.signerAddress
    ) {
      return yield* rejected("effect-conflict");
    }
    const nonceResult = yield* transaction.execute<Row>({
      label: "reward-gas-topup.nonce.read",
      text: `SELECT next_nonce, observed_block_number, observed_at
               FROM reward_signer_nonces
              WHERE chain_id=$1 AND signer_address=$2 FOR UPDATE`,
      values: [candidate.chainId, candidate.signerAddress],
      readonly: false,
    });
    let nonce: bigint;
    if (nonceResult.rows.length === 0) {
      nonce = input.observedPendingNonce;
      yield* transaction.execute({
        label: "reward-gas-topup.nonce.create",
        text: `INSERT INTO reward_signer_nonces (
                 chain_id, signer_address, next_nonce, observed_pending_nonce,
                 observed_block_number, observed_block_hash, observed_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        values: [
          candidate.chainId,
          candidate.signerAddress,
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
      const nonceRow = nonceResult.rows[0] as Row;
      const stale = yield* parse(
        () =>
          input.observedBlockNumber < bigint(nonceRow, "observed_block_number") ||
          Date.parse(input.observedAt) < instantMillis(nonceRow, "observed_at"),
      );
      if (stale) return yield* rejected("effect-conflict");
      nonce = yield* parse(() => bigint(nonceRow, "next_nonce"));
      if (input.observedPendingNonce > nonce) nonce = input.observedPendingNonce;
      yield* transaction.execute({
        label: "reward-gas-topup.nonce.reserve",
        text: `UPDATE reward_signer_nonces
                  SET next_nonce=$3, observed_pending_nonce=$4,
                      observed_block_number=$5, observed_block_hash=$6,
                      observed_at=$7, fence_version=fence_version+1,
                      updated_at=clock_timestamp()
                WHERE chain_id=$1 AND signer_address=$2`,
        values: [
          candidate.chainId,
          candidate.signerAddress,
          (nonce + 1n).toString(),
          input.observedPendingNonce.toString(),
          input.observedBlockNumber.toString(),
          input.observedBlockHash,
          input.observedAt,
        ],
        readonly: false,
      });
    }
    const created = yield* transaction.execute({
      label: "reward-gas-topup.effect.create",
      text: `INSERT INTO reward_chain_effects (
               effect_id, effect_kind, state, chain_id, signer_address,
               target_address, value_wei, reserved_amount_atomic
             ) VALUES ($1,'gas_topup','planned',$2,$3,$4,$5,0)`,
      values: [
        input.effectId,
        candidate.chainId,
        candidate.signerAddress,
        candidate.recipientAddress,
        candidate.amountWei.toString(),
      ],
      readonly: false,
    });
    if (created.rowCount !== 1) return yield* rejected("effect-conflict");
    yield* transaction.execute({
      label: "reward-gas-topup.nonce-transition.create",
      text: `INSERT INTO reward_chain_effect_transitions (
               effect_id, target_version, event_type, event
             ) VALUES ($1,2,'nonce_reserved',jsonb_build_object('nonce',$2::text))`,
      values: [input.effectId, nonce.toString()],
      readonly: false,
    });
    const reserved = yield* transaction.execute({
      label: "reward-gas-topup.effect.nonce-reserve",
      text: `UPDATE reward_chain_effects
                SET state='nonce_reserved', version=2, nonce=$2,
                    updated_at=clock_timestamp()
              WHERE effect_id=$1 AND state='planned' AND version=1`,
      values: [input.effectId, nonce.toString()],
      readonly: false,
    });
    if (reserved.rowCount !== 1) return yield* rejected("effect-conflict");
    const bound = yield* transaction.execute({
      label: "reward-gas-topup.effect.bind",
      text: `UPDATE reward_gas_topups SET effect_id=$2, updated_at=clock_timestamp()
              WHERE topup_id=$1 AND status='requested' AND effect_id IS NULL`,
      values: [candidate.topupId, input.effectId],
      readonly: false,
    });
    if (bound.rowCount !== 1) return yield* rejected("effect-conflict");
    return {
      ...candidate,
      effectId: input.effectId,
      nonce,
      effectVersion: 2,
    } satisfies RewardGasTopupReservedEffect;
  });
}

function lockEffectIn(transaction: ControlPlaneTransaction, effectId: string, label: string) {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label,
      text: `SELECT effect.state, effect.version, effect.signed_transaction_hash,
                    effect.transaction_hash, topup.topup_id
               FROM reward_chain_effects effect
               JOIN reward_gas_topups topup ON topup.effect_id=effect.effect_id
              WHERE effect.effect_id=$1 AND effect.effect_kind='gas_topup'
                FOR UPDATE OF effect, topup`,
      values: [effectId],
      readonly: false,
    });
    if (result.rows.length !== 1) return yield* rejected("not-found");
    const row = result.rows[0] as Row;
    return yield* parse(() => ({
      state: text(row, "state"),
      version: integer(row, "version"),
      signedTransactionHash: nullableText(row, "signed_transaction_hash"),
      transactionHash: nullableText(row, "transaction_hash"),
      topupId: text(row, "topup_id"),
    }));
  });
}

type ReceiptInput = Parameters<RewardGasTopupSendStore["confirm"]>[0];

function settleIn(
  transaction: ControlPlaneTransaction,
  input: ReceiptInput,
  outcome: "confirmed" | "reverted",
) {
  return Effect.gen(function* () {
    const locked = yield* lockEffectIn(
      transaction,
      input.effectId,
      `reward-gas-topup.${outcome}.read`,
    );
    if (
      !["broadcast_pending", "confirming", "reconciliation_required"].includes(locked.state) ||
      locked.transactionHash !== input.transactionHash
    ) {
      return yield* rejected("effect-conflict");
    }
    const version = locked.version + 1;
    yield* transaction.execute({
      label: `reward-gas-topup.${outcome}-transition.create`,
      text: `INSERT INTO reward_chain_effect_transitions (
               effect_id, target_version, event_type, event
             ) VALUES ($1,$2,$3,jsonb_build_object('transaction_hash',$4::text))`,
      values: [
        input.effectId,
        version,
        outcome === "confirmed" ? "receipt_confirmed" : "receipt_reverted",
        input.transactionHash,
      ],
      readonly: false,
    });
    const settled = yield* transaction.execute({
      label: `reward-gas-topup.effect.${outcome}`,
      text: `UPDATE reward_chain_effects
                SET state=$3, version=$2,
                    settled_amount_atomic=CASE WHEN $3='confirmed' THEN value_wei ELSE NULL END,
                    receipt_status=CASE WHEN $3='confirmed' THEN 'success' ELSE 'reverted' END,
                    receipt_block_number=$4, receipt_block_hash=$5, receipt_hash=$6,
                    confirmations=$7, confirmed_at=$8,
                    failure_class=NULL, failure_reason=NULL,
                    updated_at=clock_timestamp()
              WHERE effect_id=$1`,
      values: [
        input.effectId,
        version,
        outcome,
        input.blockNumber.toString(),
        input.blockHash,
        input.receiptHash,
        input.confirmations,
        input.confirmedAt,
      ],
      readonly: false,
    });
    if (settled.rowCount !== 1) return yield* rejected("effect-conflict");
    if (outcome === "confirmed") {
      yield* transaction.execute({
        label: "reward-gas-topup.receipt-evidence.create",
        text: `INSERT INTO reward_native_transfer_receipt_evidence (
                 effect_id, sender_address, recipient_address, amount_wei,
                 transaction_hash, block_number, block_hash, receipt_hash,
                 confirmations, confirmed_at
               )
               SELECT effect_id, signer_address, target_address, value_wei,
                      transaction_hash, receipt_block_number, receipt_block_hash,
                      receipt_hash, confirmations, confirmed_at
                 FROM reward_chain_effects WHERE effect_id=$1`,
        values: [input.effectId],
        readonly: false,
      });
    }
    const topup = yield* transaction.execute({
      label: `reward-gas-topup.${outcome}.record`,
      text:
        outcome === "confirmed"
          ? `UPDATE reward_gas_topups
                SET status='confirmed', confirmed_at=$2, updated_at=clock_timestamp()
              WHERE topup_id=$1 AND status='broadcast'`
          : `UPDATE reward_gas_topups
                SET status='released', release_reason='receipt_reverted',
                    released_at=$2, updated_at=clock_timestamp()
              WHERE topup_id=$1 AND status='broadcast'`,
      values: [locked.topupId, input.confirmedAt],
      readonly: false,
    });
    if (topup.rowCount !== 1) return yield* rejected("effect-conflict");
    yield* releaseBudgetIn(transaction, locked.topupId, outcome === "confirmed");
  });
}

export function makeControlPlaneRewardGasTopupSendRepository() {
  return {
    loadActiveSigner: (chainId: number) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-gas-topup.wallet.read",
            text: `SELECT signer_address FROM reward_gas_topup_wallets
                    WHERE chain_id=$1 AND status='active'`,
            values: [chainId],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          if (result.rows.length !== 1) return yield* storage("invalid-row");
          return yield* parse(() => text(result.rows[0] as Row, "signer_address"));
        }),
      ),
    listOpen: (limit: number) =>
      mapped(
        Effect.gen(function* () {
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
            return yield* storage("invalid-row");
          }
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-gas-topup.open.list",
            text: `SELECT topup_id FROM reward_gas_topups
                    WHERE status IN ('requested','broadcast')
                    ORDER BY created_at, topup_id LIMIT $1`,
            values: [limit],
            readonly: true,
          });
          return yield* parse(() => result.rows.map((row) => text(row, "topup_id")));
        }),
      ),
    loadCandidate: (topupId: string) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-gas-topup.candidate.read",
            text: `SELECT topup.topup_id, topup.account_id, topup.credit_id,
                          topup.recipient_address, topup.chain_id, topup.amount_wei,
                          topup.target_balance_wei, topup.status, topup.effect_id,
                          gas.signer_address AS gas_signer_address
                     FROM reward_gas_topups topup
                     LEFT JOIN reward_gas_topup_wallets gas
                       ON gas.chain_id=topup.chain_id AND gas.status='active'
                    WHERE topup.topup_id=$1`,
            values: [topupId],
            readonly: true,
          });
          if (result.rows.length === 0) return yield* rejected("not-found");
          if (result.rows.length !== 1) return yield* storage("invalid-row");
          const row = result.rows[0] as Row;
          if (row.status !== "requested" || row.effect_id !== null) {
            return yield* rejected("effect-conflict");
          }
          if (row.gas_signer_address === null) return yield* rejected("gas-wallet-unavailable");
          return yield* parse(() => candidateFromRow(row, "gas_signer_address"));
        }),
      ),
    findProgress: (effectId: string) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-gas-topup.progress.read",
            text: `${PROGRESS_SELECT} WHERE effect.effect_id=$1`,
            values: [effectId],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          if (result.rows.length !== 1) return yield* storage("invalid-row");
          return yield* parse(() => progressFromRow(result.rows[0] as Row));
        }),
      ),
    releaseUnsent: (input: Parameters<RewardGasTopupSendStore["releaseUnsent"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const reason = input.reason.trim();
          if (reason.length === 0) return yield* rejected("effect-conflict");
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const released = yield* transaction.execute({
                label: "reward-gas-topup.unsent.release",
                text: `UPDATE reward_gas_topups
                          SET status='released', release_reason=$2,
                              released_at=clock_timestamp(), updated_at=clock_timestamp()
                        WHERE topup_id=$1 AND status='requested' AND effect_id IS NULL`,
                values: [input.topupId, reason],
                readonly: false,
              });
              if (released.rowCount !== 1) return yield* rejected("effect-conflict");
              yield* releaseBudgetIn(transaction, input.topupId, false);
            }),
          );
        }),
      ),
    reserveNonce: (input: Parameters<RewardGasTopupSendStore["reserveNonce"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) => reserveNonceIn(transaction, input));
        }),
      ),
    prepare: (input: Parameters<RewardGasTopupSendStore["prepare"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* transaction.execute({
                label: "reward-gas-topup.prepared-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,3,'prepared',jsonb_build_object(
                         'calldata_hash',$2::text,'signed_transaction_hash',$3::text
                       ))`,
                values: [
                  input.reservation.effectId,
                  input.calldataHash,
                  input.signedTransactionHash,
                ],
                readonly: false,
              });
              const prepared = yield* transaction.execute({
                label: "reward-gas-topup.effect.prepare",
                text: `UPDATE reward_chain_effects
                          SET state='prepared', version=3, calldata='0x',
                              calldata_hash=$2, signed_transaction=$3,
                              signed_transaction_hash=$4, prepared_at=$5,
                              updated_at=clock_timestamp()
                        WHERE effect_id=$1 AND effect_kind='gas_topup'
                          AND state='nonce_reserved' AND version=2 AND nonce=$6`,
                values: [
                  input.reservation.effectId,
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
        }),
      ),
    recordSubmission: (input: Parameters<RewardGasTopupSendStore["recordSubmission"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const reason = input.failureReason?.trim();
          if (input.outcome === "uncertain" && (reason === undefined || reason.length === 0)) {
            return yield* rejected("effect-conflict");
          }
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const locked = yield* lockEffectIn(
                transaction,
                input.effectId,
                "reward-gas-topup.submission.read",
              );
              if (
                locked.state !== "prepared" ||
                locked.signedTransactionHash !== input.transactionHash
              ) {
                return yield* rejected("effect-conflict");
              }
              const version = locked.version + 1;
              yield* transaction.execute({
                label: "reward-gas-topup.submission-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,$2,'broadcast_submitted',jsonb_build_object(
                         'transaction_hash',$3::text
                       ))`,
                values: [input.effectId, version, input.transactionHash],
                readonly: false,
              });
              const submitted = yield* transaction.execute({
                label: "reward-gas-topup.submission.record",
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
                yield* transaction.execute({
                  label: "reward-gas-topup.uncertain-transition.create",
                  text: `INSERT INTO reward_chain_effect_transitions (
                           effect_id, target_version, event_type, event
                         ) VALUES ($1,$2,'submission_uncertain',jsonb_build_object(
                           'failure_reason',$3::text
                         ))`,
                  values: [input.effectId, version + 1, reason],
                  readonly: false,
                });
                const uncertain = yield* transaction.execute({
                  label: "reward-gas-topup.uncertain.record",
                  text: `UPDATE reward_chain_effects
                            SET state='reconciliation_required', version=version+1,
                                failure_class='ambiguous_submission', failure_reason=$2,
                                updated_at=clock_timestamp()
                          WHERE effect_id=$1 AND state='broadcast_pending'`,
                  values: [input.effectId, reason],
                  readonly: false,
                });
                if (uncertain.rowCount !== 1) return yield* rejected("effect-conflict");
              }
              // An uncertain submission may still land, so the top-up is broadcast either way.
              const topup = yield* transaction.execute({
                label: "reward-gas-topup.broadcast.record",
                text: `UPDATE reward_gas_topups
                          SET status='broadcast', broadcast_at=$2, updated_at=clock_timestamp()
                        WHERE topup_id=$1 AND status='requested'`,
                values: [locked.topupId, input.submittedAt],
                readonly: false,
              });
              if (topup.rowCount !== 1) return yield* rejected("effect-conflict");
            }),
          );
        }),
      ),
    requireReconciliation: (
      input: Parameters<RewardGasTopupSendStore["requireReconciliation"]>[0],
    ) =>
      mapped(
        Effect.gen(function* () {
          const reason = input.reason.trim();
          if (reason.length === 0) return yield* rejected("effect-conflict");
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const locked = yield* lockEffectIn(
                transaction,
                input.effectId,
                "reward-gas-topup.reconciliation.read",
              );
              if (locked.transactionHash !== input.transactionHash) {
                return yield* rejected("effect-conflict");
              }
              if (locked.state === "reconciliation_required") return;
              if (locked.state !== "broadcast_pending" && locked.state !== "confirming") {
                return yield* rejected("effect-conflict");
              }
              const version = locked.version + 1;
              yield* transaction.execute({
                label: "reward-gas-topup.reconciliation-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,$2,'receipt_requires_reconciliation',jsonb_build_object(
                         'failure_reason',$3::text
                       ))`,
                values: [input.effectId, version, reason],
                readonly: false,
              });
              const updated = yield* transaction.execute({
                label: "reward-gas-topup.reconciliation.record",
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
        }),
      ),
    confirm: (input: ReceiptInput) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) => settleIn(transaction, input, "confirmed"));
        }),
      ),
    recordReverted: (input: ReceiptInput) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) => settleIn(transaction, input, "reverted"));
        }),
      ),
  };
}

export const makeControlPlaneRewardGasTopupSendStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RewardGasTopupSendStore => {
  const repository = makeControlPlaneRewardGasTopupSendRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    loadActiveSigner: (chainId) => provide(repository.loadActiveSigner(chainId)),
    listOpen: (limit) => provide(repository.listOpen(limit)),
    loadCandidate: (topupId) => provide(repository.loadCandidate(topupId)),
    findProgress: (effectId) => provide(repository.findProgress(effectId)),
    releaseUnsent: (input) => provide(repository.releaseUnsent(input)),
    reserveNonce: (input) => provide(repository.reserveNonce(input)),
    prepare: (input) => provide(repository.prepare(input)),
    recordSubmission: (input) => provide(repository.recordSubmission(input)),
    requireReconciliation: (input) => provide(repository.requireReconciliation(input)),
    confirm: (input) => provide(repository.confirm(input)),
    recordReverted: (input) => provide(repository.recordReverted(input)),
  };
};
