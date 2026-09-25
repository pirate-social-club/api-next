import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

/** Exact byte encodings from Spec 012 §5.3.13.3.1. */
const sha256Hex = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const signedMessagePrefix = new TextEncoder().encode("\x17Spaces Signed Message:\n");

export type SpacesOwnerChallengeInput = Readonly<{
  environment: string;
  canonicalRoot: string;
  communityId: string;
  ceremonyId: string;
  generation: number;
  nonceHex: string;
  rootOutpoint: string;
  rootKeyHex: string;
  expiresAt: string;
}>;

export function spacesOwnerChallengeMessageV1(input: SpacesOwnerChallengeInput): string {
  return JSON.stringify([
    "pirate-spaces-root-owner-v1",
    input.environment,
    "mainnet",
    input.canonicalRoot,
    input.communityId,
    input.ceremonyId,
    input.generation,
    input.nonceHex,
    input.rootOutpoint,
    input.rootKeyHex,
    input.expiresAt,
  ]);
}

/** The wallet hashes the prefix and message before BIP-340 signing. */
export function spacesOwnerChallengeDigestV1(message: string): string {
  const messageBytes = new TextEncoder().encode(message);
  const bytes = new Uint8Array(signedMessagePrefix.byteLength + messageBytes.byteLength);
  bytes.set(signedMessagePrefix);
  bytes.set(messageBytes, signedMessagePrefix.byteLength);
  return sha256Hex(bytes);
}

export function spacesOwnerStartRequestHashV1(
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
      "pirate-spaces-owner-start-v1",
      input.environment,
      input.accountId,
      input.communityId,
      "mainnet",
      input.canonicalRoot,
      input.idempotencyKey,
    ]),
  );
}

export function spacesOwnerPollRequestHashV1(
  input: Readonly<{
    ceremonyId: string;
    generation: number;
    idempotencyKey: string;
    signatureHex: string;
  }>,
): string {
  return sha256Hex(
    JSON.stringify([
      "pirate-spaces-owner-poll-v1",
      input.ceremonyId,
      input.generation,
      input.idempotencyKey,
      input.signatureHex,
    ]),
  );
}

/** Local BIP-340 check used only to distinguish a bad signature from a retry. */
export function spacesOwnerSignatureValidV1(
  challengeDigestHex: string,
  rootKeyHex: string,
  signatureHex: string,
): boolean {
  if (
    !/^[0-9a-f]{64}$/u.test(challengeDigestHex) ||
    !/^[0-9a-f]{64}$/u.test(rootKeyHex) ||
    !/^[0-9a-f]{128}$/u.test(signatureHex)
  ) {
    return false;
  }
  try {
    return schnorr.verify(
      Buffer.from(signatureHex, "hex"),
      Buffer.from(challengeDigestHex, "hex"),
      Buffer.from(rootKeyHex, "hex"),
    );
  } catch {
    return false;
  }
}
