import {
  COMMUNITY_PURCHASE_FUNDING_ENDPOINT,
  type CommunityPurchaseFundingAdmissionStore,
  type CommunityPurchaseFundingAdmissionStoreInput,
  type CommunityPurchaseFundingAttemptState,
  type CommunityPurchaseFundingJournalRecord,
  type CommunityPurchaseFundingJournalStore,
  type CommunityPurchaseFundingParkedCount,
  type CommunityPurchaseFundingPlanRecord,
  type CommunityPurchaseFundingPlanStore,
  type CommunityPurchaseFundingQueryStore,
  type CommunityPurchaseFundingReconciliationAttemptStore,
  CommunityPurchaseFundingStorageFailed,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  confirmedCommunityPurchaseReceiptId,
  decodeCommunityPurchaseFundingSnapshot,
  encodeCommunityPurchaseFundingEvent,
  encodeCommunityPurchaseFundingSnapshot,
  journalEntryFromCommunityPurchaseFunding,
  normalizeCommunityPurchaseEvmAddress,
} from "@pirate/application";
import {
  type Bytes32,
  type CommunityPurchaseFundingEvent,
  type CommunityPurchaseFundingEvidence,
  type CommunityPurchaseFundingPlan,
  type CommunityPurchaseFundingSnapshot,
  type CommunityPurchaseOperationId,
  communityPurchaseAtomicAmount,
  createCommunityPurchaseFunding,
  deriveCommunityPurchaseOperationId,
  type EvmAddress,
  type MoneyFlowJournalEntry,
  type ReconciliationFailureClass,
} from "@pirate/domain";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;
type RepositoryError = CommunityPurchaseFundingStorageFailed | ControlPlaneError;
type BeginInput = Parameters<CommunityPurchaseFundingJournalStore["begin"]>[0];
type AcquireLeaseInput = Parameters<CommunityPurchaseFundingJournalStore["acquireLease"]>[0];
type WasTransitionCommittedInput = Parameters<
  CommunityPurchaseFundingJournalStore["wasTransitionCommitted"]
>[0];
type CommitTransitionInput = Parameters<
  CommunityPurchaseFundingJournalStore["commitTransition"]
>[0];
type LoadForActorInput = Parameters<CommunityPurchaseFundingQueryStore["loadForActor"]>[0];
type ListReconcilableInput = Parameters<CommunityPurchaseFundingQueryStore["listReconcilable"]>[0];
type ListDormancyCandidatesInput = Parameters<
  CommunityPurchaseFundingQueryStore["listDormancyCandidates"]
>[0];
type RecordAttemptStartInput = Parameters<
  CommunityPurchaseFundingReconciliationAttemptStore["recordAttemptStart"]
>[0];
type RecordAttemptSuccessInput = Parameters<
  CommunityPurchaseFundingReconciliationAttemptStore["recordAttemptSuccess"]
>[0];
type RecordAttemptFailureInput = Parameters<
  CommunityPurchaseFundingReconciliationAttemptStore["recordAttemptFailure"]
>[0];
type CreatePlanInput = Parameters<CommunityPurchaseFundingPlanStore["createPlan"]>[0];

const JOURNAL_COLUMNS = `
  operation_id, community_id, actor_id, quote_id, purchase_id, policy_version,
  chain_id, token_contract, token_decimals, expected_sender, expected_recipient,
  expected_amount_atomic, required_confirmations, state, version, snapshot,
  failure_tag, failure_reason, funding_receipt_status, funding_transaction_hash,
  funding_log_index, funding_observation_id, lease_owner, lease_fence_token,
  lease_expires_at`;

function storageFailure(
  reason: CommunityPurchaseFundingStorageFailed["reason"],
): CommunityPurchaseFundingStorageFailed {
  return new CommunityPurchaseFundingStorageFailed({ reason });
}

function mapRepositoryError(error: RepositoryError): CommunityPurchaseFundingStorageFailed {
  if (error._tag === "CommunityPurchaseFundingStorageFailed") return error;
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") {
    return storageFailure("outcome-unknown");
  }
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return storageFailure("outcome-unknown");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState === "23505") {
    return storageFailure("constraint");
  }
  return storageFailure("unavailable");
}

function requiredString(row: Row, field: string): string | null {
  return typeof row[field] === "string" ? row[field] : null;
}

function integer(row: Row, field: string): number | null {
  const value = row[field];
  const candidate =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : typeof value === "string" && /^-?[0-9]+$/u.test(value)
          ? Number(value)
          : Number.NaN;
  return Number.isSafeInteger(candidate) ? candidate : null;
}

function timestamp(row: Row, field: string): string | null {
  const value = row[field];
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

const RECONCILIATION_FAILURE_CLASSES = new Set<ReconciliationFailureClass>([
  "lease_contention",
  "chain_unavailable",
  "chain_timeout",
  "transaction_not_found",
  "invalid_evidence",
  "reorg",
  "identity_conflict",
]);

function attemptFromRow(row: Row): CommunityPurchaseFundingAttemptState | null {
  const operationId = requiredString(row, "operation_id");
  const generation = integer(row, "generation");
  const lastAttemptAt = timestamp(row, "last_attempt_at");
  const nextAttemptAt = timestamp(row, "next_attempt_at");
  const failureValue = row.last_failure_class;
  const lastFailureClass =
    failureValue === null || failureValue === undefined
      ? null
      : typeof failureValue === "string" &&
          RECONCILIATION_FAILURE_CLASSES.has(failureValue as ReconciliationFailureClass)
        ? (failureValue as ReconciliationFailureClass)
        : undefined;
  const consecutiveFailures = integer(row, "consecutive_failures");
  const escalatedAt = timestamp(row, "escalated_at");
  if (
    operationId === null ||
    generation === null ||
    generation < 0 ||
    lastFailureClass === undefined ||
    consecutiveFailures === null ||
    consecutiveFailures < 0 ||
    (row.last_attempt_at !== null && row.last_attempt_at !== undefined && lastAttemptAt === null) ||
    (row.next_attempt_at !== null && row.next_attempt_at !== undefined && nextAttemptAt === null) ||
    (row.escalated_at !== null && row.escalated_at !== undefined && escalatedAt === null)
  ) {
    return null;
  }
  return {
    operationId: operationId as CommunityPurchaseOperationId,
    generation,
    lastAttemptAt,
    nextAttemptAt,
    lastFailureClass,
    consecutiveFailures,
    escalatedAt,
  };
}

function jsonValue(row: Row, field: string): unknown {
  const value = row[field];
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function oneRow(
  rows: readonly Row[],
): Effect.Effect<Row | null, CommunityPurchaseFundingStorageFailed> {
  return rows.length <= 1
    ? Effect.succeed(rows[0] ?? null)
    : Effect.fail(storageFailure("invalid-row"));
}

function recordFromRow(row: Row): CommunityPurchaseFundingJournalRecord | null {
  const snapshot = decodeCommunityPurchaseFundingSnapshot(jsonValue(row, "snapshot"));
  if (snapshot === null) return null;
  const version = integer(row, "version");
  const policyVersion = integer(row, "policy_version");
  const chainId = integer(row, "chain_id");
  const tokenDecimals = integer(row, "token_decimals");
  const requiredConfirmations = integer(row, "required_confirmations");
  if (
    version !== snapshot.version ||
    requiredString(row, "operation_id") !== snapshot.operationId ||
    requiredString(row, "community_id") !== snapshot.communityId ||
    requiredString(row, "quote_id") !== snapshot.quoteId ||
    requiredString(row, "purchase_id") !== snapshot.purchaseId ||
    policyVersion !== snapshot.policyVersion ||
    chainId !== snapshot.expected.chainId ||
    requiredString(row, "token_contract") !== snapshot.expected.tokenContract ||
    tokenDecimals !== snapshot.expected.tokenDecimals ||
    requiredString(row, "expected_sender") !== snapshot.expected.sender ||
    requiredString(row, "expected_recipient") !== snapshot.expected.recipient ||
    requiredString(row, "expected_amount_atomic") !== snapshot.expected.amountAtomic.toString() ||
    requiredConfirmations !== snapshot.expected.requiredConfirmations ||
    requiredString(row, "state") !== snapshot.state
  ) {
    return null;
  }
  return { entry: journalEntryFromCommunityPurchaseFunding(snapshot) };
}

function sameIdentity(
  row: Row,
  actorId: string,
  snapshot: CommunityPurchaseFundingSnapshot,
): boolean {
  return (
    requiredString(row, "actor_id") === actorId &&
    requiredString(row, "operation_id") === snapshot.operationId &&
    requiredString(row, "community_id") === snapshot.communityId &&
    requiredString(row, "quote_id") === snapshot.quoteId &&
    requiredString(row, "purchase_id") === snapshot.purchaseId &&
    integer(row, "policy_version") === snapshot.policyVersion &&
    integer(row, "chain_id") === snapshot.expected.chainId &&
    requiredString(row, "token_contract") === snapshot.expected.tokenContract &&
    integer(row, "token_decimals") === snapshot.expected.tokenDecimals &&
    requiredString(row, "expected_sender") === snapshot.expected.sender &&
    requiredString(row, "expected_recipient") === snapshot.expected.recipient &&
    requiredString(row, "expected_amount_atomic") === snapshot.expected.amountAtomic.toString() &&
    integer(row, "required_confirmations") === snapshot.expected.requiredConfirmations
  );
}

function resultDocument(entry: MoneyFlowJournalEntry<CommunityPurchaseFundingSnapshot>) {
  return {
    operation_id: entry.state.operationId,
    status: entry.status,
    version: entry.version,
  };
}

function failureColumns(snapshot: CommunityPurchaseFundingSnapshot): readonly unknown[] {
  if (snapshot.state === "reclaimable_failed" || snapshot.state === "reconciliation_required") {
    return [snapshot.failure._tag, snapshot.failureReason];
  }
  return [null, null];
}

function currentEvidence(snapshot: CommunityPurchaseFundingSnapshot): readonly unknown[] {
  const evidence = snapshot.fundingEvidence;
  return evidence === null
    ? [null, null, null, null]
    : [evidence.receiptStatus, evidence.transactionHash, evidence.logIndex, evidence.observationId];
}

function sameConfirmedReceipt(
  row: Row,
  snapshot: Extract<CommunityPurchaseFundingSnapshot, { readonly state: "confirmed" }>,
): boolean {
  const evidence = snapshot.fundingEvidence;
  return (
    requiredString(row, "receipt_id") ===
      confirmedCommunityPurchaseReceiptId(snapshot.operationId) &&
    requiredString(row, "operation_id") === snapshot.operationId &&
    requiredString(row, "community_id") === snapshot.communityId &&
    requiredString(row, "purchase_id") === snapshot.purchaseId &&
    integer(row, "chain_id") === evidence.chainId &&
    requiredString(row, "token_contract") === evidence.tokenContract &&
    requiredString(row, "sender") === evidence.sender &&
    requiredString(row, "recipient") === evidence.recipient &&
    requiredString(row, "amount_atomic") === evidence.amountAtomic.toString() &&
    requiredString(row, "transaction_hash") === evidence.transactionHash &&
    integer(row, "log_index") === evidence.logIndex &&
    integer(row, "block_number") === evidence.blockNumber &&
    requiredString(row, "block_hash") === evidence.blockHash
  );
}

function eventEvidence(
  event: CommunityPurchaseFundingEvent,
): CommunityPurchaseFundingEvidence | null {
  return event.type === "funding_evidence_observed" || event.type === "reconciliation_resolved"
    ? event.evidence
    : null;
}

function loadJournal(
  transaction: Transaction,
  operationId: CommunityPurchaseOperationId,
  lock: boolean,
): Effect.Effect<Row | null, RepositoryError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "money.community-purchase-funding.load",
      text: `SELECT ${JOURNAL_COLUMNS}
               FROM community_purchase_funding_journal
              WHERE operation_id = $1${lock ? " FOR UPDATE" : ""}`,
      values: [operationId],
      readonly: !lock,
    });
    return yield* oneRow(result.rows);
  });
}

function decodeRecord(
  row: Row | null,
): Effect.Effect<
  CommunityPurchaseFundingJournalRecord | null,
  CommunityPurchaseFundingStorageFailed
> {
  if (row === null) return Effect.succeed(null);
  const record = recordFromRow(row);
  return record === null ? Effect.fail(storageFailure("invalid-row")) : Effect.succeed(record);
}

function advisoryLock(
  transaction: Transaction,
  key: string,
): Effect.Effect<void, ControlPlaneError> {
  return transaction
    .execute({
      label: "money.community-purchase-funding.advisory-lock",
      text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      values: [key],
      readonly: false,
    })
    .pipe(Effect.asVoid);
}

function insertJournal(
  transaction: Transaction,
  actorId: string,
  entry: MoneyFlowJournalEntry<CommunityPurchaseFundingSnapshot>,
): Effect.Effect<void, ControlPlaneError> {
  const snapshot = entry.state;
  return transaction
    .execute({
      label: "money.community-purchase-funding.insert-journal",
      text: `INSERT INTO community_purchase_funding_journal (
               operation_id, community_id, actor_id, quote_id, purchase_id,
               policy_version, chain_id, token_contract, token_decimals,
               expected_sender, expected_recipient, expected_amount_atomic,
               required_confirmations, state, version, snapshot
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16::jsonb
             )`,
      values: [
        snapshot.operationId,
        snapshot.communityId,
        actorId,
        snapshot.quoteId,
        snapshot.purchaseId,
        snapshot.policyVersion,
        snapshot.expected.chainId,
        snapshot.expected.tokenContract,
        snapshot.expected.tokenDecimals,
        snapshot.expected.sender,
        snapshot.expected.recipient,
        snapshot.expected.amountAtomic.toString(),
        snapshot.expected.requiredConfirmations,
        snapshot.state,
        snapshot.version,
        JSON.stringify(encodeCommunityPurchaseFundingSnapshot(snapshot)),
      ],
      readonly: false,
    })
    .pipe(Effect.asVoid);
}

function bigintString(row: Row, field: string): bigint | null {
  const value = row[field];
  if (typeof value === "bigint") return value > 0n ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function address(row: Row, field: string): EvmAddress | null {
  return normalizeCommunityPurchaseEvmAddress(row[field]);
}

type FundingPlanRow = Readonly<{
  readonly plan: CommunityPurchaseFundingPlan;
  readonly status: "active" | "bound" | "cancelled";
  readonly operationId: string | null;
  readonly quotedAt: string;
  readonly expiresAt: string;
  readonly databaseNowMs: number;
}>;

function fundingPlanFromRow(row: Row): FundingPlanRow | null {
  const communityId = requiredString(row, "community_id");
  const quoteId = requiredString(row, "quote_id");
  const purchaseId = requiredString(row, "purchase_id");
  const actorId = requiredString(row, "actor_id");
  const buyerWallet = address(row, "buyer_wallet_address");
  const chainId = integer(row, "chain_id");
  const buyerChainId = integer(row, "buyer_chain_id");
  const policyVersion = integer(row, "policy_version");
  const tokenContract = address(row, "token_contract");
  const tokenDecimals = integer(row, "token_decimals");
  const treasuryAddress = address(row, "treasury_address");
  const amountAtomic = bigintString(row, "amount_atomic");
  const requiredConfirmations = integer(row, "required_confirmations");
  const status = requiredString(row, "status");
  const operationId = row.operation_id === null ? null : requiredString(row, "operation_id");
  const quotedAt = timestamp(row, "quoted_at");
  const expiresAt = timestamp(row, "expires_at");
  const databaseNowMs = integer(row, "database_now_ms");
  if (
    communityId === null ||
    quoteId === null ||
    purchaseId === null ||
    actorId === null ||
    buyerWallet === null ||
    chainId === null ||
    buyerChainId !== chainId ||
    policyVersion === null ||
    tokenContract === null ||
    tokenDecimals !== 6 ||
    treasuryAddress === null ||
    amountAtomic === null ||
    requiredConfirmations === null ||
    (status !== "active" && status !== "bound" && status !== "cancelled") ||
    (status === "bound" && operationId === null) ||
    (status !== "bound" && operationId !== null) ||
    quotedAt === null ||
    expiresAt === null ||
    databaseNowMs === null
  ) {
    return null;
  }
  try {
    const plan: CommunityPurchaseFundingPlan = {
      communityId,
      quoteId,
      purchaseId,
      policyVersion,
      expected: {
        chainId,
        tokenContract,
        tokenDecimals: 6,
        sender: buyerWallet,
        recipient: treasuryAddress,
        amountAtomic: communityPurchaseAtomicAmount(amountAtomic),
        requiredConfirmations,
      },
      now: databaseNowMs,
    };
    // Exercise the domain derivation while the row is still locked. A malformed
    // persisted term is a storage defect, never caller-controlled input.
    deriveCommunityPurchaseOperationId(plan);
    return { plan, status, operationId, quotedAt, expiresAt, databaseNowMs };
  } catch {
    return null;
  }
}

const PLAN_COLUMNS = `
  quote_id, community_id, actor_id, buyer_wallet_address, buyer_chain_id,
  purchase_id, policy_version, chain_id, token_contract, token_decimals,
  treasury_address, amount_atomic, required_confirmations, quoted_at,
  expires_at, status, operation_id,
  (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS database_now_ms`;

function insertAdmissionRequest(
  transaction: Transaction,
  input: CommunityPurchaseFundingAdmissionStoreInput,
  operationId: CommunityPurchaseOperationId,
  entry: MoneyFlowJournalEntry<CommunityPurchaseFundingSnapshot>,
): Effect.Effect<void, ControlPlaneError> {
  return transaction
    .execute({
      label: "money.community-purchase-funding.insert-admission-request",
      text: `INSERT INTO community_purchase_funding_requests (
               actor_id, endpoint, client_nonce, request_hash, canonical_request,
               operation_id, status, result, result_version
             ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9)`,
      values: [
        input.actorId,
        COMMUNITY_PURCHASE_FUNDING_ENDPOINT,
        input.clientNonce,
        input.requestHash,
        JSON.stringify(input.canonicalRequest),
        operationId,
        entry.status,
        JSON.stringify(resultDocument(entry)),
        entry.version,
      ],
      readonly: false,
    })
    .pipe(Effect.asVoid);
}

export function makeControlPlaneCommunityPurchaseFundingRepository() {
  const createPlan = Effect.fn("CommunityPurchaseFundingRepository.createPlan")(function* (
    input: CreatePlanInput,
  ) {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        const lockKeys = [
          `cpf:plan:purchase:${input.purchaseId}`,
          `cpf:plan:quote:${input.quoteId}`,
        ].sort();
        for (const key of lockKeys) yield* advisoryLock(transaction, key);
        const existingResult = yield* transaction.execute<Row>({
          label: "money.community-purchase-funding.plan.find-existing",
          text: `SELECT ${PLAN_COLUMNS}
                   FROM community_purchase_funding_plans
                  WHERE quote_id = $1 OR purchase_id = $2
                  FOR UPDATE`,
          values: [input.quoteId, input.purchaseId],
          readonly: false,
        });
        if (existingResult.rows.length > 1) return { kind: "conflict" } as const;
        const existingRow = existingResult.rows[0];
        if (existingRow !== undefined) {
          const existing = fundingPlanFromRow(existingRow);
          if (existing === null || existing.status !== "active") {
            return { kind: "conflict" } as const;
          }
          const expected = existing.plan.expected;
          const exact =
            existing.plan.quoteId === input.quoteId &&
            existing.plan.communityId === input.communityId &&
            requiredString(existingRow, "actor_id") === input.actorId &&
            existing.plan.purchaseId === input.purchaseId &&
            existing.plan.policyVersion === input.policyVersion &&
            expected.sender === input.buyerWalletAddress &&
            expected.chainId === input.buyerChainId &&
            expected.tokenContract === input.tokenContract &&
            expected.tokenDecimals === input.tokenDecimals &&
            expected.recipient === input.treasuryAddress &&
            expected.amountAtomic === input.amountAtomic &&
            expected.requiredConfirmations === input.requiredConfirmations &&
            Date.parse(existing.expiresAt) - Date.parse(existing.quotedAt) ===
              input.quoteTtlSeconds * 1_000;
          if (!exact) return { kind: "conflict" } as const;
          return {
            kind: "replayed",
            plan: fundingPlanRecord(existing, input.actorId),
          } as const;
        }

        const inserted = yield* transaction.execute<Row>({
          label: "money.community-purchase-funding.plan.insert",
          text: `INSERT INTO community_purchase_funding_plans (
                   quote_id, community_id, actor_id, buyer_wallet_address, buyer_chain_id,
                   purchase_id, policy_version, chain_id, token_contract, token_decimals,
                   treasury_address, amount_atomic, required_confirmations, quoted_at,
                   expires_at, status
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $5, $8, $9, $10, $11, $12,
                   statement_timestamp(),
                   statement_timestamp() + ($13 * INTERVAL '1 second'), 'active'
                 )
                 RETURNING ${PLAN_COLUMNS}`,
          values: [
            input.quoteId,
            input.communityId,
            input.actorId,
            input.buyerWalletAddress,
            input.buyerChainId,
            input.purchaseId,
            input.policyVersion,
            input.tokenContract,
            input.tokenDecimals,
            input.treasuryAddress,
            input.amountAtomic.toString(),
            input.requiredConfirmations,
            input.quoteTtlSeconds,
          ],
          readonly: false,
        });
        const row = yield* oneRow(inserted.rows);
        const record = row === null ? null : fundingPlanFromRow(row);
        if (record === null) return yield* Effect.fail(storageFailure("invalid-row"));
        return { kind: "inserted", plan: fundingPlanRecord(record, input.actorId) } as const;
      }),
    );
  });

  const beginFromPlan = Effect.fn("CommunityPurchaseFundingRepository.beginFromPlan")(function* (
    input: CommunityPurchaseFundingAdmissionStoreInput,
  ) {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        // This lock is the idempotency fence. It is intentionally checked before
        // expiry, so a lost response can be replayed after the quote expires.
        yield* advisoryLock(
          transaction,
          `cpf:request:${input.actorId}:${COMMUNITY_PURCHASE_FUNDING_ENDPOINT}:${input.clientNonce}`,
        );
        const requestResult = yield* transaction.execute<Row>({
          label: "money.community-purchase-funding.admission.lock-request",
          text: `SELECT request_hash, operation_id
                   FROM community_purchase_funding_requests
                  WHERE actor_id = $1 AND endpoint = $2 AND client_nonce = $3
                  FOR UPDATE`,
          values: [input.actorId, COMMUNITY_PURCHASE_FUNDING_ENDPOINT, input.clientNonce],
          readonly: false,
        });
        const requestRow = yield* oneRow(requestResult.rows);
        if (requestRow !== null) {
          if (requiredString(requestRow, "request_hash") !== input.requestHash) {
            return { kind: "request_conflict" } as const;
          }
          const operationId = requiredString(requestRow, "operation_id");
          if (operationId === null) return yield* Effect.fail(storageFailure("invalid-row"));
          const row = yield* loadJournal(
            transaction,
            operationId as CommunityPurchaseOperationId,
            true,
          );
          if (
            row === null ||
            requiredString(row, "actor_id") !== input.actorId ||
            requiredString(row, "quote_id") !== input.quoteId ||
            requiredString(row, "expected_sender") !== input.authenticatedWalletAddress
          ) {
            return yield* Effect.fail(storageFailure("invalid-row"));
          }
          const record = yield* decodeRecord(row);
          if (record === null) return yield* Effect.fail(storageFailure("invalid-row"));
          return { kind: "replayed", record } as const;
        }

        const planResult = yield* transaction.execute<Row>({
          label: "money.community-purchase-funding.admission.lock-plan",
          text: `SELECT ${PLAN_COLUMNS}
                   FROM community_purchase_funding_plans
                  WHERE quote_id = $1
                  FOR UPDATE`,
          values: [input.quoteId],
          readonly: false,
        });
        const planRow = yield* oneRow(planResult.rows);
        if (planRow === null) return { kind: "plan_not_found" } as const;
        const planRecord = fundingPlanFromRow(planRow);
        if (planRecord === null) return yield* Effect.fail(storageFailure("invalid-row"));
        if (planRecord.plan.quoteId !== input.quoteId) {
          return { kind: "plan_not_found" } as const;
        }
        if (requiredString(planRow, "actor_id") !== input.actorId) {
          return { kind: "actor_mismatch" } as const;
        }
        if (planRecord.plan.expected.sender !== input.authenticatedWalletAddress) {
          return { kind: "wallet_mismatch" } as const;
        }
        if (planRecord.status === "cancelled") return { kind: "plan_cancelled" } as const;
        if (
          planRecord.status === "active" &&
          Date.parse(planRecord.expiresAt) <= planRecord.databaseNowMs
        ) {
          return { kind: "plan_expired" } as const;
        }

        const operationId = deriveCommunityPurchaseOperationId(planRecord.plan);
        yield* advisoryLock(transaction, `cpf:operation:${operationId}`);
        const existing = yield* loadJournal(transaction, operationId, true);
        if (planRecord.status === "bound") {
          if (planRecord.operationId !== operationId || existing === null) {
            return { kind: "operation_conflict" } as const;
          }
          const expected = createCommunityPurchaseFunding(planRecord.plan);
          if (!sameIdentity(existing, input.actorId, expected)) {
            return { kind: "operation_conflict" } as const;
          }
          const record = yield* decodeRecord(existing);
          if (record === null) return yield* Effect.fail(storageFailure("invalid-row"));
          yield* insertAdmissionRequest(transaction, input, operationId, record.entry);
          return { kind: "replayed", record } as const;
        }
        if (existing !== null) return { kind: "operation_conflict" } as const;

        const snapshot = createCommunityPurchaseFunding(planRecord.plan);
        const entry = journalEntryFromCommunityPurchaseFunding(snapshot);
        yield* insertJournal(transaction, input.actorId, entry);
        const bound = yield* transaction.execute({
          label: "money.community-purchase-funding.admission.bind-plan",
          text: `UPDATE community_purchase_funding_plans
                    SET status = 'bound', operation_id = $2
                  WHERE quote_id = $1 AND status = 'active' AND operation_id IS NULL`,
          values: [input.quoteId, operationId],
          readonly: false,
        });
        if (bound.rowCount !== 1) return { kind: "operation_conflict" } as const;
        yield* insertAdmissionRequest(transaction, input, operationId, entry);
        return { kind: "inserted", record: { entry } } as const;
      }),
    );
  });

  const begin = Effect.fn("CommunityPurchaseFundingRepository.begin")(function* (
    input: BeginInput,
  ) {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        const snapshot = input.entry.state;
        yield* advisoryLock(
          transaction,
          `cpf:request:${input.request.actorId}:${input.request.endpoint}:${input.request.clientNonce}`,
        );
        // Keep the same request-before-operation ordering as beginFromPlan.
        // The raw begin seam is internal, but matching its lock order prevents
        // a future internal caller from deadlocking public admission.
        yield* advisoryLock(transaction, `cpf:operation:${snapshot.operationId}`);

        const requestResult = yield* transaction.execute<Row>({
          label: "money.community-purchase-funding.lock-request",
          text: `SELECT request_hash, canonical_request, operation_id
                   FROM community_purchase_funding_requests
                  WHERE actor_id = $1 AND endpoint = $2 AND client_nonce = $3
                  FOR UPDATE`,
          values: [input.request.actorId, input.request.endpoint, input.request.clientNonce],
          readonly: false,
        });
        const requestRow = yield* oneRow(requestResult.rows);
        if (requestRow !== null) {
          if (
            requiredString(requestRow, "request_hash") !== input.request.requestHash ||
            requiredString(requestRow, "operation_id") !== input.request.operationId
          ) {
            return { kind: "request_conflict" } as const;
          }
          const row = yield* loadJournal(transaction, snapshot.operationId, true);
          if (row === null || !sameIdentity(row, input.request.actorId, snapshot)) {
            return { kind: "operation_conflict" } as const;
          }
          const record = yield* decodeRecord(row);
          if (record === null) return yield* Effect.fail(storageFailure("invalid-row"));
          return { kind: "replayed", record } as const;
        }

        const existing = yield* loadJournal(transaction, snapshot.operationId, true);
        if (existing === null) {
          yield* insertJournal(transaction, input.request.actorId, input.entry);
        } else if (!sameIdentity(existing, input.request.actorId, snapshot)) {
          return { kind: "operation_conflict" } as const;
        }
        const record = existing === null ? { entry: input.entry } : yield* decodeRecord(existing);
        if (record === null) return yield* Effect.fail(storageFailure("invalid-row"));

        yield* transaction.execute({
          label: "money.community-purchase-funding.insert-request",
          text: `INSERT INTO community_purchase_funding_requests (
                   actor_id, endpoint, client_nonce, request_hash, canonical_request,
                   operation_id, status, result, result_version
                 ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9)`,
          values: [
            input.request.actorId,
            input.request.endpoint,
            input.request.clientNonce,
            input.request.requestHash,
            JSON.stringify(input.request.canonicalRequest),
            input.request.operationId,
            record.entry.status,
            JSON.stringify(resultDocument(record.entry)),
            record.entry.version,
          ],
          readonly: false,
        });
        return { kind: existing === null ? "inserted" : "replayed", record } as const;
      }),
    );
  });

  const load = Effect.fn("CommunityPurchaseFundingRepository.load")(function* (
    operationId: CommunityPurchaseOperationId,
  ) {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<Row>({
      label: "money.community-purchase-funding.load",
      text: `SELECT ${JOURNAL_COLUMNS}
               FROM community_purchase_funding_journal
              WHERE operation_id = $1`,
      values: [operationId],
      readonly: true,
    });
    return yield* decodeRecord(yield* oneRow(result.rows));
  });

  const loadForActor = Effect.fn("CommunityPurchaseFundingRepository.loadForActor")(function* (
    input: LoadForActorInput,
  ) {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<Row>({
      label: "money.community-purchase-funding.load-for-actor",
      text: `SELECT ${JOURNAL_COLUMNS}
               FROM community_purchase_funding_journal
              WHERE operation_id = $1 AND actor_id = $2`,
      values: [input.operationId, input.actorId],
      readonly: true,
    });
    return yield* decodeRecord(yield* oneRow(result.rows));
  });

  const listReconcilable = Effect.fn("CommunityPurchaseFundingRepository.listReconcilable")(
    function* (input: ListReconcilableInput) {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "money.community-purchase-funding.list-reconcilable",
        text: `SELECT j.operation_id, j.funding_transaction_hash
               FROM community_purchase_funding_journal AS j
               LEFT JOIN community_purchase_funding_reconciliation_attempts AS a
                 ON a.operation_id = j.operation_id
              WHERE j.state IN ('confirming', 'reconciliation_required')
                AND j.funding_transaction_hash IS NOT NULL
                AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= clock_timestamp())
                AND a.escalated_at IS NULL
              ORDER BY j.updated_at ASC, j.operation_id ASC
              LIMIT $1`,
        values: [input.limit],
        readonly: true,
      });
      const records: Array<{
        readonly operationId: CommunityPurchaseOperationId;
        readonly transactionHash: Bytes32;
      }> = [];
      for (const row of result.rows) {
        const operationId = requiredString(row, "operation_id");
        const transactionHash = requiredString(row, "funding_transaction_hash");
        if (
          operationId === null ||
          transactionHash === null ||
          !/^0x[0-9a-f]{64}$/u.test(transactionHash)
        ) {
          return yield* Effect.fail(storageFailure("invalid-row"));
        }
        records.push({
          operationId: operationId as CommunityPurchaseOperationId,
          transactionHash: transactionHash as Bytes32,
        });
      }
      return records;
    },
  );

  const listDormancyCandidates = Effect.fn(
    "CommunityPurchaseFundingRepository.listDormancyCandidates",
  )(function* (input: ListDormancyCandidatesInput) {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<Row>({
      label: "money.community-purchase-funding.list-dormancy-candidates",
      text: `SELECT operation_id, version,
                    (EXTRACT(EPOCH FROM statement_timestamp()) * 1000)::bigint
                      AS database_now_ms
               FROM community_purchase_funding_journal
              WHERE state = 'planned'
                AND funding_transaction_hash IS NULL
                AND created_at <= statement_timestamp()
                  - ($2 * INTERVAL '1 millisecond')
              ORDER BY created_at ASC, operation_id ASC
              LIMIT $1`,
      values: [input.limit, input.submissionWindowMs],
      readonly: true,
    });
    const records: Array<{
      readonly operationId: CommunityPurchaseOperationId;
      readonly expectedVersion: number;
      readonly databaseNowMs: number;
    }> = [];
    for (const row of result.rows) {
      const operationId = requiredString(row, "operation_id");
      const expectedVersion = integer(row, "version");
      const databaseNowMs = integer(row, "database_now_ms");
      if (
        operationId === null ||
        expectedVersion === null ||
        expectedVersion < 1 ||
        databaseNowMs === null ||
        databaseNowMs < 0
      ) {
        return yield* Effect.fail(storageFailure("invalid-row"));
      }
      records.push({
        operationId: operationId as CommunityPurchaseOperationId,
        expectedVersion,
        databaseNowMs,
      });
    }
    return records;
  });

  const parkedCounts = Effect.fn("CommunityPurchaseFundingRepository.parkedCounts")(function* () {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute<Row>({
      label: "money.community-purchase-funding.parked-counts",
      text: `SELECT failure_tag, failure_reason, count(*)::integer AS operations
               FROM community_purchase_funding_journal
              WHERE state = 'reconciliation_required'
                AND funding_transaction_hash IS NULL
              GROUP BY failure_tag, failure_reason
              ORDER BY failure_tag ASC, failure_reason ASC`,
      values: [],
      readonly: true,
    });
    const counts: CommunityPurchaseFundingParkedCount[] = [];
    for (const row of result.rows) {
      const failureTag = requiredString(row, "failure_tag");
      const failureReason = requiredString(row, "failure_reason");
      const operations = integer(row, "operations");
      if (
        (failureTag !== "ambiguous" && failureTag !== "legacy") ||
        failureReason === null ||
        operations === null ||
        operations < 0
      ) {
        return yield* Effect.fail(storageFailure("invalid-row"));
      }
      counts.push({ failureTag, failureReason, operations });
    }
    return counts;
  });

  const recordAttemptStart = Effect.fn("CommunityPurchaseFundingRepository.recordAttemptStart")(
    function* (input: RecordAttemptStartInput) {
      const db = yield* ControlPlaneDb;
      // PostgreSQL locks the conflicting row while evaluating this predicate;
      // one of two concurrent due claims therefore returns no row.
      const result = yield* db.execute<Row>({
        label: "money.community-purchase-funding.record-attempt-start",
        text: `INSERT INTO community_purchase_funding_reconciliation_attempts (
                 operation_id, generation, last_attempt_at, next_attempt_at, updated_at
               ) VALUES (
                 $1, 1, clock_timestamp(),
                 clock_timestamp() + ($2 * INTERVAL '1 millisecond'), clock_timestamp()
               )
               ON CONFLICT (operation_id) DO UPDATE SET
                 generation = community_purchase_funding_reconciliation_attempts.generation + 1,
                 last_attempt_at = clock_timestamp(),
                 next_attempt_at = clock_timestamp() + ($2 * INTERVAL '1 millisecond'),
                 updated_at = clock_timestamp()
               WHERE (
                 community_purchase_funding_reconciliation_attempts.next_attempt_at IS NULL
                 OR community_purchase_funding_reconciliation_attempts.next_attempt_at <= clock_timestamp()
               )
                 AND community_purchase_funding_reconciliation_attempts.escalated_at IS NULL
               RETURNING operation_id, generation, last_attempt_at, next_attempt_at,
                         last_failure_class, consecutive_failures, escalated_at`,
        values: [input.operationId, input.reservationMs],
        readonly: false,
      });
      const row = yield* oneRow(result.rows);
      if (row === null) return { kind: "unavailable" } as const;
      const state = attemptFromRow(row);
      if (state === null) return yield* Effect.fail(storageFailure("invalid-row"));
      return { kind: "reserved", state } as const;
    },
  );

  const recordAttemptSuccess = Effect.fn("CommunityPurchaseFundingRepository.recordAttemptSuccess")(
    function* (input: RecordAttemptSuccessInput) {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "money.community-purchase-funding.record-attempt-success",
        text: `UPDATE community_purchase_funding_reconciliation_attempts
                   SET last_failure_class = NULL, consecutive_failures = 0,
                       next_attempt_at = NULL, escalated_at = NULL,
                       updated_at = clock_timestamp()
                 WHERE operation_id = $1 AND generation = $2
                 RETURNING operation_id, generation, last_attempt_at, next_attempt_at,
                           last_failure_class, consecutive_failures, escalated_at`,
        values: [input.operationId, input.generation],
        readonly: false,
      });
      const row = yield* oneRow(result.rows);
      if (row === null) return { kind: "stale" } as const;
      const state = attemptFromRow(row);
      if (state === null) return yield* Effect.fail(storageFailure("invalid-row"));
      return { kind: "finalized", state } as const;
    },
  );

  const recordAttemptFailure = Effect.fn("CommunityPurchaseFundingRepository.recordAttemptFailure")(
    function* (input: RecordAttemptFailureInput) {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "money.community-purchase-funding.record-attempt-failure",
        text: `UPDATE community_purchase_funding_reconciliation_attempts
                   SET last_failure_class = $2,
                       consecutive_failures = consecutive_failures + 1,
                       next_attempt_at = clock_timestamp() + ($3 * INTERVAL '1 millisecond'),
                       escalated_at = CASE
                         WHEN consecutive_failures + 1 >= $4 AND escalated_at IS NULL
                           THEN clock_timestamp()
                         ELSE escalated_at
                       END,
                       updated_at = clock_timestamp()
                 WHERE operation_id = $1 AND generation = $5
                 RETURNING operation_id, generation, last_attempt_at, next_attempt_at,
                           last_failure_class, consecutive_failures, escalated_at`,
        values: [
          input.operationId,
          input.failureClass,
          input.retryDelayMs,
          input.escalationThreshold,
          input.generation,
        ],
        readonly: false,
      });
      const row = yield* oneRow(result.rows);
      if (row === null) return { kind: "stale" } as const;
      const state = attemptFromRow(row);
      if (state === null) return yield* Effect.fail(storageFailure("invalid-row"));
      return { kind: "finalized", state } as const;
    },
  );

  const acquireLease = Effect.fn("CommunityPurchaseFundingRepository.acquireLease")(function* (
    input: AcquireLeaseInput,
  ) {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        const row = yield* loadJournal(transaction, input.operationId, true);
        if (row === null) return { kind: "missing" } as const;
        const currentOwner = row.lease_owner;
        const currentExpiry = timestamp(row, "lease_expires_at");
        const clock = yield* transaction.execute<Row>({
          label: "money.community-purchase-funding.lease-clock",
          text: "SELECT clock_timestamp() AS database_now",
          values: [],
          readonly: false,
        });
        const clockRow = yield* oneRow(clock.rows);
        const databaseNow = clockRow === null ? null : timestamp(clockRow, "database_now");
        if (databaseNow === null) return yield* Effect.fail(storageFailure("invalid-row"));
        if (
          typeof currentOwner === "string" &&
          currentOwner !== input.ownerId &&
          currentExpiry !== null &&
          Date.parse(currentExpiry) > Date.parse(databaseNow)
        ) {
          return {
            kind: "busy",
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((Date.parse(currentExpiry) - Date.parse(databaseNow)) / 1_000),
            ),
          } as const;
        }
        const renewed = yield* transaction.execute<Row>({
          label: "money.community-purchase-funding.acquire-lease",
          text: `UPDATE community_purchase_funding_journal
                    SET lease_owner = $2,
                        lease_fence_token = CASE
                          WHEN lease_owner = $2 AND lease_expires_at > clock_timestamp()
                            THEN lease_fence_token
                          ELSE lease_fence_token + 1
                        END,
                        lease_expires_at = clock_timestamp() + ($3 * INTERVAL '1 millisecond'),
                        updated_at = clock_timestamp()
                  WHERE operation_id = $1
                  RETURNING operation_id, lease_owner, lease_fence_token, lease_expires_at`,
          values: [input.operationId, input.ownerId, input.leaseMs],
          readonly: false,
        });
        const renewedRow = yield* oneRow(renewed.rows);
        const fenceToken = renewedRow === null ? null : integer(renewedRow, "lease_fence_token");
        const expiresAt = renewedRow === null ? null : timestamp(renewedRow, "lease_expires_at");
        if (fenceToken === null || fenceToken < 1 || expiresAt === null) {
          return yield* Effect.fail(storageFailure("invalid-row"));
        }
        return {
          kind: "acquired",
          lease: {
            operationId: input.operationId,
            ownerId: input.ownerId,
            fenceToken,
            expiresAt,
            databaseNowMs: Date.parse(databaseNow),
          },
        } as const;
      }),
    );
  });

  const wasTransitionCommitted = Effect.fn(
    "CommunityPurchaseFundingRepository.wasTransitionCommitted",
  )(function* (input: WasTransitionCommittedInput) {
    const db = yield* ControlPlaneDb;
    const result = yield* db.execute({
      label: "money.community-purchase-funding.find-transition",
      text: `SELECT 1
                 FROM community_purchase_funding_transitions
                WHERE operation_id = $1 AND target_version = $2 AND event = $3::jsonb`,
      values: [
        input.operationId,
        input.targetVersion,
        JSON.stringify(encodeCommunityPurchaseFundingEvent(input.event)),
      ],
      readonly: true,
    });
    return result.rowCount === 1;
  });

  const commitTransition = Effect.fn("CommunityPurchaseFundingRepository.commitTransition")(
    function* (input: CommitTransitionInput) {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const row = yield* loadJournal(transaction, input.lease.operationId, true);
          if (row === null) return { kind: "missing" } as const;
          const eventJson = JSON.stringify(encodeCommunityPurchaseFundingEvent(input.event));
          const prior = yield* transaction.execute<Row>({
            label: "money.community-purchase-funding.lock-transition",
            text: `SELECT event
                   FROM community_purchase_funding_transitions
                  WHERE operation_id = $1 AND target_version = $2
                  FOR UPDATE`,
            values: [input.lease.operationId, input.expectedVersion + 1],
            readonly: false,
          });
          const priorRow = yield* oneRow(prior.rows);
          if (priorRow !== null) {
            const same = yield* transaction.execute({
              label: "money.community-purchase-funding.compare-transition",
              text: `SELECT 1
                     FROM community_purchase_funding_transitions
                    WHERE operation_id = $1 AND target_version = $2 AND event = $3::jsonb`,
              values: [input.lease.operationId, input.expectedVersion + 1, eventJson],
              readonly: false,
            });
            const record = yield* decodeRecord(row);
            if (record === null) return yield* Effect.fail(storageFailure("invalid-row"));
            return same.rowCount === 1
              ? ({ kind: "replayed", record } as const)
              : ({ kind: "version_conflict" } as const);
          }
          if (integer(row, "version") !== input.expectedVersion) {
            return { kind: "version_conflict" } as const;
          }
          if (
            requiredString(row, "lease_owner") !== input.lease.ownerId ||
            integer(row, "lease_fence_token") !== input.lease.fenceToken ||
            timestamp(row, "lease_expires_at") === null
          ) {
            return { kind: "lease_lost" } as const;
          }
          const liveLease = yield* transaction.execute({
            label: "money.community-purchase-funding.check-lease",
            text: `SELECT 1
                   FROM community_purchase_funding_journal
                  WHERE operation_id = $1 AND lease_owner = $2
                    AND lease_fence_token = $3 AND lease_expires_at > clock_timestamp()`,
            values: [input.lease.operationId, input.lease.ownerId, input.lease.fenceToken],
            readonly: false,
          });
          if (liveLease.rowCount !== 1) return { kind: "lease_lost" } as const;
          if (!sameIdentity(row, requiredString(row, "actor_id") ?? "", input.nextEntry.state)) {
            return { kind: "identity_conflict" } as const;
          }

          const evidence = eventEvidence(input.event);
          if (evidence !== null) {
            yield* advisoryLock(
              transaction,
              `cpf:transaction:${evidence.chainId}:${evidence.transactionHash}`,
            );
            const claimed = yield* transaction.execute<Row>({
              label: "money.community-purchase-funding.lock-transaction-claim",
              text: `SELECT operation_id, chain_id, transaction_hash, successful_log_index
                     FROM community_purchase_funding_transaction_claims
                    WHERE chain_id = $1 AND transaction_hash = $2
                    FOR UPDATE`,
              values: [evidence.chainId, evidence.transactionHash],
              readonly: false,
            });
            const claimRow = yield* oneRow(claimed.rows);
            if (
              claimRow !== null &&
              requiredString(claimRow, "operation_id") !== input.lease.operationId
            ) {
              return { kind: "identity_conflict" } as const;
            }
            if (claimRow === null) {
              yield* transaction.execute({
                label: "money.community-purchase-funding.insert-transaction-claim",
                text: `INSERT INTO community_purchase_funding_transaction_claims (
                       operation_id, chain_id, transaction_hash, successful_log_index
                     ) VALUES ($1, $2, $3, $4)`,
                values: [
                  input.lease.operationId,
                  evidence.chainId,
                  evidence.transactionHash,
                  evidence.receiptStatus === "success" ? evidence.logIndex : null,
                ],
                readonly: false,
              });
            }
          }

          yield* transaction.execute({
            label: "money.community-purchase-funding.insert-transition",
            text: `INSERT INTO community_purchase_funding_transitions (
                   operation_id, target_version, source, event_type, event,
                   observation_id, transaction_hash, log_index
                 ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
            values: [
              input.lease.operationId,
              input.nextEntry.version,
              input.source,
              input.event.type,
              eventJson,
              evidence?.observationId ?? null,
              evidence?.transactionHash ?? null,
              evidence?.logIndex ?? null,
            ],
            readonly: false,
          });

          const snapshot = input.nextEntry.state;
          const failure = failureColumns(snapshot);
          const observed = currentEvidence(snapshot);
          const updated = yield* transaction.execute<Row>({
            label: "money.community-purchase-funding.update-journal",
            text: `UPDATE community_purchase_funding_journal
                    SET state = $4, version = $5, snapshot = $6::jsonb,
                        failure_tag = $7, failure_reason = $8,
                        funding_receipt_status = $9, funding_transaction_hash = $10,
                        funding_log_index = $11, funding_observation_id = $12,
                        updated_at = clock_timestamp()
                  WHERE operation_id = $1 AND version = $2
                    AND lease_owner = $3 AND lease_fence_token = $13
                    AND lease_expires_at > clock_timestamp()
                  RETURNING ${JOURNAL_COLUMNS}`,
            values: [
              input.lease.operationId,
              input.expectedVersion,
              input.lease.ownerId,
              snapshot.state,
              snapshot.version,
              JSON.stringify(encodeCommunityPurchaseFundingSnapshot(snapshot)),
              ...failure,
              ...observed,
              input.lease.fenceToken,
            ],
            readonly: false,
          });
          const updatedRow = yield* oneRow(updated.rows);
          if (updatedRow === null) return { kind: "lease_lost" } as const;

          if (snapshot.state === "confirmed") {
            const finalEvidence = snapshot.fundingEvidence;
            if (finalEvidence.receiptStatus !== "success" || finalEvidence.logIndex === null) {
              return yield* Effect.fail(storageFailure("invalid-row"));
            }
            yield* transaction.execute({
              label: "money.community-purchase-funding.insert-receipt",
              text: `INSERT INTO community_purchase_funding_receipts (
                     receipt_id, operation_id, community_id, purchase_id, chain_id,
                     token_contract, sender, recipient, amount_atomic,
                     transaction_hash, log_index, block_number, block_hash
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                   ON CONFLICT (operation_id) DO NOTHING`,
              values: [
                confirmedCommunityPurchaseReceiptId(snapshot.operationId),
                snapshot.operationId,
                snapshot.communityId,
                snapshot.purchaseId,
                finalEvidence.chainId,
                finalEvidence.tokenContract,
                finalEvidence.sender,
                finalEvidence.recipient,
                finalEvidence.amountAtomic.toString(),
                finalEvidence.transactionHash,
                finalEvidence.logIndex,
                finalEvidence.blockNumber,
                finalEvidence.blockHash,
              ],
              readonly: false,
            });
            const persistedReceipt = yield* transaction.execute<Row>({
              label: "money.community-purchase-funding.verify-receipt",
              text: `SELECT receipt_id, operation_id, community_id, purchase_id, chain_id,
                            token_contract, sender, recipient, amount_atomic,
                            transaction_hash, log_index, block_number, block_hash
                       FROM community_purchase_funding_receipts
                      WHERE operation_id = $1`,
              values: [snapshot.operationId],
              readonly: false,
            });
            const receiptRow = yield* oneRow(persistedReceipt.rows);
            if (receiptRow === null || !sameConfirmedReceipt(receiptRow, snapshot)) {
              return yield* Effect.fail(storageFailure("constraint"));
            }
          }

          yield* transaction.execute({
            label: "money.community-purchase-funding.update-request-results",
            text: `UPDATE community_purchase_funding_requests
                    SET status = $2, result = $3::jsonb, result_version = $4,
                        updated_at = clock_timestamp()
                  WHERE operation_id = $1`,
            values: [
              snapshot.operationId,
              input.nextEntry.status,
              JSON.stringify(resultDocument(input.nextEntry)),
              input.nextEntry.version,
            ],
            readonly: false,
          });
          const record = yield* decodeRecord(updatedRow);
          if (record === null) return yield* Effect.fail(storageFailure("invalid-row"));
          return { kind: "committed", record } as const;
        }),
      );
    },
  );

  return {
    createPlan,
    begin,
    beginFromPlan,
    load,
    loadForActor,
    listReconcilable,
    listDormancyCandidates,
    parkedCounts,
    recordAttemptStart,
    recordAttemptSuccess,
    recordAttemptFailure,
    acquireLease,
    wasTransitionCommitted,
    commitTransition,
  };
}

function fundingPlanRecord(
  row: FundingPlanRow,
  actorId: string,
): CommunityPurchaseFundingPlanRecord {
  return {
    quoteId: row.plan.quoteId,
    communityId: row.plan.communityId,
    actorId,
    purchaseId: row.plan.purchaseId,
    policyVersion: row.plan.policyVersion,
    expected: row.plan.expected,
    quotedAt: row.quotedAt,
    expiresAt: row.expiresAt,
  };
}

export function makeControlPlaneCommunityPurchaseFundingQueryStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CommunityPurchaseFundingQueryStore {
  const repository = makeControlPlaneCommunityPurchaseFundingRepository();
  const provide = <A>(effect: Effect.Effect<A, RepositoryError, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(mapRepositoryError));
  return {
    loadForActor: (input) => provide(repository.loadForActor(input)),
    listReconcilable: (input) => provide(repository.listReconcilable(input)),
    listDormancyCandidates: (input) => provide(repository.listDormancyCandidates(input)),
    parkedCounts: () => provide(repository.parkedCounts()),
  };
}

export function makeControlPlaneCommunityPurchaseFundingAttemptStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CommunityPurchaseFundingReconciliationAttemptStore {
  const repository = makeControlPlaneCommunityPurchaseFundingRepository();
  const provide = <A>(effect: Effect.Effect<A, RepositoryError, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(mapRepositoryError));
  return {
    recordAttemptStart: (input) => provide(repository.recordAttemptStart(input)),
    recordAttemptSuccess: (input) => provide(repository.recordAttemptSuccess(input)),
    recordAttemptFailure: (input) => provide(repository.recordAttemptFailure(input)),
  };
}

export function makeControlPlaneCommunityPurchaseFundingAdmissionStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CommunityPurchaseFundingAdmissionStore {
  const repository = makeControlPlaneCommunityPurchaseFundingRepository();
  const provide = <A>(effect: Effect.Effect<A, RepositoryError, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(mapRepositoryError));
  return {
    beginFromPlan: (input) => provide(repository.beginFromPlan(input)),
  };
}

export function makeControlPlaneCommunityPurchaseFundingPlanStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CommunityPurchaseFundingPlanStore {
  const repository = makeControlPlaneCommunityPurchaseFundingRepository();
  const provide = <A>(effect: Effect.Effect<A, RepositoryError, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(mapRepositoryError));
  return { createPlan: (input) => provide(repository.createPlan(input)) };
}

export function makeControlPlaneCommunityPurchaseFundingStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CommunityPurchaseFundingJournalStore {
  const repository = makeControlPlaneCommunityPurchaseFundingRepository();
  const provide = <A>(effect: Effect.Effect<A, RepositoryError, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(Effect.mapError(mapRepositoryError));
  return {
    begin: (input) => provide(repository.begin(input)),
    load: (operationId) => provide(repository.load(operationId)),
    acquireLease: (input) => provide(repository.acquireLease(input)),
    wasTransitionCommitted: (input) => provide(repository.wasTransitionCommitted(input)),
    commitTransition: (input) => provide(repository.commitTransition(input)),
  };
}
