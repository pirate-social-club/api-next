import {
  CommunityPurchaseCommerceStorageFailed,
  type CommunityPurchaseCommerceStore,
  type CommunityPurchaseFundingPlanDraft,
  type CommunityPurchaseFundingPlanRecord,
  type CommunityPurchaseFundingStorageFailed,
  type CommunityPurchaseQuote,
  type CommunityPurchaseQuoteCreateOutcome,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Data, Effect, type Layer } from "effect";

import { createCommunityPurchaseFundingPlanInTransaction } from "./community-purchase-funding-repository";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;
type RepositoryError =
  | CommunityPurchaseCommerceStorageFailed
  | CommunityPurchaseFundingStorageFailed
  | ControlPlaneError;

class CommerceTransactionAbort extends Data.TaggedError("CommerceTransactionAbort")<{
  readonly kind: "not_found" | "conflict";
}> {}

function storageFailure(
  reason: CommunityPurchaseCommerceStorageFailed["reason"],
): CommunityPurchaseCommerceStorageFailed {
  return new CommunityPurchaseCommerceStorageFailed({ reason });
}

function mapRepositoryError(error: RepositoryError): CommunityPurchaseCommerceStorageFailed {
  if (error._tag === "CommunityPurchaseCommerceStorageFailed") return error;
  if (error._tag === "CommunityPurchaseFundingStorageFailed") {
    return storageFailure(error.reason);
  }
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

function positiveBigInt(row: Row, field: string): bigint | null {
  const value = row[field];
  if (typeof value === "bigint" && value > 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function timestamp(row: Row, field: string): string | null {
  const value = row[field];
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function oneRow(rows: readonly Row[]): Row | null {
  return rows.length <= 1 ? (rows[0] ?? null) : null;
}

function uuidId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

export type CommunityPurchaseCommerceStoreOptions = Readonly<{
  /** Test seam only; production defaults to the Worker Web Crypto CSPRNG. */
  readonly nextId?: (prefix: string) => string;
}>;

const QUOTE_COLUMNS = `
  q.quote_id, q.purchase_id, q.community_id, q.actor_id, q.listing_id, q.policy_version,
  q.eligibility_snapshot_id, q.pricing_snapshot_id, q.verification_snapshot_id,
  q.route_snapshot_id, q.allocation_snapshot_id, q.settlement_snapshot_id,
  q.donation_snapshot_id, q.reservation_id, q.buyer_wallet_address, q.buyer_chain_id,
  q.token_contract, q.token_decimals, q.treasury_address, q.amount_atomic,
  q.required_confirmations, q.quoted_at, q.expires_at, q.status`;

function quoteFromRow(
  row: Row,
  plan: CommunityPurchaseFundingPlanRecord,
): CommunityPurchaseQuote | null {
  const quoteId = requiredString(row, "quote_id");
  const purchaseId = requiredString(row, "purchase_id");
  const communityId = requiredString(row, "community_id");
  const listingId = requiredString(row, "listing_id");
  const policyVersion = integer(row, "policy_version");
  const wallet = requiredString(row, "buyer_wallet_address");
  const chainId = integer(row, "buyer_chain_id");
  const tokenContract = requiredString(row, "token_contract");
  const tokenDecimals = integer(row, "token_decimals");
  const treasury = requiredString(row, "treasury_address");
  const amountAtomic = positiveBigInt(row, "amount_atomic");
  const confirmations = integer(row, "required_confirmations");
  const quotedAt = timestamp(row, "quoted_at");
  const expiresAt = timestamp(row, "expires_at");
  if (
    quoteId === null ||
    purchaseId === null ||
    communityId === null ||
    listingId === null ||
    policyVersion === null ||
    wallet === null ||
    !/^0x[0-9a-f]{40}$/u.test(wallet) ||
    chainId === null ||
    tokenContract === null ||
    !/^0x[0-9a-f]{40}$/u.test(tokenContract) ||
    tokenDecimals !== 6 ||
    treasury === null ||
    !/^0x[0-9a-f]{40}$/u.test(treasury) ||
    amountAtomic === null ||
    confirmations === null ||
    quotedAt === null ||
    expiresAt === null ||
    plan.quoteId !== quoteId ||
    plan.purchaseId !== purchaseId ||
    plan.communityId !== communityId ||
    plan.policyVersion !== policyVersion ||
    plan.expected.sender !== wallet ||
    plan.expected.chainId !== chainId ||
    plan.expected.tokenContract !== tokenContract ||
    plan.expected.tokenDecimals !== tokenDecimals ||
    plan.expected.recipient !== treasury ||
    plan.expected.amountAtomic !== amountAtomic ||
    plan.expected.requiredConfirmations !== confirmations
  ) {
    return null;
  }
  return {
    quoteId,
    purchaseId,
    communityId,
    listingId,
    policyVersion,
    buyerWalletAddress: wallet as `0x${string}`,
    expectedChainId: chainId,
    tokenContract: tokenContract as `0x${string}`,
    tokenDecimals: 6,
    treasuryAddress: treasury as `0x${string}`,
    amountAtomic: amountAtomic as CommunityPurchaseQuote["amountAtomic"],
    requiredConfirmations: confirmations,
    quotedAt,
    expiresAt,
    plan,
  };
}

function quoteDraft(
  input: Parameters<CommunityPurchaseCommerceStore["createQuoteAndPlan"]>[0],
  quoteId: string,
  purchaseId: string,
  row: Row,
): CommunityPurchaseFundingPlanDraft | null {
  const policyVersion = integer(row, "policy_version");
  const chainId = integer(row, "chain_id") ?? integer(row, "buyer_chain_id");
  const tokenContract = requiredString(row, "token_contract");
  const tokenDecimals = integer(row, "token_decimals");
  const treasury = requiredString(row, "treasury_address");
  const amountAtomic = positiveBigInt(row, "amount_atomic");
  const requiredConfirmations = integer(row, "required_confirmations");
  if (
    policyVersion === null ||
    chainId === null ||
    tokenContract === null ||
    !/^0x[0-9a-f]{40}$/u.test(tokenContract) ||
    tokenDecimals !== 6 ||
    treasury === null ||
    !/^0x[0-9a-f]{40}$/u.test(treasury) ||
    amountAtomic === null ||
    requiredConfirmations === null
  ) {
    return null;
  }
  return {
    quoteId,
    communityId: input.communityId,
    actorId: input.actorId,
    buyerWalletAddress: input.authenticatedWalletAddress,
    buyerChainId: chainId,
    purchaseId,
    policyVersion,
    tokenContract: tokenContract as `0x${string}`,
    tokenDecimals: 6,
    treasuryAddress: treasury as `0x${string}`,
    amountAtomic: amountAtomic as CommunityPurchaseFundingPlanDraft["amountAtomic"],
    requiredConfirmations,
    quoteTtlSeconds: 600,
  };
}

function quoteSelectByIntent(
  transaction: Transaction,
  input: Parameters<CommunityPurchaseCommerceStore["createQuoteAndPlan"]>[0],
): Effect.Effect<Row | null, ControlPlaneError> {
  return transaction
    .execute<Row>({
      label: "money.community-purchase-commerce.intent.find-existing",
      text: `SELECT ${QUOTE_COLUMNS}
                FROM community_purchase_intents i
                JOIN community_purchase_quotes q ON q.purchase_id = i.purchase_id
               WHERE i.actor_id = $1 AND i.listing_id = $2 AND i.idempotency_key = $3
               FOR UPDATE OF i, q`,
      values: [input.actorId, input.listingId, input.idempotencyKey],
      readonly: false,
    })
    .pipe(Effect.map((result) => oneRow(result.rows)));
}

function quoteById(
  transaction: Transaction,
  quoteId: string,
): Effect.Effect<Row | null, ControlPlaneError> {
  return transaction
    .execute<Row>({
      label: "money.community-purchase-commerce.quote.load",
      text: `SELECT ${QUOTE_COLUMNS}
                FROM community_purchase_quotes q
               WHERE quote_id = $1
               FOR UPDATE`,
      values: [quoteId],
      readonly: false,
    })
    .pipe(Effect.map((result) => oneRow(result.rows)));
}

function advisoryLock(transaction: Transaction, key: string) {
  return transaction
    .execute({
      label: "money.community-purchase-commerce.intent.lock",
      text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      values: [key],
      readonly: false,
    })
    .pipe(Effect.asVoid);
}

function loadExistingQuote(
  transaction: Transaction,
  input: Parameters<CommunityPurchaseCommerceStore["createQuoteAndPlan"]>[0],
): Effect.Effect<CommunityPurchaseQuoteCreateOutcome | null, RepositoryError> {
  return Effect.gen(function* () {
    const row = yield* quoteSelectByIntent(transaction, input);
    if (row === null) return null;
    const storedWallet = requiredString(row, "buyer_wallet_address");
    const storedVerification = requiredString(row, "verification_snapshot_id");
    if (
      storedWallet !== input.authenticatedWalletAddress ||
      storedVerification !== input.verificationSnapshotId
    ) {
      return { kind: "conflict" } as const;
    }
    const planRow = quoteDraft(
      input,
      requiredString(row, "quote_id") ?? "",
      requiredString(row, "purchase_id") ?? "",
      row,
    );
    if (planRow === null) return yield* Effect.fail(storageFailure("invalid-row"));
    const plan = yield* loadPlanRecordForQuote(transaction, planRow);
    if (plan === null) return yield* Effect.fail(storageFailure("invalid-row"));
    const quote = quoteFromRow(row, plan);
    if (quote === null) return yield* Effect.fail(storageFailure("invalid-row"));
    return { kind: "replayed", quote } as const;
  });
}

function loadPlanRecordForQuote(
  transaction: Transaction,
  draft: CommunityPurchaseFundingPlanDraft,
): Effect.Effect<CommunityPurchaseFundingPlanRecord | null, RepositoryError> {
  return transaction
    .execute<Row>({
      label: "money.community-purchase-commerce.plan.load",
      text: `SELECT quote_id, community_id, actor_id, purchase_id, policy_version,
                     buyer_wallet_address, buyer_chain_id, chain_id, token_contract,
                     token_decimals, treasury_address, amount_atomic,
                     required_confirmations, quoted_at, expires_at, status,
                     (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS database_now_ms
                FROM community_purchase_funding_plans
               WHERE quote_id = $1
               FOR UPDATE`,
      values: [draft.quoteId],
      readonly: false,
    })
    .pipe(
      Effect.flatMap((result) => {
        const row = oneRow(result.rows);
        if (row === null) return Effect.succeed(null);
        const quoteId = requiredString(row, "quote_id");
        const communityId = requiredString(row, "community_id");
        const actorId = requiredString(row, "actor_id");
        const purchaseId = requiredString(row, "purchase_id");
        const policyVersion = integer(row, "policy_version");
        const quotedAt = timestamp(row, "quoted_at");
        const expiresAt = timestamp(row, "expires_at");
        const chainId = integer(row, "chain_id");
        const tokenContract = requiredString(row, "token_contract");
        const treasury = requiredString(row, "treasury_address");
        const amountAtomic = positiveBigInt(row, "amount_atomic");
        const confirmations = integer(row, "required_confirmations");
        const databaseNowMs = integer(row, "database_now_ms");
        const wallet = requiredString(row, "buyer_wallet_address");
        const status = requiredString(row, "status");
        if (
          quoteId === null ||
          communityId === null ||
          actorId === null ||
          purchaseId === null ||
          policyVersion === null ||
          quotedAt === null ||
          expiresAt === null ||
          chainId === null ||
          tokenContract === null ||
          treasury === null ||
          amountAtomic === null ||
          confirmations === null ||
          databaseNowMs === null ||
          wallet === null ||
          (status !== "active" && status !== "bound" && status !== "cancelled") ||
          quoteId !== draft.quoteId ||
          communityId !== draft.communityId ||
          actorId !== draft.actorId ||
          purchaseId !== draft.purchaseId ||
          policyVersion !== draft.policyVersion ||
          wallet !== draft.buyerWalletAddress ||
          chainId !== draft.buyerChainId ||
          tokenContract !== draft.tokenContract ||
          treasury !== draft.treasuryAddress ||
          amountAtomic !== draft.amountAtomic ||
          confirmations !== draft.requiredConfirmations
        ) {
          return Effect.succeed(null);
        }
        return Effect.succeed({
          quoteId,
          communityId,
          actorId,
          purchaseId,
          policyVersion,
          expected: {
            chainId,
            tokenContract: tokenContract as `0x${string}`,
            tokenDecimals: 6,
            sender: wallet as `0x${string}`,
            recipient: treasury as `0x${string}`,
            amountAtomic:
              amountAtomic as CommunityPurchaseFundingPlanRecord["expected"]["amountAtomic"],
            requiredConfirmations: confirmations,
          },
          quotedAt,
          expiresAt,
        } satisfies CommunityPurchaseFundingPlanRecord);
      }),
    );
}

function createCommerceTransaction(
  transaction: Transaction,
  input: Parameters<CommunityPurchaseCommerceStore["createQuoteAndPlan"]>[0],
  nextId: (prefix: string) => string,
): Effect.Effect<CommunityPurchaseQuoteCreateOutcome, RepositoryError | CommerceTransactionAbort> {
  return Effect.gen(function* () {
    yield* advisoryLock(
      transaction,
      `commerce:intent:${input.actorId}:${input.listingId}:${input.idempotencyKey}`,
    );
    const existing = yield* loadExistingQuote(transaction, input);
    if (existing !== null) return existing;

    const membership = yield* transaction.execute<Row>({
      label: "money.community-purchase-commerce.membership.check",
      text: `SELECT 1
                FROM communities c
                JOIN community_memberships m ON m.community_id = c.community_id
               WHERE c.community_id = $1
                 AND c.status = 'active'
                 AND m.user_id = $2
                 AND m.status = 'member'
               FOR SHARE OF c, m`,
      values: [input.communityId, input.actorId],
      readonly: false,
    });
    if (membership.rowCount !== 1)
      return yield* new CommerceTransactionAbort({ kind: "not_found" });

    const listingResult = yield* transaction.execute<Row>({
      label: "money.community-purchase-commerce.listing.lock",
      text: `SELECT listing_id, community_id, policy_version, availability_mode, available_quantity
                FROM community_commerce_listings
               WHERE listing_id = $1 AND community_id = $2 AND status = 'active'
               FOR UPDATE`,
      values: [input.listingId, input.communityId],
      readonly: false,
    });
    const listing = oneRow(listingResult.rows);
    if (listing === null) return yield* new CommerceTransactionAbort({ kind: "not_found" });
    yield* transaction.execute({
      label: "money.community-purchase-commerce.reservation.expire",
      text: `WITH expired AS (
                UPDATE community_purchase_availability_reservations
                   SET status = 'expired', updated_at = statement_timestamp()
                 WHERE listing_id = $1
                   AND status = 'held'
                   AND expires_at <= statement_timestamp()
                 RETURNING purchase_id, quantity
               ), marked_quotes AS (
                UPDATE community_purchase_quotes q
                   SET status = 'expired'
                 WHERE q.purchase_id IN (SELECT purchase_id FROM expired)
                   AND q.status = 'active'
               ), marked_intents AS (
                UPDATE community_purchase_intents i
                   SET status = 'expired', updated_at = statement_timestamp()
                 WHERE i.purchase_id IN (SELECT purchase_id FROM expired)
                   AND i.status = 'quoted'
               )
               UPDATE community_commerce_listings l
                  SET available_quantity = CASE
                    WHEN l.availability_mode = 'finite'
                    THEN l.available_quantity + COALESCE((SELECT sum(quantity) FROM expired), 0)
                    ELSE l.available_quantity
                  END,
                      updated_at = statement_timestamp()
                WHERE l.listing_id = $1`,
      values: [input.listingId],
      readonly: false,
    });
    const refreshedListingResult = yield* transaction.execute<Row>({
      label: "money.community-purchase-commerce.listing.refresh",
      text: `SELECT listing_id, community_id, policy_version, availability_mode, available_quantity
                FROM community_commerce_listings
               WHERE listing_id = $1 AND community_id = $2 AND status = 'active'
               FOR UPDATE`,
      values: [input.listingId, input.communityId],
      readonly: false,
    });
    const refreshedListing = oneRow(refreshedListingResult.rows);
    if (refreshedListing === null)
      return yield* new CommerceTransactionAbort({ kind: "not_found" });
    const policyVersion = integer(refreshedListing, "policy_version");
    const availabilityMode = requiredString(refreshedListing, "availability_mode");
    const availableQuantity = integer(refreshedListing, "available_quantity");
    if (
      policyVersion === null ||
      (availabilityMode !== "unbounded" && availabilityMode !== "finite") ||
      (availabilityMode === "finite" && (availableQuantity === null || availableQuantity < 1))
    ) {
      return yield* new CommerceTransactionAbort({ kind: "not_found" });
    }

    const policy = yield* transaction.execute<Row>({
      label: "money.community-purchase-commerce.policy.load",
      text: `SELECT 1
                FROM community_commerce_policy_revisions
               WHERE community_id = $1 AND policy_version = $2
                 AND effective_at <= statement_timestamp()
               FOR SHARE`,
      values: [input.communityId, policyVersion],
      readonly: false,
    });
    if (policy.rowCount !== 1) return yield* new CommerceTransactionAbort({ kind: "not_found" });

    const verification = yield* transaction.execute<Row>({
      label: "money.community-purchase-commerce.verification.load",
      text: `SELECT snapshot_id
                FROM community_purchase_verification_snapshots
               WHERE snapshot_id = $1
                 AND community_id = $2
                 AND actor_id = $3
                 AND provider = 'zkPassport'
                 AND status = 'valid'
                 AND verified_at >= statement_timestamp() - INTERVAL '24 hours'
                 AND expires_at > statement_timestamp()
               FOR SHARE`,
      values: [input.verificationSnapshotId, input.communityId, input.actorId],
      readonly: false,
    });
    if (verification.rowCount !== 1)
      return yield* new CommerceTransactionAbort({ kind: "not_found" });

    const eligibility = yield* transaction.execute<Row>({
      label: "money.community-purchase-commerce.eligibility.load",
      text: `SELECT snapshot_id
                FROM community_purchase_eligibility_snapshots
               WHERE community_id = $1
                 AND actor_id = $2
                 AND policy_version = $3
                 AND verification_snapshot_id = $4
                 AND decision = 'eligible'
               ORDER BY evaluated_at DESC, snapshot_id DESC
               LIMIT 1
               FOR SHARE`,
      values: [input.communityId, input.actorId, policyVersion, input.verificationSnapshotId],
      readonly: false,
    });
    if (eligibility.rowCount !== 1)
      return yield* new CommerceTransactionAbort({ kind: "not_found" });

    const snapshots = yield* transaction.execute<Row>({
      label: "money.community-purchase-commerce.snapshots.load",
      text: `SELECT
                p.policy_version, p.amount_atomic,
                r.chain_id, r.token_contract, r.token_decimals, r.treasury_address,
                r.required_confirmations,
                a.snapshot_id AS allocation_snapshot_id,
                s.snapshot_id AS settlement_snapshot_id,
                d.snapshot_id AS donation_snapshot_id,
                p.snapshot_id AS pricing_snapshot_id,
                r.snapshot_id AS route_snapshot_id
             FROM community_purchase_pricing_snapshots p
             JOIN community_purchase_route_snapshots r
               ON r.community_id = p.community_id AND r.policy_version = p.policy_version
             JOIN community_purchase_allocation_snapshots a
               ON a.community_id = p.community_id AND a.policy_version = p.policy_version
              AND a.listing_id = $4 AND a.quantity = 1
             JOIN community_purchase_settlement_snapshots s
               ON s.community_id = p.community_id AND s.policy_version = p.policy_version
             JOIN community_purchase_donation_snapshots d
               ON d.community_id = p.community_id AND d.policy_version = p.policy_version
            WHERE p.community_id = $1
              AND p.actor_id = $2
              AND p.policy_version = $3
            ORDER BY p.created_at DESC, p.snapshot_id DESC
            LIMIT 1`,
      values: [input.communityId, input.actorId, policyVersion, input.listingId],
      readonly: false,
    });
    const snapshot = oneRow(snapshots.rows);
    if (snapshot === null) return yield* new CommerceTransactionAbort({ kind: "not_found" });

    const purchaseId = nextId("purchase");
    const quoteId = nextId("quote");
    const reservationId = nextId("reservation");
    const draft = quoteDraft(input, quoteId, purchaseId, snapshot);
    if (draft === null) return yield* Effect.fail(storageFailure("invalid-row"));

    yield* transaction.execute({
      label: "money.community-purchase-commerce.intent.insert",
      text: `INSERT INTO community_purchase_intents (
                purchase_id, actor_id, community_id, listing_id, idempotency_key,
                authenticated_wallet_address, verification_snapshot_id
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      values: [
        purchaseId,
        input.actorId,
        input.communityId,
        input.listingId,
        input.idempotencyKey,
        input.authenticatedWalletAddress,
        input.verificationSnapshotId,
      ],
      readonly: false,
    });
    yield* transaction.execute({
      label: "money.community-purchase-commerce.reservation.insert",
      text: `INSERT INTO community_purchase_availability_reservations (
                reservation_id, purchase_id, listing_id, quantity, expires_at
              ) VALUES ($1, $2, $3, 1,
                        statement_timestamp() + INTERVAL '600 seconds')`,
      values: [reservationId, purchaseId, input.listingId],
      readonly: false,
    });
    if (availabilityMode === "finite") {
      const decremented = yield* transaction.execute({
        label: "money.community-purchase-commerce.listing.reserve",
        text: `UPDATE community_commerce_listings
                  SET available_quantity = available_quantity - 1,
                      updated_at = statement_timestamp()
                WHERE listing_id = $1 AND available_quantity >= 1`,
        values: [input.listingId],
        readonly: false,
      });
      if (decremented.rowCount !== 1)
        return yield* new CommerceTransactionAbort({ kind: "conflict" });
    }
    yield* transaction.execute({
      label: "money.community-purchase-commerce.quote.insert",
      text: `INSERT INTO community_purchase_quotes (
                quote_id, purchase_id, community_id, actor_id, listing_id, policy_version,
                eligibility_snapshot_id, pricing_snapshot_id, verification_snapshot_id,
                route_snapshot_id, allocation_snapshot_id, settlement_snapshot_id,
                donation_snapshot_id, reservation_id, buyer_wallet_address, buyer_chain_id,
                token_contract, token_decimals, treasury_address, amount_atomic,
                required_confirmations, quoted_at, expires_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                $17, $18, $19, $20, $21, statement_timestamp(),
                statement_timestamp() + INTERVAL '600 seconds')`,
      values: [
        quoteId,
        purchaseId,
        input.communityId,
        input.actorId,
        input.listingId,
        policyVersion,
        requiredString(eligibility.rows[0] ?? {}, "snapshot_id"),
        requiredString(snapshot, "pricing_snapshot_id"),
        input.verificationSnapshotId,
        requiredString(snapshot, "route_snapshot_id"),
        requiredString(snapshot, "allocation_snapshot_id"),
        requiredString(snapshot, "settlement_snapshot_id"),
        requiredString(snapshot, "donation_snapshot_id"),
        reservationId,
        input.authenticatedWalletAddress,
        draft.buyerChainId,
        draft.tokenContract,
        draft.tokenDecimals,
        draft.treasuryAddress,
        draft.amountAtomic.toString(),
        draft.requiredConfirmations,
      ],
      readonly: false,
    });

    const planOutcome = yield* createCommunityPurchaseFundingPlanInTransaction(transaction, draft);
    if (planOutcome.kind !== "inserted") {
      return yield* new CommerceTransactionAbort({ kind: "conflict" });
    }
    const quoteRow = yield* quoteById(transaction, quoteId);
    if (quoteRow === null) return yield* Effect.fail(storageFailure("invalid-row"));
    const quote = quoteFromRow(quoteRow, planOutcome.plan);
    if (quote === null) return yield* Effect.fail(storageFailure("invalid-row"));
    return { kind: "inserted", quote } as const;
  });
}

export function makeControlPlaneCommunityPurchaseCommerceStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: CommunityPurchaseCommerceStoreOptions = {},
): CommunityPurchaseCommerceStore {
  const nextId = options.nextId ?? uuidId;
  const provide = <A>(
    effect: Effect.Effect<A, RepositoryError | CommerceTransactionAbort, ControlPlaneDb>,
  ) =>
    Effect.provide(runtime)(effect).pipe(
      Effect.catchTag("CommerceTransactionAbort", (error) => Effect.succeed({ kind: error.kind })),
      Effect.mapError(mapRepositoryError),
    );
  return {
    createQuoteAndPlan: (input) => {
      const effect = Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          createCommerceTransaction(transaction, input, nextId),
        );
      });
      return provide(effect);
    },
  };
}
