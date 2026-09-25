import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type RewardWinnerSendContext,
  type RewardWinnerSendNonceReader,
  type RewardWinnerSendOutcome,
  type RewardWinnerSendRecord,
  RewardWinnerSendRejected,
  type RewardWinnerSendStatus,
  RewardWinnerSendStorageFailed,
  type RewardWinnerSendStore,
} from "@pirate/application";
import { Effect, type Layer } from "effect";
import { CONFIRMED_PAYOUT_WALLET } from "./reward-gas-topup-repository.ts";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: RewardWinnerSendStorageFailed["reason"]) =>
  new RewardWinnerSendStorageFailed({ reason });
const rejected = (reason: RewardWinnerSendRejected["reason"]) =>
  new RewardWinnerSendRejected({ reason });

function mapError(error: ControlPlaneError): RewardWinnerSendStorageFailed {
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

const parse = <A>(build: () => A) =>
  Effect.try({ try: build, catch: () => storage("invalid-row") });

const statuses = new Set<RewardWinnerSendStatus>([
  "retryable",
  "pending",
  "confirmed",
  "reverted",
  "settled_unverified",
  "cancelled",
]);

const RECORD_SELECT = `
  SELECT send.send_id, send.credit_id, send.account_id, send.status, send.chain_id,
         send.sender_address, send.token_address, send.attempt,
         attempt.recipient_address, attempt.amount_atomic::text AS amount_atomic,
         attempt.nonce::text AS nonce,
         COALESCE((
           SELECT string_agg(transaction.transaction_hash, ','
                    ORDER BY transaction.created_at, transaction.transaction_hash)
             FROM reward_winner_send_transactions transaction
            WHERE transaction.send_id=send.send_id AND transaction.attempt=send.attempt
              AND transaction.kind='transfer'
         ), '') AS transaction_hashes,
         COALESCE((
           SELECT string_agg(transaction.transaction_hash, ','
                    ORDER BY transaction.created_at, transaction.transaction_hash)
             FROM reward_winner_send_transactions transaction
            WHERE transaction.send_id=send.send_id AND transaction.attempt=send.attempt
              AND transaction.kind='cancel'
         ), '') AS cancellation_hashes
    FROM reward_winner_sends send
    JOIN reward_winner_send_attempts attempt
      ON attempt.send_id=send.send_id AND attempt.attempt=send.attempt`;

function recordFromRow(row: Row): RewardWinnerSendRecord {
  const status = text(row, "status") as RewardWinnerSendStatus;
  if (!statuses.has(status)) throw new Error("invalid status");
  const hashes = row.transaction_hashes;
  const cancellations = row.cancellation_hashes;
  if (typeof hashes !== "string" || typeof cancellations !== "string") {
    throw new Error("invalid transaction hashes");
  }
  return {
    sendId: text(row, "send_id"),
    creditId: text(row, "credit_id"),
    accountId: text(row, "account_id"),
    status,
    chainId: integer(row, "chain_id"),
    senderAddress: text(row, "sender_address"),
    recipientAddress: text(row, "recipient_address"),
    tokenAddress: text(row, "token_address"),
    amountAtomic: bigint(row, "amount_atomic"),
    nonce: bigint(row, "nonce"),
    attempt: integer(row, "attempt"),
    transactionHashes: hashes.length === 0 ? [] : hashes.split(","),
    cancellationHashes: cancellations.length === 0 ? [] : cancellations.split(","),
  };
}

function oneRecord(rows: readonly Row[]) {
  if (rows.length === 0) return Effect.succeed(null);
  if (rows.length !== 1) return Effect.fail(storage("invalid-row"));
  return parse(() => recordFromRow(rows[0] as Row));
}

type Executor = Pick<ControlPlaneTransaction, "execute">;

function getIn(executor: Executor, input: { readonly accountId: string; readonly sendId: string }) {
  return Effect.gen(function* () {
    const result = yield* executor.execute<Row>({
      label: "reward-winner-send.record.read",
      text: `${RECORD_SELECT} WHERE send.account_id=$1 AND send.send_id=$2`,
      values: [input.accountId, input.sendId],
      readonly: true,
    });
    return yield* oneRecord(result.rows);
  });
}

function requireRecord(
  executor: Executor,
  input: { readonly accountId: string; readonly sendId: string },
) {
  return Effect.gen(function* () {
    const record = yield* getIn(executor, input);
    if (record === null) return yield* storage("invalid-row");
    return record;
  });
}

function lockIn(
  transaction: ControlPlaneTransaction,
  input: { readonly sendId: string; readonly accountId?: string },
) {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "reward-winner-send.record.lock",
      text: `SELECT account_id, attempt, status FROM reward_winner_sends
              WHERE send_id=$1 FOR UPDATE`,
      values: [input.sendId],
      readonly: false,
    });
    if (result.rows.length !== 1) return yield* rejected("not-found");
    const row = result.rows[0] as Row;
    const locked = yield* parse(() => ({
      accountId: text(row, "account_id"),
      attempt: integer(row, "attempt"),
      status: text(row, "status") as RewardWinnerSendStatus,
    }));
    if (input.accountId !== undefined && locked.accountId !== input.accountId) {
      return yield* rejected("not-found");
    }
    return locked;
  });
}

/** Serializes every nonce reservation for one sender on one chain. */
function lockSenderIn(
  transaction: ControlPlaneTransaction,
  sender: { readonly chainId: number; readonly senderAddress: string },
) {
  return transaction.execute({
    label: "reward-winner-send.sender.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    values: [`reward-winner-send:${sender.chainId}:${sender.senderAddress}`],
    readonly: false,
  });
}

/**
 * Under the sender lock: refuse while the sender has an open send, then read
 * the nonce and require it above every nonce the sender ever reserved, so a
 * stale read can never reuse a consumed or reserved nonce.
 */
function reserveSenderNonceIn(
  transaction: ControlPlaneTransaction,
  input: {
    readonly chainId: number;
    readonly senderAddress: string;
    readonly readNonce: RewardWinnerSendNonceReader;
  },
) {
  return Effect.gen(function* () {
    yield* lockSenderIn(transaction, input);
    const open = yield* transaction.execute<Row>({
      label: "reward-winner-send.sender-open.read",
      text: `SELECT 1 FROM reward_winner_sends
              WHERE chain_id=$1 AND sender_address=$2 AND status IN ('retryable','pending')
              LIMIT 1`,
      values: [input.chainId, input.senderAddress],
      readonly: false,
    });
    if (open.rows.length > 0) return yield* rejected("sender-busy");
    const highest = yield* transaction.execute<Row>({
      label: "reward-winner-send.sender-nonce.read",
      text: `SELECT max(attempt.nonce)::text AS nonce
               FROM reward_winner_send_attempts attempt
               JOIN reward_winner_sends send ON send.send_id=attempt.send_id
              WHERE send.chain_id=$1 AND send.sender_address=$2`,
      values: [input.chainId, input.senderAddress],
      readonly: false,
    });
    const row = highest.rows[0] as Row | undefined;
    const reserved =
      row === undefined || row.nonce === null ? null : yield* parse(() => bigint(row, "nonce"));
    const nonce = yield* input.readNonce;
    if (nonce < 0n || (reserved !== null && nonce <= reserved)) {
      return yield* rejected("nonce-not-consumed");
    }
    return nonce;
  });
}

function attemptHashesIn(
  executor: Executor,
  input: { readonly sendId: string; readonly attempt: number },
) {
  return Effect.gen(function* () {
    const result = yield* executor.execute<Row>({
      label: "reward-winner-send.attempt-hashes.read",
      text: `SELECT transaction_hash FROM reward_winner_send_transactions
              WHERE send_id=$1 AND attempt=$2`,
      values: [input.sendId, input.attempt],
      readonly: false,
    });
    return yield* parse(() => result.rows.map((row) => text(row, "transaction_hash")));
  });
}

function insertOutcomeIn(
  transaction: ControlPlaneTransaction,
  input: Readonly<{ sendId: string; attempt: number }> & RewardWinnerSendOutcome,
) {
  const evidence =
    input.outcome === "settled_unverified"
      ? { transactionHash: null, blockNumber: null, blockHash: null }
      : {
          transactionHash: input.transactionHash,
          blockNumber: input.blockNumber.toString(),
          blockHash: input.blockHash,
        };
  return transaction.execute({
    label: "reward-winner-send.outcome.create",
    text: `INSERT INTO reward_winner_send_outcomes (
             send_id, attempt, outcome, transaction_hash, block_number, block_hash,
             observed_head_block_number, observed_confirmed_nonce, confirmations
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    values: [
      input.sendId,
      input.attempt,
      input.outcome,
      evidence.transactionHash,
      evidence.blockNumber,
      evidence.blockHash,
      input.observedHeadBlockNumber.toString(),
      input.observedConfirmedNonce.toString(),
      input.confirmations,
    ],
    readonly: false,
  });
}

function contextFromRow(row: Row): RewardWinnerSendContext {
  return {
    creditId: text(row, "credit_id"),
    accountId: text(row, "account_id"),
    personaId: text(row, "payout_persona_id"),
    walletAssignmentId: text(row, "assignment_id"),
    senderAddress: text(row, "address"),
    tokenAddress: text(row, "token_address"),
    chainId: integer(row, "chain_id"),
    paidAtomic: bigint(row, "paid_atomic"),
  };
}

export function makeControlPlaneRewardWinnerSendRepository() {
  return {
    findByKey: (input: Parameters<RewardWinnerSendStore["findByKey"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-winner-send.idempotency.read",
            text: `SELECT send.send_id, send.credit_id, attempt.recipient_address,
                          attempt.amount_atomic::text AS amount_atomic
                     FROM reward_winner_send_attempts attempt
                     JOIN reward_winner_sends send ON send.send_id=attempt.send_id
                    WHERE attempt.account_id=$1 AND attempt.idempotency_key=$2`,
            values: [input.accountId, input.idempotencyKey],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          if (result.rows.length !== 1) return yield* storage("invalid-row");
          const row = result.rows[0] as Row;
          const match = yield* parse(() => ({
            sendId: text(row, "send_id"),
            creditId: text(row, "credit_id"),
            recipientAddress: text(row, "recipient_address"),
            amountAtomic: bigint(row, "amount_atomic"),
          }));
          const record = yield* requireRecord(db, {
            accountId: input.accountId,
            sendId: match.sendId,
          });
          return {
            creditId: match.creditId,
            recipientAddress: match.recipientAddress,
            amountAtomic: match.amountAtomic,
            record,
          };
        }),
      ),
    findByCredit: (input: Parameters<RewardWinnerSendStore["findByCredit"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-winner-send.credit.read",
            text: `${RECORD_SELECT} WHERE send.account_id=$1 AND send.credit_id=$2
                    ORDER BY (send.status <> 'cancelled') DESC, send.created_at DESC,
                             send.send_id DESC
                    LIMIT 1`,
            values: [input.accountId, input.creditId],
            readonly: true,
          });
          return yield* oneRecord(result.rows);
        }),
      ),
    get: (input: Parameters<RewardWinnerSendStore["get"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* getIn(db, input);
        }),
      ),
    loadContext: (input: Parameters<RewardWinnerSendStore["loadContext"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-winner-send.context.read",
            text: `SELECT credit.credit_id, credit.account_id, credit.payout_persona_id,
                          credit.chain_id, credit.token_address,
                          credit.paid_atomic::text AS paid_atomic,
                          credit.source_kind, credit.state,
                          EXISTS (
                            SELECT 1 FROM megapot_participant_claims claim
                             WHERE claim.credit_id=credit.credit_id
                               AND claim.status='accepted'
                          ) AS claimed,
                          wallet.assignment_id, wallet.address
                     FROM reward_ledger_credits credit
                     LEFT JOIN LATERAL (${CONFIRMED_PAYOUT_WALLET}) wallet ON true
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
            row.claimed !== true ||
            row.assignment_id === null ||
            row.address === null
          ) {
            return yield* rejected("credit-not-eligible");
          }
          return yield* parse(() => contextFromRow(row));
        }),
      ),
    create: (input: Parameters<RewardWinnerSendStore["create"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const { context } = input;
              const nonce = yield* reserveSenderNonceIn(transaction, {
                chainId: context.chainId,
                senderAddress: context.senderAddress,
                readNonce: input.readNonce,
              });
              yield* transaction.execute({
                label: "reward-winner-send.create",
                text: `INSERT INTO reward_winner_sends (
                         send_id, credit_id, account_id, persona_id, wallet_assignment_id,
                         chain_id, token_address, sender_address, attempt, status
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'retryable')`,
                values: [
                  input.sendId,
                  context.creditId,
                  context.accountId,
                  context.personaId,
                  context.walletAssignmentId,
                  context.chainId,
                  context.tokenAddress,
                  context.senderAddress,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "reward-winner-send.attempt.create",
                text: `INSERT INTO reward_winner_send_attempts (
                         send_id, attempt, account_id, idempotency_key, recipient_address,
                         amount_atomic, nonce
                       ) VALUES ($1,1,$2,$3,$4,$5,$6)`,
                values: [
                  input.sendId,
                  context.accountId,
                  input.idempotencyKey,
                  input.recipientAddress,
                  input.amountAtomic.toString(),
                  nonce.toString(),
                ],
                readonly: false,
              });
              return yield* requireRecord(transaction, {
                accountId: context.accountId,
                sendId: input.sendId,
              });
            }),
          );
        }),
      ),
    startAttempt: (input: Parameters<RewardWinnerSendStore["startAttempt"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const sender = yield* transaction.execute<Row>({
                label: "reward-winner-send.sender.read",
                text: `SELECT chain_id, sender_address FROM reward_winner_sends
                        WHERE send_id=$1 AND account_id=$2`,
                values: [input.sendId, input.accountId],
                readonly: false,
              });
              if (sender.rows.length !== 1) return yield* rejected("not-found");
              const identity = yield* parse(() => ({
                chainId: integer(sender.rows[0] as Row, "chain_id"),
                senderAddress: text(sender.rows[0] as Row, "sender_address"),
              }));
              // The sender lock comes before the row lock, as in create.
              yield* lockSenderIn(transaction, identity);
              const locked = yield* lockIn(transaction, input);
              if (locked.status !== "reverted" || locked.attempt !== input.previousAttempt) {
                return yield* rejected("send-conflict");
              }
              const nonce = yield* reserveSenderNonceIn(transaction, {
                ...identity,
                readNonce: input.readNonce,
              });
              const attempt = input.previousAttempt + 1;
              yield* transaction.execute({
                label: "reward-winner-send.retry-attempt.create",
                text: `INSERT INTO reward_winner_send_attempts (
                         send_id, attempt, account_id, idempotency_key, recipient_address,
                         amount_atomic, nonce
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                values: [
                  input.sendId,
                  attempt,
                  input.accountId,
                  input.idempotencyKey,
                  input.recipientAddress,
                  input.amountAtomic.toString(),
                  nonce.toString(),
                ],
                readonly: false,
              });
              const moved = yield* transaction.execute({
                label: "reward-winner-send.retry-attempt.start",
                text: `UPDATE reward_winner_sends
                          SET attempt=$2, status='retryable', updated_at=clock_timestamp()
                        WHERE send_id=$1 AND attempt=$3 AND status='reverted'`,
                values: [input.sendId, attempt, input.previousAttempt],
                readonly: false,
              });
              if (moved.rowCount !== 1) return yield* rejected("send-conflict");
              return yield* requireRecord(transaction, input);
            }),
          );
        }),
      ),
    attachTransaction: (input: Parameters<RewardWinnerSendStore["attachTransaction"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const locked = yield* lockIn(transaction, input);
              const existing = yield* transaction.execute<Row>({
                label: "reward-winner-send.transaction.read",
                text: `SELECT send_id, attempt, kind FROM reward_winner_send_transactions
                        WHERE transaction_hash=$1`,
                values: [input.transactionHash],
                readonly: false,
              });
              if (existing.rows.length > 0) {
                const row = existing.rows[0] as Row;
                if (
                  row.send_id !== input.sendId ||
                  Number(row.attempt) !== input.attempt ||
                  row.kind !== input.kind
                ) {
                  return yield* rejected("transaction-mismatch");
                }
                return yield* requireRecord(transaction, input);
              }
              if (
                locked.attempt !== input.attempt ||
                (locked.status !== "retryable" && locked.status !== "pending")
              ) {
                return yield* rejected("send-conflict");
              }
              yield* transaction.execute({
                label: "reward-winner-send.transaction.create",
                text: `INSERT INTO reward_winner_send_transactions (
                         transaction_hash, send_id, attempt, kind
                       ) VALUES ($1,$2,$3,$4)`,
                values: [input.transactionHash, input.sendId, input.attempt, input.kind],
                readonly: false,
              });
              return yield* requireRecord(transaction, input);
            }),
          );
        }),
      ),
    recordStatus: (input: Parameters<RewardWinnerSendStore["recordStatus"]>[0]) =>
      mapped<void, never, ControlPlaneDb>(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.execute({
            label: "reward-winner-send.status.record",
            text: `UPDATE reward_winner_sends
                      SET status=$3, updated_at=clock_timestamp()
                    WHERE send_id=$1 AND attempt=$2 AND status IN ('retryable','pending')
                      AND status <> $3`,
            values: [input.sendId, input.attempt, input.status],
            readonly: false,
          });
        }),
      ),
    recordOutcome: (input: Parameters<RewardWinnerSendStore["recordOutcome"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const locked = yield* lockIn(transaction, input);
              // Another request settled or moved this attempt first.
              if (
                locked.attempt !== input.attempt ||
                (locked.status !== "retryable" && locked.status !== "pending")
              ) {
                return "unchanged" as const;
              }
              // Under the row lock no hash can join the attempt; one that
              // joined since the observation makes the observation stale.
              const current = yield* attemptHashesIn(transaction, input);
              const observed = new Set(input.observedTransactionHashes);
              if (current.length !== observed.size || current.some((hash) => !observed.has(hash))) {
                return "stale" as const;
              }
              yield* insertOutcomeIn(transaction, input);
              const settled = yield* transaction.execute({
                label: "reward-winner-send.outcome.record",
                text: `UPDATE reward_winner_sends
                          SET status=$3, updated_at=clock_timestamp()
                        WHERE send_id=$1 AND attempt=$2 AND status IN ('retryable','pending')`,
                values: [input.sendId, input.attempt, input.outcome],
                readonly: false,
              });
              if (settled.rowCount !== 1) return yield* rejected("send-conflict");
              return "recorded" as const;
            }),
          );
        }),
      ),
    recoverConfirmed: (input: Parameters<RewardWinnerSendStore["recoverConfirmed"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const locked = yield* lockIn(transaction, input);
              if (locked.attempt !== input.attempt || locked.status !== "settled_unverified") {
                return yield* rejected("send-conflict");
              }
              const existing = yield* transaction.execute<Row>({
                label: "reward-winner-send.late-transaction.read",
                text: `SELECT send_id, attempt, kind FROM reward_winner_send_transactions
                        WHERE transaction_hash=$1`,
                values: [input.transactionHash],
                readonly: false,
              });
              if (existing.rows.length > 0) {
                const row = existing.rows[0] as Row;
                if (
                  row.send_id !== input.sendId ||
                  Number(row.attempt) !== input.attempt ||
                  row.kind !== "transfer"
                ) {
                  return yield* rejected("transaction-mismatch");
                }
              } else {
                yield* transaction.execute({
                  label: "reward-winner-send.late-transaction.create",
                  text: `INSERT INTO reward_winner_send_transactions (
                           transaction_hash, send_id, attempt, kind
                         ) VALUES ($1,$2,$3,'transfer')`,
                  values: [input.transactionHash, input.sendId, input.attempt],
                  readonly: false,
                });
              }
              yield* insertOutcomeIn(transaction, { ...input, outcome: "confirmed" });
              const recovered = yield* transaction.execute({
                label: "reward-winner-send.late-confirmation.record",
                text: `UPDATE reward_winner_sends
                          SET status='confirmed', updated_at=clock_timestamp()
                        WHERE send_id=$1 AND attempt=$2 AND status='settled_unverified'`,
                values: [input.sendId, input.attempt],
                readonly: false,
              });
              if (recovered.rowCount !== 1) return yield* rejected("send-conflict");
              return yield* requireRecord(transaction, input);
            }),
          );
        }),
      ),
  };
}

export const makeControlPlaneRewardWinnerSendStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RewardWinnerSendStore => {
  const repository = makeControlPlaneRewardWinnerSendRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    findByKey: (input) => provide(repository.findByKey(input)),
    findByCredit: (input) => provide(repository.findByCredit(input)),
    get: (input) => provide(repository.get(input)),
    loadContext: (input) => provide(repository.loadContext(input)),
    create: (input) => provide(repository.create(input)),
    startAttempt: (input) => provide(repository.startAttempt(input)),
    attachTransaction: (input) => provide(repository.attachTransaction(input)),
    recordStatus: (input) => provide(repository.recordStatus(input)),
    recordOutcome: (input) => provide(repository.recordOutcome(input)),
    recoverConfirmed: (input) => provide(repository.recoverConfirmed(input)),
  };
};
