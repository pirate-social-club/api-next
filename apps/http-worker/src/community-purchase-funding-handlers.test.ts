import { describe, expect, test } from "bun:test";
import {
  type CommunityPurchaseFundingJournalRecord,
  type CommunityPurchaseFundingLease,
  CommunityPurchaseFundingRejected,
  CommunityPurchaseFundingStorageFailed,
} from "@pirate/application/money/community-purchase-funding";
import {
  CommunityPurchaseFundingChainReadFailed,
  type CommunityPurchaseFundingObservationUseCase,
} from "@pirate/application/money/community-purchase-funding-observation";
import type { CommunityPurchaseFundingProducerStore } from "@pirate/application/money/community-purchase-funding-producer";
import { CommunityPurchaseFundingProducerStorageFailed } from "@pirate/application/money/community-purchase-funding-producer";
import type { CommunityPurchaseFundingQueryStore } from "@pirate/application/money/community-purchase-funding-query";
import { communityPurchaseAtomicAmount, createCommunityPurchaseFunding } from "@pirate/domain";
import { Effect } from "effect";
import {
  makeCommunityPurchaseFundingHandlers,
  makeCommunityPurchaseFundingQuoteHandlers,
} from "./community-purchase-funding-handlers.ts";
import type { DecodedRequest } from "./transport.ts";

const operationRef = "money:v1:community_purchase:community-a:quote-a:purchase-a:7";
const transactionHash = `0x${"1".repeat(64)}`;
const sessionWallet = `0x${"a".repeat(40)}`;
const sessionWalletAuthenticatedCase = `0x${"A".repeat(40)}`;
const quote = {
  quoteId: "quote-a",
  purchaseId: "purchase-a",
  communityId: "community-a",
  actorId: "actor-a",
  listingId: "listing-a",
  policyVersion: 7,
  expected: {
    chainId: 8453,
    tokenContract: `0x${"b".repeat(40)}` as `0x${string}`,
    tokenDecimals: 6 as const,
    sender: sessionWallet as `0x${string}`,
    recipient: `0x${"c".repeat(40)}` as `0x${string}`,
    amountAtomic: communityPurchaseAtomicAmount(1_000_000n),
    requiredConfirmations: 3,
  },
  quotedAt: "2026-08-19T00:00:00.000Z",
  expiresAt: "2026-08-19T00:10:00.000Z",
};

const request = (overrides: Partial<DecodedRequest> = {}): DecodedRequest => ({
  body: { transaction_hash: transactionHash },
  params: { operationRef },
  query: {},
  principal: {
    kind: "user",
    subject: "actor-a",
    walletAddress: sessionWallet,
  },
  ...overrides,
});

const ownedSnapshot = createCommunityPurchaseFunding({
  communityId: quote.communityId,
  quoteId: quote.quoteId,
  purchaseId: quote.purchaseId,
  policyVersion: quote.policyVersion,
  expected: quote.expected,
  now: 0,
});
const ownedRecord = {
  entry: {
    idempotencyKey: ownedSnapshot.operationId,
    version: ownedSnapshot.version,
    state: ownedSnapshot,
    status: "planned",
  },
} satisfies CommunityPurchaseFundingJournalRecord;
const ownedLease = {
  operationId: ownedSnapshot.operationId,
  ownerId: "test-owner",
  fenceToken: 1,
  expiresAt: "2026-08-19T00:01:00.000Z",
  databaseNowMs: 0,
} satisfies CommunityPurchaseFundingLease;

function observationResult(replayed: boolean) {
  return { lease: ownedLease, entry: ownedRecord.entry, replayed };
}

function ownedQuery(
  loadForActor: CommunityPurchaseFundingQueryStore["loadForActor"] = () =>
    Effect.succeed(ownedRecord),
): CommunityPurchaseFundingQueryStore {
  return {
    loadForActor,
    listReconcilable: () => Effect.succeed([]),
    listDormancyCandidates: () => Effect.succeed([]),
  };
}

function observationHandlers(observe: CommunityPurchaseFundingObservationUseCase["observe"]) {
  return makeCommunityPurchaseFundingHandlers({
    admission: {
      beginFromPlan: () => Effect.succeed({ kind: "plan_not_found" as const }),
    },
    observation: { observe },
    query: ownedQuery(),
  });
}

describe("community purchase funding handlers", () => {
  test("constructs quote intent from the session and ignores browser economics", async () => {
    let received:
      | Parameters<CommunityPurchaseFundingProducerStore["createQuoteAndPlan"]>[0]
      | undefined;
    const handlers = makeCommunityPurchaseFundingQuoteHandlers({
      producer: {
        createQuoteAndPlan: (input) => {
          received = input;
          return Effect.succeed({ kind: "created" as const, quote });
        },
      },
    });

    const result = await handlers.CreateCommunityPurchaseFundingQuote({
      body: {
        community_id: "community-a",
        listing_id: "listing-a",
        wallet_address: `0x${"d".repeat(40)}`,
        amount_atomic: "999999999",
        recipient: `0x${"d".repeat(40)}`,
      },
      params: {},
      query: {},
      principal: {
        kind: "user",
        subject: "actor-a",
        walletAddress: sessionWalletAuthenticatedCase,
      },
    });

    expect(received).toEqual({
      actorId: "actor-a",
      buyerWalletAddress: sessionWallet as `0x${string}`,
      communityId: "community-a",
      listingId: "listing-a",
      quoteTtlSeconds: 600,
    });
    expect(result).toMatchObject({
      status: 201,
      body: {
        quote_id: "quote-a",
        community_id: "community-a",
        listing_id: "listing-a",
        replayed: false,
        funding: { sender: sessionWallet, amount_atomic: "1000000" },
      },
    });
  });

  test("returns 200 for an exact durable quote replay", async () => {
    const handlers = makeCommunityPurchaseFundingQuoteHandlers({
      producer: {
        createQuoteAndPlan: () => Effect.succeed({ kind: "replayed" as const, quote }),
      },
    });

    const result = await handlers.CreateCommunityPurchaseFundingQuote({
      body: { community_id: "community-a", listing_id: "listing-a" },
      params: {},
      query: {},
      principal: { kind: "user", subject: "actor-a", walletAddress: sessionWallet },
    });

    expect(result).toMatchObject({ status: 200, body: { replayed: true } });
  });

  test("maps producer misses, conflicts, and ambiguous storage safely", async () => {
    for (const outcome of ["not-found", "conflict"] as const) {
      const handlers = makeCommunityPurchaseFundingQuoteHandlers({
        producer: { createQuoteAndPlan: () => Effect.succeed({ kind: outcome }) },
      });
      await expect(
        handlers.CreateCommunityPurchaseFundingQuote({
          body: { community_id: "community-a", listing_id: "listing-a" },
          params: {},
          query: {},
          principal: { kind: "user", subject: "actor-a", walletAddress: sessionWallet },
        }),
      ).rejects.toMatchObject({ _tag: outcome === "not-found" ? "NotFound" : "Conflict" });
    }

    const unavailable = makeCommunityPurchaseFundingQuoteHandlers({
      producer: {
        createQuoteAndPlan: () =>
          Effect.fail(
            new CommunityPurchaseFundingProducerStorageFailed({ reason: "outcome-unknown" }),
          ),
      },
    });
    await expect(
      unavailable.CreateCommunityPurchaseFundingQuote({
        body: { community_id: "community-a", listing_id: "listing-a" },
        params: {},
        query: {},
        principal: { kind: "user", subject: "actor-a", walletAddress: sessionWallet },
      }),
    ).rejects.toMatchObject({ _tag: "ProviderUnavailable" });
  });

  test("does not call the chain observer when actor-scoped lookup misses", async () => {
    let observationCalls = 0;
    const handlers = makeCommunityPurchaseFundingHandlers({
      admission: {
        beginFromPlan: () => Effect.succeed({ kind: "plan_not_found" as const }),
      },
      observation: {
        observe: () => {
          observationCalls += 1;
          return Effect.die("observer must not run");
        },
      },
      query: {
        loadForActor: () => Effect.succeed(null),
        listReconcilable: () => Effect.succeed([]),
        listDormancyCandidates: () => Effect.succeed([]),
      },
    });

    await expect(handlers.ObserveCommunityPurchaseFunding(request())).rejects.toMatchObject({
      _tag: "NotFound",
      message: "Funding operation not found",
    });
    expect(observationCalls).toBe(0);
  });

  test("looks up exact actor ownership before constructing observation input", async () => {
    const events: string[] = [];
    let lookupInput: unknown;
    let observationInput: unknown;
    const handlers = makeCommunityPurchaseFundingHandlers({
      admission: {
        beginFromPlan: () => Effect.succeed({ kind: "plan_not_found" as const }),
      },
      observation: {
        observe: (input) => {
          events.push("observe-invoked");
          observationInput = input;
          return Effect.succeed(observationResult(false));
        },
      },
      query: ownedQuery((input) => {
        lookupInput = input;
        events.push("lookup-started");
        return Effect.sync(() => {
          events.push("lookup-settled");
          return ownedRecord;
        });
      }),
    });

    const result = await handlers.ObserveCommunityPurchaseFunding(request());

    expect(lookupInput).toEqual({ operationId: operationRef, actorId: "actor-a" });
    expect(observationInput).toEqual({
      operationId: operationRef,
      transactionHash,
      ownerId: `http:actor-a:${operationRef}:${transactionHash}`,
      leaseMs: 30_000,
      source: "request",
    });
    expect(events).toEqual(["lookup-started", "lookup-settled", "observe-invoked"]);
    expect(result).toEqual({
      operation_ref: operationRef,
      status: "planned",
      version: 1,
      replayed: false,
    });
  });

  test("does not invoke observation while ownership lookup is pending", async () => {
    let resolveLookup: (record: CommunityPurchaseFundingJournalRecord) => void = () => {};
    const lookup = new Promise<CommunityPurchaseFundingJournalRecord>((resolve) => {
      resolveLookup = resolve;
    });
    let lookupStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    let observationCalls = 0;
    const handlers = makeCommunityPurchaseFundingHandlers({
      admission: {
        beginFromPlan: () => Effect.succeed({ kind: "plan_not_found" as const }),
      },
      observation: {
        observe: () => {
          observationCalls += 1;
          return Effect.succeed(observationResult(false));
        },
      },
      query: ownedQuery(() =>
        Effect.promise(() => {
          lookupStarted();
          return lookup;
        }),
      ),
    });

    const pending = handlers.ObserveCommunityPurchaseFunding(request());
    await started;
    expect(observationCalls).toBe(0);

    resolveLookup(ownedRecord);
    await expect(pending).resolves.toEqual({
      operation_ref: operationRef,
      status: "planned",
      version: 1,
      replayed: false,
    });
    expect(observationCalls).toBe(1);
  });

  test("rejects invalid operation and actor inputs before ownership lookup", async () => {
    for (const overrides of [
      { params: { operationRef: ` ${operationRef} ` } },
      {
        principal: {
          kind: "user" as const,
          subject: " actor-a",
          walletAddress: sessionWallet,
        },
      },
    ]) {
      let lookupCalls = 0;
      let observationCalls = 0;
      const handlers = makeCommunityPurchaseFundingHandlers({
        admission: {
          beginFromPlan: () => Effect.succeed({ kind: "plan_not_found" as const }),
        },
        observation: {
          observe: () => {
            observationCalls += 1;
            return Effect.succeed(observationResult(false));
          },
        },
        query: ownedQuery(() => {
          lookupCalls += 1;
          return Effect.succeed(ownedRecord);
        }),
      });

      await expect(
        handlers.ObserveCommunityPurchaseFunding(request(overrides)),
      ).rejects.toMatchObject({
        _tag: "BadRequest",
        message: "Invalid funding operation",
      });
      expect(lookupCalls).toBe(0);
      expect(observationCalls).toBe(0);
    }
  });

  test("preserves a replayed observation wire result", async () => {
    const handlers = makeCommunityPurchaseFundingHandlers({
      admission: {
        beginFromPlan: () => Effect.succeed({ kind: "plan_not_found" as const }),
      },
      observation: {
        observe: () => Effect.succeed(observationResult(true)),
      },
      query: ownedQuery(),
    });

    await expect(handlers.ObserveCommunityPurchaseFunding(request())).resolves.toEqual({
      operation_ref: operationRef,
      status: "planned",
      version: 1,
      replayed: true,
    });
  });

  test("rejects unauthenticated observation before ownership lookup", async () => {
    let lookupCalls = 0;
    const handlers = makeCommunityPurchaseFundingHandlers({
      admission: {
        beginFromPlan: () => Effect.succeed({ kind: "plan_not_found" as const }),
      },
      observation: { observe: () => Effect.die("observer must not run") },
      query: ownedQuery(() => {
        lookupCalls += 1;
        return Effect.succeed(ownedRecord);
      }),
    });

    await expect(
      handlers.ObserveCommunityPurchaseFunding(request({ principal: null })),
    ).rejects.toMatchObject({ _tag: "AuthError" });
    expect(lookupCalls).toBe(0);
  });

  test("maps invalid observation input to a bad request after ownership succeeds", async () => {
    const handlers = makeCommunityPurchaseFundingHandlers({
      admission: {
        beginFromPlan: () => Effect.succeed({ kind: "plan_not_found" as const }),
      },
      observation: {
        observe: () =>
          Effect.fail(new CommunityPurchaseFundingRejected({ reason: "invalid-input" })),
      },
      query: ownedQuery(),
    });

    await expect(handlers.ObserveCommunityPurchaseFunding(request())).rejects.toMatchObject({
      _tag: "BadRequest",
      message: "Invalid funding observation",
    });
  });

  test("prevents observation when actor ownership storage fails", async () => {
    let observationCalls = 0;
    const handlers = makeCommunityPurchaseFundingHandlers({
      admission: {
        beginFromPlan: () => Effect.succeed({ kind: "plan_not_found" as const }),
      },
      observation: {
        observe: () => {
          observationCalls += 1;
          return Effect.die("observer must not run");
        },
      },
      query: ownedQuery(() =>
        Effect.fail(new CommunityPurchaseFundingStorageFailed({ reason: "unavailable" })),
      ),
    });

    await expect(handlers.ObserveCommunityPurchaseFunding(request())).rejects.toMatchObject({
      _tag: "InternalError",
      message: "Funding operation failed",
    });
    expect(observationCalls).toBe(0);
  });

  test("maps observation provider errors and preserves observer defects", async () => {
    const unavailable = makeCommunityPurchaseFundingHandlers({
      admission: {
        beginFromPlan: () => Effect.succeed({ kind: "plan_not_found" as const }),
      },
      observation: {
        observe: () =>
          Effect.fail(new CommunityPurchaseFundingChainReadFailed({ reason: "unavailable" })),
      },
      query: ownedQuery(),
    });
    await expect(unavailable.ObserveCommunityPurchaseFunding(request())).rejects.toMatchObject({
      _tag: "ProviderUnavailable",
      message: "Funding chain observation is unavailable",
    });

    const defect = new Error("observer defect");
    const defective = makeCommunityPurchaseFundingHandlers({
      admission: {
        beginFromPlan: () => Effect.succeed({ kind: "plan_not_found" as const }),
      },
      observation: { observe: () => Effect.die(defect) },
      query: ownedQuery(),
    });
    await expect(defective.ObserveCommunityPurchaseFunding(request())).rejects.toBe(defect);
  });

  test("preserves observation state failure mappings", async () => {
    const cases = [
      ["lease-busy", "RetryableConflict", "Funding observation is already in progress"],
      ["lease-lost", "RetryableConflict", "Funding observation is already in progress"],
      ["version-conflict", "RetryableConflict", "Funding operation advanced concurrently"],
      ["not-found", "NotFound", "Funding operation not found"],
      ["request-conflict", "Conflict", "Funding observation conflicts with durable state"],
      ["operation-conflict", "Conflict", "Funding observation conflicts with durable state"],
      ["identity-conflict", "Conflict", "Funding observation conflicts with durable state"],
      ["transition-rejected", "Conflict", "Funding observation conflicts with durable state"],
    ] as const;

    for (const [reason, tag, message] of cases) {
      const handlers = observationHandlers(() =>
        Effect.fail(new CommunityPurchaseFundingRejected({ reason })),
      );
      await expect(handlers.ObserveCommunityPurchaseFunding(request())).rejects.toMatchObject({
        _tag: tag,
        message,
      });
    }
  });

  test("preserves storage and chain failure mappings", async () => {
    for (const reason of ["unavailable", "invalid-row", "constraint", "outcome-unknown"] as const) {
      const handlers = observationHandlers(() =>
        Effect.fail(new CommunityPurchaseFundingStorageFailed({ reason })),
      );
      await expect(handlers.ObserveCommunityPurchaseFunding(request())).rejects.toMatchObject({
        _tag: "InternalError",
        message: "Funding operation failed",
      });
    }

    const chainCases = [
      ["not-found", "NotFound", "Funding transaction not found"],
      ["unavailable", "ProviderUnavailable", "Funding chain observation is unavailable"],
      ["timeout", "ProviderUnavailable", "Funding chain observation is unavailable"],
      ["invalid-evidence", "ProviderUnavailable", "Funding chain observation is unavailable"],
      ["reorg", "ProviderUnavailable", "Funding chain observation is unavailable"],
    ] as const;
    for (const [reason, tag, message] of chainCases) {
      const handlers = observationHandlers(() =>
        Effect.fail(new CommunityPurchaseFundingChainReadFailed({ reason })),
      );
      await expect(handlers.ObserveCommunityPurchaseFunding(request())).rejects.toMatchObject({
        _tag: tag,
        message,
      });
    }
  });

  test("collapses missing, wrong-actor, and wrong-wallet plans to one public response", async () => {
    for (const kind of ["plan_not_found", "actor_mismatch", "wallet_mismatch"] as const) {
      const handlers = makeCommunityPurchaseFundingHandlers({
        admission: { beginFromPlan: () => Effect.succeed({ kind }) },
        observation: { observe: () => Effect.die("unused") },
        query: {
          loadForActor: () => Effect.succeed(null),
          listReconcilable: () => Effect.succeed([]),
          listDormancyCandidates: () => Effect.succeed([]),
        },
      });

      await expect(
        handlers.BeginCommunityPurchaseFunding(
          request({ body: { quote_id: "quote-a", client_nonce: "nonce-a" } }),
        ),
      ).rejects.toMatchObject({ _tag: "NotFound", message: "Funding plan not found" });
    }
  });
});
