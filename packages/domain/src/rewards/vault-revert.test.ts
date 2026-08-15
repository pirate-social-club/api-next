import { describe, expect, it } from "bun:test";

import { classifyRewardVaultRevert, isRewardVaultCapacityDeferral } from "./vault-revert";

describe("classifyRewardVaultRevert", () => {
  it("defers only on the epoch capacity ceiling", () => {
    const result = classifyRewardVaultRevert("0x2b579c17");
    expect(result.disposition).toBe("capacity_deferred");
    expect(result.errorName).toBe("EpochLimitExceeded");
  });

  it("does not defer on the per-transfer limit", () => {
    const result = classifyRewardVaultRevert("0x3525bb0b");
    expect(result.disposition).toBe("reconciliation_required");
    expect(result.errorName).toBe("TransferLimitExceeded");
  });

  it.each([
    ["0xe5c91771", "StalePolicy"],
    ["0x1ab7da6b", "DeadlineExpired"],
    ["0x01828959", "OperationAlreadyUsed"],
    ["0x373a363f", "PayoutsPaused"],
    ["0xcfd11eb6", "RefundsPaused"],
    ["0x82b42900", "Unauthorized"],
    ["0x1f2a2005", "ZeroAmount"],
    ["0xd92e233d", "ZeroAddress"],
    ["0x045c4b02", "TokenTransferFailed"],
    ["0xab143c06", "Reentrancy"],
    ["0xd06b96b1", "InvalidPolicy"],
  ])("never defers on %s", (selector, errorName) => {
    const result = classifyRewardVaultRevert(selector);
    expect(result.disposition).toBe("reconciliation_required");
    expect(result.errorName).toBe(errorName);
  });

  it("does not defer on an unrecognized selector", () => {
    const result = classifyRewardVaultRevert("0xdeadbeef");
    expect(result.disposition).toBe("reconciliation_required");
    expect(result.errorName).toBeNull();
    expect(result.selector).toBe("0xdeadbeef");
  });

  it.each([null, undefined, "", "0x"])("does not defer without revert data (%p)", (data) => {
    const result = classifyRewardVaultRevert(data);
    expect(result.disposition).toBe("reconciliation_required");
    expect(result.errorName).toBeNull();
    expect(result.selector).toBeNull();
  });

  it.each(["0x123", "notbytes", "0xzzzzzzzz"])(
    "does not defer on malformed revert data (%p)",
    (data) => {
      expect(classifyRewardVaultRevert(data).disposition).toBe("reconciliation_required");
    },
  );

  it("recognizes Solidity built-in reverts without deferring", () => {
    expect(classifyRewardVaultRevert("0x08c379a0").errorName).toBe("Error(string)");
    expect(classifyRewardVaultRevert("0x4e487b71").errorName).toBe("Panic(uint256)");
  });

  it("matches selectors case-insensitively and ignores trailing ABI data", () => {
    expect(classifyRewardVaultRevert("0x2B579C17").disposition).toBe("capacity_deferred");
    expect(classifyRewardVaultRevert(`0x2b579c17${"00".repeat(32)}`).disposition).toBe(
      "capacity_deferred",
    );
  });

  it("exposes the capacity decision through the boolean helper", () => {
    expect(isRewardVaultCapacityDeferral("0x2b579c17")).toBe(true);
    expect(isRewardVaultCapacityDeferral("0x373a363f")).toBe(false);
    expect(isRewardVaultCapacityDeferral(null)).toBe(false);
  });
});
