import type { GuestCookieEffect } from "@pirate/application/guest-participation-authority";
import { GuestAttachmentIntentIdV1, GuestBadRequest, GuestCredentialIdV1 } from "@pirate/contracts";
import { GuestProofMaterial } from "@pirate/platform-cf/guest-proof-crypto";
import { Schema } from "effect";

const Secret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u));
const decodeSecret = Schema.decodeUnknownSync(Secret);
const decodeCredential = Schema.decodeUnknownSync(GuestCredentialIdV1);
const decodeIntent = Schema.decodeUnknownSync(GuestAttachmentIntentIdV1);
const invalid = () =>
  new GuestBadRequest({
    message: "Invalid guest cookie effect",
    details: { reason_code: "guest_cookie_invalid" },
  });
type IssuedProof = Readonly<{
  kind: "credential" | "intent";
  id: string;
  material: GuestProofMaterial;
}>;
type CarriedProof = Readonly<{ credentialId: string; secret: string }>;

function cookieName(effect: GuestCookieEffect): string {
  return effect.kind === "credential"
    ? `__Host-pirate_guest_${decodeCredential(effect.credentialId)}`
    : `__Host-pirate_guest_attach_${decodeIntent(effect.intentId).slice(4)}`;
}

/** Apply accepted store effects only. Unknown COMMIT never authorizes issuing a cookie.
 * Issuance uses new transport-owned material; refresh uses the carried proved value.
 * There is deliberately no reconstruction from a locator, digest or operation key.
 */
export function writeGuestResponseCookies(
  input: Readonly<{
    headers: Headers;
    effects: readonly GuestCookieEffect[];
    issuedProofs: readonly IssuedProof[];
    carriedCredentials: readonly CarriedProof[];
  }>,
): Headers {
  const result = new Headers(input.headers);
  result.set("cache-control", "private, no-store");
  const cookies: string[] = [];
  const seen = new Set<string>();
  const issuedValues = new Set<string>();
  try {
    if (input.effects.length > 32) throw invalid();
    for (const effect of input.effects) {
      const name = cookieName(effect);
      if (seen.has(name)) throw invalid();
      seen.add(name);
      let value = "";
      let age = 0;
      if (effect.action !== "expire") {
        const id = effect.kind === "credential" ? effect.credentialId : effect.intentId;
        if (effect.action === "issue") {
          const proofs = input.issuedProofs.filter(
            (proof) => proof.kind === effect.kind && proof.id === id,
          );
          if (proofs.length !== 1 || !(proofs[0]?.material instanceof GuestProofMaterial))
            throw invalid();
          value = decodeSecret(proofs[0].material.valueForCookie());
          if (issuedValues.has(value)) throw invalid();
          issuedValues.add(value);
        } else {
          const proofs = input.carriedCredentials.filter((proof) => proof.credentialId === id);
          if (proofs.length !== 1 || proofs[0] === undefined) throw invalid();
          value = decodeSecret(proofs[0].secret);
        }
        age = effect.kind === "credential" ? 34_560_000 : 900;
      }
      cookies.push(
        `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}${age === 0 ? "; Expires=Thu, 01 Jan 1970 00:00:00 GMT" : ""}`,
      );
    }
  } catch {
    throw invalid();
  }
  for (const cookie of cookies) result.append("set-cookie", cookie);
  return result;
}

/** A separate readable CSRF cookie supplies no ownership or learning authority. */
export async function ensureGuestCsrfCookie(
  headers: Headers,
  carriedCsrf: string | null,
): Promise<Headers> {
  const result = new Headers(headers);
  result.set("cache-control", "private, no-store");
  if (carriedCsrf !== null) {
    try {
      decodeSecret(carriedCsrf);
    } catch {
      throw invalid();
    }
    return result;
  }
  const material = await GuestProofMaterial.issue();
  result.append(
    "set-cookie",
    `__Host-pirate_guest_csrf=${material.valueForCookie()}; Path=/; Secure; SameSite=Lax; Max-Age=34560000`,
  );
  return result;
}
