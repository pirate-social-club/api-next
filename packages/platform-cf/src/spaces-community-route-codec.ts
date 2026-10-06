import { createHash } from "node:crypto";

/**
 * Exact encodings for attaching an owned Spaces root as a community address.
 * The owner message is a route-only domain, separate from the sale-authority
 * domain `pirate-spaces-root-owner-v1`, so neither signature can stand in for
 * the other. Field order is frozen by the Spec 012 owner-message vectors.
 */
const sha256Hex = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const SPACES_ROUTE_PROVIDER_ID = "spaces.root-route.v1";
export const SPACES_ROUTE_VERIFIER_CONTRACT = "spaces-verifier-root-route-v1";

/** A challenge must be signed and committed within this window. */
export const SPACES_ROUTE_CHALLENGE_SECONDS = 900;
/** Route evidence resolves for this long after its ownership observation. */
export const SPACES_ROUTE_EVIDENCE_LEASE_SECONDS = 21_600;
/** A live binding is re-observed once its evidence is this old. */
export const SPACES_ROUTE_RENEW_AFTER_SECONDS = 3_600;

export type SpacesRouteOwnerMessageInput = Readonly<{
  environment: string;
  actorId: string;
  communityId: string;
  attachmentIntentId: string;
  ceremonyIntentId: string;
  generation: number;
  canonicalRoot: string;
  rootOutpoint: string;
  ownerPublicKeyHex: string;
  publicOrigin: string;
  providerConfigurationDigest: string;
  requirementHash: string;
  nonceHex: string;
  expiresAt: string;
}>;

export const spacesRouteCanonicalHrefV1 = (publicOrigin: string, canonicalRoot: string): string =>
  `${publicOrigin}/c/@${canonicalRoot}`;

export function spacesRouteOwnerMessageV1(input: SpacesRouteOwnerMessageInput): string {
  return JSON.stringify([
    "pirate-spaces-community-route-owner-v1",
    input.environment,
    "mainnet",
    input.actorId,
    input.communityId,
    input.attachmentIntentId,
    input.ceremonyIntentId,
    input.generation,
    `@${input.canonicalRoot}`,
    input.rootOutpoint,
    input.ownerPublicKeyHex,
    input.publicOrigin,
    spacesRouteCanonicalHrefV1(input.publicOrigin, input.canonicalRoot),
    SPACES_ROUTE_PROVIDER_ID,
    input.providerConfigurationDigest,
    input.requirementHash,
    input.nonceHex,
    input.expiresAt,
  ]);
}

/** Changing the origin or any lease bound yields a different configuration. */
export function spacesRouteProviderConfigurationDigestV1(
  input: Readonly<{ environment: string; publicOrigin: string }>,
): string {
  return sha256Hex(
    JSON.stringify([
      "pirate-spaces-community-route-provider-v1",
      SPACES_ROUTE_PROVIDER_ID,
      SPACES_ROUTE_VERIFIER_CONTRACT,
      input.environment,
      "mainnet",
      input.publicOrigin,
      SPACES_ROUTE_CHALLENGE_SECONDS,
      SPACES_ROUTE_EVIDENCE_LEASE_SECONDS,
    ]),
  );
}

export type SpacesRoutePurpose =
  | Readonly<{ kind: "first_attachment" }>
  | Readonly<{ kind: "revalidation"; routeBindingId: string; expectedBindingGeneration: number }>;

/**
 * The immutable requirement. A first attachment and a revalidation of one
 * binding generation hash differently, so a signature for one never serves
 * the other, nor a later generation of the same binding.
 */
export function spacesRouteRequirementHashV1(
  input: Readonly<{
    environment: string;
    communityId: string;
    canonicalRoot: string;
    publicOrigin: string;
    purpose: SpacesRoutePurpose;
  }>,
): string {
  return sha256Hex(
    JSON.stringify([
      "pirate-spaces-community-route-requirement-v1",
      input.environment,
      "mainnet",
      input.communityId,
      `@${input.canonicalRoot}`,
      spacesRouteCanonicalHrefV1(input.publicOrigin, input.canonicalRoot),
      "manage_routes",
      ...(input.purpose.kind === "first_attachment"
        ? ["first_canonical_route"]
        : [
            "revalidate_canonical_route",
            input.purpose.routeBindingId,
            input.purpose.expectedBindingGeneration,
          ]),
    ]),
  );
}

/** One owner identity per root, outpoint and key; renewal requires it unchanged. */
export function spacesRouteOwnerIdentityDigestV1(
  input: Readonly<{ canonicalRoot: string; rootOutpoint: string; ownerPublicKeyHex: string }>,
): string {
  return sha256Hex(
    JSON.stringify([
      "pirate-spaces-root-owner-identity-v1",
      "mainnet",
      `@${input.canonicalRoot}`,
      input.rootOutpoint,
      input.ownerPublicKeyHex,
    ]),
  );
}

export function spacesRouteStartRequestHashV1(
  input: Readonly<{
    environment: string;
    accountId: string;
    communityId: string;
    canonicalRoot: string;
    idempotencyKey: string;
  }>,
): string {
  return sha256Hex(
    JSON.stringify([
      "pirate-spaces-community-route-start-v1",
      input.environment,
      input.accountId,
      input.communityId,
      "mainnet",
      input.canonicalRoot,
      input.idempotencyKey,
    ]),
  );
}

export function spacesRouteEvidenceDigestV1(
  input: Readonly<{
    kind: "attachment" | "renewal";
    reference: string;
    bindingGeneration: number;
    ownerIdentityDigest: string;
    observationSha256Hex: string;
    challengeDigestHex: string | null;
    signatureHex: string | null;
    verifiedAt: string;
    expiresAt: string;
  }>,
): string {
  return sha256Hex(
    JSON.stringify([
      "pirate-spaces-community-route-evidence-v1",
      input.kind,
      input.reference,
      input.bindingGeneration,
      input.ownerIdentityDigest,
      input.observationSha256Hex,
      input.challengeDigestHex,
      input.signatureHex,
      input.verifiedAt,
      input.expiresAt,
    ]),
  );
}
