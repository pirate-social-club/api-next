import { canonicalJson } from "../canonical-json.ts";
import { sha256Hex } from "../gates-v2/sha256.ts";

/**
 * Spec 015 §5.2a: an account-scoped action intent that lets a reward winner
 * start the Very ceremony a participant claim requires. No community is
 * involved; the intent's scope is the account itself.
 */
export const REWARD_CLAIM_ACTION_KIND = "reward_claim" as const;

export function rewardClaimActionPayloadHash(accountId: string): string {
  return sha256Hex(
    canonicalJson({ action_kind: REWARD_CLAIM_ACTION_KIND, account_id: accountId, version: 1 }),
  );
}

export function rewardClaimIntentBindingHash(accountId: string): string {
  return sha256Hex(
    canonicalJson({
      action_kind: REWARD_CLAIM_ACTION_KIND,
      actor_id: accountId,
      binding: "reward_claim_very_v1",
    }),
  );
}
