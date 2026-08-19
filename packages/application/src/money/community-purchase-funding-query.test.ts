import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  CommunityPurchaseFundingQueryRejected,
  type CommunityPurchaseFundingQueryStore,
  getCommunityPurchaseFundingForActor,
  listReconcilableCommunityPurchaseFunding,
} from "./community-purchase-funding-query.ts";

const store: CommunityPurchaseFundingQueryStore = {
  loadForActor: () => Effect.succeed(null),
  listReconcilable: () => Effect.succeed([]),
  parkedCounts: () => Effect.succeed([]),
};

describe("community purchase funding queries", () => {
  test("returns not found without widening actor scope", async () => {
    await expect(
      Effect.runPromise(
        getCommunityPurchaseFundingForActor(
          { operationId: "operation_1", actorId: "actor_1" },
          store,
        ),
      ),
    ).rejects.toMatchObject({ reason: "not-found" });
  });

  test("bounds reconciler batches before storage", async () => {
    for (const limit of [0, 101, 1.5]) {
      await expect(
        Effect.runPromise(listReconcilableCommunityPurchaseFunding(limit, store)),
      ).rejects.toBeInstanceOf(CommunityPurchaseFundingQueryRejected);
    }
    await expect(
      Effect.runPromise(listReconcilableCommunityPurchaseFunding(100, store)),
    ).resolves.toEqual([]);
  });
});
