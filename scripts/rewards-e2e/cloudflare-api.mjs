import { readFileSync } from "node:fs";

export const cloudflareAccountId = "08a4c22cf52e2ecae883e36f80a33f4a";

/** Existing managed credentials stay in memory and are never returned in diagnostics. */
export async function cloudflareApi(path, init = {}) {
  const token =
    process.env.CLOUDFLARE_API_TOKEN ??
    readFileSync("/home/t42/.config/.wrangler/config/default.toml", "utf8").match(
      /^oauth_token\s*=\s*"([^"]+)"/m,
    )?.[1];
  if (!token) throw new Error("Cloudflare managed authentication is unavailable");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}${path}`,
    {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    },
  );
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(
      `Cloudflare request refused: HTTP ${response.status}, codes ${(data.errors ?? []).map((error) => error.code).join(",")}`,
    );
  }
  return data.result;
}
