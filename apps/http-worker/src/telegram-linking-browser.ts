import { AuthError } from "@pirate/contracts";

const COOKIE = "__Host-pirate_telegram_link";
/** Called only after the session cookie was authenticated and Origin/CSRF checked. */
export async function telegramLinkBrowser(
  session: string,
  cookies: ReadonlyMap<string, string>,
  duplicateNames: ReadonlySet<string>,
  invalidNames: ReadonlySet<string>,
  useBinding = true,
) {
  const binding = useBinding ? cookies.get(COOKIE) : undefined;
  if (
    (useBinding && duplicateNames.has(COOKIE)) ||
    (useBinding && invalidNames.has(COOKIE)) ||
    (binding !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(binding))
  )
    throw new AuthError({ message: "Link browser invalid" });
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(session)),
  );
  const sessionHash = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return { sessionHash, ...(binding === undefined ? {} : { binding }) };
}
