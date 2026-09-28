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
  accountId: string;
  personaId: string;
  walletAssignmentId: string;
  walletId: string;
  chainId: 8453 | 84532;
  senderAddress: string;
  tokenAddress: string;
  recipientAddress: string;
  amountAtomic: bigint;
  gasBudgetWei: bigint;
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
  gasBudgetPerSendWei: bigint;
  accountDailyGasBudgetWei: bigint;
  walletDailyGasBudgetWei: bigint;
  platformDailyGasBudgetWei: bigint;
}>;

export class SponsoredSendRefused extends Error {
  constructor(readonly reason: "not-found" | "ineligible" | "conflict" | "limit" | "expired") {
    super(`sponsored send ${reason}`);
    this.name = "SponsoredSendRefused";
  }
}

const SELECT = `SELECT send.* FROM wallet_sponsored_sends send`;

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
    accountId: requiredText(row, "account_id"),
    personaId: requiredText(row, "persona_id"),
    walletAssignmentId: requiredText(row, "wallet_assignment_id"),
    walletId: requiredText(row, "privy_wallet_id"),
    chainId,
    senderAddress: requiredText(row, "sender_address"),
    tokenAddress: requiredText(row, "token_address"),
    recipientAddress: requiredText(row, "recipient_address"),
    amountAtomic: BigInt(requiredText(row, "amount_atomic")),
    gasBudgetWei: BigInt(requiredText(row, "gas_budget_wei")),
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
      label: "wallet-sponsored-send.read",
      text: `${SELECT} WHERE send.account_id=$1 AND send.send_id=$2`,
      values: [accountId, sendId],
      readonly: true,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new Error("duplicate sponsored send");
    return parseRecord(result.rows[0] as Row);
  });
}

function findByPersonaIn(executor: Executor, accountId: string, personaId: string) {
  return Effect.gen(function* () {
    const result = yield* executor.execute<Row>({
      label: "wallet-sponsored-send.persona.read",
      text: `${SELECT} WHERE send.account_id=$1 AND send.persona_id=$2
        ORDER BY (send.status IN ('reserved','submitting','submitted','held')) DESC,
          send.created_at DESC LIMIT 1`,
      values: [accountId, personaId],
      readonly: true,
    });
    return result.rows.length === 0 ? null : parseRecord(result.rows[0] as Row);
  });
}

/** A single global lock keeps account, wallet and platform reservations serializable. */
function lockBudgetIn(transaction: ControlPlaneTransaction) {
  return transaction.execute({
    label: "wallet-sponsored-send.budget.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended('wallet-sponsored-send-budget',0))",
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
    !positiveLimit(limits.platformUtcDay) ||
    limits.gasBudgetPerSendWei <= 0n ||
    limits.accountDailyGasBudgetWei < limits.gasBudgetPerSendWei ||
    limits.walletDailyGasBudgetWei < limits.gasBudgetPerSendWei ||
    limits.platformDailyGasBudgetWei < limits.gasBudgetPerSendWei
  )
    throw new Error("sponsorship count limits must be positive");

  return {
    get: (input: { accountId: string; sendId: string }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* readIn(db, input.accountId, input.sendId);
      }),
    findByPersona: (input: { accountId: string; personaId: string }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* findByPersonaIn(db, input.accountId, input.personaId);
      }),
    reserve: (input: {
      accountId: string;
      personaId: string;
      chainId: 8453 | 84532;
      tokenAddress: string;
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
              label: "wallet-sponsored-send.idempotency.read",
              text: `${SELECT} WHERE send.account_id=$1 AND send.idempotency_key=$2`,
              values: [input.accountId, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length > 0) {
              const existing = parseRecord(replay.rows[0] as Row);
              if (
                existing.personaId !== input.personaId ||
                existing.chainId !== input.chainId ||
                existing.tokenAddress !== input.tokenAddress ||
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
              label: "wallet-sponsored-send.expired-reservation.abandon",
              text: `UPDATE wallet_sponsored_sends
                SET status='abandoned', updated_at=clock_timestamp()
                WHERE account_id=$1 AND persona_id=$2 AND chain_id=$3 AND status='reserved'
                  AND request_expires_at < clock_timestamp()`,
              values: [input.accountId, input.personaId, input.chainId],
              readonly: false,
            });
            const open = yield* transaction.execute<Row>({
              label: "wallet-sponsored-send.open.read",
              text: `${SELECT} WHERE send.account_id=$1 AND send.persona_id=$2
                AND send.chain_id=$3 AND send.status IN ('reserved','submitting','submitted','held')
                ORDER BY send.created_at DESC LIMIT 1`,
              values: [input.accountId, input.personaId, input.chainId],
              readonly: false,
            });
            if (open.rows.length > 0) {
              const previous = parseRecord(open.rows[0] as Row);
              if (
                previous.tokenAddress !== input.tokenAddress ||
                previous.recipientAddress !== input.recipientAddress ||
                previous.amountAtomic !== input.amountAtomic
              )
                return yield* Effect.fail(new SponsoredSendRefused("conflict"));
              return previous;
            }
            const context = yield* transaction.execute<Row>({
              label: "wallet-sponsored-send.context.read",
              text: `SELECT wallet.assignment_id AS wallet_assignment_id,
                  wallet.privy_wallet_id, wallet.address AS sender_address,
                  wallet.status AS wallet_status, persona.status AS persona_status
                FROM persona_wallet_assignments wallet
                JOIN personas persona ON persona.persona_id=wallet.persona_id
                  AND persona.account_id=wallet.account_id
                WHERE wallet.persona_id=$1 AND wallet.account_id=$2
                  AND wallet.chain_account_kind='evm'`,
              values: [input.personaId, input.accountId],
              readonly: false,
            });
            if (context.rows.length === 0)
              return yield* Effect.fail(new SponsoredSendRefused("not-found"));
            if (context.rows.length !== 1) throw new Error("duplicate persona wallet context");
            const row = context.rows[0] as Row;
            if (
              row.wallet_assignment_id === null ||
              row.privy_wallet_id === null ||
              row.wallet_status !== "active" ||
              row.persona_status !== "active" ||
              row.sender_address === null ||
              input.amountAtomic <= 0n ||
              input.tokenAddress === input.recipientAddress ||
              row.sender_address === input.recipientAddress
            )
              return yield* Effect.fail(new SponsoredSendRefused("ineligible"));
            const siblingRecipient = yield* transaction.execute<Row>({
              label: "wallet-sponsored-send.sibling-recipient.read",
              text: `SELECT 1 FROM persona_wallet_assignments wallet
                WHERE wallet.account_id=$1 AND wallet.persona_id<>$2
                  AND lower(wallet.address)=$3
                LIMIT 1`,
              values: [input.accountId, input.personaId, input.recipientAddress],
              readonly: false,
            });
            if (siblingRecipient.rows.length > 0)
              return yield* Effect.fail(new SponsoredSendRefused("ineligible"));
            const counts = yield* transaction.execute<Row>({
              label: "wallet-sponsored-send.quota.read",
              text: `SELECT count(*)::int AS platform_count,
                count(*) FILTER (WHERE account_id=$1)::int AS account_count,
                count(*) FILTER (WHERE wallet_assignment_id=$2)::int AS wallet_count,
                COALESCE(sum(gas_budget_wei),0)::text AS platform_gas_wei,
                COALESCE(sum(gas_budget_wei) FILTER (WHERE account_id=$1),0)::text
                  AS account_gas_wei,
                COALESCE(sum(gas_budget_wei) FILTER (WHERE wallet_assignment_id=$2),0)::text
                  AS wallet_gas_wei
                FROM wallet_sponsored_sends
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
              Number(usage.wallet_count) >= limits.perWalletUtcDay ||
              BigInt(String(usage.platform_gas_wei)) + limits.gasBudgetPerSendWei >
                limits.platformDailyGasBudgetWei ||
              BigInt(String(usage.account_gas_wei)) + limits.gasBudgetPerSendWei >
                limits.accountDailyGasBudgetWei ||
              BigInt(String(usage.wallet_gas_wei)) + limits.gasBudgetPerSendWei >
                limits.walletDailyGasBudgetWei
            )
              return yield* Effect.fail(new SponsoredSendRefused("limit"));
            yield* transaction.execute({
              label: "wallet-sponsored-send.reserve",
              text: `INSERT INTO wallet_sponsored_sends (
                send_id, account_id, persona_id, wallet_assignment_id,
                privy_wallet_id, chain_id, sender_address, token_address,
                recipient_address, amount_atomic, gas_budget_wei, reference_id, idempotency_key,
                provider_idempotency_key, request_expires_at, status
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                clock_timestamp()+INTERVAL '4 minutes','reserved')`,
              values: [
                input.sendId,
                input.accountId,
                input.personaId,
                row.wallet_assignment_id,
                row.privy_wallet_id,
                input.chainId,
                row.sender_address,
                input.tokenAddress,
                input.recipientAddress,
                input.amountAtomic.toString(),
                limits.gasBudgetPerSendWei.toString(),
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
          label: "wallet-sponsored-send.submitting",
          text: `UPDATE wallet_sponsored_sends SET status='submitting', updated_at=clock_timestamp()
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
          label: "wallet-sponsored-send.submitted",
          text: `UPDATE wallet_sponsored_sends
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
          label: "wallet-sponsored-send.held",
          text: `UPDATE wallet_sponsored_sends SET status='held', updated_at=clock_timestamp()
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
          label: "wallet-sponsored-send.observation.attach",
          text: `UPDATE wallet_sponsored_sends
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
          label: "wallet-sponsored-send.final",
          text: `UPDATE wallet_sponsored_sends
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
          label: "wallet-sponsored-send.abandon-unsigned",
          text: `UPDATE wallet_sponsored_sends SET status='abandoned', updated_at=clock_timestamp()
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
    findByPersona: (input: Parameters<typeof repository.findByPersona>[0]) =>
      provide(repository.findByPersona(input)),
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
