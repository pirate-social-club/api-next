import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  AccountAgeCapabilityV1,
  GetMyAgeCapability,
  MinimumAgeAttestationV1,
  PutMyMinimumAgeAttestation,
} from "./age-access.ts";

describe("account age access contracts", () => {
  test("keeps capability and attestation private and provider-neutral", () => {
    expect(GetMyAgeCapability.path).toBe("/me/age-capability");
    expect(PutMyMinimumAgeAttestation.path).toBe("/me/minimum-age-attestation");
    expect(
      Schema.decodeUnknownSync(MinimumAgeAttestationV1)({
        version: "minimum-age-attestation-v1",
        minimum_age: 16,
        affirmed: true,
      }),
    ).toEqual({
      version: "minimum-age-attestation-v1",
      minimum_age: 16,
      affirmed: true,
    });
    expect(
      Schema.decodeUnknownSync(AccountAgeCapabilityV1)({
        content_rating: "general",
        policy_reference: null,
        provider_id: null,
        evidence_expires_at: null,
        next_action: {
          kind: "verify_minimum_age",
          href: "/verification/sessions",
          minimum_age: 18,
        },
      }),
    ).toMatchObject({ content_rating: "general" });
  });
});
