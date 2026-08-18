import { describe, expect, test } from "bun:test";
import {
  type CommunityPurchaseFundingPlan,
  communityPurchaseAtomicAmount,
  createCommunityPurchaseFunding,
} from "@pirate/domain";
import { Effect } from "effect";
import {
  type CommunityPurchaseFundingJournalRecord,
  journalEntryFromCommunityPurchaseFunding,
} from "./community-purchase-funding";
import {
  admitCommunityPurchaseFunding,
  CommunityPurchaseFundingAdmissionRejected,
  type CommunityPurchaseFundingAdmissionStoreInput,
  CommunityPurchaseFundingStorageFailed,
  makeCommunityPurchaseFundingAdmissionUseCase,
} from "./community-purchase-funding-admission";

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

function source(
  kind:
    | "inserted"
    | "replayed"
    | "request_conflict"
    | "operation_conflict"
    | "plan_not_found"
    | "plan_expired"
    | "plan_cancelled"
    | "actor_mismatch"
    | "wallet_mismatch" = "inserted",
) {
  const calls: CommunityPurchaseFundingAdmissionStoreInput[] = [];
  const record: CommunityPurchaseFundingJournalRecord = {
    entry: journalEntryFromCommunityPurchaseFunding(createCommunityPurchaseFunding(PLAN)),
  };
  return {
    calls,
    planSource: {
      beginFromPlan: (input: CommunityPurchaseFundingAdmissionStoreInput) => {
        calls.push(input);
        return Effect.succeed(
          kind === "inserted" || kind === "replayed" ? { kind, record } : { kind },
        );
      },
    },
  };
}

describe("community-purchase funding admission", () => {
  test("accepts identity only, normalizes wallet, and derives fixed canonical request/hash", async () => {
    const memory = source();
    const result = await Effect.runPromise(
      admitCommunityPurchaseFunding(
        {
          actorId: "actor_1",
          authenticatedWalletAddress: BUYER.toUpperCase(),
          quoteId: "quote_1",
          clientNonce: "nonce_1",
          amountAtomic: "999999999",
          expected: { recipient: "attacker" },
          canonicalRequest: { amount_atomic: "999999999" },
        },
        memory.planSource,
      ),
    );
    expect(result.replayed).toBe(false);
    expect(memory.calls[0]).toMatchObject({
      actorId: "actor_1",
      authenticatedWalletAddress: BUYER,
      quoteId: "quote_1",
      clientNonce: "nonce_1",
      canonicalRequest: {
        request_version: "community-purchase-funding-admission-v1",
        quote_id: "quote_1",
        wallet_address: BUYER,
      },
    });
    expect(memory.calls[0]?.requestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(memory.calls[0]).not.toHaveProperty("plan");
    expect(memory.calls[0]).not.toHaveProperty("operationId");
  });

  test("rejects malformed identity before storage access", async () => {
    const memory = source();
    await expect(
      Effect.runPromise(
        admitCommunityPurchaseFunding(
          {
            actorId: " actor_1",
            authenticatedWalletAddress: BUYER,
            quoteId: "quote_1",
            clientNonce: "n",
          },
          memory.planSource,
        ),
      ),
    ).rejects.toBeInstanceOf(CommunityPurchaseFundingAdmissionRejected);
    expect(memory.calls).toHaveLength(0);
  });

  test.each([
    ["plan_not_found", "plan-not-found"],
    ["plan_expired", "plan-expired"],
    ["plan_cancelled", "plan-cancelled"],
    ["actor_mismatch", "actor-mismatch"],
    ["wallet_mismatch", "wallet-mismatch"],
  ] as const)("maps plan outcome %s", async (kind, reason) => {
    const memory = source(kind);
    await expect(
      Effect.runPromise(
        admitCommunityPurchaseFunding(
          {
            actorId: "actor_1",
            authenticatedWalletAddress: BUYER,
            quoteId: "quote_1",
            clientNonce: "n",
          },
          memory.planSource,
        ),
      ),
    ).rejects.toMatchObject({ reason });
  });

  test("returns replay and maps conflicts and storage", async () => {
    const replay = source("replayed");
    expect(
      (
        await Effect.runPromise(
          makeCommunityPurchaseFundingAdmissionUseCase(replay.planSource)({
            actorId: "actor_1",
            authenticatedWalletAddress: BUYER,
            quoteId: "quote_1",
            clientNonce: "n",
          }),
        )
      ).replayed,
    ).toBe(true);
    for (const kind of ["request_conflict", "operation_conflict"] as const) {
      const conflict = source(kind);
      await expect(
        Effect.runPromise(
          admitCommunityPurchaseFunding(
            {
              actorId: "actor_1",
              authenticatedWalletAddress: BUYER,
              quoteId: "quote_1",
              clientNonce: "n",
            },
            conflict.planSource,
          ),
        ),
      ).rejects.toBeInstanceOf(CommunityPurchaseFundingAdmissionRejected);
    }
    const failing = {
      beginFromPlan: () =>
        Effect.fail(new CommunityPurchaseFundingStorageFailed({ reason: "unavailable" })),
    };
    await expect(
      Effect.runPromise(
        admitCommunityPurchaseFunding(
          {
            actorId: "actor_1",
            authenticatedWalletAddress: BUYER,
            quoteId: "quote_1",
            clientNonce: "n",
          },
          failing,
        ),
      ),
    ).rejects.toBeInstanceOf(CommunityPurchaseFundingStorageFailed);
  });
});
