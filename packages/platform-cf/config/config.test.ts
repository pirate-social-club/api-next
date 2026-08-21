import { describe, expect, test } from "bun:test";
import * as BunRuntime from "bun";
import { Config, Redacted } from "effect";
import { AppEnv, HttpWorkerConfig, loadConfig, loadConfigFrom, secret } from "./index.ts";

describe("config system (000 §9)", () => {
  test("fail-at-startup: a missing required variable throws at load", () => {
    delete process.env.API_NEXT_ENV;
    expect(() => loadConfig(AppEnv)).toThrow();
  });

  test("fail-at-startup: an invalid literal value throws at load", () => {
    const env = Config.literals(["development", "staging", "production"], "API_NEXT_ENV_INVALID");
    process.env.API_NEXT_ENV_INVALID = "prod";
    expect(() => loadConfig(env)).toThrow();
    delete process.env.API_NEXT_ENV_INVALID;
  });

  test("a valid environment parses", () => {
    const env = Config.literals(["development", "staging", "production"], "API_NEXT_ENV_VALID");
    process.env.API_NEXT_ENV_VALID = "staging";
    expect(loadConfig(env)).toBe("staging");
    delete process.env.API_NEXT_ENV_VALID;
  });

  test("a defaulted variable falls back rather than failing", () => {
    delete process.env.API_NEXT_PORT;
    const port = Config.port("API_NEXT_PORT").pipe(Config.withDefault(8080));
    expect(loadConfig(port)).toBe(8080);
  });

  test("secrets are redacted: the value never prints", () => {
    process.env.API_NEXT_TEST_SECRET = "hunter2";
    const value = loadConfig(secret("API_NEXT_TEST_SECRET"));
    expect(String(value)).toBe("<redacted>");
    delete process.env.API_NEXT_TEST_SECRET;
  });

  test("HTTP composition fails before route construction when required config is absent", () => {
    expect(() =>
      loadConfigFrom(HttpWorkerConfig, {
        API_NEXT_ENV: "production",
        CORS_ORIGIN: "https://pirate.app",
      }),
    ).toThrow();
  });

  test("Self stays disabled unless explicitly configured", () => {
    const configured = loadConfigFrom(HttpWorkerConfig, {
      API_NEXT_ENV: "development",
      CORS_ORIGIN: "https://pirate.app",
      PIRATE_APP_JWT_PRIVATE_KEY: "private",
      PIRATE_APP_JWT_PUBLIC_KEY: "public",
      PIRATE_APP_JWT_ISSUER: "api-next-session-test",
      PIRATE_APP_JWT_AUDIENCE: "api-next-browser-test",
      PIRATE_APP_JWT_SCOPE: "api-next-browser-session-test",
      PRIVY_APP_ID: "privy",
      PRIVY_APP_SECRET: "secret",
      PRIVY_JWKS_URL: "https://privy.test/jwks",
      PRIVY_JWT_ISSUER: "privy",
      PRIVY_JWT_AUDIENCE: "pirate",
      COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://rpc.test",
    });
    expect(configured).toMatchObject({
      SELF_PASS_ENABLED: false,
      SELF_PASS_MOCK_PASSPORT: false,
      SELF_PASS_APP_NAME: "Pirate",
      VERY_OAUTH_ENABLED: false,
      VERY_OAUTH_AUTHORIZATION_ENDPOINT: "",
      VERY_OAUTH_TOKEN_ENDPOINT: "",
      VERY_OAUTH_USERINFO_ENDPOINT: "",
      VERY_OAUTH_ISSUER: "",
      VERY_OAUTH_JWKS_URL: "",
      VERY_OAUTH_CLIENT_ID: "",
      VERY_OAUTH_REDIRECT_URI: "",
      VERY_WEB_ENABLED: false,
      VERY_APP_ID: "",
      VERY_API_URL: "",
      VERY_VERIFY_URL: "",
      VERY_BRIDGE_API_URL: "",
      HNS_OWNERSHIP_ENABLED: false,
      HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "",
      HNS_OWNERSHIP_CONFIGURATION_VERSION: "",
      PIRATE_API_PUBLIC_ORIGIN: "",
    });
    expect(Redacted.value(configured.VERY_OAUTH_CLIENT_SECRET)).toBe("");
    expect(Redacted.value(configured.VERY_OAUTH_SEALING_KEY)).toBe("");
    expect(Redacted.value(configured.VERY_WEB_SEALING_KEY)).toBe("");
  });

  test("Wrangler keeps external ownership providers disabled in every environment", async () => {
    const config = BunRuntime.JSONC.parse(
      await BunRuntime.file(
        new URL("../../../apps/http-worker/wrangler.jsonc", import.meta.url),
      ).text(),
    ) as {
      readonly vars?: Record<string, string>;
      readonly secrets?: { readonly required?: readonly string[] };
      readonly env?: Readonly<
        Record<
          string,
          {
            readonly vars?: Record<string, string>;
            readonly secrets?: { readonly required?: readonly string[] };
          }
        >
      >;
    };
    const staging = config.env?.staging;
    const production = config.env?.production;
    const environments = [config, ...Object.values(config.env ?? {})];
    for (const environment of environments) {
      expect(environment.vars?.VERY_OAUTH_ENABLED).toBe("false");
      expect(environment.vars?.HNS_OWNERSHIP_ENABLED).toBe("false");
      expect(environment.secrets?.required ?? []).not.toContain("VERY_OAUTH_CLIENT_SECRET");
      expect(environment.secrets?.required ?? []).not.toContain("VERY_OAUTH_SEALING_KEY");
      expect(environment.secrets?.required ?? []).not.toContain("VERY_WEB_SEALING_KEY");
    }
    // Development (the base block) and production rely on the config default,
    // while staging carries an explicit false until separately authorized.
    expect(config.vars?.VERY_WEB_ENABLED).toBeUndefined();
    expect(staging?.vars?.VERY_WEB_ENABLED).toBe("false");
    expect(production?.vars?.VERY_WEB_ENABLED).toBeUndefined();
  });
});
