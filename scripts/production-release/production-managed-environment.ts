import assert from "node:assert/strict";
import { normalizePostgresConnectionString } from "../postgres-connection-string.ts";
import {
  cloudflareAccountId,
  cloudflareApi,
  managedToken,
  runProviderClient,
} from "../rewards-e2e/cloudflare-api.mjs";

type Environment = Readonly<Record<string, string | undefined>>;
const TOOL_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "BUN_INSTALL",
  "WRANGLER_SEND_METRICS",
  "CI",
  "NO_COLOR",
  "TERM",
] as const;
const OWNER_SELECTOR = "HNS_PRODUCTION_POSTGRES_ADMIN_URL";
const RUNTIME_SELECTOR = "HNS_PRODUCTION_POSTGRES_RUNTIME_URL";
const OWNER = "pscale_api_exl4hoyn673g";
const RUNTIME = "pscale_api_4bxas7gq43a4";
const BRANCH = "mqfaju65wdm3";

/** Copy only existing OS/tool configuration, never the injected operator folder. */
export function safeToolEnvironment(input: Environment = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of TOOL_KEYS) {
    const value = input[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
export const gitEnvironment = (input: Environment = process.env): Record<string, string> => ({
  ...safeToolEnvironment(input),
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});
export const wranglerEnvironment = (input: Environment = process.env): Record<string, string> => ({
  ...safeToolEnvironment(input),
  CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId,
});
export function providerReadEnvironment(
  token: string,
  input: Environment = process.env,
): Record<string, string> {
  assert.ok(
    typeof token === "string" && token.length > 0,
    "Managed provider authentication unavailable",
  );
  return {
    ...safeToolEnvironment(input),
    CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId,
    CLOUDFLARE_API_TOKEN: token,
  };
}

/** Supervisor child retains only the two fixed DB selectors plus its normal tool environment. */
export function releaseExecutorEnvironment(
  input: Environment = process.env,
): Record<string, string> {
  const result = safeToolEnvironment(input);
  for (const key of [OWNER_SELECTOR, RUNTIME_SELECTOR]) {
    const value = input[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
/** Only the maintained exact DB-dependent preflight receives runtime aliases; never an owner URL. */
export function deploymentChildEnvironment(
  command: readonly string[],
  runtime: string,
  input: Environment = process.env,
): Record<string, string> {
  const base = wranglerEnvironment(input);
  if (
    command.length === 2 &&
    command[0] === "bun" &&
    command[1] === "scripts/telegram-activation-preflight.ts"
  )
    return { ...base, RUNTIME_POSTGRES_URL: runtime, CONTROL_PLANE_POSTGRES_RUNTIME_URL: runtime };
  return base;
}

function productionUrl(raw: string | undefined, role: string) {
  assert.ok(
    typeof raw === "string" && raw.length > 0,
    "Required injected production database URL is missing",
  );
  const url = new URL(raw);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:");
  assert.equal(url.hash, "");
  assert.equal(decodeURIComponent(url.username), role + "." + BRANCH);
  assert.equal(url.hostname, "aws-us-east-1-4.pg.psdb.cloud");
  assert.equal(url.port || "5432", "5432");
  assert.equal(url.pathname, "/postgres");
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    assert.ok(!seen.has(key), "Duplicate production connection parameter");
    seen.add(key);
    assert.ok(
      ["sslmode", "sslrootcert", "options"].includes(key),
      "Unreviewed production connection parameter",
    );
  }
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  if (url.searchParams.has("sslrootcert"))
    assert.equal(url.searchParams.get("sslrootcert"), "system");
  return url;
}
export function injectedProductionUrls(input: Environment = process.env) {
  const owner = productionUrl(input[OWNER_SELECTOR], OWNER);
  owner.searchParams.set(
    "options",
    "-c search_path=api_next,pg_catalog -c transaction_timeout=170000",
  );
  const runtime = productionUrl(input[RUNTIME_SELECTOR], RUNTIME);
  // Preserve the runtime URL's existing startup options. Its live permission/identity proof remains required.
  return {
    owner: normalizePostgresConnectionString(owner.toString()),
    runtime: normalizePostgresConnectionString(runtime.toString()),
  };
}
export function injectedReadOnlyOwnerUrl(input: Environment = process.env) {
  const owner = productionUrl(input[OWNER_SELECTOR], OWNER);
  owner.searchParams.set(
    "options",
    "-c search_path=api_next,pg_catalog -c default_transaction_read_only=on -c timezone=UTC -c transaction_timeout=170000",
  );
  return normalizePostgresConnectionString(owner.toString());
}

/** Source-owned real adapter; a stored approved login is used even inside an injected folder. */
export async function managedProviderToken(options: { readonly refused?: string } = {}) {
  const request = options.refused === undefined ? {} : { refused: options.refused };
  const token = await managedToken({
    ...request,
    environment: safeToolEnvironment(),
    renew: () => runProviderClient({ environment: safeToolEnvironment() }),
  });
  assert.ok(
    typeof token === "string" && token.length > 0,
    "Managed provider authentication unavailable",
  );
  return token;
}
export async function managedProviderApi(path: string) {
  return cloudflareApi(path, {}, { token: managedProviderToken });
}
