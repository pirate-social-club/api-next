import { describe, expect, test } from "bun:test";
import {
  classifyMegapotStorageFailure,
  mapMegapotStorageFailure,
} from "./control-plane-error-classification.ts";

describe("classifyMegapotStorageFailure", () => {
  test.each([
    ["acquisition failure", { _tag: "ControlPlaneAcquireFailed" }, "unavailable"],
    [
      "timeout with unknown outcome",
      { _tag: "ControlPlaneOperationTimedOut", outcomeCertainty: "unknown" },
      "outcome-unknown",
    ],
    [
      "timeout with known aborted outcome",
      { _tag: "ControlPlaneOperationTimedOut", outcomeCertainty: "aborted" },
      "unavailable",
    ],
    [
      "timeout with known completed outcome",
      { _tag: "ControlPlaneOperationTimedOut", outcomeCertainty: "completed" },
      "unavailable",
    ],
    [
      "timeout that never started",
      { _tag: "ControlPlaneOperationTimedOut", outcomeCertainty: "not-started" },
      "unavailable",
    ],
    ["unique violation", { _tag: "ControlPlaneStatementFailed", sqlState: "23505" }, "conflict"],
    [
      "other SQL constraint",
      { _tag: "ControlPlaneStatementFailed", sqlState: "23503" },
      "constraint",
    ],
    [
      "statement failure without SQLSTATE",
      { _tag: "ControlPlaneStatementFailed", sqlState: null },
      "unavailable",
    ],
    [
      "unknown transaction outcome",
      { _tag: "ControlPlaneTransactionOutcomeUnknown" },
      "outcome-unknown",
    ],
  ] as const)("maps %s", (_label, error, expected) => {
    expect(classifyMegapotStorageFailure(error)).toBe(expected);
  });

  test.each([
    ["unrelated tagged error", { _tag: "MegapotPurchaseRejected" }],
    ["plain object", {}],
    ["null", null],
    ["primitive", "unavailable"],
  ] as const)("does not classify %s", (_label, error) => {
    expect(classifyMegapotStorageFailure(error)).toBeUndefined();
  });

  test("passes an unrelated error through by identity", () => {
    const unrelated = { _tag: "MegapotPurchaseRejected", reason: "stale" } as const;
    const result = mapMegapotStorageFailure(unrelated, (reason) => ({ reason }));

    expect(result).toBe(unrelated);
  });

  test("constructs a storage failure for a recognized control-plane error", () => {
    const result = mapMegapotStorageFailure(
      { _tag: "ControlPlaneStatementFailed", sqlState: "23505" },
      (reason) => ({ _tag: "MegapotStorageFailed", reason }),
    );

    expect(result).toEqual({ _tag: "MegapotStorageFailed", reason: "conflict" });
  });
});
