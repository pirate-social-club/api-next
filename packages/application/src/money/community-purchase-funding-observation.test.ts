import { describe, expect, test } from "bun:test";
import {
  type CommunityPurchaseFundingEvidence,
  type CommunityPurchaseFundingPlan,
  type CommunityPurchaseOperationId,
  communityPurchaseAtomicAmount,
} from "@pirate/domain";
import { Effect } from "effect";
import {
  type CommunityPurchaseFundingJournalRecord,
  type CommunityPurchaseFundingJournalStore,
  type CommunityPurchaseFundingLease,
  makeCommunityPurchaseFundingInterpreter,
} from "./community-purchase-funding";
import {
  type CommunityPurchaseFundingChainReader,
  type CommunityPurchaseFundingChainReadInput,
  type CommunityPurchaseFundingObservationInput,
  makeCommunityPurchaseFundingObservationUseCase,
} from "./community-purchase-funding-observation";

const TOKEN = `0x${"11".repeat(20)}` as const;
const BUYER = `0x${"22".repeat(20)}` as const;
const TREASURY = `0x${"33".repeat(20)}` as const;
const TRANSACTION_HASH = `0x${"44".repeat(32)}` as const;
const BLOCK_HASH = `0x${"55".repeat(32)}` as const;
const OBSERVATION = `0x${"66".repeat(32)}` as const;
const OBSERVATION_2 = `0x${"88".repeat(32)}` as const;
const HEAD_HASH = `0x${"77".repeat(32)}` as const;

const PLAN: CommunityPurchaseFundingPlan = {
  communityId: "community_1",
  quoteId: "quote_1",
  purchaseId: "purchase_1",
  policyVersion: 3,
  expected: {
    chainId: 8453,
    tokenContract: TOKEN,
    tokenDecimals: 6,
    sender: BUYER,
    recipient: TREASURY,
    amountAtomic: communityPurchaseAtomicAmount(12_500_000n),
    requiredConfirmations: 1,
  },
  now: 1_000,
};

function evidence(receiptStatus: "success" | "reverted"): CommunityPurchaseFundingEvidence {
  return {
    receiptStatus,
    chainId: PLAN.expected.chainId,
    tokenContract: TOKEN,
    sender: BUYER,
    recipient: TREASURY,
    amountAtomic: PLAN.expected.amountAtomic,
    transactionHash: TRANSACTION_HASH,
    blockNumber: 123,
    blockHash: BLOCK_HASH,
    logIndex: receiptStatus === "success" ? 4 : null,
    observationId: OBSERVATION,
    observedHeadBlockNumber: 123,
    observedHeadBlockHash: HEAD_HASH,
  };
}

function makeMemoryStore() {
  let record: CommunityPurchaseFundingJournalRecord | null = null;
  let lease: CommunityPurchaseFundingLease | null = null;
  let nextFence = 0;
  const store: CommunityPurchaseFundingJournalStore = {
    begin: (input) =>
      Effect.sync(() => {
        if (record !== null) return { kind: "replayed", record } as const;
        record = { entry: input.entry };
        return { kind: "inserted", record } as const;
      }),
    load: () => Effect.succeed(record),
    acquireLease: (input) =>
      Effect.sync(() => {
        if (record === null) return { kind: "missing" } as const;
        lease = {
          operationId: input.operationId,
          ownerId: input.ownerId,
          fenceToken: ++nextFence,
          expiresAt: "2099-08-18T00:00:00.000Z",
          databaseNowMs: 1_001,
        };
        return { kind: "acquired", lease } as const;
      }),
    wasTransitionCommitted: () => Effect.succeed(false),
    commitTransition: (input) =>
      Effect.sync(() => {
        if (record === null) return { kind: "missing" } as const;
        if (record.entry.version !== input.expectedVersion)
          return { kind: "version_conflict" } as const;
        if (lease?.fenceToken !== input.lease.fenceToken) return { kind: "lease_lost" } as const;
        record = { entry: input.nextEntry };
        return { kind: "committed", record } as const;
      }),
  };
  return { store, getRecord: () => record };
}

async function begin(
  interpreter: ReturnType<typeof makeCommunityPurchaseFundingInterpreter>,
): Promise<CommunityPurchaseOperationId> {
  const result = await Effect.runPromise(
    interpreter.begin({
      actorId: "user_1",
      clientNonce: "nonce_1",
      canonicalRequest: { quote_id: PLAN.quoteId, purchase_id: PLAN.purchaseId },
      plan: PLAN,
    }),
  );
  return result.entry.state.operationId;
}

function observationInput(
  operationId: CommunityPurchaseOperationId,
  source: "request" | "reconciler" = "request",
): CommunityPurchaseFundingObservationInput {
  return {
    operationId,
    transactionHash: TRANSACTION_HASH,
    ownerId: `${source}_worker`,
    leaseMs: 60_000,
    source,
  };
}

function readerReturning(
  value: CommunityPurchaseFundingEvidence,
  onRead?: (input: CommunityPurchaseFundingChainReadInput) => void,
): CommunityPurchaseFundingChainReader {
  return {
    read: (input) =>
      Effect.sync(() => {
        onRead?.(input);
        return value;
      }),
  };
}

describe("community-purchase funding observation use case", () => {
  test("shares request/reconciler behavior and forwards only server-loaded expectation", async () => {
    const requestMemory = makeMemoryStore();
    const requestInterpreter = makeCommunityPurchaseFundingInterpreter(requestMemory.store);
    const requestOperationId = await begin(requestInterpreter);
    let requestRead: CommunityPurchaseFundingChainReadInput | undefined;
    const requestUseCase = makeCommunityPurchaseFundingObservationUseCase(
      requestInterpreter,
      readerReturning(evidence("success"), (input) => {
        requestRead = input;
      }),
    );
    const callerEvidence = evidence("reverted");
    const requestResult = await Effect.runPromise(
      requestUseCase.observe({
        ...observationInput(requestOperationId),
        // Deliberately ignored: evidence can only come from the chain reader.
        evidence: callerEvidence,
      } as unknown as CommunityPurchaseFundingObservationInput),
    );

    const reconcilerMemory = makeMemoryStore();
    const reconcilerInterpreter = makeCommunityPurchaseFundingInterpreter(reconcilerMemory.store);
    const reconcilerOperationId = await begin(reconcilerInterpreter);
    const reconcilerUseCase = makeCommunityPurchaseFundingObservationUseCase(
      reconcilerInterpreter,
      readerReturning(evidence("success")),
    );
    const reconcilerResult = await Effect.runPromise(
      reconcilerUseCase.observe(observationInput(reconcilerOperationId, "reconciler")),
    );

    expect(requestRead).toMatchObject({
      operationId: requestOperationId,
      transactionHash: TRANSACTION_HASH,
      expected: PLAN.expected,
    });
    expect(requestRead && "evidence" in requestRead).toBe(false);
    expect(requestResult.entry.state.fundingEvidence?.receiptStatus).toBe("success");
    expect(requestResult.entry.state).toEqual(reconcilerResult.entry.state);
    expect(requestResult.entry.status).toBe("confirmed");
  });

  test.each(["success", "reverted"] as const)(
    "persists the authoritative %s receipt path",
    async (status) => {
      const memory = makeMemoryStore();
      const interpreter = makeCommunityPurchaseFundingInterpreter(memory.store);
      const operationId = await begin(interpreter);
      const useCase = makeCommunityPurchaseFundingObservationUseCase(
        interpreter,
        readerReturning(evidence(status)),
      );
      const result = await Effect.runPromise(useCase.observe(observationInput(operationId)));
      expect(result.entry.state).toMatchObject({
        state: status === "success" ? "confirmed" : "reverted",
      });
      expect(result.entry.state.fundingEvidence?.receiptStatus).toBe(status);
    },
  );

  test("fails closed when a chain adapter returns evidence for another transaction", async () => {
    const memory = makeMemoryStore();
    const interpreter = makeCommunityPurchaseFundingInterpreter(memory.store);
    const operationId = await begin(interpreter);
    const useCase = makeCommunityPurchaseFundingObservationUseCase(
      interpreter,
      readerReturning({ ...evidence("success"), transactionHash: `0x${"99".repeat(32)}` }),
    );
    await expect(
      Effect.runPromise(useCase.observe(observationInput(operationId))),
    ).rejects.toMatchObject({ reason: "invalid-evidence" });
    expect(memory.getRecord()?.entry.version).toBe(1);
  });

  test("rejects malformed transaction identity before lease or chain I/O", async () => {
    const memory = makeMemoryStore();
    const interpreter = makeCommunityPurchaseFundingInterpreter(memory.store);
    const operationId = await begin(interpreter);
    let read = false;
    const useCase = makeCommunityPurchaseFundingObservationUseCase(
      interpreter,
      readerReturning(evidence("success"), () => {
        read = true;
      }),
    );
    await expect(
      Effect.runPromise(
        useCase.observe({
          ...observationInput(operationId),
          transactionHash: "0xBAD" as typeof TRANSACTION_HASH,
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid-input" });
    expect(read).toBe(false);
    expect(memory.getRecord()?.entry.version).toBe(1);
  });

  test("normalizes an exact replay and refuses a stale fenced lease", async () => {
    const memory = makeMemoryStore();
    const interpreter = makeCommunityPurchaseFundingInterpreter(memory.store);
    const operationId = await begin(interpreter);
    const useCase = makeCommunityPurchaseFundingObservationUseCase(
      interpreter,
      readerReturning(evidence("success")),
    );
    const first = await Effect.runPromise(useCase.observe(observationInput(operationId)));
    const replay = await Effect.runPromise(useCase.observe(observationInput(operationId)));
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, entry: { version: 2 } });

    const staleLease = first.lease;
    const freshLease = await Effect.runPromise(
      interpreter.acquireLease({ operationId, ownerId: "new_worker", leaseMs: 60_000 }),
    );
    expect(freshLease.fenceToken).toBeGreaterThan(staleLease.fenceToken);
    const staleResult = await Effect.runPromise(
      interpreter.transition({
        lease: staleLease,
        source: "request",
        expectedVersion: 2,
        event: {
          type: "funding_evidence_observed",
          expectedVersion: 2,
          at: 1_002,
          evidence: {
            ...evidence("success"),
            observationId: OBSERVATION_2,
            observedHeadBlockNumber: 124,
          },
        },
      }),
    ).then(
      () => null,
      (error) => error,
    );
    expect(staleResult).toMatchObject({ reason: "lease-lost" });
  });

  test("rejects a version fenced transition after another writer advances the journal", async () => {
    const memory = makeMemoryStore();
    const interpreter = makeCommunityPurchaseFundingInterpreter(memory.store);
    const operationId = await begin(interpreter);
    const lease = await Effect.runPromise(
      interpreter.acquireLease({ operationId, ownerId: "worker", leaseMs: 60_000 }),
    );
    await Effect.runPromise(
      interpreter.transition({
        lease,
        source: "request",
        expectedVersion: 1,
        event: {
          type: "funding_evidence_observed",
          expectedVersion: 1,
          at: 1_001,
          evidence: evidence("success"),
        },
      }),
    );
    await expect(
      Effect.runPromise(
        interpreter.transition({
          lease,
          source: "reconciler",
          expectedVersion: 1,
          event: {
            type: "funding_evidence_observed",
            expectedVersion: 1,
            at: 1_002,
            evidence: { ...evidence("success"), observedHeadBlockNumber: 124 },
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "version-conflict" });
  });
});
