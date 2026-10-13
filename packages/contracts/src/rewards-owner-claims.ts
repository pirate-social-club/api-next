import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { ProviderUnavailable } from "./errors.ts";
import { guestBrowserErrorsV1, guestFinancialEndpoint } from "./guest-browser-authority.ts";
import {
  GuestAtomicAmountV1,
  GuestDrawingIdV1,
  GuestIdentifierV1,
  GuestInstantV1,
  GuestPositiveIntegerV1,
} from "./guest-participation.ts";
import { ClaimRewardCredit, RewardCreditClaimV1, RewardCreditV1 } from "./rewards-song-offers.ts";

const Selection = Schema.Struct({
  revision: GuestPositiveIntegerV1,
  persona_id: GuestIdentifierV1,
  selected_at: GuestInstantV1,
});
const AccountBinding = Schema.Struct({
  persona_id: GuestIdentifierV1,
  bound_at: GuestInstantV1,
  selection_revision: Schema.Null,
});
const GuestBinding = Schema.Struct({
  persona_id: GuestIdentifierV1,
  bound_at: GuestInstantV1,
  selection_revision: GuestPositiveIntegerV1,
});
export const OwnerCreditRecipientV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("account_owner"),
    original_persona_id: GuestIdentifierV1,
    selection: Schema.Null,
    binding: AccountBinding,
  }),
  Schema.Struct({
    kind: Schema.Literal("guest_owner"),
    selection: Schema.NullOr(Selection),
    binding: Schema.Null,
  }),
  Schema.Struct({
    kind: Schema.Literal("guest_owner"),
    selection: Selection,
    binding: GuestBinding,
  }),
]);
export type OwnerCreditRecipientV1 = Schema.Schema.Type<typeof OwnerCreditRecipientV1>;
/** Owner credit identity is distinct from the unchanged persona-required v1 reader. */
export const OwnerRewardCreditV1 = RewardCreditV1.mapFields(
  ({ payout_persona_id: _persona, ...fields }) => ({
    ...fields,
    object: Schema.Literal("owner_reward_credit_v1"),
    source_kind: Schema.Literal("megapot_allocation"),
    identity_version: Schema.Literal("owner_v1"),
    owner_id: GuestIdentifierV1,
    community_id: GuestIdentifierV1,
    pool_leg_id: GuestIdentifierV1,
    original_drawing_id: GuestDrawingIdV1,
    amount_atomic: GuestAtomicAmountV1.check(Schema.isPattern(/^[1-9][0-9]*$/u)),
    available_atomic: GuestAtomicAmountV1,
    reserved_atomic: GuestAtomicAmountV1,
    paid_atomic: GuestAtomicAmountV1,
    claim: RewardCreditClaimV1,
    recipient: OwnerCreditRecipientV1,
  }),
).check(
  Schema.makeFilter((credit) => {
    const recipient = credit.recipient;
    if (
      credit.claim.status !== "accepted" &&
      (credit.reserved_atomic !== "0" ||
        credit.paid_atomic !== "0" ||
        credit.send !== null ||
        credit.state === "payout_reserved" ||
        credit.state === "payout_pending" ||
        credit.state === "sent")
    )
      return "Every participant credit requires accepted claim authority before payment";
    if (
      recipient.kind === "account_owner" &&
      recipient.original_persona_id !== recipient.binding.persona_id
    )
      return "Account owner retains its allocation-created original persona";
    if (recipient.kind === "guest_owner") {
      if (recipient.binding === null) {
        if (
          credit.claim.status === "accepted" ||
          credit.reserved_atomic !== "0" ||
          credit.paid_atomic !== "0" ||
          credit.send !== null
        )
          return "Unbound guest credit cannot claim, reserve or send";
      } else if (
        recipient.selection.revision !== recipient.binding.selection_revision ||
        recipient.selection.persona_id !== recipient.binding.persona_id ||
        credit.claim.status !== "accepted"
      )
        return "Guest binding pins the accepted selection and claim";
    }
    if ((credit.claim.status === "accepted") !== (credit.claim.payout_status !== null))
      return "Only an accepted claim has payout status";
    if (
      BigInt(credit.available_atomic) +
        BigInt(credit.reserved_atomic) +
        BigInt(credit.paid_atomic) !==
      BigInt(credit.amount_atomic)
    )
      return "Credit balances preserve the single liability";
    return undefined;
  }),
);
export type OwnerRewardCreditV1 = Schema.Schema.Type<typeof OwnerRewardCreditV1>;
const path = Schema.Struct({ creditId: GuestIdentifierV1 });
export const SelectOwnerRewardCreditRecipientV1 = guestFinancialEndpoint({
  method: "POST",
  path: "/rewards/credits/:creditId/recipient-selections/v1",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    path,
    bodyEncoding: "json",
    maxBodyBytes: 4_096,
    body: Schema.Struct({ idempotency_key: GuestIdentifierV1, persona_id: GuestIdentifierV1 }),
  },
  response: Schema.Struct({ selection: Selection, credit: OwnerRewardCreditV1 }),
  errors: guestBrowserErrorsV1,
});
export const ClaimOwnerRewardCreditV1 = guestFinancialEndpoint({
  method: "POST",
  path: "/rewards/credits/:creditId/owner-claims/v1",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    path,
    bodyEncoding: "json",
    maxBodyBytes: 4_096,
    body: Schema.Struct({
      idempotency_key: GuestIdentifierV1,
      selection_revision: Schema.NullOr(GuestPositiveIntegerV1),
    }),
  },
  response: Schema.Struct({
    outcome: ClaimRewardCredit.response.fields.outcome,
    credit: OwnerRewardCreditV1,
  }),
  errors: [...guestBrowserErrorsV1, ProviderUnavailable],
});
