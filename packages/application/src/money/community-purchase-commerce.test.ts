import { describe, expect, test } from "bun:test";
import { communityPurchaseAtomicAmount } from "@pirate/domain";
import { Effect } from "effect";

import {
  type CommunityPurchaseCommerceStore,
  type CommunityPurchaseQuote,
  CommunityPurchaseQuoteRejected,
  createCommunityPurchaseQuote,
} from "./community-purchase-commerce";

const WALLET = `0x${"1".repeat(40)}` as const;
const TOKEN = `0x${"2".repeat(40)}` as const;
const TREASURY = `0x${"3".repeat(40)}` as const;

function quote(): CommunityPurchaseQuote {
  return {
    quoteId: "quote_1",
    purchaseId: "purchase_1",
    communityId: "community_1",
    listingId: "listing_1",
    policyVersion: 1,
    buyerWalletAddress: WALLET,
    expectedChainId: 8453,
    tokenContract: TOKEN,
    tokenDecimals: 6,
    treasuryAddress: TREASURY,
    amountAtomic: communityPurchaseAtomicAmount(1_000_000n),
    requiredConfirmations: 3,
    quotedAt: "2026-08-19T00:00:00.000Z",
    expiresAt: "2026-08-19T00:10:00.000Z",
    plan: {
      quoteId: "quote_1",
      purchaseId: "purchase_1",
      communityId: "community_1",
      actorId: "actor_1",
      policyVersion: 1,
      expected: {
        chainId: 8453,
        tokenContract: TOKEN,
        tokenDecimals: 6,
        sender: WALLET,
        recipient: TREASURY,
        amountAtomic: communityPurchaseAtomicAmount(1_000_000n),
        requiredConfirmations: 3,
      },
      quotedAt: "2026-08-19T00:00:00.000Z",
      expiresAt: "2026-08-19T00:10:00.000Z",
    },
  };
}

function store(outcome: "inserted" | "replayed" | "not_found" | "conflict" = "inserted"): {
  readonly store: CommunityPurchaseCommerceStore;
  readonly calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    store: {
      createQuoteAndPlan: (input) => {
        calls.push(input);
        return outcome === "inserted" || outcome === "replayed"
          ? Effect.succeed({ kind: outcome, quote: quote() })
          : Effect.succeed({ kind: outcome });
      },
    },
  };
}

describe("community-purchase commerce producer", () => {
  test("passes identity and verification only; economics stay store-derived", async () => {
    const memory = store();
    const result = await Effect.runPromise(
      createCommunityPurchaseQuote(
        {
          actorId: "actor_1",
          communityId: "community_1",
          listingId: "listing_1",
          authenticatedWalletAddress: WALLET.toUpperCase(),
          verificationSnapshotId: "verification_1",
          idempotencyKey: "request_1",
          amountAtomic: "999999999",
          treasuryAddress: "attacker",
          buyerChainId: 1,
        },
        memory.store,
      ),
    );
    expect(result.quoteId).toBe("quote_1");
    expect(memory.calls[0]).toEqual({
      actorId: "actor_1",
      communityId: "community_1",
      listingId: "listing_1",
      authenticatedWalletAddress: WALLET,
      verificationSnapshotId: "verification_1",
      idempotencyKey: "request_1",
    });
  });

  test("rejects malformed identity before storage", async () => {
    const memory = store();
    await expect(
      Effect.runPromise(
        createCommunityPurchaseQuote(
          {
            actorId: "actor_1",
            communityId: "community_1",
            listingId: "listing_1",
            authenticatedWalletAddress: "not-an-address",
            verificationSnapshotId: "verification_1",
            idempotencyKey: "request_1",
          },
          memory.store,
        ),
      ),
    ).rejects.toBeInstanceOf(CommunityPurchaseQuoteRejected);
    expect(memory.calls).toHaveLength(0);
  });

  test.each(["not_found", "conflict"] as const)(
    "maps %s without inventing a quote",
    async (kind) => {
      const memory = store(kind);
      await expect(
        Effect.runPromise(
          createCommunityPurchaseQuote(
            {
              actorId: "actor_1",
              communityId: "community_1",
              listingId: "listing_1",
              authenticatedWalletAddress: WALLET,
              verificationSnapshotId: "verification_1",
              idempotencyKey: "request_1",
            },
            memory.store,
          ),
        ),
      ).rejects.toMatchObject({ reason: kind.replace("_", "-") });
    },
  );
});
