import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const cloudflareAccountId = "08a4c22cf52e2ecae883e36f80a33f4a";

const defaultLoginPath = "/home/t42/.config/.wrangler/config/default.toml";
const defaultWrangler = fileURLToPath(new URL("../../node_modules/.bin/wrangler", import.meta.url));
// The provider's client renews a stored login only once its stored expiry has
// passed; it cannot be asked to renew early. So a login this close to expiry is
// waited out and then renewed, and a renewed login must last at least this long.
const expiryWaitMs = 20_000;
const renewedMinimumMs = 5 * 60_000;
const readAttempts = 3;

export function readStoredLogin(path = defaultLoginPath) {
  const text = readFileSync(path, "utf8");
  const token = text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  const expiry = Date.parse(text.match(/^expiration_time\s*=\s*"([^"]+)"/m)?.[1] ?? "");
  return { token, expiresAt: Number.isFinite(expiry) ? expiry : 0 };
}

/**
 * Runs the provider's own client, which renews an expired stored login as a side
 * effect of any authenticated command. It runs as a child process that is
 * awaited, not blocked on, so timers such as a lease heartbeat keep firing.
 * Nothing is printed or returned; the caller checks the stored login afterwards.
 */
export function runProviderClient({ wrangler = defaultWrangler, environment = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(wrangler, ["whoami"], { stdio: "ignore", env: environment });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const done = (status) => {
      clearTimeout(timer);
      resolve(status);
    };
    child.once("error", () => done(null));
    child.once("exit", (status) => done(status));
  });
}

let renewal;

/**
 * Existing managed credentials stay in memory and are never returned in diagnostics.
 * An explicit token in the environment is used as given and never renewed.
 *
 * `refused` is the token the provider just refused, if any. A refused token that
 * is still unexpired in the store cannot be renewed; it is only replaced if
 * something else has already stored a different one.
 *
 * @param {{
 *   refused?: string,
 *   now?: () => number,
 *   environment?: Record<string, string | undefined>,
 *   read?: () => { token: string | undefined, expiresAt: number },
 *   renew?: () => Promise<unknown>,
 *   sleep?: (ms: number) => Promise<unknown>,
 * }} [options]
 */
export async function managedToken({
  refused,
  now = Date.now,
  environment = process.env,
  read = readStoredLogin,
  renew = runProviderClient,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (environment.CLOUDFLARE_API_TOKEN) {
    if (refused === environment.CLOUDFLARE_API_TOKEN)
      throw new Error("Cloudflare explicit token was refused");
    return environment.CLOUDFLARE_API_TOKEN;
  }
  let login = read();
  const usable = () =>
    typeof login.token === "string" &&
    login.token !== refused &&
    login.expiresAt - now() > expiryWaitMs;
  if (usable()) return login.token;
  if (login.token === refused && login.expiresAt - now() > expiryWaitMs)
    throw new Error(
      "Cloudflare managed login was refused before its stored expiry and cannot be renewed",
    );
  // Concurrent callers share one renewal; a second child would race the first for
  // the single-use refresh token.
  renewal ??= (async () => {
    try {
      const previous = login.token;
      const wait = login.expiresAt - now();
      if (wait > 0) await sleep(wait + 1_000);
      await renew();
      const renewed = read();
      // The postcondition, not the child's exit status, decides.
      if (
        typeof renewed.token !== "string" ||
        renewed.token === previous ||
        renewed.expiresAt - now() < renewedMinimumMs
      )
        throw new Error("Cloudflare managed login was not renewed");
    } finally {
      renewal = undefined;
    }
  })();
  await renewal;
  login = read();
  if (!usable()) throw new Error("Cloudflare managed authentication is unavailable");
  return login.token;
}

export async function cloudflareApi(path, init = {}, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const token = dependencies.token ?? managedToken;
  // Only a read is repeated. A write whose answer is lost may have been applied,
  // so it is reported as it stands and never sent again.
  const isRead = (init.method ?? "GET").toUpperCase() === "GET";
  let faults = 0;
  let renewedAfterRefusal = false;
  // The token the provider refused on the previous attempt only. It is cleared
  // once used, so a later fault does not ask for another renewal.
  let refused;
  for (;;) {
    let response;
    let data;
    let bearer;
    try {
      bearer = await token({ refused });
      refused = undefined;
      response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}${path}`,
        {
          ...init,
          signal: AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${bearer}`,
            ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
            ...init.headers,
          },
        },
      );
      data = await response.json();
    } catch (error) {
      if (error instanceof Error && /^Cloudflare (managed|explicit)/.test(error.message))
        throw error;
      if (!isRead || ++faults > readAttempts) throw new Error("Cloudflare request unanswered");
      await sleep(1_000 * faults);
      continue;
    }
    if (response.ok && data.success) return data.result;
    const failure = new Error(
      `Cloudflare request refused: HTTP ${response.status}, codes ${(data.errors ?? []).map((error) => error.code).join(",")}`,
    );
    // A refused login is rejected before the request is acted on, so one further
    // attempt with a different login is safe for a write as well.
    if (response.status === 401 && !renewedAfterRefusal) {
      renewedAfterRefusal = true;
      refused = bearer;
      continue;
    }
    if (!isRead || response.status < 500 || ++faults > readAttempts) throw failure;
    await sleep(1_000 * faults);
  }
}
