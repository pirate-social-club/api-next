import type { OwnerRewardCreditV1 } from "@pirate/contracts";
import type { Effect } from "effect";
import type { GuestParticipationStoreFailure } from "./guest-participation-authority.ts";
/** Account ID is sourced only from actual ordinary browser-session authentication.
 * No guest proof, setup session, caller account/owner field or invented session digest. */
export interface OwnerRewardCreditReadStore {
  readonly list: (
    input: Readonly<{ accountId: string; cursor: string | null; limit: number }>,
  ) => Effect.Effect<
    Readonly<{
      object: "owner_reward_credit_list_v1";
      items: readonly OwnerRewardCreditV1[];
      next_cursor: string | null;
    }>,
    GuestParticipationStoreFailure
  >;
  readonly get: (
    input: Readonly<{ accountId: string; creditId: string }>,
  ) => Effect.Effect<OwnerRewardCreditV1, GuestParticipationStoreFailure>;
}
