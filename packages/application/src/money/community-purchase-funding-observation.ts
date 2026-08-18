import type {
  Bytes32,
  CommunityPurchaseFundingEvidence,
  CommunityPurchaseFundingExpectation,
  CommunityPurchaseOperationId,
} from "@pirate/domain";
import { Data, Effect } from "effect";
import {
  type CommunityPurchaseFundingCaller,
  type CommunityPurchaseFundingInterpreter,
  type CommunityPurchaseFundingInterpreterFailure,
  type CommunityPurchaseFundingJournalRecord,
  type CommunityPurchaseFundingLease,
  CommunityPurchaseFundingRejected,
} from "./community-purchase-funding";

/**
 * Errors crossing the chain adapter boundary are deliberately small. Provider
 * details and raw responses stay in platform code; the application only needs
 * to classify whether this observation can be retried or needs reconciliation.
 */
export class CommunityPurchaseFundingChainReadFailed extends Data.TaggedError(
  "CommunityPurchaseFundingChainReadFailed",
)<{
  readonly reason: "unavailable" | "timeout" | "not-found" | "invalid-evidence" | "reorg";
}> {}

export type CommunityPurchaseFundingChainReadError = CommunityPurchaseFundingChainReadFailed;

/** The only identity a chain reader may receive is loaded from the journal. */
export type CommunityPurchaseFundingChainReadInput = Readonly<{
  readonly operationId: CommunityPurchaseOperationId;
  readonly transactionHash: Bytes32;
  readonly expected: CommunityPurchaseFundingExpectation;
}>;

/**
 * Platform implementations inspect the receipt and transaction themselves.
 * They return evidence; callers never construct or submit evidence to this
 * port.
 */
export interface CommunityPurchaseFundingChainReader {
  readonly read: (
    input: CommunityPurchaseFundingChainReadInput,
  ) => Effect.Effect<CommunityPurchaseFundingEvidence, CommunityPurchaseFundingChainReadError>;
}

export type CommunityPurchaseFundingObservationInput = Readonly<{
  readonly operationId: CommunityPurchaseOperationId;
  readonly transactionHash: Bytes32;
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly source: CommunityPurchaseFundingCaller;
}>;

export type CommunityPurchaseFundingObservationResult = Readonly<{
  readonly lease: CommunityPurchaseFundingLease;
  readonly entry: CommunityPurchaseFundingJournalRecord["entry"];
  readonly replayed: boolean;
}>;

export type CommunityPurchaseFundingObservationFailure =
  | CommunityPurchaseFundingInterpreterFailure
  | CommunityPurchaseFundingChainReadError;

export interface CommunityPurchaseFundingObservationUseCase {
  readonly observe: (
    input: CommunityPurchaseFundingObservationInput,
  ) => Effect.Effect<
    CommunityPurchaseFundingObservationResult,
    CommunityPurchaseFundingObservationFailure
  >;
}

function isBytes32(value: string): value is Bytes32 {
  return /^0x[0-9a-f]{64}$/u.test(value);
}

/**
 * One bounded observation path for both the request handler and reconciler.
 * The sequence is intentionally fixed: lease/fence, load server identity,
 * read chain evidence, then let the interpreter perform the transition.
 */
export function makeCommunityPurchaseFundingObservationUseCase(
  interpreter: CommunityPurchaseFundingInterpreter,
  chainReader: CommunityPurchaseFundingChainReader,
): CommunityPurchaseFundingObservationUseCase {
  const observe = Effect.fn("CommunityPurchaseFundingObservation.observe")(function* (
    input: CommunityPurchaseFundingObservationInput,
  ) {
    if (
      !isBytes32(input.transactionHash) ||
      (input.source !== "request" && input.source !== "reconciler")
    ) {
      return yield* new CommunityPurchaseFundingRejected({ reason: "invalid-input" });
    }
    const lease = yield* interpreter.acquireLease({
      operationId: input.operationId,
      ownerId: input.ownerId,
      leaseMs: input.leaseMs,
    });
    const loaded = yield* interpreter.load(input.operationId);
    if (loaded === null)
      return yield* new CommunityPurchaseFundingRejected({ reason: "not-found" });
    const evidence = yield* chainReader.read({
      operationId: input.operationId,
      transactionHash: input.transactionHash,
      expected: loaded.entry.state.expected,
    });
    // A reader is authoritative for evidence fields, but it must still be
    // bound to the transaction requested by this operation. Fail closed if a
    // buggy or misconfigured adapter returns another transaction.
    if (evidence.transactionHash !== input.transactionHash) {
      return yield* new CommunityPurchaseFundingChainReadFailed({
        reason: "invalid-evidence",
      });
    }
    const transitioned = yield* interpreter.transition({
      lease,
      source: input.source,
      expectedVersion: loaded.entry.version,
      event:
        loaded.entry.state.state === "reconciliation_required"
          ? {
              type: "reconciliation_resolved",
              expectedVersion: loaded.entry.version,
              at: lease.databaseNowMs,
              evidence,
            }
          : {
              type: "funding_evidence_observed",
              expectedVersion: loaded.entry.version,
              at: lease.databaseNowMs,
              evidence,
            },
    });
    return { lease, entry: transitioned.entry, replayed: transitioned.replayed };
  });

  return { observe };
}

/** Short alias for callers wiring the shared request/reconciler use case. */
export const makeObserveCommunityPurchaseFunding = makeCommunityPurchaseFundingObservationUseCase;
