import { describe, expect, test } from "bun:test";
import { communityPurchaseAtomicAmount } from "@pirate/domain";
import { Effect } from "effect";

import {
  type CommunityPurchaseFundingPlanDraft,
  createCommunityPurchaseFundingPlan,
} from "./community-purchase-funding-plan";

const draft: CommunityPurchaseFundingPlanDraft = {
  quoteId: "quote-1",
  communityId: "community-1",
  actorId: "actor-1",
  buyerWalletAddress: `0x${"1".repeat(40)}`,
  buyerChainId: 8453,
  purchaseId: "purchase-1",
  policyVersion: 1,
  tokenContract: `0x${"2".repeat(40)}`,
  tokenDecimals: 6,
  treasuryAddress: `0x${"3".repeat(40)}`,
  amountAtomic: communityPurchaseAtomicAmount(1_000_000n),
  requiredConfirmations: 3,
  quoteTtlSeconds: 300,
};

describe("community purchase funding plan creation", () => {
  test("persists only already-derived terms and preserves replay", async () => {
    let received: CommunityPurchaseFundingPlanDraft | undefined;
    const result = await Effect.runPromise(
      createCommunityPurchaseFundingPlan(draft, {
        createPlan: (input) => {
          received = input;
          return Effect.succeed({
            kind: "replayed" as const,
            plan: {
              quoteId: input.quoteId,
              communityId: input.communityId,
              actorId: input.actorId,
              purchaseId: input.purchaseId,
              policyVersion: input.policyVersion,
              expected: {
                chainId: input.buyerChainId,
                tokenContract: input.tokenContract,
                tokenDecimals: input.tokenDecimals,
                sender: input.buyerWalletAddress,
                recipient: input.treasuryAddress,
                amountAtomic: input.amountAtomic,
                requiredConfirmations: input.requiredConfirmations,
              },
              quotedAt: "2026-08-19T00:00:00.000Z",
              expiresAt: "2026-08-19T00:05:00.000Z",
            },
          });
        },
      }),
    );
    expect(received).toEqual(draft);
    expect(result.kind).toBe("replayed");
  });

  test("rejects invalid policy inputs before storage and maps conflicts", async () => {
    let calls = 0;
    const store = {
      createPlan: () => {
        calls += 1;
        return Effect.succeed({ kind: "conflict" as const });
      },
    };
    await expect(
      Effect.runPromise(
        createCommunityPurchaseFundingPlan({ ...draft, quoteTtlSeconds: 0 }, store),
      ),
    ).rejects.toMatchObject({ reason: "invalid-input" });
    expect(calls).toBe(0);
    await expect(
      Effect.runPromise(createCommunityPurchaseFundingPlan(draft, store)),
    ).rejects.toMatchObject({ reason: "conflict" });
  });
});
