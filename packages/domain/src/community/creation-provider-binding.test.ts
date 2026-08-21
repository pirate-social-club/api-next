import { describe, expect, test } from "bun:test";
import {
  communityCreationCeremonyReservationHash,
  communityCreationProviderBindingHash,
  communityCreationProviderBindingPreimage,
} from "./creation-provider-binding.ts";

const human = {
  requirement: "human_identity" as const,
  family: null,
  provider_id: "very.oauth",
  provider_configuration: { kind: "dynamic" as const, reference: "very-oauth", version: "1" },
  protocol_version: "oauth2-oidc-v1",
};

describe("community creation provider binding", () => {
  test("pins the internal authority preimage and digest", () => {
    expect(communityCreationProviderBindingPreimage(human)).toBe(
      '{"family":null,"protocol_version":"oauth2-oidc-v1","provider_configuration":{"kind":"dynamic","reference":"very-oauth","version":"1"},"provider_id":"very.oauth","requirement":"human_identity","version":"community-creation-provider-binding-v1"}',
    );
    expect(communityCreationProviderBindingHash(human)).toBe(
      "daa071f59b3a2026cd6d939440788aa149e65c86ee58930af68f8d450b7ef00f",
    );
  });

  test("keeps family and requirement kind inside the namespace fingerprint", () => {
    const hns = {
      requirement: "namespace_ownership" as const,
      family: "hns" as const,
      provider_id: "hns.owner.v1",
      provider_configuration: {
        kind: "managed" as const,
        reference: "hns-owner-staging",
        version: "hns-owner-config-v1",
      },
      protocol_version: "hns-txt-v1",
    };
    expect(communityCreationProviderBindingHash(hns)).not.toBe(
      communityCreationProviderBindingHash({ ...hns, family: "spaces" }),
    );
  });

  test("rejects cross-requirement and malformed bindings", () => {
    expect(() => communityCreationProviderBindingHash({ ...human, family: "hns" })).toThrow();
    expect(() =>
      communityCreationProviderBindingHash({ ...human, provider_id: " very.oauth" }),
    ).toThrow();
  });

  test("binds ceremony reservations to the parent, generation, provider, and route", () => {
    const reservation = {
      actor_id: "user-1",
      creation_intent_id: "intent-1",
      ceremony_intent_id: "ceremony-1",
      requirement: "namespace_ownership" as const,
      generation: 1,
      requirement_hash: "1".repeat(64),
      provider_id: "hns.owner.v1",
      provider_binding_hash: "2".repeat(64),
      route: {
        family: "hns" as const,
        root_label: "jazleeuw",
        root_label_display: "jazleeuw",
        path_segment: "app.jazleeuw",
      },
    };
    const digest = communityCreationCeremonyReservationHash(reservation);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(communityCreationCeremonyReservationHash({ ...reservation, generation: 2 })).not.toBe(
      digest,
    );
    expect(() =>
      communityCreationCeremonyReservationHash({
        ...reservation,
        requirement: "human_identity",
      }),
    ).toThrow();
  });
});
