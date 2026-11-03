import { expect, test } from "bun:test";
import {
  deploymentChildEnvironment,
  injectedProductionUrls,
  injectedReadOnlyOwnerUrl,
  providerReadEnvironment,
  releaseExecutorEnvironment,
  safeToolEnvironment,
  wranglerEnvironment,
} from "./production-managed-environment.ts";

const ownerKey = "HNS_PRODUCTION_POSTGRES_ADMIN_URL",
  runtimeKey = "HNS_PRODUCTION_POSTGRES_RUNTIME_URL";
const ownerRole = "pscale_api_exl4hoyn673g.mqfaju65wdm3",
  runtimeRole = "pscale_api_4bxas7gq43a4.mqfaju65wdm3";
function url(role: string) {
  const value = new URL("postgresql://aws-us-east-1-4.pg.psdb.cloud:5432/postgres");
  value.username = role;
  value.password = "synthetic-fixture-only";
  value.searchParams.set("sslmode", "verify-full");
  return value;
}
function urls() {
  return { [ownerKey]: url(ownerRole).toString(), [runtimeKey]: url(runtimeRole).toString() };
}
function environment() {
  return {
    PATH: "/tool/path",
    HOME: "/fixture/home",
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: "/fixture/config",
    XDG_RUNTIME_DIR: "/fixture/runtime",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/bus",
    NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
    HTTPS_PROXY: "http://proxy.invalid",
    [ownerKey]: "dummy-owner-url",
    [runtimeKey]: "dummy-runtime-url",
    CONTROL_PLANE_POSTGRES_ADMIN_URL: "dummy-owner-alias",
    CONTROL_PLANE_POSTGRES_RUNTIME_URL: "dummy-runtime-alias",
    RUNTIME_POSTGRES_URL: "dummy-runtime-alias",
    INFISICAL_TOKEN: "dummy-folder-token",
    DUMMY_OPERATOR_SECRET: "dummy-folder-secret",
    CLOUDFLARE_API_TOKEN: "dummy-injected-token",
    NODE_OPTIONS: "--require=/fixture/not-allowed",
    PIRATE_RELEASE_OUTER_START_PATH: "/fixture/foreign-start.json",
  };
}
test("tool environment retains required HOME/XDG/DBus/CA transport settings and drops injected credentials/code hooks", () => {
  const input = environment(),
    projected = safeToolEnvironment(input);
  expect(projected).toEqual({
    PATH: input.PATH,
    HOME: input.HOME,
    LANG: input.LANG,
    XDG_CONFIG_HOME: input.XDG_CONFIG_HOME,
    XDG_RUNTIME_DIR: input.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: input.DBUS_SESSION_BUS_ADDRESS,
    NODE_EXTRA_CA_CERTS: input.NODE_EXTRA_CA_CERTS,
    HTTPS_PROXY: input.HTTPS_PROXY,
  });
  expect(JSON.stringify(projected)).not.toContain("dummy-");
  expect(projected.NODE_OPTIONS).toBeUndefined();
  expect(projected.PIRATE_RELEASE_OUTER_START_PATH).toBeUndefined();
});
test("supervised release child retains exactly the two fixed injected URL selectors", () => {
  const input = environment(),
    projected = releaseExecutorEnvironment(input);
  expect(projected[ownerKey]).toBe(input[ownerKey]);
  expect(projected[runtimeKey]).toBe(input[runtimeKey]);
  for (const key of [
    "CONTROL_PLANE_POSTGRES_ADMIN_URL",
    "RUNTIME_POSTGRES_URL",
    "INFISICAL_TOKEN",
    "DUMMY_OPERATOR_SECRET",
    "CLOUDFLARE_API_TOKEN",
  ])
    expect(projected[key]).toBeUndefined();
});
test("provider token is separately supplied; Wrangler and ordinary children never receive DB URLs", () => {
  const input = environment(),
    read = providerReadEnvironment("separately-retrieved-dummy", input),
    upload = wranglerEnvironment(input);
  expect(read.CLOUDFLARE_API_TOKEN).toBe("separately-retrieved-dummy");
  expect(upload.CLOUDFLARE_API_TOKEN).toBeUndefined();
  for (const command of [
    ["bunx", "wrangler", "deploy"],
    ["cf", "workers", "versions", "get"],
    ["git", "status"],
    ["bun", "scripts/telegram-activation-preflight.ts", "--extra"],
    ["bun", "other-preflight.ts"],
  ]) {
    const child = deploymentChildEnvironment(command, "validated-runtime-only", input);
    expect(JSON.stringify(child)).not.toContain("dummy-");
    expect(child.RUNTIME_POSTGRES_URL).toBeUndefined();
  }
  expect(JSON.stringify(read)).not.toContain("dummy-owner");
  expect(JSON.stringify(read)).not.toContain("dummy-runtime");
});
test("only the exact maintained Telegram DB preflight gets runtime aliases, never any owner credential", () => {
  const child = deploymentChildEnvironment(
    ["bun", "scripts/telegram-activation-preflight.ts"],
    "validated-runtime-only",
    environment(),
  );
  expect(child.RUNTIME_POSTGRES_URL).toBe("validated-runtime-only");
  expect(child.CONTROL_PLANE_POSTGRES_RUNTIME_URL).toBe("validated-runtime-only");
  expect(child.CONTROL_PLANE_POSTGRES_ADMIN_URL).toBeUndefined();
  expect(child[ownerKey]).toBeUndefined();
  expect(child[runtimeKey]).toBeUndefined();
});
test("fixed selectors and target guards retain owner/reader settings while preserving runtime options", () => {
  const input = urls(),
    runtime = new URL(input[runtimeKey]);
  runtime.searchParams.set("options", "-c search_path=api_next,pg_catalog");
  input[runtimeKey] = runtime.toString();
  const observed = injectedProductionUrls(input);
  expect(new URL(observed.owner).searchParams.get("options")).toBe(
    "-c search_path=api_next,pg_catalog -c transaction_timeout=170000",
  );
  expect(new URL(observed.runtime).searchParams.get("options")).toBe(
    "-c search_path=api_next,pg_catalog",
  );
  expect(new URL(injectedReadOnlyOwnerUrl(input)).searchParams.get("options")).toContain(
    "default_transaction_read_only=on",
  );
  const owner = new URL(input[ownerKey]);
  owner.searchParams.set("sslrootcert", "system");
  input[ownerKey] = owner.toString();
  expect(new URL(injectedReadOnlyOwnerUrl(input)).searchParams.has("sslrootcert")).toBe(false);
  expect(() => injectedProductionUrls({})).toThrow();
  expect(() => injectedProductionUrls({ [ownerKey]: input[ownerKey] })).toThrow();
});
test("effective target and TLS query overrides, duplicate keys and unknown parameters refuse", () => {
  for (const key of [
    "host",
    "hostaddr",
    "port",
    "user",
    "database",
    "dbname",
    "ssl",
    "sslcert",
    "sslkey",
    "sslnegotiation",
    "uselibpqcompat",
    "application_name",
  ]) {
    const input = urls(),
      value = new URL(input[ownerKey]);
    value.searchParams.set(key, "synthetic-override");
    input[ownerKey] = value.toString();
    expect(() => injectedReadOnlyOwnerUrl(input)).toThrow();
  }
  for (const key of ["sslmode", "options", "sslrootcert"]) {
    const input = urls(),
      value = new URL(input[ownerKey]);
    value.searchParams.append(key, key === "sslrootcert" ? "system" : "verify-full");
    value.searchParams.append(key, key === "sslrootcert" ? "system" : "verify-full");
    input[ownerKey] = value.toString();
    expect(() => injectedReadOnlyOwnerUrl(input)).toThrow();
  }
  for (const mutate of [
    (value: URL) => {
      value.hostname = "other.invalid";
    },
    (value: URL) => {
      value.port = "5433";
    },
    (value: URL) => {
      value.username = "foreign-role";
    },
    (value: URL) => {
      value.pathname = "/other";
    },
    (value: URL) => {
      value.searchParams.set("sslmode", "disable");
    },
    (value: URL) => {
      value.searchParams.set("sslrootcert", "/foreign/file");
    },
  ]) {
    const input = urls(),
      value = new URL(input[ownerKey]);
    mutate(value);
    input[ownerKey] = value.toString();
    expect(() => injectedProductionUrls(input)).toThrow();
  }
});
