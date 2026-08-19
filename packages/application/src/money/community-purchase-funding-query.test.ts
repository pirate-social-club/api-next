import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { CommunityPurchaseFundingInterpreter } from "./community-purchase-funding.ts";
import {
  CommunityPurchaseFundingChainReadFailed,
  type CommunityPurchaseFundingObservationUseCase,
} from "./community-purchase-funding-observation.ts";
import {
  CommunityPurchaseFundingQueryRejected,
  type CommunityPurchaseFundingQueryStore,
  getCommunityPurchaseFundingForActor,
  listReconcilableCommunityPurchaseFunding,
  makeCommunityPurchaseFundingDormancySweeper,
  makeCommunityPurchaseFundingReconciler,
} from "./community-purchase-funding-query.ts";
import type {
  CommunityPurchaseFundingAttemptState,
  CommunityPurchaseFundingReconciliationAttemptStore,
} from "./community-purchase-funding-reconciliation.ts";

const store: CommunityPurchaseFundingQueryStore = {
  loadForActor: () => Effect.succeed(null),
  listReconcilable: () => Effect.succeed([]),
  listDormancyCandidates: () => Effect.succeed([]),
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

  test("isolates a failed reconciliation candidate and continues the batch", async () => {
    const first = `0x${"11".repeat(32)}` as `0x${string}`;
    const second = `0x${"22".repeat(32)}` as `0x${string}`;
    const visited: string[] = [];
    const queryStore: CommunityPurchaseFundingQueryStore = {
      ...store,
      listReconcilable: () =>
        Effect.succeed([
          { operationId: "operation_1" as never, transactionHash: first },
          { operationId: "operation_2" as never, transactionHash: second },
        ]),
    };
    const attempts: CommunityPurchaseFundingReconciliationAttemptStore = {
      recordAttemptStart: (input) =>
        Effect.succeed({
          kind: "reserved",
          state: {
            operationId: input.operationId,
            generation: 1,
            finalizedGeneration: null,
            lastAttemptAt: new Date().toISOString(),
            nextAttemptAt: null,
            lastFailureClass: null,
            consecutiveFailures: 0,
            escalatedAt: null,
          } satisfies CommunityPurchaseFundingAttemptState,
        }),
      recordAttemptSuccess: (input) =>
        Effect.succeed({
          kind: "finalized",
          state: {
            operationId: input.operationId,
            generation: input.generation,
            finalizedGeneration: input.generation,
            lastAttemptAt: new Date().toISOString(),
            nextAttemptAt: null,
            lastFailureClass: null,
            consecutiveFailures: 0,
            escalatedAt: null,
          } satisfies CommunityPurchaseFundingAttemptState,
        }),
      recordAttemptFailure: (input) =>
        Effect.succeed({
          kind: "finalized",
          state: {
            operationId: input.operationId,
            generation: input.generation,
            finalizedGeneration: input.generation,
            lastAttemptAt: new Date().toISOString(),
            nextAttemptAt: new Date(Date.now() + input.retryDelayMs).toISOString(),
            lastFailureClass: input.failureClass,
            consecutiveFailures: 1,
            escalatedAt: null,
          } satisfies CommunityPurchaseFundingAttemptState,
        }),
    };
    const alerts = { emit: () => Effect.void };
    const observation: CommunityPurchaseFundingObservationUseCase = {
      observe: (input) => {
        visited.push(input.operationId);
        return input.operationId === "operation_1"
          ? Effect.fail(new CommunityPurchaseFundingChainReadFailed({ reason: "unavailable" }))
          : Effect.succeed({} as never);
      },
    };

    const result = await Effect.runPromise(
      makeCommunityPurchaseFundingReconciler(
        queryStore,
        attempts,
        observation,
        alerts,
      )({
        limit: 10,
        ownerId: "job_1",
        leaseMs: 1_000,
      }),
    );

    expect(visited).toEqual(["operation_1", "operation_2"]);
    expect(result).toMatchObject({ selected: 2, processed: 1, failed: 1, skipped: 0 });
  });

  test("uses database candidate time when moving planned funding to dormancy", async () => {
    const transitions: Array<{
      readonly at: number;
      readonly expectedVersion: number;
      readonly type: string;
    }> = [];
    const queryStore: CommunityPurchaseFundingQueryStore = {
      ...store,
      listDormancyCandidates: () =>
        Effect.succeed([
          { operationId: "operation_1" as never, expectedVersion: 4, databaseNowMs: 12_345 },
        ]),
    };
    const interpreter = {
      acquireLease: () =>
        Effect.succeed({
          operationId: "operation_1",
          ownerId: "job_1:operation_1",
          fenceToken: 1,
          expiresAt: new Date(20_000).toISOString(),
          databaseNowMs: 12_345,
        }),
      transition: (input: {
        readonly event: {
          readonly at: number;
          readonly expectedVersion: number;
          readonly type: string;
        };
      }) => {
        transitions.push(input.event);
        return Effect.succeed({} as never);
      },
    } as unknown as CommunityPurchaseFundingInterpreter;

    const result = await Effect.runPromise(
      makeCommunityPurchaseFundingDormancySweeper(
        queryStore,
        interpreter,
      )({
        limit: 10,
        ownerId: "job_1",
        leaseMs: 1_000,
        submissionWindowMs: 30 * 60 * 1_000,
      }),
    );

    expect(transitions).toEqual([
      { at: 12_345, expectedVersion: 4, type: "submission_window_elapsed" },
    ]);
    expect(result).toMatchObject({ selected: 1, processed: 1, failures: [] });
  });
});
