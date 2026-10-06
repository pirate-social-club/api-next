import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const cloudflareAccountId = "08a4c22cf52e2ecae883e36f80a33f4a";

const loginPath = "/home/t42/.config/.wrangler/config/default.toml";
const wrangler = fileURLToPath(new URL("../../node_modules/.bin/wrangler", import.meta.url));
// A win and a loss take about an hour and the managed login lasts an hour, so it
// is renewed whenever less than this remains, and once more after a refusal.
const refreshWithinMs = 10 * 60_000;
const readAttempts = 3;

function readLogin() {
  const text = readFileSync(loginPath, "utf8");
  const token = text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  const expiry = Date.parse(text.match(/^expiration_time\s*=\s*"([^"]+)"/m)?.[1] ?? "");
  return { token, expiresAt: Number.isFinite(expiry) ? expiry : 0 };
}

/** The provider's own client renews the stored login; nothing is printed or returned. */
function refreshLogin() {
  const result = spawnSync(wrangler, ["whoami"], { stdio: "ignore", timeout: 60_000 });
  if (result.status !== 0) throw new Error("Cloudflare managed login refresh failed");
}

/**
 * Existing managed credentials stay in memory and are never returned in diagnostics.
 * An explicit token in the environment is used as given and never refreshed.
 */
export async function managedToken({
  force = false,
  now = Date.now,
  environment = process.env,
  read = readLogin,
  refresh = refreshLogin,
} = {}) {
  if (environment.CLOUDFLARE_API_TOKEN) return environment.CLOUDFLARE_API_TOKEN;
  let login = read();
  if (force || !login.token || login.expiresAt - now() < refreshWithinMs) {
    await refresh();
    login = read();
  }
  if (!login.token || login.expiresAt <= now())
    throw new Error("Cloudflare managed authentication is unavailable");
  return login.token;
}

export async function cloudflareApi(path, init = {}, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const token = dependencies.token ?? managedToken;
  // Only a read is repeated. A write whose answer is lost may have been applied,
  // so it is reported as it stands and never sent again.
  const isRead = (init.method ?? "GET").toUpperCase() === "GET";
  let refused = false;
  let failure;
  for (let attempt = 0; attempt < (isRead ? readAttempts : 1) + 1; attempt++) {
    let response;
    let data;
    try {
      response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}${path}`,
        {
          ...init,
          signal: AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${await token({ force: refused })}`,
            ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
            ...init.headers,
          },
        },
      );
      data = await response.json();
    } catch (error) {
      if (error instanceof Error && /managed (login|authentication)/.test(error.message))
        throw error;
      failure = new Error("Cloudflare request unanswered");
      if (!isRead) throw failure;
      await sleep(1_000 * (attempt + 1));
      continue;
    }
    if (response.ok && data.success) return data.result;
    failure = new Error(
      `Cloudflare request refused: HTTP ${response.status}, codes ${(data.errors ?? []).map((error) => error.code).join(",")}`,
    );
    // An expired login is refused before the request is acted on, so one renewed
    // attempt is safe for a write as well.
    if (response.status === 401 && !refused) {
      refused = true;
      continue;
    }
    if (!isRead || response.status < 500) throw failure;
    await sleep(1_000 * (attempt + 1));
  }
  throw failure ?? new Error("Cloudflare request refused");
}
