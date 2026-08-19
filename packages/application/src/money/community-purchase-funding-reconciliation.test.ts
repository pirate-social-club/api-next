import { describe, expect, test } from "bun:test";
import type { Bytes32, CommunityPurchaseOperationId } from "@pirate/domain";
import { Effect } from "effect";
import type { Alert } from "../ports.ts";
import {
  CommunityPurchaseFundingChainReadFailed,
  type CommunityPurchaseFundingObservationUseCase,
} from "./community-purchase-funding-observation.ts";
import type { CommunityPurchaseFundingQueryStore } from "./community-purchase-funding-query.ts";
import {
  type CommunityPurchaseFundingAttemptState,
  type CommunityPurchaseFundingReconciliationAttemptStore,
  makeCommunityPurchaseFundingReconciler,
} from "./community-purchase-funding-reconciliation.ts";

const OP_A =
  "money:v1:community_purchase:community_1:quote_a:purchase_a:3" as CommunityPurchaseOperationId;
const OP_B =
  "money:v1:community_purchase:community_1:quote_b:purchase_b:3" as CommunityPurchaseOperationId;
const HASH_A = `0x${"aa".repeat(32)}` as Bytes32;
const HASH_B = `0x${"bb".repeat(32)}` as Bytes32;

function state(
  operationId: CommunityPurchaseOperationId,
  generation = 1,
  consecutiveFailures = 0,
): CommunityPurchaseFundingAttemptState {
  return {
    operationId,
    generation,
    finalizedGeneration: null,
    lastAttemptAt: "2026-08-19T00:00:00.000Z",
    nextAttemptAt: null,
    lastFailureClass: null,
    consecutiveFailures,
    escalatedAt: null,
  };
}

function queryStore(): CommunityPurchaseFundingQueryStore {
  return {
    loadForActor: () => Effect.succeed(null),
    listReconcilable: ({ limit }) =>
      Effect.succeed(
        [
          { operationId: OP_A, transactionHash: HASH_A },
          { operationId: OP_B, transactionHash: HASH_B },
        ].slice(0, limit),
      ),
    listDormancyCandidates: () => Effect.succeed([]),
  };
}

describe("community purchase reconciliation fairness", () => {
  test("a stale finalizer is ignored and cannot claim processing", async () => {
    const observed: string[] = [];
    const attempts: CommunityPurchaseFundingReconciliationAttemptStore = {
      recordAttemptStart: (input) =>
        Effect.succeed({ kind: "reserved", state: state(input.operationId) }),
      recordAttemptSuccess: () => Effect.succeed({ kind: "stale" }),
      recordAttemptFailure: () => Effect.succeed({ kind: "stale" }),
    };
    const observation: CommunityPurchaseFundingObservationUseCase = {
      observe: (input) => {
        observed.push(input.operationId);
        return Effect.succeed({} as never);
      },
    };
    const result = await Effect.runPromise(
      makeCommunityPurchaseFundingReconciler(queryStore(), attempts, observation, {
        emit: (_alert: Alert) => Effect.void,
      })({ limit: 1, ownerId: "worker-1", leaseMs: 1_000 }),
    );
    expect(observed).toEqual([OP_A]);
    expect(result).toMatchObject({ selected: 1, processed: 0, failed: 0, skipped: 1 });
  });

  test("an expected poisoned candidate gets backoff while later candidates run", async () => {
    const observed: string[] = [];
    const attempts: CommunityPurchaseFundingReconciliationAttemptStore = {
      recordAttemptStart: (input) =>
        Effect.succeed({ kind: "reserved", state: state(input.operationId) }),
      recordAttemptSuccess: (input) =>
        Effect.succeed({ kind: "finalized", state: state(input.operationId) }),
      recordAttemptFailure: (input) =>
        Effect.succeed({
          kind: "finalized",
          state: {
            ...state(input.operationId),
            lastFailureClass: input.failureClass,
            consecutiveFailures: 1,
            nextAttemptAt: "2026-08-19T00:01:00.000Z",
          },
        }),
    };
    const observation: CommunityPurchaseFundingObservationUseCase = {
      observe: (input) => {
        observed.push(input.operationId);
        return input.operationId === OP_A
          ? Effect.fail(new CommunityPurchaseFundingChainReadFailed({ reason: "unavailable" }))
          : Effect.succeed({} as never);
      },
    };
    const result = await Effect.runPromise(
      makeCommunityPurchaseFundingReconciler(queryStore(), attempts, observation, {
        emit: (_alert: Alert) => Effect.void,
      })({ limit: 2, ownerId: "worker-1", leaseMs: 1_000 }),
    );
    expect(observed).toEqual([OP_A, OP_B]);
    expect(result).toMatchObject({ selected: 2, processed: 1, failed: 1, skipped: 0 });
  });
});
