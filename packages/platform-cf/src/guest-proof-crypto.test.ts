import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GuestAttachmentIntentIdV1, GuestBadRequest, GuestCredentialIdV1 } from "@pirate/contracts";
import { Schema } from "effect";
import {
  digestGuestProof,
  GuestProofMaterial,
  newGuestAttachmentIntentId,
  newGuestCredentialId,
} from "./guest-proof-crypto.ts";

test("guest proof hashes all 32 bytes using SHA-256 independently of its locator", async () => {
  for (const bytes of [
    Buffer.alloc(32),
    Buffer.alloc(32, 255),
    Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
  ]) {
    expect(await digestGuestProof(bytes.toString("base64url"))).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
});

test("noncanonical, padded, short and oversized proofs fail without retaining input", async () => {
  for (const value of [
    "",
    "A".repeat(42),
    "A".repeat(44),
    `${"A".repeat(42)}B`,
    `${"A".repeat(43)}=`,
    "secret\nvalue",
  ]) {
    const result = await digestGuestProof(value).then(
      () => null,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(GuestBadRequest);
    if (value) expect(JSON.stringify(result)).not.toContain(value);
    expect((result as GuestBadRequest).details.reason_code).toBe("guest_cookie_invalid");
  }
});

test("fresh independent proof and locator draws match frozen cookie schemas and redact JSON", async () => {
  const credentials = new Set<string>();
  const proofs = new Set<string>();
  for (let i = 0; i < 8; i += 1) {
    const credentialId = newGuestCredentialId();
    const intentId = newGuestAttachmentIntentId();
    expect(Schema.is(GuestCredentialIdV1)(credentialId)).toBe(true);
    expect(Schema.is(GuestAttachmentIntentIdV1)(intentId)).toBe(true);
    const material = await GuestProofMaterial.issue();
    const value = material.valueForCookie();
    expect(value).toHaveLength(43);
    expect(material.digestForStore()).toBe(await digestGuestProof(value));
    expect(value).not.toContain(credentialId);
    expect(JSON.stringify(material)).toBe('"[redacted guest proof]"');
    expect(Object.keys(material)).toEqual([]);
    credentials.add(credentialId);
    proofs.add(value);
  }
  expect(credentials.size).toBe(8);
  expect(proofs.size).toBe(8);
});
