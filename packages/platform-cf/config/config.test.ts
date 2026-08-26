import { describe, expect, test } from "bun:test";
import * as BunRuntime from "bun";
import { Config, Redacted } from "effect";
import {
  AppEnv,
  assertMegapotRewardRuntimePosture,
  HttpWorkerConfig,
  JobsWorkerConfig,
  loadConfig,
  loadConfigFrom,
  secret,
} from "./index.ts";

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

  test("jobs composition parses the complete staging-only Megapot posture", () => {
    const configured = loadConfigFrom(JobsWorkerConfig, {
      API_NEXT_ENV: "staging",
      COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://funding-rpc.test",
      MEGAPOT_REWARDS_ENABLED: "true",
      MEGAPOT_CHAIN_ID: "84532",
      MEGAPOT_V2_RPC_URL: "https://base-sepolia-rpc.test",
      MEGAPOT_ATTESTATION_ID: "megapot-base-sepolia-v2",
      MEGAPOT_REQUIRED_CONFIRMATIONS: "3",
      MEGAPOT_CUSTODY_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      MEGAPOT_COMMITMENT_PUBLIC_ORIGIN: "https://commitments.test",
      MEGAPOT_OBSERVATION_TTL_SECONDS: "300",
      MEGAPOT_APPROVED_ALLOWANCE_ATOMIC: "1000000000",
      MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS: "120",
      MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS: "12000",
      MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI: "1000000000000000",
      MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING: "5",
      MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "50000000",
      MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING: "50",
      MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "500000000",
    });
    expect(configured).toMatchObject({
      API_NEXT_ENV: "staging",
      MEGAPOT_REWARDS_ENABLED: true,
      MEGAPOT_CHAIN_ID: 84_532,
      MEGAPOT_REQUIRED_CONFIRMATIONS: 3,
      MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS: 120,
    });
    expect(Redacted.value(configured.MEGAPOT_CUSTODY_PRIVATE_KEY)).toBe(`0x${"1".repeat(64)}`);
  });

  test("Megapot runtime admits Base Sepolia only outside production", () => {
    expect(
      assertMegapotRewardRuntimePosture({
        API_NEXT_ENV: "staging",
        MEGAPOT_REWARDS_ENABLED: true,
        MEGAPOT_CHAIN_ID: 84_532,
        MEGAPOT_REQUIRED_CONFIRMATIONS: 3,
      }),
    ).toBe(84_532);
    expect(
      assertMegapotRewardRuntimePosture({
        API_NEXT_ENV: "production",
        MEGAPOT_REWARDS_ENABLED: false,
        MEGAPOT_CHAIN_ID: 8_453,
        MEGAPOT_REQUIRED_CONFIRMATIONS: 3,
      }),
    ).toBe(8_453);
    expect(() =>
      assertMegapotRewardRuntimePosture({
        API_NEXT_ENV: "production",
        MEGAPOT_REWARDS_ENABLED: false,
        MEGAPOT_CHAIN_ID: 84_532,
        MEGAPOT_REQUIRED_CONFIRMATIONS: 3,
      }),
    ).toThrow("invalid Megapot reward runtime posture");
    expect(() =>
      assertMegapotRewardRuntimePosture({
        API_NEXT_ENV: "production",
        MEGAPOT_REWARDS_ENABLED: true,
        MEGAPOT_CHAIN_ID: 8_453,
        MEGAPOT_REQUIRED_CONFIRMATIONS: 3,
      }),
    ).toThrow("invalid Megapot reward runtime posture");
  });

  test("deployable Worker overlays keep Base Sepolia out of production", async () => {
    const paths = [
      "../../../apps/http-worker/wrangler.jsonc",
      "../../../apps/jobs-worker/wrangler.jsonc",
    ] as const;

    for (const path of paths) {
      const config = BunRuntime.JSONC.parse(
        await BunRuntime.file(new URL(path, import.meta.url)).text(),
      ) as {
        readonly env?: Readonly<
          Record<string, { readonly vars?: Readonly<Record<string, string>> }>
        >;
      };

      expect(config.env?.staging?.vars?.MEGAPOT_REWARDS_ENABLED).toBe("true");
      expect(config.env?.staging?.vars?.MEGAPOT_CHAIN_ID).toBe("84532");
      expect(config.env?.production?.vars?.MEGAPOT_REWARDS_ENABLED).toBe("false");
      expect(config.env?.production?.vars?.MEGAPOT_CHAIN_ID).toBe("8453");
    }
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
      MEGAPOT_REWARDS_ENABLED: "false",
      MEGAPOT_CHAIN_ID: "84532",
      MEGAPOT_V2_RPC_URL: "https://base-sepolia-rpc.test",
      MEGAPOT_ATTESTATION_ID: "megapot-base-sepolia-v2",
      MEGAPOT_REQUIRED_CONFIRMATIONS: "3",
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
      VERY_WEB_APP_ID: "",
      VERY_WEB_API_URL: "",
      VERY_WEB_VERIFY_URL: "",
      VERY_WEB_BRIDGE_API_URL: "",
      HNS_OWNERSHIP_ENABLED: false,
      HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "",
      HNS_OWNERSHIP_CONFIGURATION_VERSION: "",
      PIRATE_API_PUBLIC_ORIGIN: "",
    });
    expect(Redacted.value(configured.VERY_OAUTH_CLIENT_SECRET)).toBe("");
    expect(Redacted.value(configured.VERY_OAUTH_SEALING_KEY)).toBe("");
    expect(Redacted.value(configured.VERY_WEB_SEALING_KEY)).toBe("");
  });

  test("Wrangler enables Very web only in staging and keeps other ownership providers disabled", async () => {
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
    }
    // Development (the base block) and production rely on the fail-closed
    // default. Staging alone carries the operator-authorized Very web app.
    expect(config.vars?.VERY_WEB_ENABLED).toBeUndefined();
    expect(staging?.vars?.VERY_WEB_ENABLED).toBe("true");
    expect(staging?.vars?.VERY_WEB_APP_ID).toBe("fa6bb1db-51dd-4673-915a-b945e7a895a0");
    expect(production?.vars?.VERY_WEB_ENABLED).toBeUndefined();
    expect(production?.vars?.VERY_WEB_APP_ID).toBeUndefined();
  });

  test("pins the production HTTP origin to its dedicated Hyperdrive and custom domain", async () => {
    const config = BunRuntime.JSONC.parse(
      await BunRuntime.file(
        new URL("../../../apps/http-worker/wrangler.jsonc", import.meta.url),
      ).text(),
    ) as {
      readonly env?: {
        readonly production?: {
          readonly workers_dev?: boolean;
          readonly routes?: readonly {
            readonly pattern?: string;
            readonly custom_domain?: boolean;
          }[];
          readonly hyperdrive?: readonly {
            readonly binding?: string;
            readonly id?: string;
            readonly localConnectionString?: string;
          }[];
          readonly vars?: Record<string, string>;
        };
      };
    };
    const production = config.env?.production;
    expect(production?.workers_dev).toBe(true);
    expect(production?.routes).toEqual([{ pattern: "api-next.pirate.sc", custom_domain: true }]);
    expect(production?.hyperdrive).toEqual([
      {
        binding: "CONTROL_PLANE",
        id: "884b68c5a7904982a86620ed90032b77",
        localConnectionString: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
      },
    ]);
    expect(production?.vars?.PIRATE_API_PUBLIC_ORIGIN).toBe("https://api-next.pirate.sc");
    expect(production?.vars?.CORS_ORIGIN).toBe(
      "https://app.pirate,https://pirate.app,https://pirate.sc",
    );
    expect(production?.vars?.HNS_OWNERSHIP_ENABLED).toBe("false");
  });
});
