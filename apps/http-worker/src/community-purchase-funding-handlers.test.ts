import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeCommunityPurchaseFundingHandlers } from "./community-purchase-funding-handlers.ts";
import type { DecodedRequest } from "./transport.ts";

const operationRef = "funding-operation-a";
const transactionHash = `0x${"1".repeat(64)}`;

const request = (overrides: Partial<DecodedRequest> = {}): DecodedRequest => ({
  body: { transaction_hash: transactionHash },
  params: { operationRef },
  query: {},
  principal: {
    kind: "user",
    subject: "actor-a",
    walletAddress: `0x${"a".repeat(40)}`,
  },
  ...overrides,
});

describe("community purchase funding handlers", () => {
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
