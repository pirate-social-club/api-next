import { describe, expect, test } from "bun:test";
import { HNS_ROOT_IMPORT_POLICY_V1 } from "@pirate/domain";
import type { HnsChainObservationResultV1 } from "./hns-chain-observation.ts";
import { decideHnsRetentionReviewV1, hnsRetentionReviewDueAtV1 } from "./hns-retention-review.ts";
import type { HnsRootResourceRecordV1 } from "./hns-root-import-plan.ts";
import type { HnsRetainedAuthorityReferenceV1 } from "./hns-teardown-retention.ts";

const authority: HnsRetainedAuthorityReferenceV1 = {
  ns_names: ["ns1.pirate.", "ns2.pirate."],
  ds: [{ key_tag: 12_345, algorithm: 13, digest_type: 2, digest: "ab".repeat(32) }],
  challenge_txt_value: "pirate-verification=reviewed",
};

function observed(
  view: "current" | "safe",
  records: readonly HnsRootResourceRecordV1[],
  height = 812_345,
): HnsChainObservationResultV1 {
  return {
    kind: "observed",
    observation: {
      view,
      network: "main",
      genesis_block_hash: `${"0".repeat(63)}1`,
      anchor: {
        network: "main",
        genesis_block_hash: `${"0".repeat(63)}1`,
        height,
        best_block_hash: "aa".repeat(32),
        median_time_past_epoch_seconds: 1_770_000_000,
        header_time_epoch_seconds: 1_770_000_030,
        confirmations: 1,
      },
      tip_height: height,
      update_inclusion_height: height - 12,
      commitment: null,
      observed_at_epoch_ms: view === "current" ? 1_770_000_060_000 : 1_770_000_061_000,
      records,
      resource_sha256: `${"0".repeat(63)}${view === "current" ? "1" : "2"}`,
    },
  };
}

const unavailable = (): HnsChainObservationResultV1 => ({
  kind: "unavailable",
  classification: "node_unavailable",
});

const finding = (): HnsChainObservationResultV1 => ({
  kind: "finding",
  classification: "resource_absent",
  anchor: {
    network: "main",
    genesis_block_hash: `${"0".repeat(63)}1`,
    height: 812_345,
    best_block_hash: "aa".repeat(32),
    median_time_past_epoch_seconds: 1_770_000_000,
    header_time_epoch_seconds: 1_770_000_030,
    confirmations: 1,
  },
  observed_at_epoch_ms: 1_770_000_060_000,
});

describe("retention reviews record what one inspection shows", () => {
  test("a reference from either view retains, and names the view that carried it", () => {
    for (const referencing of ["current", "safe"] as const) {
      const clean = [{ type: "TXT", txt: ["unrelated"] }] as const;
      const review = decideHnsRetentionReviewV1({
        authority,
        current: observed(
          "current",
          referencing === "current" ? [{ type: "NS", ns: "ns2.pirate" }] : clean,
        ),
        safe: observed(
          "safe",
          referencing === "safe" ? [{ type: "NS", ns: "NS2.Pirate." }] : clean,
        ),
      });
      expect(review.decision).toBe("retain");
      expect(review.reason).toBe("chain_reference_retained");
      expect(review.inspected_views.at(-1)).toBe(referencing);
    }
  });

  test("a delegation signer or the verification challenge references the authority just as a nameserver does", () => {
    for (const records of [
      [{ type: "DS", keyTag: 12_345, algorithm: 13, digestType: 2, digest: "AB".repeat(32) }],
      [{ type: "TXT", txt: ["pirate-verification=reviewed"] }],
    ]) {
      const review = decideHnsRetentionReviewV1({
        authority,
        current: observed("current", records as never),
        safe: observed("safe", []),
      });
      expect(review.reason).toBe("chain_reference_retained");
    }
  });

  test("unavailable evidence and a name finding both retain without inferring absence", () => {
    for (const current of [null, unavailable(), finding()]) {
      const review = decideHnsRetentionReviewV1({
        authority,
        current,
        safe: observed("safe", []),
      });
      expect(review.decision).toBe("retain");
      expect(review.reason).toBe("unavailable_chain_state_retained");
      expect(review.inspected_views).toEqual([]);
    }
    // A clean current view still retains when the safe view is unreadable:
    // both views must be inspected before absence means anything at all.
    const halfInspected = decideHnsRetentionReviewV1({
      authority,
      current: observed("current", []),
      safe: unavailable(),
    });
    expect(halfInspected.reason).toBe("unavailable_chain_state_retained");
    expect(halfInspected.inspected_views).toEqual(["current"]);
  });

  test("unknown provenance retains and inspects nothing", () => {
    const review = decideHnsRetentionReviewV1({
      authority: null,
      current: observed("current", []),
      safe: observed("safe", []),
    });
    expect(review.decision).toBe("retain");
    expect(review.reason).toBe("unknown_provenance_retained");
    expect(review.inspected_views).toEqual([]);
  });

  test("a clean inspection of both views still retains: no exposure horizon is defined", () => {
    const review = decideHnsRetentionReviewV1({
      authority,
      current: observed("current", [{ type: "TXT", txt: ["unrelated"] }]),
      safe: observed("safe", []),
    });
    // This is the case the specification's positive-evidence clause would
    // cover, and its exposure-horizon analysis does not exist. The reviewer
    // records the gap rather than reading absence as permission to delete.
    expect(review.decision).toBe("retain");
    expect(review.reason).toBe("exposure_horizon_undetermined_retained");
    expect(review.inspected_views).toEqual(["current", "safe"]);
    // The decision type admits no retiring value at all, so no future edit can
    // turn a clean inspection into an authorization by changing one branch.
    const decision: "retain" = review.decision;
    expect(decision).toBe("retain");
  });

  test("the review carries both views' evidence, and its reference is stable per inspection", () => {
    const input = {
      authority,
      current: observed("current", []),
      safe: observed("safe", []),
    } as const;
    const review = decideHnsRetentionReviewV1(input);
    expect(review.current_observed_at_epoch_ms).toBe(1_770_000_060_000);
    expect(review.safe_observed_at_epoch_ms).toBe(1_770_000_061_000);
    expect(review.current_resource_sha256).toBe(`${"0".repeat(63)}1`);
    expect(review.safe_resource_sha256).toBe(`${"0".repeat(63)}2`);
    expect(decideHnsRetentionReviewV1(input).evidence_ref).toBe(review.evidence_ref);
    // A different inspection is a different review, not a replay of this one.
    expect(
      decideHnsRetentionReviewV1({ ...input, current: observed("current", [], 812_346) })
        .evidence_ref,
    ).not.toBe(review.evidence_ref);
    // Unavailable evidence still produces a reference, so a repeated outage is
    // recognised as the same inspection rather than accumulating reviews.
    const outage = { authority, current: unavailable(), safe: unavailable() };
    expect(decideHnsRetentionReviewV1(outage).evidence_ref).toBe(
      decideHnsRetentionReviewV1(outage).evidence_ref,
    );
  });

  test("the review cadence is the frozen policy's, seven days then thirty", () => {
    const now = 1_770_000_000_000;
    expect(hnsRetentionReviewDueAtV1(now, HNS_ROOT_IMPORT_POLICY_V1, "initial")).toBe(
      now + 604_800_000,
    );
    expect(hnsRetentionReviewDueAtV1(now, HNS_ROOT_IMPORT_POLICY_V1, "recurring")).toBe(
      now + 2_592_000_000,
    );
  });
});
