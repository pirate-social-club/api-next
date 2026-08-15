import { describe, expect, test } from "bun:test";
import {
  canTransitionStorySettlementStep,
  type Hex,
  isTerminalStorySettlementStepState,
  type StorySettlementStepSnapshot,
  type StorySettlementStepState,
  transitionStorySettlementStep,
} from "./story-settlement-step-state-machine";

const HASH = `0x${"11".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"22".repeat(32)}` as Hex;

const planned: StorySettlementStepSnapshot = {
  state: "planned",
  version: 1,
  nonce: null,
  signedTransactionStored: false,
  transactionHash: null,
  receipt: null,
};

describe("Story settlement step state machine", () => {
  const states: StorySettlementStepState[] = [
    "planned",
    "reserving",
    "failed_prebroadcast",
    "prepared",
    "broadcast",
    "mined",
    "confirmed",
    "reverted",
    "replaced",
    "reconciliation_required",
  ];
  const expected: Record<StorySettlementStepState, StorySettlementStepState[]> = {
    planned: ["reserving"],
    reserving: ["prepared", "failed_prebroadcast"],
    failed_prebroadcast: ["reserving"],
    prepared: ["broadcast", "reconciliation_required"],
    broadcast: ["broadcast", "mined", "reverted", "replaced", "reconciliation_required"],
    mined: ["mined", "confirmed", "broadcast", "reconciliation_required"],
    confirmed: [],
    reverted: [],
    replaced: [],
    reconciliation_required: ["broadcast", "mined", "confirmed", "reverted", "replaced"],
  };

  test("matches the reviewed transition matrix exactly", () => {
    for (const from of states) {
      expect(states.filter((to) => canTransitionStorySettlementStep(from, to)).sort()).toEqual(
        [...expected[from]].sort(),
      );
    }
    expect(states.filter(isTerminalStorySettlementStepState)).toEqual([
      "confirmed",
      "reverted",
      "replaced",
    ]);
  });

  test("fences versions and requires durable signed evidence before broadcast states", () => {
    expect(() =>
      transitionStorySettlementStep(planned, { expectedVersion: 2, to: "reserving", nonce: 7 }),
    ).toThrow("story_settlement_step_version_conflict");
    const reserving = transitionStorySettlementStep(planned, {
      expectedVersion: 1,
      to: "reserving",
      nonce: 7,
    });
    expect(reserving).toMatchObject({ state: "reserving", version: 2, nonce: 7 });
    expect(() =>
      transitionStorySettlementStep(reserving, { expectedVersion: 2, to: "prepared" }),
    ).toThrow("prepared_step_requires_durable_signed_transaction");
    const prepared = transitionStorySettlementStep(reserving, {
      expectedVersion: 2,
      to: "prepared",
      signedTransactionStored: true,
      transactionHash: HASH,
    });
    expect(
      transitionStorySettlementStep(prepared, { expectedVersion: 3, to: "broadcast" }),
    ).toMatchObject({ state: "broadcast", version: 4, nonce: 7, transactionHash: HASH });
  });

  test("reuses a reserved nonce after proven prebroadcast failure", () => {
    const reserving = transitionStorySettlementStep(planned, {
      expectedVersion: 1,
      to: "reserving",
      nonce: 7,
    });
    const failed = transitionStorySettlementStep(reserving, {
      expectedVersion: 2,
      to: "failed_prebroadcast",
    });
    expect(() =>
      transitionStorySettlementStep(failed, { expectedVersion: 3, to: "reserving", nonce: 8 }),
    ).toThrow("story_settlement_step_nonce_is_immutable");
    expect(
      transitionStorySettlementStep(failed, { expectedVersion: 3, to: "reserving" }),
    ).toMatchObject({ state: "reserving", nonce: 7 });
  });

  test("requires receipt outcomes and clears pre-finality receipt on reorg to broadcast", () => {
    const mined: StorySettlementStepSnapshot = {
      state: "mined",
      version: 8,
      nonce: 7,
      signedTransactionStored: true,
      transactionHash: HASH,
      receipt: { status: "success", blockNumber: 100n, blockHash: BLOCK_HASH },
    };
    expect(
      transitionStorySettlementStep(mined, { expectedVersion: 8, to: "confirmed" }).state,
    ).toBe("confirmed");
    expect(
      transitionStorySettlementStep(mined, { expectedVersion: 8, to: "broadcast" }).receipt,
    ).toBeNull();
    expect(() =>
      transitionStorySettlementStep(
        { ...mined, state: "broadcast", receipt: null },
        {
          expectedVersion: 8,
          to: "reverted",
          receipt: { status: "success", blockNumber: 101n, blockHash: BLOCK_HASH },
        },
      ),
    ).toThrow("reverted_step_requires_reverted_receipt");
  });

  test("never permits terminal transitions", () => {
    for (const state of ["confirmed", "reverted", "replaced"] as const) {
      expect(() =>
        transitionStorySettlementStep(
          {
            state,
            version: 10,
            nonce: 7,
            signedTransactionStored: true,
            transactionHash: HASH,
            receipt:
              state === "replaced"
                ? null
                : {
                    status: state === "reverted" ? "reverted" : "success",
                    blockNumber: 1n,
                    blockHash: BLOCK_HASH,
                  },
          },
          { expectedVersion: 10, to: "reconciliation_required" },
        ),
      ).toThrow(`illegal_story_settlement_step_transition:${state}:reconciliation_required`);
    }
  });
});
