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
  encodeCommunityPurchaseFundingEvent,
  encodeCommunityPurchaseFundingSnapshot,
  makeCommunityPurchaseFundingInterpreter,
  normalizeCommunityPurchaseEvmAddress,
} from "./community-purchase-funding";

const TOKEN = `0x${"11".repeat(20)}` as const;
const BUYER = `0x${"22".repeat(20)}` as const;
const TREASURY = `0x${"33".repeat(20)}` as const;
const TRANSACTION_HASH = `0x${"44".repeat(32)}` as const;
const BLOCK_HASH = `0x${"55".repeat(32)}` as const;
const OBSERVATION_1 = `0x${"66".repeat(32)}` as const;
const OBSERVATION_2 = `0x${"77".repeat(32)}` as const;
const HEAD_HASH_1 = `0x${"88".repeat(32)}` as const;
const HEAD_HASH_2 = `0x${"99".repeat(32)}` as const;

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
    requiredConfirmations: 3,
  },
  now: 1_000,
};

const FINAL_EVIDENCE: CommunityPurchaseFundingEvidence = {
  receiptStatus: "success",
  chainId: PLAN.expected.chainId,
  tokenContract: TOKEN,
  sender: BUYER,
  recipient: TREASURY,
  amountAtomic: PLAN.expected.amountAtomic,
  transactionHash: TRANSACTION_HASH,
  blockNumber: 123,
  blockHash: BLOCK_HASH,
  logIndex: 4,
  observationId: OBSERVATION_1,
  observedHeadBlockNumber: 125,
  observedHeadBlockHash: HEAD_HASH_1,
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function makeMemoryStore(): CommunityPurchaseFundingJournalStore {
  const records = new Map<CommunityPurchaseOperationId, CommunityPurchaseFundingJournalRecord>();
  const requests = new Map<
    string,
    { requestHash: string; operationId: CommunityPurchaseOperationId }
  >();
  const transitions = new Map<string, string>();
  const leases = new Map<CommunityPurchaseOperationId, CommunityPurchaseFundingLease>();
  let nextFence = 0;
  return {
    begin: (input) =>
      Effect.sync(() => {
        const requestKey = `${input.request.actorId}:${input.request.endpoint}:${input.request.clientNonce}`;
        const priorRequest = requests.get(requestKey);
        if (priorRequest) {
          if (
            priorRequest.requestHash !== input.request.requestHash ||
            priorRequest.operationId !== input.request.operationId
          ) {
            return { kind: "request_conflict" } as const;
          }
          const record = records.get(priorRequest.operationId);
          if (!record) return { kind: "operation_conflict" } as const;
          return { kind: "replayed", record } as const;
        }
        const prior = records.get(input.request.operationId);
        if (
          prior &&
          json(encodeCommunityPurchaseFundingSnapshot(prior.entry.state)) !==
            json(encodeCommunityPurchaseFundingSnapshot(input.entry.state))
        ) {
          return { kind: "operation_conflict" } as const;
        }
        const record = prior ?? { entry: input.entry };
        records.set(input.request.operationId, record);
        requests.set(requestKey, {
          requestHash: input.request.requestHash,
          operationId: input.request.operationId,
        });
        return { kind: prior ? "replayed" : "inserted", record } as const;
      }),
    load: (operationId) => Effect.succeed(records.get(operationId) ?? null),
    acquireLease: (input) =>
      Effect.sync(() => {
        if (!records.has(input.operationId)) return { kind: "missing" } as const;
        const lease = {
          operationId: input.operationId,
          ownerId: input.ownerId,
          fenceToken: ++nextFence,
          expiresAt: "2099-08-18T00:00:00.000Z",
        };
        leases.set(input.operationId, lease);
        return { kind: "acquired", lease } as const;
      }),
    wasTransitionCommitted: (input) =>
      Effect.succeed(
        transitions.get(`${input.operationId}:${input.targetVersion}`) ===
          json(encodeCommunityPurchaseFundingEvent(input.event)),
      ),
    commitTransition: (input) =>
      Effect.sync(() => {
        const current = records.get(input.lease.operationId);
        if (!current) return { kind: "missing" } as const;
        const transitionKey = `${input.lease.operationId}:${input.expectedVersion + 1}`;
        const eventJson = json(encodeCommunityPurchaseFundingEvent(input.event));
        const prior = transitions.get(transitionKey);
        if (prior !== undefined) {
          return prior === eventJson
            ? ({ kind: "replayed", record: current } as const)
            : ({ kind: "version_conflict" } as const);
        }
        if (current.entry.version !== input.expectedVersion) {
          return { kind: "version_conflict" } as const;
        }
        if (leases.get(input.lease.operationId)?.fenceToken !== input.lease.fenceToken) {
          return { kind: "lease_lost" } as const;
        }
        const record = { entry: input.nextEntry };
        records.set(input.lease.operationId, record);
        transitions.set(transitionKey, eventJson);
        return { kind: "committed", record } as const;
      }),
  };
}

async function beginAndLease(store = makeMemoryStore()) {
  const interpreter = makeCommunityPurchaseFundingInterpreter(store);
  const begun = await Effect.runPromise(
    interpreter.begin({
      actorId: "user_1",
      clientNonce: "nonce_1",
      canonicalRequest: { quote_id: PLAN.quoteId, purchase_id: PLAN.purchaseId },
      plan: PLAN,
    }),
  );
  const lease = await Effect.runPromise(
    interpreter.acquireLease({
      operationId: begun.entry.state.operationId,
      ownerId: "worker_1",
      leaseMs: 60_000,
    }),
  );
  return { interpreter, begun, lease };
}

describe("community-purchase funding interpreter", () => {
  test("derives the request hash and rejects changed canonical or economic identity", async () => {
    const store = makeMemoryStore();
    const interpreter = makeCommunityPurchaseFundingInterpreter(store);
    const input = {
      actorId: "user_1",
      clientNonce: "nonce_1",
      canonicalRequest: { quote_id: PLAN.quoteId, purchase_id: PLAN.purchaseId },
      plan: PLAN,
    } as const;
    expect((await Effect.runPromise(interpreter.begin(input))).replayed).toBe(false);
    expect((await Effect.runPromise(interpreter.begin(input))).replayed).toBe(true);
    await expect(
      Effect.runPromise(
        interpreter.begin({
          ...input,
          canonicalRequest: { ...input.canonicalRequest, extra: true },
        }),
      ),
    ).rejects.toMatchObject({ reason: "request-conflict" });
    await expect(
      Effect.runPromise(
        interpreter.begin({
          ...input,
          clientNonce: "nonce_2",
          canonicalRequest: { ...input.canonicalRequest, amount_atomic: "12500001" },
          plan: {
            ...PLAN,
            expected: {
              ...PLAN.expected,
              amountAtomic: communityPurchaseAtomicAmount(12_500_001n),
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "operation-conflict" });
  });

  test("normalizes chain-reader addresses at the interpreter boundary", async () => {
    expect(normalizeCommunityPurchaseEvmAddress(TOKEN.toUpperCase())).toBe(TOKEN);
    expect(normalizeCommunityPurchaseEvmAddress("0x1234")).toBeNull();
    const { interpreter, lease } = await beginAndLease();
    const result = await Effect.runPromise(
      interpreter.transition({
        lease,
        source: "request",
        expectedVersion: 1,
        event: {
          type: "funding_evidence_observed",
          expectedVersion: 1,
          at: 1_001,
          evidence: {
            ...FINAL_EVIDENCE,
            tokenContract: TOKEN.toUpperCase() as typeof TOKEN,
            sender: BUYER.toUpperCase() as typeof BUYER,
            recipient: TREASURY.toUpperCase() as typeof TREASURY,
          },
        },
      }),
    );
    expect(result.entry.state.fundingEvidence?.tokenContract).toBe(TOKEN);
  });

  test("uses one transition path for request and reconciler and replays lost responses", async () => {
    const requestFlow = await beginAndLease();
    const reconcilerFlow = await beginAndLease();
    const event = {
      type: "funding_evidence_observed",
      expectedVersion: 1,
      at: 1_001,
      evidence: FINAL_EVIDENCE,
    } as const;
    const requestResult = await Effect.runPromise(
      requestFlow.interpreter.transition({
        lease: requestFlow.lease,
        source: "request",
        expectedVersion: 1,
        event,
      }),
    );
    const reconcilerResult = await Effect.runPromise(
      reconcilerFlow.interpreter.transition({
        lease: reconcilerFlow.lease,
        source: "reconciler",
        expectedVersion: 1,
        event,
      }),
    );
    expect(requestResult.entry.state).toEqual(reconcilerResult.entry.state);
    expect(requestResult.entry.status).toBe("confirmed");
    const lostResponseReplay = await Effect.runPromise(
      requestFlow.interpreter.transition({
        lease: requestFlow.lease,
        source: "request",
        expectedVersion: 1,
        event,
      }),
    );
    expect(lostResponseReplay).toMatchObject({ replayed: true, entry: { version: 2 } });
  });

  test("persists a fresh deeper canonical observation on a final entry", async () => {
    const { interpreter, lease } = await beginAndLease();
    await Effect.runPromise(
      interpreter.transition({
        lease,
        source: "request",
        expectedVersion: 1,
        event: {
          type: "funding_evidence_observed",
          expectedVersion: 1,
          at: 1_001,
          evidence: FINAL_EVIDENCE,
        },
      }),
    );
    const refreshed = await Effect.runPromise(
      interpreter.transition({
        lease,
        source: "reconciler",
        expectedVersion: 2,
        event: {
          type: "funding_evidence_observed",
          expectedVersion: 2,
          at: 1_002,
          evidence: {
            ...FINAL_EVIDENCE,
            observationId: OBSERVATION_2,
            observedHeadBlockNumber: 126,
            observedHeadBlockHash: HEAD_HASH_2,
          },
        },
      }),
    );
    expect(refreshed).toMatchObject({
      replayed: false,
      entry: { version: 3, status: "confirmed" },
    });
    expect(refreshed.entry.state.fundingEvidence?.observationId).toBe(OBSERVATION_2);
  });
});
