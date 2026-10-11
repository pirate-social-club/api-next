import type {
  BrowserParticipationContext,
  OrdinaryBrowserAccount,
  SetupBrowserAccount,
} from "@pirate/application/guest-participation-authority";
import {
  type BrowserParticipationPolicy,
  GuestAttachmentIntentIdV1,
  GuestBadRequest,
  GuestBrowserLimitsV1,
  GuestConflict,
  GuestCredentialIdV1,
} from "@pirate/contracts";
import { Schema } from "effect";

const CredentialCookieName = Schema.String.check(
  Schema.isPattern(/^__Host-pirate_guest_[A-Za-z0-9_-]{21}[AQgw]$/u),
);
const IntentCookieName = Schema.String.check(
  Schema.isPattern(/^__Host-pirate_guest_attach_[A-Za-z0-9_-]{21}[AQgw]$/u),
);
const isCredentialCookieName: (value: unknown) => boolean = Schema.is(CredentialCookieName);
const isIntentCookieName: (value: unknown) => boolean = Schema.is(IntentCookieName);
const Secret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u));
const GUEST_CSRF_COOKIE_NAME = "__Host-pirate_guest_csrf";
const invalidCookie = () =>
  new GuestBadRequest({
    message: "Invalid guest cookie",
    details: { reason_code: "guest_cookie_invalid" },
  });

/** Transport-only material. Never attach these values to DecodedRequest or JSON. */
export function parseGuestBrowserCookies(headers: Headers, cleanup: boolean) {
  const raw = headers.get("cookie") ?? "";
  if (new TextEncoder().encode(raw).byteLength > GuestBrowserLimitsV1.cookieHeaderBytes) {
    throw new GuestBadRequest({
      message: "Guest cookie header exceeds its bound",
      details: { reason_code: "guest_cookie_limit_exceeded" },
    });
  }
  const credentials: { readonly credentialId: string; readonly secret: string }[] = [];
  const intents: { readonly intentId: string; readonly secret: string }[] = [];
  const seen = new Set<string>();
  let csrf: string | null = null;
  for (const entry of raw.split(";")) {
    const separator = entry.indexOf("=");
    const name = (separator < 0 ? entry : entry.slice(0, separator)).trim();
    if (!name.startsWith("__Host-pirate_guest_")) continue;
    if (separator < 0 || seen.has(name)) throw invalidCookie();
    seen.add(name);
    const value = entry.slice(separator + 1).trim();
    try {
      const secret = Schema.decodeUnknownSync(Secret)(value);
      if (name === GUEST_CSRF_COOKIE_NAME) {
        csrf = secret;
        continue;
      }
      if (isIntentCookieName(name)) {
        const intentId = Schema.decodeUnknownSync(GuestAttachmentIntentIdV1)(
          `gai_${name.slice("__Host-pirate_guest_attach_".length)}`,
        );
        intents.push({ intentId, secret });
      } else if (isCredentialCookieName(name)) {
        const credentialId = Schema.decodeUnknownSync(GuestCredentialIdV1)(
          name.slice("__Host-pirate_guest_".length),
        );
        credentials.push({ credentialId, secret });
      } else throw invalidCookie();
    } catch {
      throw invalidCookie();
    }
    if (
      credentials.length > GuestBrowserLimitsV1.cleanupCredentials ||
      intents.length > GuestBrowserLimitsV1.cleanupCeremonies
    ) {
      throw new GuestBadRequest({
        message: "Guest cookie count exceeds its hard bound",
        details: { reason_code: "guest_cookie_limit_exceeded" },
      });
    }
  }
  if (!cleanup && credentials.length > GuestBrowserLimitsV1.credentials) {
    throw new GuestConflict({
      message: "Credential cleanup required",
      details: { reason_code: "guest_credential_cleanup_required" },
    });
  }
  if (!cleanup && intents.length > GuestBrowserLimitsV1.ceremonies) {
    throw new GuestConflict({
      message: "Ceremony cleanup required",
      details: { reason_code: "guest_ceremony_cleanup_required" },
    });
  }
  return { credentials, intents, csrf } as const;
}

/** Frozen adapter boundary; no implementation/composition is installed by phase0.
 * Unsafe calls verify exact trusted product Origin and separate x-guest-csrf-token CSRF before
 * body allocation. Attachment additionally verifies account cookie CSRF. Authorization
 * presence is always refused. Raw proof/digest material remains inside this adapter.
 */
export interface GuestBrowserAuthenticationAdapter {
  readonly authenticate: (
    input: Readonly<{
      policy: BrowserParticipationPolicy;
      trustedProductOrigin: string;
      requestHeaders: Headers;
      selectedCredentialId: string | null;
      account: OrdinaryBrowserAccount | SetupBrowserAccount | null;
    }>,
  ) => Promise<BrowserParticipationContext>;
}
