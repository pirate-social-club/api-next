import { describe, expect, test } from "bun:test";
import type { CommunityPurchaseFundingProducerStore } from "@pirate/application/money/community-purchase-funding-producer";
import { CommunityPurchaseFundingProducerStorageFailed } from "@pirate/application/money/community-purchase-funding-producer";
import { communityPurchaseAtomicAmount } from "@pirate/domain";
import { Effect } from "effect";
import {
  makeCommunityPurchaseFundingHandlers,
  makeCommunityPurchaseFundingQuoteHandlers,
} from "./community-purchase-funding-handlers.ts";
import type { DecodedRequest } from "./transport.ts";

const operationRef = "funding-operation-a";
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
