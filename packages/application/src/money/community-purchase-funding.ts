import {
  assertCommunityPurchaseFundingSnapshot,
  type CommunityPurchaseFundingEvent,
  type CommunityPurchaseFundingEvidence,
  type CommunityPurchaseFundingPlan,
  type CommunityPurchaseFundingSnapshot,
  type CommunityPurchaseOperationId,
  communityPurchaseAtomicAmount,
  createCommunityPurchaseFunding,
  deriveCommunityPurchaseRowId,
  type EvmAddress,
  isTransitionRejection,
  type MoneyFlowJournalEntry,
  transitionCommunityPurchaseFunding,
} from "@pirate/domain";
import { Data, Effect, Option, Schema } from "effect";

export const COMMUNITY_PURCHASE_FUNDING_ENDPOINT = "community-purchase-funding" as const;

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const CanonicalAddress = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/u));
const PositiveIntegerString = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));
const CanonicalRequest = Schema.Record(Schema.String, Schema.Json);

const EncodedEvidence = Schema.Struct({
  receiptStatus: Schema.Literals(["success", "reverted"]),
  chainId: Schema.Number,
  tokenContract: CanonicalAddress,
  sender: CanonicalAddress,
  recipient: CanonicalAddress,
  amountAtomic: PositiveIntegerString,
  transactionHash: Schema.String,
  blockNumber: Schema.Number,
  blockHash: Schema.String,
  logIndex: Schema.NullOr(Schema.Number),
  observationId: Schema.String,
  observedHeadBlockNumber: Schema.Number,
  observedHeadBlockHash: Schema.String,
});

const ReclaimableFence = Schema.Struct({
  _tag: Schema.Literal("reclaimable"),
  mayRebroadcast: Schema.Literal(true),
  mayRetry: Schema.Literal(true),
});
const AmbiguousFence = Schema.Struct({
  _tag: Schema.Literals(["ambiguous", "legacy"]),
  mayRebroadcast: Schema.Literal(false),
  mayRetry: Schema.Literal(false),
  disposition: Schema.Literal("reconciliation_required"),
});
const EncodedFailure = Schema.Union([ReclaimableFence, AmbiguousFence]);

const EncodedSnapshot = Schema.Struct({
  state: Schema.Literals([
    "planned",
    "confirming",
    "confirmed",
    "reverted",
    "reclaimable_failed",
    "reconciliation_required",
  ]),
  operationId: Schema.NonEmptyString,
  communityId: Schema.NonEmptyString,
  quoteId: Schema.NonEmptyString,
  purchaseId: Schema.NonEmptyString,
  policyVersion: Schema.Number,
  expected: Schema.Struct({
    chainId: Schema.Number,
    tokenContract: CanonicalAddress,
    tokenDecimals: Schema.Literal(6),
    sender: CanonicalAddress,
    recipient: CanonicalAddress,
    amountAtomic: PositiveIntegerString,
    requiredConfirmations: Schema.Number,
  }),
  version: Schema.Number,
  updatedAt: Schema.Number,
  fundingEvidence: Schema.NullOr(EncodedEvidence),
  failure: Schema.NullOr(EncodedFailure),
  failureReason: Schema.NullOr(Schema.String),
  reconciliationEvidence: Schema.NullOr(EncodedEvidence),
});

type JsonRecord = Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>;
export type CommunityPurchaseFundingCaller = "request" | "reconciler";

export type CommunityPurchaseFundingRequestRecord = Readonly<{
  actorId: string;
  endpoint: typeof COMMUNITY_PURCHASE_FUNDING_ENDPOINT;
  clientNonce: string;
  requestHash: string;
  canonicalRequest: JsonRecord;
  operationId: CommunityPurchaseOperationId;
}>;

export type CommunityPurchaseFundingLease = Readonly<{
  operationId: CommunityPurchaseOperationId;
  ownerId: string;
  fenceToken: number;
  expiresAt: string;
}>;

export type CommunityPurchaseFundingJournalRecord = Readonly<{
  entry: MoneyFlowJournalEntry<CommunityPurchaseFundingSnapshot>;
}>;

export type CommunityPurchaseFundingBeginStoreOutcome =
  | { readonly kind: "inserted"; readonly record: CommunityPurchaseFundingJournalRecord }
  | { readonly kind: "replayed"; readonly record: CommunityPurchaseFundingJournalRecord }
  | { readonly kind: "request_conflict" }
  | { readonly kind: "operation_conflict" };

export type CommunityPurchaseFundingLeaseStoreOutcome =
  | { readonly kind: "acquired"; readonly lease: CommunityPurchaseFundingLease }
  | { readonly kind: "busy"; readonly retryAfterSeconds: number }
  | { readonly kind: "missing" };

export type CommunityPurchaseFundingCommitStoreOutcome =
  | { readonly kind: "committed"; readonly record: CommunityPurchaseFundingJournalRecord }
  | { readonly kind: "replayed"; readonly record: CommunityPurchaseFundingJournalRecord }
  | { readonly kind: "version_conflict" }
  | { readonly kind: "lease_lost" }
  | { readonly kind: "identity_conflict" }
  | { readonly kind: "missing" };

export class CommunityPurchaseFundingStorageFailed extends Data.TaggedError(
  "CommunityPurchaseFundingStorageFailed",
)<{
  readonly reason: "unavailable" | "invalid-row" | "constraint" | "outcome-unknown";
}> {}

export class CommunityPurchaseFundingRejected extends Data.TaggedError(
  "CommunityPurchaseFundingRejected",
)<{
  readonly reason:
    | "invalid-input"
    | "request-conflict"
    | "operation-conflict"
    | "not-found"
    | "lease-busy"
    | "lease-lost"
    | "version-conflict"
    | "identity-conflict"
    | "transition-rejected";
  readonly detail?: string;
  readonly retryAfterSeconds?: number;
}> {}

export type CommunityPurchaseFundingInterpreterFailure =
  | CommunityPurchaseFundingStorageFailed
  | CommunityPurchaseFundingRejected;

export interface CommunityPurchaseFundingJournalStore {
  readonly begin: (input: {
    readonly request: CommunityPurchaseFundingRequestRecord;
    readonly entry: MoneyFlowJournalEntry<CommunityPurchaseFundingSnapshot>;
  }) => Effect.Effect<
    CommunityPurchaseFundingBeginStoreOutcome,
    CommunityPurchaseFundingStorageFailed
  >;
  readonly load: (
    operationId: CommunityPurchaseOperationId,
  ) => Effect.Effect<
    CommunityPurchaseFundingJournalRecord | null,
    CommunityPurchaseFundingStorageFailed
  >;
  readonly acquireLease: (input: {
    readonly operationId: CommunityPurchaseOperationId;
    readonly ownerId: string;
    readonly leaseMs: number;
  }) => Effect.Effect<
    CommunityPurchaseFundingLeaseStoreOutcome,
    CommunityPurchaseFundingStorageFailed
  >;
  readonly wasTransitionCommitted: (input: {
    readonly operationId: CommunityPurchaseOperationId;
    readonly targetVersion: number;
    readonly event: CommunityPurchaseFundingEvent;
  }) => Effect.Effect<boolean, CommunityPurchaseFundingStorageFailed>;
  readonly commitTransition: (input: {
    readonly lease: CommunityPurchaseFundingLease;
    readonly source: CommunityPurchaseFundingCaller;
    readonly expectedVersion: number;
    readonly event: CommunityPurchaseFundingEvent;
    readonly nextEntry: MoneyFlowJournalEntry<CommunityPurchaseFundingSnapshot>;
  }) => Effect.Effect<
    CommunityPurchaseFundingCommitStoreOutcome,
    CommunityPurchaseFundingStorageFailed
  >;
}

export interface CommunityPurchaseFundingInterpreter {
  readonly begin: (input: {
    readonly actorId: string;
    readonly clientNonce: string;
    readonly canonicalRequest: unknown;
    readonly plan: CommunityPurchaseFundingPlan;
  }) => Effect.Effect<
    {
      readonly entry: MoneyFlowJournalEntry<CommunityPurchaseFundingSnapshot>;
      readonly replayed: boolean;
    },
    CommunityPurchaseFundingInterpreterFailure
  >;
  readonly acquireLease: (input: {
    readonly operationId: CommunityPurchaseOperationId;
    readonly ownerId: string;
    readonly leaseMs: number;
  }) => Effect.Effect<CommunityPurchaseFundingLease, CommunityPurchaseFundingInterpreterFailure>;
  readonly transition: (input: {
    readonly lease: CommunityPurchaseFundingLease;
    readonly source: CommunityPurchaseFundingCaller;
    readonly expectedVersion: number;
    readonly event: CommunityPurchaseFundingEvent;
  }) => Effect.Effect<
    {
      readonly entry: MoneyFlowJournalEntry<CommunityPurchaseFundingSnapshot>;
      readonly replayed: boolean;
    },
    CommunityPurchaseFundingInterpreterFailure
  >;
}

function reject(
  reason: CommunityPurchaseFundingRejected["reason"],
  options: { readonly detail?: string; readonly retryAfterSeconds?: number } = {},
): CommunityPurchaseFundingRejected {
  return new CommunityPurchaseFundingRejected({ reason, ...options });
}

function canonicalNonEmpty(value: string): boolean {
  return value.length > 0 && value === value.trim();
}

function decodeCanonicalRequest(value: unknown): JsonRecord | null {
  const decoded = Schema.decodeUnknownOption(CanonicalRequest)(value);
  return Option.isSome(decoded) ? decoded.value : null;
}

function validSha256(value: string): boolean {
  return Option.isSome(Schema.decodeUnknownOption(Sha256Hex)(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export async function computeCommunityPurchaseFundingRequestHash(
  canonicalRequest: JsonRecord,
): Promise<string> {
  const material = canonicalJson({
    hash_version: "community-purchase-funding-request-v1",
    request: canonicalRequest,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeCommunityPurchaseEvmAddress(value: unknown): EvmAddress | null {
  const stringValue = Schema.decodeUnknownOption(Schema.String)(value);
  if (Option.isNone(stringValue)) return null;
  const decoded = Schema.decodeUnknownOption(CanonicalAddress)(stringValue.value.toLowerCase());
  return Option.isSome(decoded) ? (decoded.value as EvmAddress) : null;
}

export function normalizeCommunityPurchaseFundingEvidence(
  evidence: CommunityPurchaseFundingEvidence,
): CommunityPurchaseFundingEvidence | null {
  const tokenContract = normalizeCommunityPurchaseEvmAddress(evidence.tokenContract);
  const sender = normalizeCommunityPurchaseEvmAddress(evidence.sender);
  const recipient = normalizeCommunityPurchaseEvmAddress(evidence.recipient);
  return tokenContract === null || sender === null || recipient === null
    ? null
    : { ...evidence, tokenContract, sender, recipient };
}

function encodeEvidence(evidence: CommunityPurchaseFundingEvidence | null): unknown {
  return evidence === null ? null : { ...evidence, amountAtomic: evidence.amountAtomic.toString() };
}

function decodeEvidence(
  value: Schema.Schema.Type<typeof EncodedEvidence>,
): CommunityPurchaseFundingEvidence {
  return {
    ...value,
    amountAtomic: communityPurchaseAtomicAmount(BigInt(value.amountAtomic)),
  } as CommunityPurchaseFundingEvidence;
}

export function encodeCommunityPurchaseFundingSnapshot(
  snapshot: CommunityPurchaseFundingSnapshot,
): JsonRecord {
  return {
    ...snapshot,
    expected: { ...snapshot.expected, amountAtomic: snapshot.expected.amountAtomic.toString() },
    fundingEvidence: encodeEvidence(snapshot.fundingEvidence),
    reconciliationEvidence: encodeEvidence(snapshot.reconciliationEvidence),
  } as JsonRecord;
}

export function decodeCommunityPurchaseFundingSnapshot(
  value: unknown,
): CommunityPurchaseFundingSnapshot | null {
  const result = Schema.decodeUnknownOption(EncodedSnapshot)(value);
  if (Option.isNone(result)) return null;
  const decoded = result.value;
  const snapshot = {
    ...decoded,
    operationId: decoded.operationId as CommunityPurchaseOperationId,
    expected: {
      ...decoded.expected,
      amountAtomic: communityPurchaseAtomicAmount(BigInt(decoded.expected.amountAtomic)),
    },
    fundingEvidence:
      decoded.fundingEvidence === null ? null : decodeEvidence(decoded.fundingEvidence),
    reconciliationEvidence:
      decoded.reconciliationEvidence === null
        ? null
        : decodeEvidence(decoded.reconciliationEvidence),
  } as CommunityPurchaseFundingSnapshot;
  try {
    assertCommunityPurchaseFundingSnapshot(snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

export function encodeCommunityPurchaseFundingEvent(
  event: CommunityPurchaseFundingEvent,
): JsonRecord {
  if (event.type === "funding_evidence_observed" || event.type === "reconciliation_resolved") {
    return { ...event, evidence: encodeEvidence(event.evidence) } as JsonRecord;
  }
  return { ...event } as JsonRecord;
}

export function journalEntryFromCommunityPurchaseFunding(
  snapshot: CommunityPurchaseFundingSnapshot,
): MoneyFlowJournalEntry<CommunityPurchaseFundingSnapshot> {
  const base = {
    idempotencyKey: snapshot.operationId,
    version: snapshot.version,
    state: snapshot,
  } as const;
  if (snapshot.state === "reclaimable_failed") {
    return { ...base, status: snapshot.state, failure: snapshot.failure };
  }
  if (snapshot.state === "reconciliation_required") {
    return { ...base, status: snapshot.state, failure: snapshot.failure };
  }
  return { ...base, status: snapshot.state };
}

function normalizeEvent(
  event: CommunityPurchaseFundingEvent,
): CommunityPurchaseFundingEvent | null {
  if (event.type !== "funding_evidence_observed" && event.type !== "reconciliation_resolved") {
    return event;
  }
  const evidence = normalizeCommunityPurchaseFundingEvidence(event.evidence);
  return evidence === null ? null : { ...event, evidence };
}

function sameEvidence(
  left: CommunityPurchaseFundingEvidence,
  right: CommunityPurchaseFundingEvidence,
): boolean {
  return (
    left.receiptStatus === right.receiptStatus &&
    left.chainId === right.chainId &&
    left.tokenContract === right.tokenContract &&
    left.sender === right.sender &&
    left.recipient === right.recipient &&
    left.amountAtomic === right.amountAtomic &&
    left.transactionHash === right.transactionHash &&
    left.blockNumber === right.blockNumber &&
    left.blockHash === right.blockHash &&
    left.logIndex === right.logIndex &&
    left.observationId === right.observationId &&
    left.observedHeadBlockNumber === right.observedHeadBlockNumber &&
    left.observedHeadBlockHash === right.observedHeadBlockHash
  );
}

function isExactObservationReplay(
  snapshot: CommunityPurchaseFundingSnapshot,
  event: CommunityPurchaseFundingEvent,
): boolean {
  if (event.type !== "funding_evidence_observed") return false;
  return (
    (snapshot.fundingEvidence !== null && sameEvidence(snapshot.fundingEvidence, event.evidence)) ||
    (snapshot.reconciliationEvidence !== null &&
      sameEvidence(snapshot.reconciliationEvidence, event.evidence))
  );
}

export function makeCommunityPurchaseFundingInterpreter(
  store: CommunityPurchaseFundingJournalStore,
): CommunityPurchaseFundingInterpreter {
  const begin = Effect.fn("CommunityPurchaseFundingInterpreter.begin")(function* (input: {
    readonly actorId: string;
    readonly clientNonce: string;
    readonly canonicalRequest: unknown;
    readonly plan: CommunityPurchaseFundingPlan;
  }) {
    const canonicalRequest = decodeCanonicalRequest(input.canonicalRequest);
    if (
      !canonicalNonEmpty(input.actorId) ||
      !canonicalNonEmpty(input.clientNonce) ||
      canonicalRequest === null
    ) {
      return yield* reject("invalid-input");
    }
    const requestHash = yield* Effect.tryPromise({
      try: () => computeCommunityPurchaseFundingRequestHash(canonicalRequest),
      catch: () => new CommunityPurchaseFundingStorageFailed({ reason: "unavailable" }),
    });
    if (!validSha256(requestHash)) return yield* reject("invalid-input");
    const snapshot = createCommunityPurchaseFunding(input.plan);
    const outcome = yield* store.begin({
      request: {
        actorId: input.actorId,
        endpoint: COMMUNITY_PURCHASE_FUNDING_ENDPOINT,
        clientNonce: input.clientNonce,
        requestHash,
        canonicalRequest,
        operationId: snapshot.operationId,
      },
      entry: journalEntryFromCommunityPurchaseFunding(snapshot),
    });
    if (outcome.kind === "request_conflict") return yield* reject("request-conflict");
    if (outcome.kind === "operation_conflict") return yield* reject("operation-conflict");
    return { entry: outcome.record.entry, replayed: outcome.kind === "replayed" };
  });

  const acquireLease = Effect.fn("CommunityPurchaseFundingInterpreter.acquireLease")(
    function* (input: {
      readonly operationId: CommunityPurchaseOperationId;
      readonly ownerId: string;
      readonly leaseMs: number;
    }) {
      if (
        !canonicalNonEmpty(input.ownerId) ||
        !Number.isSafeInteger(input.leaseMs) ||
        input.leaseMs < 1
      ) {
        return yield* reject("invalid-input");
      }
      const outcome = yield* store.acquireLease(input);
      if (outcome.kind === "missing") return yield* reject("not-found");
      if (outcome.kind === "busy") {
        return yield* reject("lease-busy", { retryAfterSeconds: outcome.retryAfterSeconds });
      }
      return outcome.lease;
    },
  );

  const transition = Effect.fn("CommunityPurchaseFundingInterpreter.transition")(function* (input: {
    readonly lease: CommunityPurchaseFundingLease;
    readonly source: CommunityPurchaseFundingCaller;
    readonly expectedVersion: number;
    readonly event: CommunityPurchaseFundingEvent;
  }) {
    const event = normalizeEvent(input.event);
    if (
      event === null ||
      event.expectedVersion !== input.expectedVersion ||
      input.lease.operationId.length === 0 ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      return yield* reject("invalid-input");
    }
    const loaded = yield* store.load(input.lease.operationId);
    if (loaded === null) return yield* reject("not-found");
    if (loaded.entry.version !== input.expectedVersion) {
      const replayed = yield* store.wasTransitionCommitted({
        operationId: input.lease.operationId,
        targetVersion: input.expectedVersion + 1,
        event,
      });
      return replayed ? { entry: loaded.entry, replayed: true } : yield* reject("version-conflict");
    }
    const reduced = transitionCommunityPurchaseFunding(loaded.entry.state, event);
    if (isTransitionRejection(reduced)) {
      if (
        reduced.rejected === "funding_observation_not_fresh" &&
        isExactObservationReplay(loaded.entry.state, event)
      ) {
        return { entry: loaded.entry, replayed: true };
      }
      return yield* reject("transition-rejected", { detail: reduced.rejected });
    }
    const outcome = yield* store.commitTransition({
      lease: input.lease,
      source: input.source,
      expectedVersion: input.expectedVersion,
      event,
      nextEntry: journalEntryFromCommunityPurchaseFunding(reduced),
    });
    if (outcome.kind === "missing") return yield* reject("not-found");
    if (outcome.kind === "version_conflict") return yield* reject("version-conflict");
    if (outcome.kind === "lease_lost") return yield* reject("lease-lost");
    if (outcome.kind === "identity_conflict") return yield* reject("identity-conflict");
    return { entry: outcome.record.entry, replayed: outcome.kind === "replayed" };
  });

  return { begin, acquireLease, transition };
}

export function confirmedCommunityPurchaseReceiptId(
  operationId: CommunityPurchaseOperationId,
): string {
  return deriveCommunityPurchaseRowId(operationId, "receipt");
}
