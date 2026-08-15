/**
 * Classifies raw, already-extracted RewardsTreasuryVault revert data.
 *
 * Chain clients own transaction tracing and ABI/keccak decoding. This pure
 * policy is deliberately limited to the normalized revert bytes: only the
 * epoch ceiling is safe to defer, while every other result is reconciled.
 */

const VAULT_ERROR_SELECTORS: Record<string, string> = {
  "0x2b579c17": "EpochLimitExceeded",
  "0x3525bb0b": "TransferLimitExceeded",
  "0xe5c91771": "StalePolicy",
  "0x1ab7da6b": "DeadlineExpired",
  "0x01828959": "OperationAlreadyUsed",
  "0x373a363f": "PayoutsPaused",
  "0xcfd11eb6": "RefundsPaused",
  "0x82b42900": "Unauthorized",
  "0x1f2a2005": "ZeroAmount",
  "0xd92e233d": "ZeroAddress",
  "0x045c4b02": "TokenTransferFailed",
  "0xab143c06": "Reentrancy",
  "0xd06b96b1": "InvalidPolicy",
  "0x08c379a0": "Error(string)",
  "0x4e487b71": "Panic(uint256)",
};

const CAPACITY_DEFERRABLE_SELECTOR = "0x2b579c17";

export type RewardVaultRevertDisposition = "capacity_deferred" | "reconciliation_required";

export type RewardVaultRevertClassification = {
  disposition: RewardVaultRevertDisposition;
  errorName: string | null;
  selector: string | null;
  reason: string;
};

function normalizeSelector(revertData: string): string | null {
  if (!/^0x[0-9a-fA-F]*$/u.test(revertData) || revertData.length < 10) return null;
  return revertData.slice(0, 10).toLowerCase();
}

export function classifyRewardVaultRevert(
  revertData: string | null | undefined,
): RewardVaultRevertClassification {
  if (revertData === null || revertData === undefined || revertData === "" || revertData === "0x") {
    return {
      disposition: "reconciliation_required",
      errorName: null,
      selector: null,
      reason: "vault reverted without return data; cause unproven",
    };
  }

  const selector = normalizeSelector(revertData);
  if (!selector) {
    return {
      disposition: "reconciliation_required",
      errorName: null,
      selector: null,
      reason: "vault revert data was malformed or too short to identify",
    };
  }

  const errorName = VAULT_ERROR_SELECTORS[selector] ?? null;
  if (selector === CAPACITY_DEFERRABLE_SELECTOR) {
    return {
      disposition: "capacity_deferred",
      errorName,
      selector,
      reason: "vault epoch capacity exhausted; operation is unchanged and retryable next epoch",
    };
  }

  return {
    disposition: "reconciliation_required",
    errorName,
    selector,
    reason: errorName
      ? `vault reverted with ${errorName}; not a capacity condition`
      : "vault reverted with an unrecognized selector; cause unproven",
  };
}

export function isRewardVaultCapacityDeferral(revertData: string | null | undefined): boolean {
  return classifyRewardVaultRevert(revertData).disposition === "capacity_deferred";
}
