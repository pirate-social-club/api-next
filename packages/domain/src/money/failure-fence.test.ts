import { describe, expect, test } from "bun:test";
import { classifySettlementFailure, isFailureFenceReclaimable } from "./failure-fence";

// Ported invariants: the old settlement-effects suite proved that only an
// explicit pre-broadcast failure is reclaimable, and that ambiguous and
// legacy failures are reconciliation-only.

describe("classifySettlementFailure", () => {
  test("only an explicit pre-broadcast failure is reclaimable", () => {
    expect(
      classifySettlementFailure({ error: "explicit_prebroadcast", broadcastAttempted: false }),
    ).toMatchObject({ _tag: "reclaimable", mayRebroadcast: true, mayRetry: true });
    expect(
      isFailureFenceReclaimable(
        classifySettlementFailure({
          error: "explicit_prebroadcast",
          broadcastAttempted: false,
        }),
      ),
    ).toBe(true);
  });

  test("a broadcast attempt fences even an explicit failure as ambiguous", () => {
    const fence = classifySettlementFailure({
      error: "explicit_prebroadcast",
      broadcastAttempted: true,
    });
    expect(fence).toMatchObject({ _tag: "ambiguous", disposition: "reconciliation_required" });
    expect(fence.mayRebroadcast).toBe(false);
    expect(fence.mayRetry).toBe(false);
  });

  test("chain ambiguity is reconciliation-only regardless of broadcast state", () => {
    for (const broadcastAttempted of [true, false]) {
      const fence = classifySettlementFailure({ error: "chain_ambiguous", broadcastAttempted });
      expect(fence._tag).toBe("ambiguous");
      expect(fence.mayRebroadcast).toBe(false);
    }
  });

  test("unclassified failures are legacy and never re-broadcast", () => {
    const fence = classifySettlementFailure({ error: "unclassified" });
    expect(fence).toMatchObject({ _tag: "legacy", disposition: "reconciliation_required" });
    expect(fence.mayRebroadcast).toBe(false);
    expect(fence.mayRetry).toBe(false);
  });

  test("only the reclaimable tag passes the reclaimability guard", () => {
    const fences = [
      classifySettlementFailure({ error: "explicit_prebroadcast", broadcastAttempted: false }),
      classifySettlementFailure({ error: "explicit_prebroadcast", broadcastAttempted: true }),
      classifySettlementFailure({ error: "chain_ambiguous", broadcastAttempted: true }),
      classifySettlementFailure({ error: "unclassified" }),
    ];
    expect(fences.filter(isFailureFenceReclaimable)).toHaveLength(1);
  });
});
