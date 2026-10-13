import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { guestFinancialEndpoint, guestInterfaceEndpoint } from "./guest-browser-authority.ts";
import { registry } from "./registry.ts";
const admitted = [
  "PrepareGuestAttachmentTargetV1", "ConfirmGuestAttachmentTargetV1", "GetMySuccessfulGuestAttachmentV1",
  "SelectOwnerRewardCreditRecipientV1", "ClaimOwnerRewardCreditV1",
  "ListMyOwnerParticipationsV1", "GetMyOwnerParticipationV1",
  "ListMyOwnerRewardCreditsV1", "GetMyOwnerRewardCreditV1",
] as const;
test("exact nine financial declarations are source-admitted/private without minting runtime authority", () => {
  expect(admitted).toHaveLength(9);
  for (const name of admitted) {
    expect(registry[name].implementation).toBeUndefined();
    expect(registry[name].cacheControl).toBe("private, no-store");
  }
});
test("historical disabled constructor stays closed; source financial helper rejects disabled override", () => {
  const base = { method: "GET", path: "/source-test", auth: Auth.public(), response: Schema.Null } as const;
  expect(guestInterfaceEndpoint(base).implementation).toBe("disabled");
  expect(() => guestFinancialEndpoint({ ...base, implementation: "disabled" })).toThrow("must not override");
  expect(guestFinancialEndpoint(base).implementation).toBeUndefined();
});
