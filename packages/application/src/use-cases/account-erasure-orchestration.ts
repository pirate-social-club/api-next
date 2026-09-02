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
