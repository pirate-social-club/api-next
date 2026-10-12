import { GuestBadRequest } from "@pirate/contracts";
import { Schema } from "effect";

const Secret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u));
const decodeSecret = Schema.decodeUnknownSync(Secret);

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** SHA-256 of the canonical secret's 32 decoded bytes, never its public locator. */
export async function digestGuestProof(secret: string): Promise<string> {
  let canonical: string;
  try {
    canonical = decodeSecret(secret);
  } catch {
    throw new GuestBadRequest({
      message: "Invalid guest proof",
      details: { reason_code: "guest_cookie_invalid" },
    });
  }
  const binary = atob(`${canonical.replaceAll("-", "+").replaceAll("_", "/")}=`);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Transport-owned issuance. Raw proof and digest cannot enter JSON or object inspection. */
export class GuestProofMaterial {
  readonly #secret: string;
  readonly #digest: string;
  private constructor(secret: string, digest: string) {
    this.#secret = secret;
    this.#digest = digest;
  }

  static async issue(): Promise<GuestProofMaterial> {
    const secret = encode(crypto.getRandomValues(new Uint8Array(32)));
    return new GuestProofMaterial(secret, await digestGuestProof(secret));
  }

  /** Pass only to the verifier/store boundary, never a request or response projection. */
  digestForStore(): string {
    return this.#digest;
  }

  /** Pass only to an HttpOnly cookie writer. No reissuance from IDs or digests exists. */
  valueForCookie(): string {
    return this.#secret;
  }

  toJSON(): string {
    return "[redacted guest proof]";
  }
}

/** Each locator draw is independent of the 32-byte proof/nonce draw. */
export function newGuestCredentialId(): string {
  return encode(crypto.getRandomValues(new Uint8Array(16)));
}

export function newGuestAttachmentIntentId(): string {
  return `gai_${newGuestCredentialId()}`;
}
