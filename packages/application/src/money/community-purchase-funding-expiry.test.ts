import { describe, expect, test } from "bun:test";
import {
  type CommunityPurchaseFundingPlan,
  type CommunityPurchaseOperationId,
  communityPurchaseAtomicAmount,
  createCommunityPurchaseFunding,
} from "@pirate/domain";
import { Effect } from "effect";
import {
  type CommunityPurchaseFundingJournalRecord,
  type CommunityPurchaseFundingJournalStore,
  type CommunityPurchaseFundingLease,
  journalEntryFromCommunityPurchaseFunding,
  makeCommunityPurchaseFundingInterpreter,
} from "./community-purchase-funding";
import {
  type CommunityPurchaseFundingExpiryStore,
  type CommunityPurchaseFundingPlanExpiry,
  makeCommunityPurchaseFundingExpiryUseCase,
} from "./community-purchase-funding-expiry";

const TOKEN = `0x${"11".repeat(20)}` as const;
const BUYER = `0x${"22".repeat(20)}` as const;
const TREASURY = `0x${"33".repeat(20)}` as const;

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

const DEADLINE_MS = 5_000;

function makeHarness(input: {
  readonly databaseNowMs: number;
  readonly planExpiry?: CommunityPurchaseFundingPlanExpiry | null;
}) {
  const records = new Map<CommunityPurchaseOperationId, CommunityPurchaseFundingJournalRecord>();
  const transitions: Array<{ readonly type: string; readonly at: number }> = [];
  const seed = journalEntryFromCommunityPurchaseFunding(createCommunityPurchaseFunding(PLAN));
  records.set(seed.state.operationId, { entry: seed });
  let nextFence = 0;
  const store: CommunityPurchaseFundingJournalStore = {
    begin: () => {
      throw new Error("not used by expiry tests");
    },
    load: (operationId) => Effect.succeed(records.get(operationId) ?? null),
    acquireLease: (leaseInput) =>
      Effect.sync(() => {
        if (!records.has(leaseInput.operationId)) return { kind: "missing" } as const;
        const lease: CommunityPurchaseFundingLease = {
          operationId: leaseInput.operationId,
          ownerId: leaseInput.ownerId,
          fenceToken: ++nextFence,
          expiresAt: "2099-08-18T00:00:00.000Z",
        };
        return { kind: "acquired", lease } as const;
      }),
    wasTransitionCommitted: () => Effect.succeed(false),
    commitTransition: (commitInput) =>
      Effect.sync(() => {
        const current = records.get(commitInput.lease.operationId);
        if (!current) return { kind: "missing" } as const;
        transitions.push({ type: commitInput.event.type, at: commitInput.event.at });
        const record = { entry: commitInput.nextEntry };
        records.set(commitInput.lease.operationId, record);
        return { kind: "committed", record } as const;
      }),
  };
  const planExpiry: CommunityPurchaseFundingExpiryStore = {
    readPlanExpiry: () =>
      Effect.succeed(
        input.planExpiry === undefined
          ? { observationDeadlineMs: DEADLINE_MS, databaseNowMs: input.databaseNowMs }
          : input.planExpiry,
      ),
  };
  const interpreter = makeCommunityPurchaseFundingInterpreter(store);
  const expireIfDue = makeCommunityPurchaseFundingExpiryUseCase(interpreter, planExpiry);
  return { expireIfDue, records, transitions, operationId: seed.state.operationId };
}

describe("community-purchase funding silent-expiry use case", () => {
  test("expires a due planned operation through the reducer with database-clock evidence", async () => {
    const harness = makeHarness({ databaseNowMs: DEADLINE_MS });
    const result = await Effect.runPromise(
      harness.expireIfDue({
        operationId: harness.operationId,
        ownerId: "expiry_1",
        leaseMs: 30_000,
        source: "reconciler",
      }),
    );
    expect(result.kind).toBe("expired");
    if (result.kind !== "expired") throw new Error("expected expiry");
    expect(result.entry).toMatchObject({
      status: "reconciliation_required",
      version: 2,
      state: {
        state: "reconciliation_required",
        fundingEvidence: null,
        reconciliationEvidence: null,
        failureReason: "planned_observation_window_expired",
      },
      failure: {
        _tag: "legacy",
        mayRebroadcast: false,
        mayRetry: false,
        disposition: "reconciliation_required",
      },
    });
    expect(harness.transitions).toEqual([
      { type: "planned_observation_window_expired", at: DEADLINE_MS },
    ]);
  });

  test("does not expire before the database-clock deadline", async () => {
    const harness = makeHarness({ databaseNowMs: DEADLINE_MS - 1 });
    const result = await Effect.runPromise(
      harness.expireIfDue({
        operationId: harness.operationId,
        ownerId: "expiry_1",
        leaseMs: 30_000,
        source: "reconciler",
      }),
    );
    expect(result.kind).toBe("not_due");
    expect(harness.transitions).toEqual([]);
  });

  test("does nothing for an operation that already left planned", async () => {
    const harness = makeHarness({ databaseNowMs: DEADLINE_MS + 1 });
    const first = await Effect.runPromise(
      harness.expireIfDue({
        operationId: harness.operationId,
        ownerId: "expiry_1",
        leaseMs: 30_000,
        source: "reconciler",
      }),
    );
    expect(first.kind).toBe("expired");
    const second = await Effect.runPromise(
      harness.expireIfDue({
        operationId: harness.operationId,
        ownerId: "expiry_1",
        leaseMs: 30_000,
        source: "reconciler",
      }),
    );
    expect(second.kind).toBe("not_planned");
    expect(harness.transitions).toHaveLength(1);
  });

  test("rejects a missing operation and fails closed on a missing bound plan", async () => {
    const harness = makeHarness({ databaseNowMs: DEADLINE_MS + 1 });
    await expect(
      Effect.runPromise(
        harness.expireIfDue({
          operationId:
            "money:v1:community_purchase:community_1:quote_missing:purchase_missing:3" as CommunityPurchaseOperationId,
          ownerId: "expiry_1",
          leaseMs: 30_000,
          source: "reconciler",
        }),
      ),
    ).rejects.toMatchObject({ reason: "not-found" });

    const noPlan = makeHarness({ databaseNowMs: DEADLINE_MS + 1, planExpiry: null });
    await expect(
      Effect.runPromise(
        noPlan.expireIfDue({
          operationId: noPlan.operationId,
          ownerId: "expiry_1",
          leaseMs: 30_000,
          source: "reconciler",
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid-row" });
  });
});
