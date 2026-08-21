import { describe, expect, test } from "bun:test";
import {
  communityCreationCeremonyReservationHash,
  communityCreationProviderBindingHash,
  communityCreationProviderBindingPreimage,
} from "./creation-provider-binding.ts";

const human = {
  requirement: "human_identity" as const,
  family: null,
  provider_id: "very.web",
  provider_configuration: { kind: "dynamic" as const, reference: "very-web", version: "1" },
  protocol_version: "very-web-v1",
};

describe("community creation provider binding", () => {
  test("pins the internal authority preimage and digest", () => {
    expect(communityCreationProviderBindingPreimage(human)).toBe(
      '{"family":null,"protocol_version":"very-web-v1","provider_configuration":{"kind":"dynamic","reference":"very-web","version":"1"},"provider_id":"very.web","requirement":"human_identity","version":"community-creation-provider-binding-v1"}',
    );
    expect(communityCreationProviderBindingHash(human)).toBe(
      "2283c494869080e599ad8063831fc7dda3f5e094a53fb3356f333f9e9ca140e8",
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
      communityCreationProviderBindingHash({ ...human, provider_id: " very.web" }),
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
