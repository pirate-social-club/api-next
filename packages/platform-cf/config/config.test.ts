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

  test("pins the OpenAI moderation origin at config decode", () => {
    expect(() =>
      loadConfigFrom(HttpWorkerConfig, {
        OPENAI_MODERATION_BASE_URL: "https://moderation-proxy.invalid/v1",
      }),
    ).toThrow();
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

  test("jobs composition permits an absent production Megapot RPC while rewards are disabled", () => {
    const configured = loadConfigFrom(JobsWorkerConfig, {
      API_NEXT_ENV: "production",
      COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://rpc.invalid/",
      MEGAPOT_REWARDS_ENABLED: "false",
      MEGAPOT_CHAIN_ID: "8453",
      MEGAPOT_ATTESTATION_ID: "megapot-base-sepolia-v2",
      MEGAPOT_REQUIRED_CONFIRMATIONS: "3",
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

    expect(configured.MEGAPOT_REWARDS_ENABLED).toBe(false);
    expect(Redacted.value(configured.MEGAPOT_V2_RPC_URL)).toBe("");
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

  test("staging admits acceptance traffic without weakening production registration limits", async () => {
    const config = BunRuntime.JSONC.parse(
      await BunRuntime.file(
        new URL("../../../apps/http-worker/wrangler.jsonc", import.meta.url),
      ).text(),
    ) as {
      readonly env?: Readonly<Record<string, { readonly vars?: Readonly<Record<string, string>> }>>;
    };

    expect(config.env?.staging?.vars?.REGISTRATION_IP_LIMIT).toBe("50");
    expect(config.env?.staging?.vars?.REGISTRATION_IP_WINDOW_SECONDS).toBe("900");
    expect(config.env?.production?.vars?.REGISTRATION_IP_LIMIT).toBe("5");
    expect(config.env?.production?.vars?.REGISTRATION_IP_WINDOW_SECONDS).toBe("900");
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
      HNS_COMMUNITY_APP_API_ENABLED: false,
      HNS_HANDLE_HOST_API_ENABLED: false,
      HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN: "",
      HNS_COMMUNITY_APP_API_ACCESS_ISSUER: "",
      HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL: "",
      HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE: "",
      HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE: "",
      HNS_FORWARDER_V3_KEY_REGISTRY_VERSION: "",
      HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS: 0,
      HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS: -1,
      OPENAI_MODERATION_ENABLED: false,
      OPENAI_MODERATION_MODEL: "omni-moderation-2024-09-26",
      OPENAI_MODERATION_BASE_URL: "https://api.openai.com/v1",
      OPENAI_MODERATION_TIMEOUT_MS: 10_000,
      PIRATE_API_PUBLIC_ORIGIN: "",
    });
    expect(Redacted.value(configured.VERY_OAUTH_CLIENT_SECRET)).toBe("");
    expect(Redacted.value(configured.VERY_OAUTH_SEALING_KEY)).toBe("");
    expect(Redacted.value(configured.VERY_WEB_SEALING_KEY)).toBe("");
    expect(Redacted.value(configured.HNS_FORWARDER_V3_HMAC_KEY_REGISTRY)).toBe("");
    expect(Redacted.value(configured.OPENAI_API_KEY)).toBe("");
  });

  test("declares the disabled HNS community API graph independently in every environment", async () => {
    const config = BunRuntime.JSONC.parse(
      await BunRuntime.file(
        new URL("../../../apps/http-worker/wrangler.jsonc", import.meta.url),
      ).text(),
    ) as {
      readonly vars?: Record<string, string>;
      readonly secrets?: { readonly required?: readonly string[] };
      readonly durable_objects?: {
        readonly bindings?: readonly { readonly name?: string; readonly class_name?: string }[];
      };
      readonly migrations?: readonly {
        readonly tag?: string;
        readonly new_sqlite_classes?: readonly string[];
      }[];
      readonly env?: Readonly<
        Record<
          string,
          {
            readonly vars?: Record<string, string>;
            readonly secrets?: { readonly required?: readonly string[] };
            readonly durable_objects?: {
              readonly bindings?: readonly {
                readonly name?: string;
                readonly class_name?: string;
              }[];
            };
          }
        >
      >;
    };

    for (const environment of [config, config.env?.staging]) {
      expect(environment?.vars?.HNS_COMMUNITY_APP_API_ENABLED).toBe("false");
      expect(environment?.vars?.HNS_HANDLE_HOST_API_ENABLED).toBe("false");
      expect(environment?.vars?.HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN).toBe("");
      expect(environment?.vars?.HNS_COMMUNITY_APP_API_ACCESS_ISSUER).toBe("");
      expect(environment?.vars?.HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL).toBe("");
      expect(environment?.vars?.HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE).toBe("");
      expect(environment?.vars?.HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE).toBe("");
      expect(environment?.vars?.HNS_FORWARDER_V3_KEY_REGISTRY_VERSION).toBe("");
      expect(environment?.vars?.HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS).toBe("0");
      expect(environment?.vars?.HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS).toBe("-1");
      expect(environment?.secrets?.required).toContain("HNS_FORWARDER_V3_HMAC_KEY_REGISTRY");
      expect(environment?.durable_objects?.bindings).toContainEqual({
        name: "HNS_COMMUNITY_APP_API_REPLAY",
        class_name: "HnsForwarderReplayStoreDO",
      });
    }
    const production = config.env?.production;
    expect(production?.vars?.HNS_COMMUNITY_APP_API_ENABLED).toBe("true");
    expect(production?.vars?.HNS_HANDLE_HOST_API_ENABLED).toBe("true");
    expect(production?.vars?.HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN).toBe(
      "https://hns-community-api.pirate.sc",
    );
    expect(production?.vars?.HNS_COMMUNITY_APP_API_ACCESS_ISSUER).toBe(
      "https://piratesocialclub.cloudflareaccess.com",
    );
    expect(production?.vars?.HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL).toBe(
      "https://piratesocialclub.cloudflareaccess.com/cdn-cgi/access/certs",
    );
    expect(production?.vars?.HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE).toBe(
      "0654e5ea35b95c368a012a9e014351840f743253f55a606976d5bb8e628383c9",
    );
    expect(production?.vars?.HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE).toBe(
      "pirate:hns-forwarder-v3:production-community-app:v1",
    );
    expect(production?.vars?.HNS_FORWARDER_V3_KEY_REGISTRY_VERSION).toBe("2026-08-28-02");
    expect(production?.vars?.HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS).toBe("300");
    expect(production?.vars?.HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS).toBe("5");
    expect(production?.secrets?.required).toContain("HNS_FORWARDER_V3_HMAC_KEY_REGISTRY");
    expect(production?.durable_objects?.bindings).toContainEqual({
      name: "HNS_COMMUNITY_APP_API_REPLAY",
      class_name: "HnsForwarderReplayStoreDO",
    });
    expect(config.migrations).toContainEqual({
      tag: "v4",
      new_sqlite_classes: ["HnsForwarderReplayStoreDO"],
    });
    expect(JSON.stringify(config)).not.toContain("HNS_OWNER_VERIFIER");
    expect(JSON.stringify(config)).not.toContain("HNS_OBSERVER_DRIVER");
  });

  test("Wrangler enables only the authorized Very web and OpenAI providers in staging", async () => {
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
      expect(environment.vars?.OPENAI_MODERATION_MODEL).toBe("omni-moderation-2024-09-26");
      expect(environment.vars?.OPENAI_MODERATION_BASE_URL).toBe("https://api.openai.com/v1");
      expect(environment.vars?.OPENAI_MODERATION_TIMEOUT_MS).toBe("10000");
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
    expect(config.vars?.OPENAI_MODERATION_ENABLED).toBe("false");
    expect(config.secrets?.required ?? []).not.toContain("OPENAI_API_KEY");
    expect(staging?.vars?.OPENAI_MODERATION_ENABLED).toBe("true");
    expect(staging?.secrets?.required ?? []).toContain("OPENAI_API_KEY");
    expect(production?.vars?.OPENAI_MODERATION_ENABLED).toBe("false");
    expect(production?.secrets?.required ?? []).not.toContain("OPENAI_API_KEY");
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
          readonly send_email?: readonly {
            readonly name?: string;
            readonly destination_address?: string;
            readonly allowed_sender_addresses?: readonly string[];
          }[];
          readonly secrets?: { readonly required?: readonly string[] };
          readonly vars?: Record<string, string>;
        };
      };
    };
    const production = config.env?.production;
    expect(production?.workers_dev).toBe(true);
    expect(production?.routes).toEqual([
      { pattern: "api-next.pirate.sc", custom_domain: true },
      { pattern: "hns-community-api.pirate.sc", custom_domain: true },
    ]);
    expect(production?.hyperdrive).toEqual([
      {
        binding: "CONTROL_PLANE",
        id: "884b68c5a7904982a86620ed90032b77",
        localConnectionString: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
      },
    ]);
    expect(production?.send_email).toEqual([
      {
        name: "HNS_EDGE_ALERT_EMAIL",
        destination_address: "piratesocialclub@proton.me",
        allowed_sender_addresses: ["alerts@pirate.sc"],
      },
    ]);
    expect(production?.secrets?.required).toContain("HNS_EDGE_ALERT_TOKEN");
    expect(production?.vars?.PIRATE_API_PUBLIC_ORIGIN).toBe("https://api-next.pirate.sc");
    expect(production?.vars?.CORS_ORIGIN).toBe(
      "https://app.pirate,https://pirate.app,https://pirate.sc",
    );
    expect(production?.vars?.HNS_OWNERSHIP_ENABLED).toBe("false");
  });
});
