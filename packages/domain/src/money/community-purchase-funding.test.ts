import { describe, expect, test } from "bun:test";
import {
  type CommunityPurchaseFundingEvidence,
  type CommunityPurchaseFundingSnapshot,
  type CommunityPurchaseFundingState,
  canTransitionCommunityPurchaseFunding,
  communityPurchaseAtomicAmount,
  createCommunityPurchaseFunding,
  deriveCommunityPurchaseOperationId,
  deriveCommunityPurchaseRowId,
  transitionCommunityPurchaseFunding,
} from "./community-purchase-funding";
import { AMBIGUOUS, LEGACY, RECLAIMABLE } from "./failure-fence";
import { isTransitionRejection, type TransitionRejection } from "./state-machine";

const TOKEN = `0x${"11".repeat(20)}` as const;
const BUYER = `0x${"22".repeat(20)}` as const;
const TREASURY = `0x${"33".repeat(20)}` as const;
const TRANSACTION_HASH = `0x${"44".repeat(32)}` as const;
const BLOCK_HASH = `0x${"55".repeat(32)}` as const;
const REORG_BLOCK_HASH = `0x${"66".repeat(32)}` as const;
const OBSERVATION_1 = `0x${"77".repeat(32)}` as const;
const OBSERVATION_2 = `0x${"88".repeat(32)}` as const;
const OBSERVATION_3 = `0x${"99".repeat(32)}` as const;
const OBSERVATION_4 = `0x${"aa".repeat(32)}` as const;
const HEAD_HASH_1 = `0x${"bb".repeat(32)}` as const;
const HEAD_HASH_2 = `0x${"cc".repeat(32)}` as const;
const HEAD_HASH_3 = `0x${"dd".repeat(32)}` as const;

const PLAN = {
  communityId: "community_1",
  quoteId: "quote_1",
  purchaseId: "purchase_1",
  policyVersion: 3,
  expected: {
    chainId: 8453,
    tokenContract: TOKEN,
    tokenDecimals: 6 as const,
    sender: BUYER,
    recipient: TREASURY,
    amountAtomic: communityPurchaseAtomicAmount(12_500_000n),
    requiredConfirmations: 3,
  },
  now: 1_000,
} as const;

const EVIDENCE: CommunityPurchaseFundingEvidence = {
  receiptStatus: "success",
  chainId: PLAN.expected.chainId,
  tokenContract: TOKEN,
  sender: BUYER,
  recipient: TREASURY,
  amountAtomic: PLAN.expected.amountAtomic,
  transactionHash: TRANSACTION_HASH,
  blockNumber: 123,
  blockHash: BLOCK_HASH,
  logIndex: 4,
  observationId: OBSERVATION_1,
  observedHeadBlockNumber: 123,
  observedHeadBlockHash: HEAD_HASH_1,
};
const FINAL_EVIDENCE: CommunityPurchaseFundingEvidence = {
  ...EVIDENCE,
  observationId: OBSERVATION_2,
  observedHeadBlockNumber: 125,
  observedHeadBlockHash: HEAD_HASH_2,
};

function accepted(
  result: CommunityPurchaseFundingSnapshot | TransitionRejection,
): CommunityPurchaseFundingSnapshot {
  if (isTransitionRejection(result)) throw new Error(result.rejected);
  return result;
}

function rejected(
  result: CommunityPurchaseFundingSnapshot | TransitionRejection,
): TransitionRejection {
  if (!isTransitionRejection(result)) throw new Error("expected_transition_rejection");
  return result;
}

function observe(
  snapshot: CommunityPurchaseFundingSnapshot,
  evidence: CommunityPurchaseFundingEvidence,
  at = snapshot.updatedAt + 1,
): CommunityPurchaseFundingSnapshot | TransitionRejection {
  return transitionCommunityPurchaseFunding(snapshot, {
    type: "funding_evidence_observed",
    expectedVersion: snapshot.version,
    at,
    evidence,
  });
}

describe("community-purchase funding state machine", () => {
  const states: CommunityPurchaseFundingState[] = [
    "planned",
    "confirming",
    "confirmed",
    "reverted",
    "reclaimable_failed",
    "reconciliation_required",
  ];
  const expected: Record<CommunityPurchaseFundingState, CommunityPurchaseFundingState[]> = {
    planned: ["confirming", "confirmed", "reverted", "reclaimable_failed"],
    confirming: ["confirming", "confirmed", "reverted", "reconciliation_required"],
    confirmed: ["reconciliation_required"],
    reverted: ["reconciliation_required"],
    reclaimable_failed: ["planned"],
    reconciliation_required: ["confirming", "confirmed", "reverted"],
  };

  test("pins every allowed and forbidden state pair", () => {
    for (const from of states) {
      expect(states.filter((to) => canTransitionCommunityPurchaseFunding(from, to))).toEqual(
        expected[from],
      );
    }
  });

  test("derives stable operation and downstream row identities without a client nonce", () => {
    const operationId = deriveCommunityPurchaseOperationId(PLAN);
    expect(String(operationId)).toBe(
      "money:v1:community_purchase:community_1:quote_1:purchase_1:3",
    );
    expect(deriveCommunityPurchaseOperationId(PLAN)).toBe(operationId);
    expect(deriveCommunityPurchaseOperationId({ ...PLAN, policyVersion: 4 })).not.toBe(operationId);
    expect(deriveCommunityPurchaseOperationId({ ...PLAN, quoteId: "quote_2" })).not.toBe(
      operationId,
    );
    expect(String(deriveCommunityPurchaseRowId(operationId, "allocation", 2))).toBe(
      "money-row:v1:allocation:2:money%3Av1%3Acommunity_purchase%3Acommunity_1%3Aquote_1%3Apurchase_1%3A3",
    );
    expect(deriveCommunityPurchaseRowId(operationId, "allocation", 2)).toBe(
      deriveCommunityPurchaseRowId(operationId, "allocation", 2),
    );
    expect(deriveCommunityPurchaseRowId(operationId, "allocation", 3)).not.toBe(
      deriveCommunityPurchaseRowId(operationId, "allocation", 2),
    );
  });

  test("confirms only the exact expected transfer after required finality", () => {
    const planned = createCommunityPurchaseFunding(PLAN);
    const confirming = accepted(observe(planned, EVIDENCE));
    expect(confirming).toMatchObject({
      state: "confirming",
      version: 2,
      fundingEvidence: { observedHeadBlockNumber: 123 },
    });

    const confirmed = accepted(observe(confirming, FINAL_EVIDENCE));
    expect(confirmed).toMatchObject({
      state: "confirmed",
      version: 3,
      operationId: planned.operationId,
      failure: null,
    });
  });

  test("rejects wrong chain, token, sender, recipient, or amount as values", () => {
    const mismatches: ReadonlyArray<readonly [Partial<CommunityPurchaseFundingEvidence>, string]> =
      [
        [{ chainId: 1 }, "funding_evidence_chain_mismatch"],
        [{ tokenContract: BUYER }, "funding_evidence_token_mismatch"],
        [{ sender: TREASURY }, "funding_evidence_sender_mismatch"],
        [{ recipient: BUYER }, "funding_evidence_recipient_mismatch"],
        [
          { amountAtomic: communityPurchaseAtomicAmount(EVIDENCE.amountAtomic + 1n) },
          "funding_evidence_amount_mismatch",
        ],
      ];
    for (const [override, reason] of mismatches) {
      expect(
        rejected(
          observe(createCommunityPurchaseFunding(PLAN), {
            ...EVIDENCE,
            ...override,
          }),
        ).rejected,
      ).toBe(reason);
    }
  });

  test("freezes transaction identity and reconciles changed log identity", () => {
    const confirming = accepted(observe(createCommunityPurchaseFunding(PLAN), EVIDENCE));
    expect(
      rejected(
        observe(confirming, {
          ...EVIDENCE,
          transactionHash: `0x${"ee".repeat(32)}`,
          observationId: OBSERVATION_2,
          observedHeadBlockNumber: 124,
          observedHeadBlockHash: HEAD_HASH_2,
        }),
      ).rejected,
    ).toBe("funding_evidence_effect_identity_changed");
    expect(
      accepted(
        observe(confirming, {
          ...EVIDENCE,
          logIndex: 5,
          observationId: OBSERVATION_2,
          observedHeadBlockNumber: 124,
          observedHeadBlockHash: HEAD_HASH_2,
        }),
      ),
    ).toMatchObject({
      state: "reconciliation_required",
      failure: AMBIGUOUS,
    });
  });

  test("represents a final revert without fabricating an ERC-20 transfer log", () => {
    const reverted = accepted(
      observe(createCommunityPurchaseFunding(PLAN), {
        ...FINAL_EVIDENCE,
        receiptStatus: "reverted",
        logIndex: null,
      }),
    );
    expect(reverted).toMatchObject({
      state: "reverted",
      fundingEvidence: { receiptStatus: "reverted", logIndex: null },
    });
    expect(
      rejected(
        observe(createCommunityPurchaseFunding(PLAN), {
          ...FINAL_EVIDENCE,
          receiptStatus: "reverted",
        }),
      ).rejected,
    ).toBe("reverted_funding_cannot_have_transfer_log");
  });

  test("turns block drift and decreasing finality into fenced reconciliation", () => {
    const confirmed = accepted(observe(createCommunityPurchaseFunding(PLAN), FINAL_EVIDENCE));
    const reconciliation = accepted(
      observe(confirmed, {
        ...EVIDENCE,
        blockNumber: 124,
        blockHash: REORG_BLOCK_HASH,
        observationId: OBSERVATION_3,
        observedHeadBlockNumber: 124,
        observedHeadBlockHash: HEAD_HASH_3,
      }),
    );
    expect(reconciliation).toMatchObject({
      state: "reconciliation_required",
      failure: AMBIGUOUS,
      failureReason: "funding_block_identity_changed",
      reconciliationEvidence: {
        blockHash: REORG_BLOCK_HASH,
        observationId: OBSERVATION_3,
      },
    });

    expect(
      rejected(
        transitionCommunityPurchaseFunding(reconciliation, {
          type: "reconciliation_resolved",
          expectedVersion: reconciliation.version,
          at: reconciliation.updatedAt + 1,
          evidence: reconciliation.reconciliationEvidence ?? EVIDENCE,
        }),
      ).rejected,
    ).toBe("reconciliation_observation_not_fresh");

    const resolved = accepted(
      transitionCommunityPurchaseFunding(reconciliation, {
        type: "reconciliation_resolved",
        expectedVersion: reconciliation.version,
        at: reconciliation.updatedAt + 1,
        evidence: {
          ...EVIDENCE,
          blockNumber: 124,
          blockHash: REORG_BLOCK_HASH,
          observationId: OBSERVATION_4,
          observedHeadBlockNumber: 126,
          observedHeadBlockHash: HEAD_HASH_3,
        },
      }),
    );
    expect(resolved.state).toBe("confirmed");
  });

  test("records only explicit safe failures as reclaimable and preserves other fences", () => {
    const planned = createCommunityPurchaseFunding(PLAN);
    const failed = accepted(
      transitionCommunityPurchaseFunding(planned, {
        type: "reclaimable_failure_recorded",
        expectedVersion: planned.version,
        at: planned.updatedAt + 1,
        failure: RECLAIMABLE,
        reason: "provider_unavailable_before_observation",
      }),
    );
    expect(failed).toMatchObject({ state: "reclaimable_failed", failure: RECLAIMABLE });
    const retried = accepted(
      transitionCommunityPurchaseFunding(failed, {
        type: "reclaimable_failure_retried",
        expectedVersion: failed.version,
        at: failed.updatedAt + 1,
      }),
    );
    expect(retried).toMatchObject({ state: "planned", failure: null, fundingEvidence: null });

    const confirmed = accepted(observe(createCommunityPurchaseFunding(PLAN), FINAL_EVIDENCE));
    const reconciliation = accepted(
      transitionCommunityPurchaseFunding(confirmed, {
        type: "reconciliation_required",
        expectedVersion: confirmed.version,
        at: confirmed.updatedAt + 1,
        failure: LEGACY,
        reason: "stored_evidence_requires_review",
      }),
    );
    expect(reconciliation).toMatchObject({
      state: "reconciliation_required",
      failure: LEGACY,
    });
  });

  test("returns version, time, and illegal-event failures without mutating state", () => {
    const planned = createCommunityPurchaseFunding(PLAN);
    expect(
      rejected(
        transitionCommunityPurchaseFunding(planned, {
          type: "funding_evidence_observed",
          expectedVersion: 99,
          at: planned.updatedAt + 1,
          evidence: EVIDENCE,
        }),
      ).rejected,
    ).toBe("community_purchase_funding_version_conflict");
    expect(
      rejected(
        transitionCommunityPurchaseFunding(planned, {
          type: "reclaimable_failure_retried",
          expectedVersion: planned.version,
          at: planned.updatedAt - 1,
        }),
      ).rejected,
    ).toBe("community_purchase_funding_event_time_invalid");
    expect(planned).toEqual(createCommunityPurchaseFunding(PLAN));
  });

  test("asserts persisted identity invariants before reducing", () => {
    const planned = createCommunityPurchaseFunding(PLAN);
    const corrupted = {
      ...planned,
      quoteId: "quote_2",
    } as CommunityPurchaseFundingSnapshot;
    expect(() =>
      transitionCommunityPurchaseFunding(corrupted, {
        type: "funding_evidence_observed",
        expectedVersion: corrupted.version,
        at: corrupted.updatedAt + 1,
        evidence: EVIDENCE,
      }),
    ).toThrow("community_purchase_operation_identity_mismatch");
  });
});
