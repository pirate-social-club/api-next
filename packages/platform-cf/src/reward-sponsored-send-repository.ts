import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Executor = Pick<ControlPlaneTransaction, "execute">;

export type SponsoredSendStatus =
  | "reserved"
  | "submitting"
  | "submitted"
  | "held"
  | "confirmed"
  | "reverted"
  | "abandoned";

export type SponsoredSendRecord = Readonly<{
  sendId: string;
  creditId: string;
  accountId: string;
  personaId: string;
  walletAssignmentId: string;
  walletId: string;
  chainId: 8453 | 84532;
  senderAddress: string;
  tokenAddress: string;
  recipientAddress: string;
  amountAtomic: bigint;
  paidAtomic: bigint;
  referenceId: string;
  idempotencyKey: string;
  providerIdempotencyKey: string;
  expiresAtMs: number;
  status: SponsoredSendStatus;
  providerTransactionId: string | null;
  userOperationHash: string | null;
  transactionHash: string | null;
  blockNumber: bigint | null;
  blockHash: string | null;
}>;

export type SponsoredSendCountLimits = Readonly<{
  perAccountUtcDay: number;
  perWalletUtcDay: number;
  platformUtcDay: number;
}>;

export class SponsoredSendRefused extends Error {
  constructor(readonly reason: "not-found" | "ineligible" | "conflict" | "limit" | "expired") {
    super(`sponsored send ${reason}`);
    this.name = "SponsoredSendRefused";
  }
}

const SELECT = `SELECT send.*, credit.paid_atomic::text AS paid_atomic
  FROM reward_sponsored_sends send
  JOIN reward_ledger_credits credit ON credit.credit_id=send.credit_id`;

function requiredText(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function optionalText(row: Row, field: string): string | null {
  const value = row[field];
  return value === null ? null : requiredText(row, field);
}

function parseRecord(row: Row): SponsoredSendRecord {
  const chainId = Number(row.chain_id);
  if (chainId !== 8453 && chainId !== 84532) throw new Error("invalid chain ID");
  const status = requiredText(row, "status") as SponsoredSendStatus;
  if (
    !new Set<SponsoredSendStatus>([
      "reserved",
      "submitting",
      "submitted",
      "held",
      "confirmed",
      "reverted",
      "abandoned",
    ]).has(status)
  )
    throw new Error("invalid sponsored send status");
  const expiresAt = row.request_expires_at;
  const expiresAtMs =
    expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(String(expiresAt));
  if (!Number.isFinite(expiresAtMs)) throw new Error("invalid request expiry");
  return {
    sendId: requiredText(row, "send_id"),
    creditId: requiredText(row, "credit_id"),
    accountId: requiredText(row, "account_id"),
    personaId: requiredText(row, "persona_id"),
    walletAssignmentId: requiredText(row, "wallet_assignment_id"),
    walletId: requiredText(row, "privy_wallet_id"),
    chainId,
    senderAddress: requiredText(row, "sender_address"),
    tokenAddress: requiredText(row, "token_address"),
    recipientAddress: requiredText(row, "recipient_address"),
    amountAtomic: BigInt(requiredText(row, "amount_atomic")),
    paidAtomic: BigInt(requiredText(row, "paid_atomic")),
    referenceId: requiredText(row, "reference_id"),
    idempotencyKey: requiredText(row, "idempotency_key"),
    providerIdempotencyKey: requiredText(row, "provider_idempotency_key"),
    expiresAtMs,
    status,
    providerTransactionId: optionalText(row, "provider_transaction_id"),
    userOperationHash: optionalText(row, "user_operation_hash"),
    transactionHash: optionalText(row, "transaction_hash"),
    blockNumber: row.block_number === null ? null : BigInt(String(row.block_number)),
    blockHash: optionalText(row, "block_hash"),
  };
}

function readIn(executor: Executor, accountId: string, sendId: string) {
  return Effect.gen(function* () {
    const result = yield* executor.execute<Row>({
      label: "reward-sponsored-send.read",
      text: `${SELECT} WHERE send.account_id=$1 AND send.send_id=$2`,
      values: [accountId, sendId],
      readonly: true,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new Error("duplicate sponsored send");
    return parseRecord(result.rows[0] as Row);
  });
}

function findByCreditIn(executor: Executor, accountId: string, creditId: string) {
  return Effect.gen(function* () {
    const result = yield* executor.execute<Row>({
      label: "reward-sponsored-send.credit.read",
      text: `${SELECT} WHERE send.account_id=$1 AND send.credit_id=$2
        ORDER BY (send.status <> 'abandoned') DESC, send.created_at DESC LIMIT 1`,
      values: [accountId, creditId],
      readonly: true,
    });
    return result.rows.length === 0 ? null : parseRecord(result.rows[0] as Row);
  });
}

/** A single global lock keeps account, wallet and platform reservations serializable. */
function lockBudgetIn(transaction: ControlPlaneTransaction) {
  return transaction.execute({
    label: "reward-sponsored-send.budget.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended('reward-sponsored-send-budget',0))",
    values: [],
    readonly: false,
  });
}

function positiveLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function makeControlPlaneSponsoredSendRepository(limits: SponsoredSendCountLimits) {
  if (
    !positiveLimit(limits.perAccountUtcDay) ||
    !positiveLimit(limits.perWalletUtcDay) ||
    !positiveLimit(limits.platformUtcDay)
  )
    throw new Error("sponsorship count limits must be positive");

  return {
    get: (input: { accountId: string; sendId: string }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* readIn(db, input.accountId, input.sendId);
      }),
    findByCredit: (input: { accountId: string; creditId: string }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* findByCreditIn(db, input.accountId, input.creditId);
      }),
    reserve: (input: {
      accountId: string;
      creditId: string;
      recipientAddress: string;
      amountAtomic: bigint;
      idempotencyKey: string;
      providerIdempotencyKey: string;
      sendId: string;
      referenceId: string;
    }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* lockBudgetIn(transaction);
            const replay = yield* transaction.execute<Row>({
              label: "reward-sponsored-send.idempotency.read",
              text: `${SELECT} WHERE send.account_id=$1 AND send.idempotency_key=$2`,
              values: [input.accountId, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length > 0) {
              const existing = parseRecord(replay.rows[0] as Row);
              if (
                existing.creditId !== input.creditId ||
                existing.recipientAddress !== input.recipientAddress ||
                existing.amountAtomic !== input.amountAtomic
              )
                return yield* Effect.fail(new SponsoredSendRefused("conflict"));
              return existing;
            }
            // A never-submitted authorization cannot remain a live reservation
            // forever. The database guard permits this transition only after
            // the signed request has expired.
            yield* transaction.execute({
              label: "reward-sponsored-send.expired-reservation.abandon",
              text: `UPDATE reward_sponsored_sends
                SET status='abandoned', updated_at=clock_timestamp()
                WHERE account_id=$1 AND credit_id=$2 AND status='reserved'
                  AND request_expires_at < clock_timestamp()`,
              values: [input.accountId, input.creditId],
              readonly: false,
            });
            const previous = yield* findByCreditIn(transaction, input.accountId, input.creditId);
            if (previous !== null && previous.status !== "abandoned") {
              if (
                previous.recipientAddress !== input.recipientAddress ||
                previous.amountAtomic !== input.amountAtomic
              )
                return yield* Effect.fail(new SponsoredSendRefused("conflict"));
              return previous;
            }
            const context = yield* transaction.execute<Row>({
              label: "reward-sponsored-send.context.read",
              text: `SELECT credit.credit_id, credit.account_id, credit.payout_persona_id AS persona_id,
                  credit.chain_id, credit.token_address, credit.paid_atomic::text AS paid_atomic,
                  credit.source_kind, credit.state,
                  claim.status AS claim_status,
                  payout.wallet_assignment_id, payout.destination_address AS sender_address,
                  wallet.privy_wallet_id, wallet.status AS wallet_status,
                  evidence.effect_id AS payout_evidence_id,
                  payout_effect.effect_id AS confirmed_payout_effect_id
                FROM reward_ledger_credits credit
                LEFT JOIN megapot_participant_claims claim
                  ON claim.credit_id=credit.credit_id AND claim.status='accepted'
                LEFT JOIN reward_payout_effects payout
                  ON payout.credit_id=credit.credit_id AND payout.account_id=credit.account_id
                LEFT JOIN reward_chain_effects payout_effect
                  ON payout_effect.effect_id=payout.payout_effect_id AND payout_effect.state='confirmed'
                LEFT JOIN reward_erc20_transfer_receipt_evidence evidence
                  ON evidence.effect_id=payout.payout_effect_id
                 AND evidence.transfer_purpose='reward_payout'
                 AND evidence.recipient_address=payout.destination_address
                LEFT JOIN persona_wallet_assignments wallet
                  ON wallet.assignment_id=payout.wallet_assignment_id
                WHERE credit.credit_id=$1 AND credit.account_id=$2`,
              values: [input.creditId, input.accountId],
              readonly: false,
            });
            if (context.rows.length === 0)
              return yield* Effect.fail(new SponsoredSendRefused("not-found"));
            if (context.rows.length !== 1) throw new Error("duplicate payout context");
            const row = context.rows[0] as Row;
            const chainId = Number(row.chain_id);
            if (
              row.source_kind !== "megapot_allocation" ||
              row.state !== "sent" ||
              row.claim_status !== "accepted" ||
              row.wallet_assignment_id === null ||
              row.privy_wallet_id === null ||
              row.wallet_status !== "active" ||
              row.sender_address === null ||
              row.payout_evidence_id === null ||
              row.confirmed_payout_effect_id === null ||
              (chainId !== 8453 && chainId !== 84532) ||
              input.amountAtomic <= 0n ||
              input.amountAtomic > BigInt(String(row.paid_atomic)) ||
              row.token_address === input.recipientAddress ||
              row.sender_address === input.recipientAddress
            )
              return yield* Effect.fail(new SponsoredSendRefused("ineligible"));
            const counts = yield* transaction.execute<Row>({
              label: "reward-sponsored-send.quota.read",
              text: `SELECT count(*)::int AS platform_count,
                count(*) FILTER (WHERE account_id=$1)::int AS account_count,
                count(*) FILTER (WHERE wallet_assignment_id=$2)::int AS wallet_count
                FROM reward_sponsored_sends
                WHERE created_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  AND status <> 'abandoned'`,
              values: [input.accountId, row.wallet_assignment_id],
              readonly: false,
            });
            const usage = counts.rows[0] as Row | undefined;
            if (
              usage === undefined ||
              Number(usage.platform_count) >= limits.platformUtcDay ||
              Number(usage.account_count) >= limits.perAccountUtcDay ||
              Number(usage.wallet_count) >= limits.perWalletUtcDay
            )
              return yield* Effect.fail(new SponsoredSendRefused("limit"));
            yield* transaction.execute({
              label: "reward-sponsored-send.reserve",
              text: `INSERT INTO reward_sponsored_sends (
                send_id, credit_id, account_id, persona_id, wallet_assignment_id,
                privy_wallet_id, chain_id, sender_address, token_address,
                recipient_address, amount_atomic, reference_id, idempotency_key,
                provider_idempotency_key, request_expires_at, status
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                clock_timestamp()+INTERVAL '4 minutes','reserved')`,
              values: [
                input.sendId,
                input.creditId,
                input.accountId,
                row.persona_id,
                row.wallet_assignment_id,
                row.privy_wallet_id,
                chainId,
                row.sender_address,
                row.token_address,
                input.recipientAddress,
                input.amountAtomic.toString(),
                input.referenceId,
                input.idempotencyKey,
                input.providerIdempotencyKey,
              ],
              readonly: false,
            });
            const created = yield* readIn(transaction, input.accountId, input.sendId);
            if (created === null) throw new Error("reservation not visible");
            return created;
          }),
        );
      }),
    markSubmitting: (input: { accountId: string; sendId: string }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "reward-sponsored-send.submitting",
          text: `UPDATE reward_sponsored_sends SET status='submitting', updated_at=clock_timestamp()
            WHERE account_id=$1 AND send_id=$2 AND status='reserved'
              AND request_expires_at > clock_timestamp()
            RETURNING send_id`,
          values: [input.accountId, input.sendId],
          readonly: false,
        });
        if (result.rowCount !== 1) return yield* Effect.fail(new SponsoredSendRefused("conflict"));
      }),
    recordSubmission: (input: {
      accountId: string;
      sendId: string;
      providerTransactionId: string | null;
      userOperationHash: string | null;
      transactionHash: string | null;
    }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "reward-sponsored-send.submitted",
          text: `UPDATE reward_sponsored_sends
            SET status='submitted', provider_transaction_id=$3,
                user_operation_hash=$4, transaction_hash=$5, updated_at=clock_timestamp()
            WHERE account_id=$1 AND send_id=$2 AND status='submitting'`,
          values: [
            input.accountId,
            input.sendId,
            input.providerTransactionId,
            input.userOperationHash,
            input.transactionHash,
          ],
          readonly: false,
        });
        if (result.rowCount !== 1) return yield* Effect.fail(new SponsoredSendRefused("conflict"));
      }),
    markHeld: (input: { accountId: string; sendId: string }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.execute({
          label: "reward-sponsored-send.held",
          text: `UPDATE reward_sponsored_sends SET status='held', updated_at=clock_timestamp()
            WHERE account_id=$1 AND send_id=$2 AND status IN ('submitting','submitted')`,
          values: [input.accountId, input.sendId],
          readonly: false,
        });
      }),
    attachObservation: (input: {
      accountId: string;
      sendId: string;
      providerTransactionId: string;
      transactionHash: string | null;
    }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "reward-sponsored-send.observation.attach",
          text: `UPDATE reward_sponsored_sends
            SET provider_transaction_id=$3, transaction_hash=COALESCE($4,transaction_hash),
                updated_at=clock_timestamp()
            WHERE account_id=$1 AND send_id=$2 AND status IN ('submitting','submitted','held')
              AND (provider_transaction_id IS NULL OR provider_transaction_id=$3)
              AND (transaction_hash IS NULL OR transaction_hash=$4 OR $4 IS NULL)`,
          values: [
            input.accountId,
            input.sendId,
            input.providerTransactionId,
            input.transactionHash,
          ],
          readonly: false,
        });
        if (result.rowCount !== 1) return yield* Effect.fail(new SponsoredSendRefused("conflict"));
      }),
    recordFinal: (input: {
      accountId: string;
      sendId: string;
      outcome: "confirmed" | "reverted";
      transactionHash: string;
      blockNumber: bigint;
      blockHash: string;
    }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "reward-sponsored-send.final",
          text: `UPDATE reward_sponsored_sends
            SET status=$3, transaction_hash=$4, block_number=$5,
                block_hash=$6, updated_at=clock_timestamp()
            WHERE account_id=$1 AND send_id=$2 AND status IN ('submitted','held')
              AND (transaction_hash IS NULL OR transaction_hash=$4)`,
          values: [
            input.accountId,
            input.sendId,
            input.outcome,
            input.transactionHash,
            input.blockNumber.toString(),
            input.blockHash,
          ],
          readonly: false,
        });
        if (result.rowCount !== 1) return yield* Effect.fail(new SponsoredSendRefused("conflict"));
      }),
    abandonUnsigned: (input: { accountId: string; sendId: string }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute({
          label: "reward-sponsored-send.abandon-unsigned",
          text: `UPDATE reward_sponsored_sends SET status='abandoned', updated_at=clock_timestamp()
            WHERE account_id=$1 AND send_id=$2 AND status='reserved'
              AND request_expires_at < clock_timestamp()`,
          values: [input.accountId, input.sendId],
          readonly: false,
        });
        if (result.rowCount !== 1) return yield* Effect.fail(new SponsoredSendRefused("conflict"));
      }),
  };
}

export function makeControlPlaneSponsoredSendStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  limits: SponsoredSendCountLimits,
) {
  const repository = makeControlPlaneSponsoredSendRepository(limits);
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(layer)(effect);
  return {
    get: (input: Parameters<typeof repository.get>[0]) => provide(repository.get(input)),
    findByCredit: (input: Parameters<typeof repository.findByCredit>[0]) =>
      provide(repository.findByCredit(input)),
    reserve: (input: Parameters<typeof repository.reserve>[0]) =>
      provide(repository.reserve(input)),
    markSubmitting: (input: Parameters<typeof repository.markSubmitting>[0]) =>
      provide(repository.markSubmitting(input)),
    recordSubmission: (input: Parameters<typeof repository.recordSubmission>[0]) =>
      provide(repository.recordSubmission(input)),
    markHeld: (input: Parameters<typeof repository.markHeld>[0]) =>
      provide(repository.markHeld(input)),
    attachObservation: (input: Parameters<typeof repository.attachObservation>[0]) =>
      provide(repository.attachObservation(input)),
    recordFinal: (input: Parameters<typeof repository.recordFinal>[0]) =>
      provide(repository.recordFinal(input)),
    abandonUnsigned: (input: Parameters<typeof repository.abandonUnsigned>[0]) =>
      provide(repository.abandonUnsigned(input)),
  };
}
