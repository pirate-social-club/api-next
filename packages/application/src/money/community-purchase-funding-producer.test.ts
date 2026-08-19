import { describe, expect, test } from "bun:test";
import { communityPurchaseAtomicAmount } from "@pirate/domain";
import { Effect } from "effect";
import {
  CommunityPurchaseFundingProducerRejected,
  type CommunityPurchaseFundingProducerStore,
  produceCommunityPurchaseFundingQuote,
} from "./community-purchase-funding-producer";

const expectation = {
  chainId: 8453,
  tokenContract: `0x${"2".repeat(40)}` as `0x${string}`,
  tokenDecimals: 6 as const,
  sender: `0x${"1".repeat(40)}` as `0x${string}`,
  recipient: `0x${"3".repeat(40)}` as `0x${string}`,
  amountAtomic: communityPurchaseAtomicAmount(1_000_000n),
  requiredConfirmations: 3,
};

const quote = {
  quoteId: "quote-1",
  purchaseId: "purchase-1",
  communityId: "community-1",
  actorId: "actor-1",
  listingId: "listing-1",
  policyVersion: 7,
  expected: expectation,
  quotedAt: "2026-08-19T00:00:00.000Z",
  expiresAt: "2026-08-19T00:10:00.000Z",
};

describe("community purchase funding quote producer", () => {
  test("passes identity-only intent and fixed 600-second TTL to the atomic store", async () => {
    let received:
      | Parameters<CommunityPurchaseFundingProducerStore["createQuoteAndPlan"]>[0]
      | null = null;
    const result = await Effect.runPromise(
      produceCommunityPurchaseFundingQuote(
        {
          actorId: "actor-1",
          authenticatedWalletAddress: `0x${"A".repeat(40)}`,
          communityId: "community-1",
          listingId: "listing-1",
        },
        {
          createQuoteAndPlan: (input) => {
            received = input;
            return Effect.succeed({ kind: "created" as const, quote });
          },
        },
      ),
    );
    expect(received).toMatchObject({
      actorId: "actor-1",
      buyerWalletAddress: `0x${"a".repeat(40)}`,
      communityId: "community-1",
      listingId: "listing-1",
      quoteTtlSeconds: 600,
    });
    expect(result).toMatchObject({ quoteId: "quote-1", replayed: false });
  });

  test("maps replay without changing the server-owned quote", async () => {
    const result = await Effect.runPromise(
      produceCommunityPurchaseFundingQuote(
        {
          actorId: "actor-1",
          authenticatedWalletAddress: `0x${"1".repeat(40)}`,
          communityId: "community-1",
          listingId: "listing-1",
        },
        { createQuoteAndPlan: () => Effect.succeed({ kind: "replayed" as const, quote }) },
      ),
    );
    expect(result.replayed).toBe(true);
    expect(result.expiresAt).toBe(quote.expiresAt);
  });

  test("rejects malformed intent before storage and maps enumeration-safe misses", async () => {
    let calls = 0;
    const countingStore: CommunityPurchaseFundingProducerStore = {
      createQuoteAndPlan: () => {
        calls += 1;
        return Effect.succeed({ kind: "not-found" as const });
      },
    };
    await expect(
      Effect.runPromise(
        produceCommunityPurchaseFundingQuote(
          {
            actorId: " actor-1",
            authenticatedWalletAddress: `0x${"1".repeat(40)}`,
            communityId: "community-1",
            listingId: "listing-1",
          },
          countingStore,
        ),
      ),
    ).rejects.toBeInstanceOf(CommunityPurchaseFundingProducerRejected);
    expect(calls).toBe(0);
    await expect(
      Effect.runPromise(
        produceCommunityPurchaseFundingQuote(
          {
            actorId: "actor-1",
            authenticatedWalletAddress: `0x${"1".repeat(40)}`,
            communityId: "community-1",
            listingId: "listing-1",
          },
          countingStore,
        ),
      ),
    ).rejects.toMatchObject({ reason: "not-found" });
    expect(calls).toBe(1);
  });
});
