import { Data, Effect } from "effect";

/**
 * A Megapot winner sends their claimed, paid USDC onward from the wallet that
 * received the payout. The client signs in the winner's wallet; the server
 * keeps one durable record per credit, fixed to one sender nonce per attempt,
 * so no retry can produce a second transfer. A wallet has at most one open
 * send at a time, so two credits paid to one wallet never share a nonce. An
 * open send that will not be signed is cancelled by a verified zero-value
 * self-transaction with the reserved nonce, never by deletion or expiry.
 * Every status is derived from chain reads at the required confirmation
 * depth, never from elapsed time.
 */

export const REWARD_WINNER_SEND_CHAIN_ID = 84_532;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
const UINT256_LIMIT = 1n << 256n;
/** Bounded re-observation when an attach lands between a read and its write. */
const SETTLE_ROUNDS = 3;

export class RewardWinnerSendStorageFailed extends Data.TaggedError(
  "RewardWinnerSendStorageFailed",
)<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class RewardWinnerSendRejected extends Data.TaggedError("RewardWinnerSendRejected")<{
  readonly reason:
    | "not-found"
    | "credit-not-eligible"
    | "invalid-recipient"
    | "invalid-amount"
    | "idempotency-conflict"
    | "send-conflict"
    | "sender-busy"
    | "transaction-not-found"
    | "transaction-mismatch"
    | "nonce-not-consumed"
    | "status-contended";
}> {}

export class RewardWinnerSendChainUnavailable extends Data.TaggedError(
  "RewardWinnerSendChainUnavailable",
)<{
  readonly reason: "rpc-unavailable";
}> {}

export type RewardWinnerSendFailure = RewardWinnerSendRejected | RewardWinnerSendStorageFailed;

export type RewardWinnerSendStatus =
  | "retryable"
  | "pending"
  | "confirmed"
  | "reverted"
  | "settled_unverified"
  | "cancelled";

/** Final for the current attempt: status is read from storage, not the chain. */
export function isFinalRewardWinnerSendStatus(status: RewardWinnerSendStatus): boolean {
  return status !== "retryable" && status !== "pending";
}

export type RewardWinnerSendTransactionKind = "transfer" | "cancel";

/** The caller's claimed, paid participant credit and the wallet that received it. */
export type RewardWinnerSendContext = Readonly<{
  creditId: string;
  accountId: string;
  personaId: string;
  walletAssignmentId: string;
  senderAddress: string;
  tokenAddress: string;
  chainId: number;
  paidAtomic: bigint;
}>;

export type RewardWinnerSendRecord = Readonly<{
  sendId: string;
  creditId: string;
  accountId: string;
  status: RewardWinnerSendStatus;
  chainId: number;
  senderAddress: string;
  recipientAddress: string;
  tokenAddress: string;
  amountAtomic: bigint;
  nonce: bigint;
  attempt: number;
  /** Transfer hashes accepted for the current attempt, oldest first. */
  transactionHashes: readonly string[];
  /** Cancellation hashes accepted for the current attempt, oldest first. */
  cancellationHashes: readonly string[];
}>;

/** The attempt an idempotency key created and the record it belongs to now. */
export type RewardWinnerSendKeyMatch = Readonly<{
  creditId: string;
  recipientAddress: string;
  amountAtomic: bigint;
  record: RewardWinnerSendRecord;
}>;

export type RewardWinnerSendReceiptEvidence = Readonly<{
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  observedHeadBlockNumber: bigint;
  observedConfirmedNonce: bigint;
  confirmations: number;
}>;

export type RewardWinnerSendOutcome =
  | (Readonly<{ outcome: "confirmed" | "reverted" | "cancelled" }> &
      RewardWinnerSendReceiptEvidence)
  | Readonly<{
      outcome: "settled_unverified";
      observedHeadBlockNumber: bigint;
      observedConfirmedNonce: bigint;
      confirmations: number;
    }>;

/** A fresh nonce read, run by the store only while it holds the sender's lock. */
export type RewardWinnerSendNonceReader = Effect.Effect<bigint, RewardWinnerSendChainUnavailable>;

export interface RewardWinnerSendStore {
  readonly findByKey: (input: {
    readonly accountId: string;
    readonly idempotencyKey: string;
  }) => Effect.Effect<RewardWinnerSendKeyMatch | null, RewardWinnerSendFailure>;
  /** The credit's non-cancelled record, else its most recent cancelled one. */
  readonly findByCredit: (input: {
    readonly accountId: string;
    readonly creditId: string;
  }) => Effect.Effect<RewardWinnerSendRecord | null, RewardWinnerSendFailure>;
  readonly get: (input: {
    readonly accountId: string;
    readonly sendId: string;
  }) => Effect.Effect<RewardWinnerSendRecord | null, RewardWinnerSendFailure>;
  /** Fails not-found for a missing or foreign credit, credit-not-eligible otherwise. */
  readonly loadContext: (input: {
    readonly accountId: string;
    readonly creditId: string;
  }) => Effect.Effect<RewardWinnerSendContext, RewardWinnerSendFailure>;
  /**
   * In one transaction holding the sender's lock: refuse sender-busy while
   * the sender has an open send, then read the nonce, require it above every
   * nonce the sender ever reserved (nonce-not-consumed), and insert. A
   * storage conflict means another request created the credit's record.
   */
  readonly create: (input: {
    readonly context: RewardWinnerSendContext;
    readonly sendId: string;
    readonly idempotencyKey: string;
    readonly recipientAddress: string;
    readonly amountAtomic: bigint;
    readonly readNonce: RewardWinnerSendNonceReader;
  }) => Effect.Effect<
    RewardWinnerSendRecord,
    RewardWinnerSendFailure | RewardWinnerSendChainUnavailable
  >;
  /**
   * The same lock and nonce rules as create, only while the record is
   * reverted at previousAttempt (send-conflict otherwise).
   */
  readonly startAttempt: (input: {
    readonly accountId: string;
    readonly sendId: string;
    readonly previousAttempt: number;
    readonly idempotencyKey: string;
    readonly recipientAddress: string;
    readonly amountAtomic: bigint;
    readonly readNonce: RewardWinnerSendNonceReader;
  }) => Effect.Effect<
    RewardWinnerSendRecord,
    RewardWinnerSendFailure | RewardWinnerSendChainUnavailable
  >;
  /**
   * Only while attempt is current and open. A hash already accepted for this
   * attempt with the same kind is a no-op; a hash accepted elsewhere or with
   * another kind is transaction-mismatch.
   */
  readonly attachTransaction: (input: {
    readonly accountId: string;
    readonly sendId: string;
    readonly attempt: number;
    readonly transactionHash: string;
    readonly kind: RewardWinnerSendTransactionKind;
  }) => Effect.Effect<RewardWinnerSendRecord, RewardWinnerSendFailure>;
  /** Persists a non-final status; a no-op once the attempt moved or settled. */
  readonly recordStatus: (input: {
    readonly sendId: string;
    readonly attempt: number;
    readonly status: "retryable" | "pending";
  }) => Effect.Effect<void, RewardWinnerSendFailure>;
  /**
   * Under the record's row lock, re-reads the attempt's accepted hashes.
   * stale: a hash was accepted after the observation, nothing is written.
   * unchanged: the attempt already moved or settled. recorded: persisted.
   */
  readonly recordOutcome: (
    input: Readonly<{
      sendId: string;
      attempt: number;
      observedTransactionHashes: readonly string[];
    }> &
      RewardWinnerSendOutcome,
  ) => Effect.Effect<"recorded" | "stale" | "unchanged", RewardWinnerSendFailure>;
  /**
   * Late-hash recovery: accepts a verified hash for a settled_unverified
   * attempt and moves it to confirmed in one transaction. send-conflict when
   * the attempt is not settled_unverified.
   */
  readonly recoverConfirmed: (
    input: Readonly<{ accountId: string; sendId: string; attempt: number }> &
      RewardWinnerSendReceiptEvidence,
  ) => Effect.Effect<RewardWinnerSendRecord, RewardWinnerSendFailure>;
}

export type RewardWinnerSendChainTransaction = Readonly<{
  transactionHash: string;
  chainId: number | null;
  from: string;
  to: string | null;
  nonce: bigint;
  valueWei: bigint;
  input: string;
}>;

export type RewardWinnerSendTransferLog = Readonly<{
  tokenAddress: string;
  from: string;
  to: string;
  amountAtomic: bigint;
}>;

export type RewardWinnerSendReceipt = Readonly<{
  transactionHash: string;
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: string;
  transfers: readonly RewardWinnerSendTransferLog[];
}>;

/**
 * A receipt read: null when the hash is not mined, or not canonical when a
 * receipt exists but its block is no longer (or not yet) the canonical one.
 */
export type RewardWinnerSendReceiptRead =
  | null
  | Readonly<{ canonical: false; transactionHash: string }>
  | (Readonly<{ canonical: true }> & RewardWinnerSendReceipt);

export interface RewardWinnerSendChain {
  readonly readPendingNonce: (
    address: string,
  ) => Effect.Effect<bigint, RewardWinnerSendChainUnavailable>;
  /** Null when the node does not know the hash (never seen, or dropped). */
  readonly readTransaction: (
    transactionHash: string,
  ) => Effect.Effect<RewardWinnerSendChainTransaction | null, RewardWinnerSendChainUnavailable>;
  readonly readHead: () => Effect.Effect<bigint, RewardWinnerSendChainUnavailable>;
  /** The account's mined transaction count as of blockNumber. */
  readonly readTransactionCount: (
    address: string,
    blockNumber: bigint,
  ) => Effect.Effect<bigint, RewardWinnerSendChainUnavailable>;
  readonly readReceipt: (
    transactionHash: string,
  ) => Effect.Effect<RewardWinnerSendReceiptRead, RewardWinnerSendChainUnavailable>;
}

export type RewardWinnerSendObservation = Readonly<{
  headBlockNumber: bigint;
  /** Sender's mined transaction count at the head. */
  latestNonce: bigint;
  /** Sender's mined transaction count at the confirmation depth. */
  confirmedNonce: bigint;
  /** Canonical receipts of accepted hashes. */
  receipts: readonly RewardWinnerSendReceipt[];
  /** Accepted hashes with a receipt whose block is not canonical. */
  reorganizedHashes: readonly string[];
  /** Accepted hashes the node still knows as a transaction, mined or not. */
  knownHashes: readonly string[];
}>;

export type RewardWinnerSendComputedStatus =
  | Readonly<{ status: "retryable" | "pending" }>
  | RewardWinnerSendOutcome;

/** ERC-20 transfer(recipient, amount) calldata, lowercase hex. */
export function encodeRewardWinnerSendCalldata(recipient: string, amountAtomic: bigint): string {
  if (!/^0x[0-9a-f]{40}$/u.test(recipient) || amountAtomic <= 0n || amountAtomic >= UINT256_LIMIT) {
    throw new Error("invalid ERC-20 transfer arguments");
  }
  return `${ERC20_TRANSFER_SELECTOR}${recipient.slice(2).padStart(64, "0")}${amountAtomic
    .toString(16)
    .padStart(64, "0")}`;
}

/** True only for exactly the record's ERC-20 transfer at the record's nonce. */
export function matchesRewardWinnerSendTransaction(
  transaction: RewardWinnerSendChainTransaction,
  record: RewardWinnerSendRecord,
): boolean {
  return (
    transaction.chainId === record.chainId &&
    transaction.from.toLowerCase() === record.senderAddress &&
    transaction.to !== null &&
    transaction.to.toLowerCase() === record.tokenAddress &&
    transaction.nonce === record.nonce &&
    transaction.valueWei === 0n &&
    transaction.input.toLowerCase() ===
      encodeRewardWinnerSendCalldata(record.recipientAddress, record.amountAtomic)
  );
}

/** True only for a zero-value, empty-calldata self-transaction at the record's nonce. */
export function matchesRewardWinnerSendCancellation(
  transaction: RewardWinnerSendChainTransaction,
  record: RewardWinnerSendRecord,
): boolean {
  return (
    transaction.chainId === record.chainId &&
    transaction.from.toLowerCase() === record.senderAddress &&
    transaction.to !== null &&
    transaction.to.toLowerCase() === record.senderAddress &&
    transaction.nonce === record.nonce &&
    transaction.valueWei === 0n &&
    (transaction.input === "0x" || transaction.input === "")
  );
}

/**
 * The status rules. Only one transaction per sender nonce can be mined, so at
 * most one accepted hash, transfer or cancellation, can hold a receipt.
 *
 * - cancelled: an accepted cancellation's receipt is at depth and carries no
 *   Transfer of the token from the sender (a reverted cancellation moved
 *   nothing either). One carrying such a Transfer is settled_unverified.
 * - confirmed: an accepted hash's receipt succeeded at depth with exactly one
 *   Transfer log of the token from sender to recipient for exactly amount.
 * - reverted: an accepted hash's receipt reverted at depth.
 * - settled_unverified: the nonce was consumed at depth but no accepted hash
 *   has a receipt, or the successful receipt lacks the exact Transfer log.
 * - pending: something for the nonce is mined but not yet at depth, a receipt
 *   is off the canonical chain, or the node still knows an accepted hash.
 * - retryable: nothing is mined for the nonce and the node knows none of the
 *   accepted hashes (none accepted yet, or all dropped): re-sign the nonce.
 */
export function computeRewardWinnerSendStatus(input: {
  readonly record: RewardWinnerSendRecord;
  readonly requiredConfirmations: number;
  readonly observation: RewardWinnerSendObservation;
}): RewardWinnerSendComputedStatus {
  const { record, observation } = input;
  const required = input.requiredConfirmations;
  if (!Number.isSafeInteger(required) || required < 1) {
    throw new Error("invalid required confirmations");
  }
  const cancellations = new Set(record.cancellationHashes);
  const accepted = new Set([...record.transactionHashes, ...record.cancellationHashes]);
  const mined = observation.receipts.filter(
    (receipt) =>
      accepted.has(receipt.transactionHash) && receipt.blockNumber <= observation.headBlockNumber,
  );
  const observed = {
    observedHeadBlockNumber: observation.headBlockNumber,
    observedConfirmedNonce: observation.confirmedNonce,
    confirmations: required,
  };
  // A receipt off the canonical chain, or two receipts for one nonce (which
  // one chain cannot hold), is a node inconsistency: wait, never settle.
  if (observation.reorganizedHashes.some((hash) => accepted.has(hash)) || mined.length > 1) {
    return { status: "pending" };
  }
  const receipt = mined[0];
  if (receipt !== undefined) {
    const depth = observation.headBlockNumber - receipt.blockNumber + 1n;
    if (depth < BigInt(required)) return { status: "pending" };
    const evidence = {
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      ...observed,
    };
    if (cancellations.has(receipt.transactionHash)) {
      const moved = receipt.transfers.some(
        (log) => log.tokenAddress === record.tokenAddress && log.from === record.senderAddress,
      );
      return moved
        ? { outcome: "settled_unverified", ...observed }
        : { outcome: "cancelled", ...evidence };
    }
    if (receipt.status === "reverted") return { outcome: "reverted", ...evidence };
    const transfers = receipt.transfers.filter(
      (log) =>
        log.tokenAddress === record.tokenAddress &&
        log.from === record.senderAddress &&
        log.to === record.recipientAddress &&
        log.amountAtomic === record.amountAtomic,
    );
    return transfers.length === 1
      ? { outcome: "confirmed", ...evidence }
      : { outcome: "settled_unverified", ...observed };
  }
  if (observation.confirmedNonce > record.nonce) {
    return { outcome: "settled_unverified", ...observed };
  }
  if (
    observation.latestNonce > record.nonce ||
    observation.knownHashes.some((hash) => accepted.has(hash))
  ) {
    return { status: "pending" };
  }
  return { status: "retryable" };
}

export type RewardWinnerSendRequest = Readonly<{
  accountId: string;
  creditId: string;
  recipientAddress: string;
  amountAtomic: bigint;
  idempotencyKey: string;
}>;

type Failure = RewardWinnerSendFailure | RewardWinnerSendChainUnavailable;

export interface RewardWinnerSendService {
  readonly request: (
    input: RewardWinnerSendRequest,
  ) => Effect.Effect<RewardWinnerSendRecord, Failure>;
  readonly attachTransaction: (input: {
    readonly accountId: string;
    readonly sendId: string;
    readonly transactionHash: string;
  }) => Effect.Effect<RewardWinnerSendRecord, Failure>;
  /** Reports a zero-value self-transaction that consumes the reserved nonce. */
  readonly cancel: (input: {
    readonly accountId: string;
    readonly sendId: string;
    readonly transactionHash: string;
  }) => Effect.Effect<RewardWinnerSendRecord, Failure>;
  readonly get: (input: {
    readonly accountId: string;
    readonly sendId: string;
  }) => Effect.Effect<RewardWinnerSendRecord, Failure>;
  readonly getByCredit: (input: {
    readonly accountId: string;
    readonly creditId: string;
  }) => Effect.Effect<RewardWinnerSendRecord, Failure>;
}

const rejected = (reason: RewardWinnerSendRejected["reason"]) =>
  new RewardWinnerSendRejected({ reason });

/** The account and credit always come from the session and the path. */
export function makeRewardWinnerSendService(input: {
  readonly store: RewardWinnerSendStore;
  readonly chain: RewardWinnerSendChain;
  readonly requiredConfirmations: number;
  readonly ids: Readonly<{ next: Effect.Effect<string> }>;
}): RewardWinnerSendService {
  const { store, chain } = input;
  if (!Number.isSafeInteger(input.requiredConfirmations) || input.requiredConfirmations < 1) {
    throw new Error("invalid reward winner send confirmations");
  }

  const observe = Effect.fn("RewardWinnerSend.observe")(function* (
    senderAddress: string,
    transactionHashes: readonly string[],
  ) {
    const headBlockNumber = yield* chain.readHead();
    const depthBlock = headBlockNumber - BigInt(input.requiredConfirmations) + 1n;
    const [latestNonce, confirmedNonce, reads] = yield* Effect.all(
      [
        chain.readTransactionCount(senderAddress, headBlockNumber),
        depthBlock < 0n
          ? Effect.succeed(0n)
          : chain.readTransactionCount(senderAddress, depthBlock),
        Effect.forEach(
          transactionHashes,
          (hash) =>
            Effect.all([chain.readReceipt(hash), chain.readTransaction(hash)], {
              concurrency: 2,
            }),
          { concurrency: 4 },
        ),
      ],
      { concurrency: 3 },
    );
    return {
      headBlockNumber,
      latestNonce,
      confirmedNonce,
      receipts: reads.flatMap(([receipt]) => (receipt?.canonical ? [receipt] : [])),
      reorganizedHashes: reads.flatMap(([receipt]) =>
        receipt !== null && !receipt.canonical ? [receipt.transactionHash] : [],
      ),
      knownHashes: reads.flatMap(([receipt, transaction], index) =>
        receipt !== null || transaction !== null ? [transactionHashes[index] as string] : [],
      ),
    } satisfies RewardWinnerSendObservation;
  });

  /**
   * Reads the chain for an open attempt and persists what it proves. A final
   * outcome is written only if no hash was accepted since the observation;
   * otherwise the record is re-read and observed again with the new hash.
   */
  const refresh = Effect.fn("RewardWinnerSend.refresh")(function* (
    initial: RewardWinnerSendRecord,
  ) {
    let record = initial;
    for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
      if (isFinalRewardWinnerSendStatus(record.status)) return record;
      const hashes = [...record.transactionHashes, ...record.cancellationHashes];
      const observation = yield* observe(record.senderAddress, hashes);
      const computed = computeRewardWinnerSendStatus({
        record,
        requiredConfirmations: input.requiredConfirmations,
        observation,
      });
      if (!("outcome" in computed)) {
        if (computed.status !== record.status) {
          yield* store.recordStatus({
            sendId: record.sendId,
            attempt: record.attempt,
            status: computed.status,
          });
        }
        return { ...record, status: computed.status };
      }
      const written = yield* store.recordOutcome({
        sendId: record.sendId,
        attempt: record.attempt,
        observedTransactionHashes: hashes,
        ...computed,
      });
      const stored = yield* store.get({ accountId: record.accountId, sendId: record.sendId });
      if (stored === null) return yield* rejected("not-found");
      if (written !== "stale") return stored;
      record = stored;
    }
    return yield* rejected("status-contended");
  });

  const sameBody = (
    record: Pick<RewardWinnerSendRecord, "recipientAddress" | "amountAtomic">,
    request: RewardWinnerSendRequest,
  ) =>
    record.recipientAddress === request.recipientAddress &&
    record.amountAtomic === request.amountAtomic;

  const replayOrConflict = Effect.fn("RewardWinnerSend.replayOrConflict")(function* (
    request: RewardWinnerSendRequest,
  ) {
    const replay = yield* store.findByKey(request);
    if (replay !== null) {
      if (replay.creditId !== request.creditId || !sameBody(replay, request)) {
        return yield* rejected("idempotency-conflict");
      }
      return yield* refresh(replay.record);
    }
    const existing = yield* store.findByCredit(request);
    if (existing !== null && existing.status !== "cancelled" && sameBody(existing, request)) {
      return yield* refresh(existing);
    }
    return yield* rejected("send-conflict");
  });

  const request = Effect.fn("RewardWinnerSend.request")(function* (raw: RewardWinnerSendRequest) {
    const request = { ...raw, recipientAddress: raw.recipientAddress.toLowerCase() };
    if (!/^0x[0-9a-f]{40}$/u.test(request.recipientAddress)) {
      return yield* rejected("invalid-recipient");
    }
    const replay = yield* store.findByKey(request);
    if (replay !== null) {
      if (replay.creditId !== request.creditId || !sameBody(replay, request)) {
        return yield* rejected("idempotency-conflict");
      }
      return yield* refresh(replay.record);
    }
    const context = yield* store.loadContext(request);
    if (context.chainId !== REWARD_WINNER_SEND_CHAIN_ID) {
      return yield* rejected("credit-not-eligible");
    }
    if (
      request.recipientAddress === ZERO_ADDRESS ||
      request.recipientAddress === context.senderAddress ||
      request.recipientAddress === context.tokenAddress
    ) {
      return yield* rejected("invalid-recipient");
    }
    if (request.amountAtomic < 1n || request.amountAtomic > context.paidAtomic) {
      return yield* rejected("invalid-amount");
    }
    const readNonce = chain.readPendingNonce(context.senderAddress);
    const found = yield* store.findByCredit(request);
    // A cancelled record released its credit: start a new record.
    const existing = found?.status === "cancelled" ? null : found;
    if (existing !== null) {
      const current = yield* refresh(existing);
      if (current.status === "reverted") {
        return yield* store
          .startAttempt({
            accountId: request.accountId,
            sendId: current.sendId,
            previousAttempt: current.attempt,
            idempotencyKey: request.idempotencyKey,
            recipientAddress: request.recipientAddress,
            amountAtomic: request.amountAtomic,
            readNonce,
          })
          .pipe(
            Effect.catchTag("RewardWinnerSendRejected", (error) =>
              error.reason === "send-conflict" ? replayOrConflict(request) : Effect.fail(error),
            ),
            Effect.catchTag("RewardWinnerSendStorageFailed", (error) =>
              error.reason === "conflict" ? replayOrConflict(request) : Effect.fail(error),
            ),
          );
      }
      if (sameBody(current, request)) return current;
      return yield* rejected("send-conflict");
    }
    const sendId = `winner-send_${yield* input.ids.next}`;
    return yield* store
      .create({
        context,
        sendId,
        idempotencyKey: request.idempotencyKey,
        recipientAddress: request.recipientAddress,
        amountAtomic: request.amountAtomic,
        readNonce,
      })
      .pipe(
        Effect.catchTag("RewardWinnerSendStorageFailed", (error) =>
          error.reason === "conflict" ? replayOrConflict(request) : Effect.fail(error),
        ),
      );
  });

  const load = Effect.fn("RewardWinnerSend.load")(function* (lookup: {
    readonly accountId: string;
    readonly sendId: string;
  }) {
    const record = yield* store.get(lookup);
    if (record === null) return yield* rejected("not-found");
    return record;
  });

  /**
   * A settled_unverified attempt becomes confirmed only when a late hash
   * verifies and its canonical receipt at depth shows the exact transfer.
   * Nothing else about the attempt changes, so no send is ever re-enabled.
   */
  const recover = Effect.fn("RewardWinnerSend.recover")(function* (
    record: RewardWinnerSendRecord,
    transactionHash: string,
  ) {
    const probe = { ...record, transactionHashes: [transactionHash], cancellationHashes: [] };
    const computed = computeRewardWinnerSendStatus({
      record: probe,
      requiredConfirmations: input.requiredConfirmations,
      observation: yield* observe(record.senderAddress, probe.transactionHashes),
    });
    if (!("outcome" in computed) || computed.outcome !== "confirmed") {
      return yield* rejected("send-conflict");
    }
    return yield* store.recoverConfirmed({
      accountId: record.accountId,
      sendId: record.sendId,
      attempt: record.attempt,
      transactionHash: computed.transactionHash,
      blockNumber: computed.blockNumber,
      blockHash: computed.blockHash,
      observedHeadBlockNumber: computed.observedHeadBlockNumber,
      observedConfirmedNonce: computed.observedConfirmedNonce,
      confirmations: computed.confirmations,
    });
  });

  const attachTransaction = Effect.fn("RewardWinnerSend.attachTransaction")(function* (attach: {
    readonly accountId: string;
    readonly sendId: string;
    readonly transactionHash: string;
  }) {
    const transactionHash = attach.transactionHash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/u.test(transactionHash)) return yield* rejected("transaction-mismatch");
    const record = yield* load(attach);
    if (record.transactionHashes.includes(transactionHash)) return yield* refresh(record);
    if (record.cancellationHashes.includes(transactionHash)) {
      return yield* rejected("transaction-mismatch");
    }
    // Open attempts take the hash; settled_unverified may still be proven.
    if (
      record.status !== "retryable" &&
      record.status !== "pending" &&
      record.status !== "settled_unverified"
    ) {
      return yield* rejected("send-conflict");
    }
    const transaction = yield* chain.readTransaction(transactionHash);
    if (transaction === null) return yield* rejected("transaction-not-found");
    if (
      transaction.transactionHash.toLowerCase() !== transactionHash ||
      !matchesRewardWinnerSendTransaction(transaction, record)
    ) {
      return yield* rejected("transaction-mismatch");
    }
    if (record.status === "settled_unverified") return yield* recover(record, transactionHash);
    const attached = yield* store
      .attachTransaction({
        accountId: attach.accountId,
        sendId: record.sendId,
        attempt: record.attempt,
        transactionHash,
        kind: "transfer",
      })
      .pipe(
        // A status read settled the attempt first: the late hash may still
        // prove the transfer.
        Effect.catchTag("RewardWinnerSendRejected", (error) =>
          error.reason !== "send-conflict"
            ? Effect.fail(error)
            : Effect.gen(function* () {
                const current = yield* load(attach);
                if (current.status !== "settled_unverified" || current.attempt !== record.attempt) {
                  return yield* error;
                }
                return yield* recover(current, transactionHash);
              }),
        ),
      );
    return yield* refresh(attached);
  });

  const cancel = Effect.fn("RewardWinnerSend.cancel")(function* (attach: {
    readonly accountId: string;
    readonly sendId: string;
    readonly transactionHash: string;
  }) {
    const transactionHash = attach.transactionHash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/u.test(transactionHash)) return yield* rejected("transaction-mismatch");
    const record = yield* load(attach);
    if (record.cancellationHashes.includes(transactionHash)) return yield* refresh(record);
    if (record.transactionHashes.includes(transactionHash)) {
      return yield* rejected("transaction-mismatch");
    }
    // Only an open send can be cancelled; nothing settled moves backwards.
    if (record.status !== "retryable" && record.status !== "pending") {
      return yield* rejected("send-conflict");
    }
    const transaction = yield* chain.readTransaction(transactionHash);
    if (transaction === null) return yield* rejected("transaction-not-found");
    if (
      transaction.transactionHash.toLowerCase() !== transactionHash ||
      !matchesRewardWinnerSendCancellation(transaction, record)
    ) {
      return yield* rejected("transaction-mismatch");
    }
    const attached = yield* store.attachTransaction({
      accountId: attach.accountId,
      sendId: record.sendId,
      attempt: record.attempt,
      transactionHash,
      kind: "cancel",
    });
    return yield* refresh(attached);
  });

  const get = Effect.fn("RewardWinnerSend.get")(function* (lookup: {
    readonly accountId: string;
    readonly sendId: string;
  }) {
    return yield* refresh(yield* load(lookup));
  });

  const getByCredit = Effect.fn("RewardWinnerSend.getByCredit")(function* (lookup: {
    readonly accountId: string;
    readonly creditId: string;
  }) {
    const record = yield* store.findByCredit(lookup);
    if (record === null) return yield* rejected("not-found");
    return yield* refresh(record);
  });

  return { request, attachTransaction, cancel, get, getByCredit };
}
