import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { AuthError, BadRequest, InternalError, NotFound, ProviderUnavailable } from "./errors.ts";
import { guestFinancialEndpoint } from "./guest-browser-authority.ts";
import { GuestIdentifierV1 } from "./guest-participation.ts";
import { OwnerRewardCreditV1 } from "./rewards-owner-claims.ts";
/** Additive coordinator interface proposal for genuine119. Existing118/legacy
 * persona-required RewardCreditV1 routes remain byte-exact. Managed financial runtime remains separately gated. */
export const ListMyOwnerRewardCreditsV1 = guestFinancialEndpoint({
  method: "GET",
  path: "/users/me/rewards/owner-credits/v1",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    query: Schema.Struct({
      cursor: Schema.optional(GuestIdentifierV1),
      limit: Schema.optional(Schema.String.check(Schema.isPattern(/^(?:[1-9]|[1-9][0-9]|100)$/u))),
    }),
  },
  response: Schema.Struct({
    object: Schema.Literal("owner_reward_credit_list_v1"),
    items: Schema.Array(OwnerRewardCreditV1).check(Schema.isMaxLength(100)),
    next_cursor: Schema.NullOr(GuestIdentifierV1),
  }),
  errors: [AuthError, BadRequest, NotFound, InternalError, ProviderUnavailable],
});
export const GetMyOwnerRewardCreditV1 = guestFinancialEndpoint({
  method: "GET",
  path: "/users/me/rewards/owner-credits/v1/:creditId",
  auth: Auth.user({ browserSessionOnly: true }),
  request: { path: Schema.Struct({ creditId: GuestIdentifierV1 }) },
  response: OwnerRewardCreditV1,
  errors: [AuthError, BadRequest, NotFound, InternalError, ProviderUnavailable],
});
