import { expect, test } from "bun:test";
import { Schema } from "effect";
import { AgeLockedResourceV1, GetMyAgeCapability } from "./age-access.ts";
import { AccountAgeVerificationV1, GetMyAgeVerification } from "./age-verification.ts";

test("renewable age authority has a private endpoint without changing the content-free lock or capability wire", () => {
  expect(GetMyAgeVerification.path).toBe("/me/age-verification");
  expect(GetMyAgeCapability.path).toBe("/me/age-capability");
  const decode = Schema.decodeUnknownSync(AccountAgeVerificationV1, { onExcessProperty: "error" });
  const required = {
    version: "account-age-verification-v1",
    minimum_age: 18,
    status: "verification_required",
    requirement_hash: "a".repeat(64),
    ceremony_intent_id: "age18-ceremony",
    generation: 1,
    provider_id: "zkpassport",
    accepted_provider_ids: ["self.pass", "zkpassport"],
  } as const;
  expect(decode(required)).toEqual(required);
  expect(() => decode({ ...required, generation: 0 })).toThrow();
  expect(() => decode({ ...required, accepted_provider_ids: ["zkpassport"] })).toThrow();
  expect(() => decode({ ...required, date_of_birth: "private" })).toThrow();
  expect(Object.keys(AgeLockedResourceV1.fields)).toEqual([
    "kind",
    "content_rating",
    "next_action",
  ]);
});
