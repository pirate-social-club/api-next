import type { BrowserSessionCookies } from "@pirate/application/use-cases/browser-sessions";
import { InternalError } from "@pirate/contracts";

export const BROWSER_RENEWAL_COOKIE_NAME = "__Host-pirate_renewal";
const attributes = "; Path=/; Secure; SameSite=Lax";

/** Only the existing cookie transport receives the secret-bearing handoff. */
export function browserSessionCookieHeaders(value: BrowserSessionCookies): readonly string[] {
  if (
    !value.accessToken ||
    value.accessToken.length > 16 * 1024 ||
    /[\s;\r\n]/u.test(value.accessToken) ||
    !Number.isSafeInteger(value.accessSeconds) ||
    value.accessSeconds < 1 ||
    value.accessSeconds > 3600 ||
    !Number.isSafeInteger(value.durableSeconds) ||
    value.durableSeconds < 1 ||
    value.durableSeconds > 30 * 86400 ||
    !/^[a-f0-9]{64}$/u.test(value.csrf) ||
    (value.renewal !== null && !/^bs_[a-f0-9]{32}\.[a-f0-9]{64}$/u.test(value.renewal))
  )
    throw new InternalError({ message: "Session cookie handoff failed" });
  return [
    `__Host-pirate_session=${encodeURIComponent(value.accessToken)}; HttpOnly${attributes}; Max-Age=${value.accessSeconds}`,
    `${BROWSER_RENEWAL_COOKIE_NAME}=${value.renewal ?? ""}; HttpOnly${attributes}; Max-Age=${value.renewal === null ? 0 : value.durableSeconds}`,
    `__Host-pirate_csrf=${value.csrf}${attributes}; Max-Age=${value.durableSeconds}`,
  ];
}

export function clearBrowserSessionCookieHeaders(): readonly string[] {
  const expired = `${attributes}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
  return [
    `__Host-pirate_session=${expired}; HttpOnly`,
    `${BROWSER_RENEWAL_COOKIE_NAME}=${expired}; HttpOnly`,
    `__Host-pirate_csrf=${expired}`,
  ];
}
