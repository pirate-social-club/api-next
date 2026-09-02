export const ACCOUNT_ERASURE_POLICY_REVISION = "account_erasure_policy_v1@1" as const;

/**
 * Ordering is policy, not an implementation convenience. A later phase may
 * rely only on terminal dispositions from every earlier phase.
 */
export const ACCOUNT_ERASURE_OWNERS = [
  "account_private",
  "social_private",
  "unpublished_content",
  "study_private",
  "learner_audio",
  "karaoke_private",
  "dance_private",
  "verification_raw",
  "durable_objects",
  "retained_evidence",
  "custody_final",
  "credential_tombstone",
  "privy",
  "external_providers",
  "platform_logs",
] as const;

export type AccountErasureOwner = (typeof ACCOUNT_ERASURE_OWNERS)[number];

export type AccountErasureTerminalDisposition = "deleted" | "retained_by_policy" | "expired";

export type AccountErasurePausedStatus =
  | "action_required"
  | "authority_required"
  | "pending_expiry"
  | "failed";

export type AccountErasureRequestStatus = "running" | AccountErasurePausedStatus | "completed";

export type AccountErasureClaimResult =
  | Readonly<{ outcome: "claimed" }>
  | Readonly<{ outcome: "terminal"; status: Exclude<AccountErasureRequestStatus, "running"> }>;

export type AccountErasureOwnerResult =
  | Readonly<{
      outcome: "draining";
      deletedCount: number;
      remainingCount: number;
    }>
  | Readonly<{
      outcome: "terminal";
      disposition: AccountErasureTerminalDisposition;
    }>
  | Readonly<{
      outcome: "paused";
      status: AccountErasurePausedStatus;
    }>;

export type AccountErasureWorkflowResult = Readonly<{
  erasureRequestId: string;
  status: Exclude<AccountErasureRequestStatus, "running">;
}>;

export const ACCOUNT_ERASURE_ADMISSION_OWNERS = [
  "community_ownership",
  "hns_authority",
  "operator_principal",
  "persona_wallet_custody",
  "financial_effects",
  "required_authorities",
] as const;

export type AccountErasureAdmissionOwner = (typeof ACCOUNT_ERASURE_ADMISSION_OWNERS)[number];

export type AccountErasureAdmissionCheck = "clear" | "blocked" | "unknown";

/**
 * A complete snapshot is required even when an earlier owner already blocks
 * admission. This lets the command return every bounded next action without
 * weakening fail-closed treatment of an unavailable owner.
 */
export type AccountErasureAdmissionSnapshot = Readonly<
  Record<AccountErasureAdmissionOwner, AccountErasureAdmissionCheck>
>;

export const ACCOUNT_ERASURE_ADMISSION_CONFLICTS = [
  "community_owner_transfer_required",
  "hns_authority_transfer_required",
  "operator_policy_required",
  "custody_not_empty",
  "financial_effect_pending",
  "custody_status_unknown",
] as const;

export type AccountErasureAdmissionConflictCategory =
  (typeof ACCOUNT_ERASURE_ADMISSION_CONFLICTS)[number];

export type AccountErasureAdmissionConflict = Readonly<{
  category: AccountErasureAdmissionConflictCategory;
  owners: readonly AccountErasureAdmissionOwner[];
}>;

export type AccountErasureAdmissionDecision =
  | Readonly<{ outcome: "admitted" }>
  | Readonly<{
      outcome: "conflict";
      conflicts: readonly AccountErasureAdmissionConflict[];
    }>;

const blockedConflictByOwner: Readonly<
  Record<
    Exclude<AccountErasureAdmissionOwner, "required_authorities">,
    AccountErasureAdmissionConflictCategory
  >
> = {
  community_ownership: "community_owner_transfer_required",
  hns_authority: "hns_authority_transfer_required",
  operator_principal: "operator_policy_required",
  persona_wallet_custody: "custody_not_empty",
  financial_effects: "financial_effect_pending",
};

/**
 * Converts an already-collected, complete admission snapshot into the stable
 * public conflict taxonomy from account_erasure_policy_v1@1. Unknown checks
 * are combined without hiding which bounded owner needs attention.
 */
export const evaluateAccountErasureAdmission = (
  snapshot: AccountErasureAdmissionSnapshot,
): AccountErasureAdmissionDecision => {
  const conflicts = new Map<
    AccountErasureAdmissionConflictCategory,
    AccountErasureAdmissionOwner[]
  >();
  const addConflict = (
    category: AccountErasureAdmissionConflictCategory,
    owner: AccountErasureAdmissionOwner,
  ): void => {
    const owners = conflicts.get(category);
    if (owners === undefined) conflicts.set(category, [owner]);
    else owners.push(owner);
  };

  for (const owner of ACCOUNT_ERASURE_ADMISSION_OWNERS) {
    const check = snapshot[owner];
    if (check === "clear") continue;
    if (check !== "blocked" || owner === "required_authorities") {
      addConflict("custody_status_unknown", owner);
      continue;
    }
    addConflict(blockedConflictByOwner[owner], owner);
  }

  if (conflicts.size === 0) return { outcome: "admitted" };

  return {
    outcome: "conflict",
    conflicts: ACCOUNT_ERASURE_ADMISSION_CONFLICTS.flatMap((category) => {
      const owners = conflicts.get(category);
      return owners === undefined ? [] : [{ category, owners }];
    }),
  };
};

export interface AccountErasureWorkflowStore {
  readonly claim: (erasureRequestId: string) => Promise<AccountErasureClaimResult>;
  /**
   * A final nonempty batch is persisted and returned as terminal. `draining`
   * means both that this call made progress and that more work still exists.
   */
  readonly drainOwner: (input: {
    readonly erasureRequestId: string;
    readonly owner: AccountErasureOwner;
  }) => Promise<AccountErasureOwnerResult>;
  readonly complete: (erasureRequestId: string) => Promise<AccountErasureWorkflowResult>;
}

export const assertAccountErasureProgress = (
  result: Extract<AccountErasureOwnerResult, { readonly outcome: "draining" }>,
): void => {
  if (
    !Number.isSafeInteger(result.deletedCount) ||
    result.deletedCount <= 0 ||
    !Number.isSafeInteger(result.remainingCount) ||
    result.remainingCount <= 0
  ) {
    throw new Error("Account erasure owner reported non-progress");
  }
};
