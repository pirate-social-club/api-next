import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type SpacesRouteOwnerMessageInput,
  spacesRouteOwnerMessageV1,
  spacesRouteProviderConfigurationDigestV1,
  spacesRouteRequirementHashV1,
} from "./spaces-community-route-codec.ts";
import {
  spacesOwnerChallengeDigestV1,
  spacesOwnerSignatureValidV1,
} from "./spaces-owner-proof-codec.ts";

/**
 * Frozen by docs/specs/api-next/012-spaces-community-route-owner-vectors.json
 * in the control plane. Synthetic values: scalar 1 is a public test key.
 */
const base: SpacesRouteOwnerMessageInput = {
  environment: "staging",
  actorId: "actor-fixture",
  communityId: "community-fixture",
  attachmentIntentId: "attachment-fixture",
  ceremonyIntentId: "ceremony-fixture",
  generation: 1,
  canonicalRoot: "harbor",
  rootOutpoint: `${"11".repeat(32)}:0`,
  ownerPublicKeyHex: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  publicOrigin: "https://web-next-staging.pirate.sc",
  providerConfigurationDigest: "33".repeat(32),
  requirementHash: "44".repeat(32),
  nonceHex: "55".repeat(32),
  expiresAt: "2030-01-01T00:15:00.000Z",
};
const baseSignature =
  "b4d1f0356ba8ecc486747e2eee72212c23cf03c94d8a1633ecd02ab38a55245fcc7d6a5468fd0372174d585162bbc145cfec6596bc4b84259be50f3a7a99a068";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("Spaces community route owner message", () => {
  test("matches the frozen base vector byte for byte", () => {
    const message = spacesRouteOwnerMessageV1(base);
    expect(JSON.parse(message)).toHaveLength(18);
    expect(sha256(message)).toBe(
      "40419d28389cdfbc7ab3c5da96c5dd4802aee80fb070457e97c98c952dba8cbe",
    );
    const digest = spacesOwnerChallengeDigestV1(message);
    expect(digest).toBe("1ddab6af6ee79c0ed9d848d8b67cdb3248fd295499d59835b45a75e28e2e6006");
    expect(spacesOwnerSignatureValidV1(digest, base.ownerPublicKeyHex, baseSignature)).toBe(true);
  });

  test("the base signature authorizes no other community, root, generation or expiry", () => {
    const changed: readonly (readonly [Partial<SpacesRouteOwnerMessageInput>, string])[] = [
      [
        { communityId: "community-other" },
        "b3e765467039790adc3a1adda773ef3a4fdbff6302c729d4a78ade538945fb41",
      ],
      [{ generation: 2 }, "f4a7b844d95fb2904288527fc45a6dc55f317ec6d799e33a68acd78683dd4f65"],
      [
        { expiresAt: "2030-01-01T00:16:00.000Z" },
        "f8e55d395b6dea3b49a288d0591485b2a7e1c18afe91118c78550744c7cbb2d5",
      ],
    ];
    const digests = new Set<string>();
    for (const [change, expected] of changed) {
      const digest = spacesOwnerChallengeDigestV1(
        spacesRouteOwnerMessageV1({ ...base, ...change }),
      );
      expect(digest).toBe(expected);
      digests.add(digest);
    }
    // The root and its href always change together here, which the builder
    // enforces; the origin moves the href alone.
    for (const change of [{ canonicalRoot: "other" }, { publicOrigin: "https://other.example" }]) {
      digests.add(spacesOwnerChallengeDigestV1(spacesRouteOwnerMessageV1({ ...base, ...change })));
    }
    expect(digests.size).toBe(5);
    for (const digest of digests) {
      expect(spacesOwnerSignatureValidV1(digest, base.ownerPublicKeyHex, baseSignature)).toBe(
        false,
      );
    }
  });

  test("provider configuration and requirement bind the origin and community", () => {
    const configuration = spacesRouteProviderConfigurationDigestV1({
      environment: "staging",
      publicOrigin: base.publicOrigin,
    });
    expect(configuration).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      spacesRouteProviderConfigurationDigestV1({
        environment: "staging",
        publicOrigin: "https://other.example",
      }),
    ).not.toBe(configuration);
    const requirement = {
      environment: "staging",
      communityId: base.communityId,
      canonicalRoot: base.canonicalRoot,
      publicOrigin: base.publicOrigin,
      purpose: { kind: "first_attachment" },
    } as const;
    const revalidation = (expectedBindingGeneration: number) =>
      spacesRouteRequirementHashV1({
        ...requirement,
        purpose: { kind: "revalidation", routeBindingId: "binding", expectedBindingGeneration },
      });
    expect(
      new Set([
        spacesRouteRequirementHashV1(requirement),
        spacesRouteRequirementHashV1({ ...requirement, communityId: "community-other" }),
        revalidation(1),
        revalidation(2),
      ]).size,
    ).toBe(4);
  });
});
