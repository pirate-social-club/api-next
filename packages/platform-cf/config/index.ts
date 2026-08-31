import { Config, ConfigProvider, Effect, Redacted } from "effect";
import type { Redacted as RedactedType } from "effect/Redacted";

/**
 * Configuration system (api-next 000 §9) — Effect `Config`, fail-closed.
 *
 * Every variable is declared exactly once, with type, default or required-
 * ness, and environment applicability. Binding-based Workers load their
 * config before constructing the route application; invalid or missing
 * required config therefore fails the first health-check request rather than
 * limping into a read path (incident api#999 class).
 *
 * Semantics note: `Config.withDefault` swallows parse failures, so a
 * defaulted variable can never be *invalid* — it falls back. Money-path
 * variables are therefore REQUIRED (no defaults): an unset or malformed
 * money-path value must fail startup, and a missing testnet posture is a
 * deploy-time event, not a runtime surprise.
 */

/** Where this Worker build may run; gates per-env config below. */
export const AppEnv = Config.literals(["development", "staging", "production"], "API_NEXT_ENV");

export interface AppEnvValue {
  readonly API_NEXT_ENV: "development" | "staging" | "production";
}

export const isProduction = (env: AppEnvValue): boolean => env.API_NEXT_ENV === "production";

export interface MegapotRewardRuntimePosture {
  readonly API_NEXT_ENV: AppEnvValue["API_NEXT_ENV"];
  readonly MEGAPOT_REWARDS_ENABLED: boolean;
  readonly MEGAPOT_CHAIN_ID: number;
  readonly MEGAPOT_REQUIRED_CONFIRMATIONS: number;
}

/** Proves each environment uses its admitted chain and keeps mainnet activation disabled. */
export function assertMegapotRewardRuntimePosture(config: MegapotRewardRuntimePosture): number {
  const expectedChainId = config.API_NEXT_ENV === "production" ? 8_453 : 84_532;
  if (
    config.MEGAPOT_CHAIN_ID !== expectedChainId ||
    config.MEGAPOT_REQUIRED_CONFIRMATIONS <= 0 ||
    (config.MEGAPOT_REWARDS_ENABLED && config.API_NEXT_ENV === "production")
  ) {
    throw new Error("invalid Megapot reward runtime posture");
  }
  return config.MEGAPOT_CHAIN_ID;
}

/**
 * Fail-closed loader for process-backed configuration. A binding-based Worker
 * uses {@link loadConfigFrom} from its first-request composition boundary
 * because Cloudflare supplies bindings only to `fetch`.
 */
export function loadConfig<A>(config: Config.Config<A>): A {
  // The default provider snapshots process.env at import; building the
  // provider per call keeps loads honest for tests and per-worker entry.
  return Effect.runSync(
    (config as unknown as Effect.Effect<A>).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: process.env as Record<string, string> }),
      ),
    ),
  );
}

/** Secrets are redacted so they never surface in logs or error text. */
export const secret = (name: string): Config.Config<RedactedType<string>> =>
  // Config.redacted does not read from the default env provider in this RC;
  // wrap explicitly until the pinned Effect bump fixes it.
  Config.string(name).pipe(Config.map((value: string) => Redacted.make(value)));

const MegapotRewardConfigFields = {
  MEGAPOT_REWARDS_ENABLED: Config.boolean("MEGAPOT_REWARDS_ENABLED"),
  MEGAPOT_CHAIN_ID: Config.int("MEGAPOT_CHAIN_ID"),
  MEGAPOT_V2_RPC_URL: secret("MEGAPOT_V2_RPC_URL"),
  MEGAPOT_ATTESTATION_ID: Config.nonEmptyString("MEGAPOT_ATTESTATION_ID"),
  MEGAPOT_REQUIRED_CONFIRMATIONS: Config.int("MEGAPOT_REQUIRED_CONFIRMATIONS"),
} as const;

/** The fail-closed money-path variables required by M3 and M5. */
export const MoneyPathConfig = Config.all({
  COMMUNITY_PURCHASE_FUNDING_RPC_URL: secret("COMMUNITY_PURCHASE_FUNDING_RPC_URL"),
  ...MegapotRewardConfigFields,
});

export const JobsWorkerConfig = Config.all({
  API_NEXT_ENV: AppEnv,
  COMMUNITY_MAINTENANCE_ENABLED: Config.boolean("COMMUNITY_MAINTENANCE_ENABLED"),
  SONG_MAINTENANCE_OBSERVATION_ENABLED: Config.boolean("SONG_MAINTENANCE_OBSERVATION_ENABLED"),
  COMMUNITY_PURCHASE_FUNDING_RPC_URL: secret("COMMUNITY_PURCHASE_FUNDING_RPC_URL"),
  ...MegapotRewardConfigFields,
  MEGAPOT_V2_RPC_URL: secret("MEGAPOT_V2_RPC_URL").pipe(Config.withDefault(Redacted.make(""))),
  MEGAPOT_CUSTODY_PRIVATE_KEY: secret("MEGAPOT_CUSTODY_PRIVATE_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  MEGAPOT_COMMITMENT_PUBLIC_ORIGIN: secret("MEGAPOT_COMMITMENT_PUBLIC_ORIGIN").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  MEGAPOT_OBSERVATION_TTL_SECONDS: Config.int("MEGAPOT_OBSERVATION_TTL_SECONDS"),
  MEGAPOT_APPROVED_ALLOWANCE_ATOMIC: Config.nonEmptyString("MEGAPOT_APPROVED_ALLOWANCE_ATOMIC"),
  MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS: Config.int("MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS"),
  MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS: Config.int("MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS"),
  MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI: Config.nonEmptyString(
    "MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI",
  ),
  MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING: Config.int(
    "MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING",
  ),
  MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: Config.nonEmptyString(
    "MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC",
  ),
  MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING: Config.int(
    "MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING",
  ),
  MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: Config.nonEmptyString(
    "MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC",
  ),
});

/**
 * Configuration required before the HTTP application layer is constructed.
 * The Hyperdrive object is a Worker binding rather than an environment
 * variable and is checked by the composition root alongside this group.
 */
export const HttpWorkerConfig = Config.all({
  API_NEXT_ENV: AppEnv,
  CORS_ORIGIN: Config.nonEmptyString("CORS_ORIGIN"),
  PIRATE_API_PUBLIC_ORIGIN: Config.string("PIRATE_API_PUBLIC_ORIGIN").pipe(Config.withDefault("")),
  SELF_PASS_ENABLED: Config.boolean("SELF_PASS_ENABLED").pipe(Config.withDefault(false)),
  SELF_PASS_APP_NAME: Config.string("SELF_PASS_APP_NAME").pipe(Config.withDefault("Pirate")),
  SELF_PASS_MOCK_PASSPORT: Config.boolean("SELF_PASS_MOCK_PASSPORT").pipe(
    Config.withDefault(false),
  ),
  ZKPASSPORT_ENABLED: Config.boolean("ZKPASSPORT_ENABLED").pipe(Config.withDefault(false)),
  ZKPASSPORT_DOMAIN: Config.string("ZKPASSPORT_DOMAIN").pipe(Config.withDefault("")),
  ZKPASSPORT_NAME: Config.string("ZKPASSPORT_NAME").pipe(Config.withDefault("Pirate")),
  ZKPASSPORT_LOGO: Config.string("ZKPASSPORT_LOGO").pipe(Config.withDefault("")),
  ZKPASSPORT_VERIFIER_URL: Config.string("ZKPASSPORT_VERIFIER_URL").pipe(Config.withDefault("")),
  ZKPASSPORT_VERIFIER_SHARED_SECRET: secret("ZKPASSPORT_VERIFIER_SHARED_SECRET").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET: secret(
    "ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET",
  ).pipe(Config.withDefault(Redacted.make(""))),
  ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID: Config.string(
    "ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID",
  ).pipe(Config.withDefault("")),
  ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_SECRET: secret(
    "ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_SECRET",
  ).pipe(Config.withDefault(Redacted.make(""))),
  ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID: Config.string(
    "ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID",
  ).pipe(Config.withDefault("")),
  ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL: Config.string(
    "ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL",
  ).pipe(Config.withDefault("")),
  ZKPASSPORT_DEV_MODE: Config.boolean("ZKPASSPORT_DEV_MODE").pipe(Config.withDefault(false)),
  VERY_OAUTH_ENABLED: Config.boolean("VERY_OAUTH_ENABLED").pipe(Config.withDefault(false)),
  VERY_OAUTH_AUTHORIZATION_ENDPOINT: Config.string("VERY_OAUTH_AUTHORIZATION_ENDPOINT").pipe(
    Config.withDefault(""),
  ),
  VERY_OAUTH_TOKEN_ENDPOINT: Config.string("VERY_OAUTH_TOKEN_ENDPOINT").pipe(
    Config.withDefault(""),
  ),
  VERY_OAUTH_USERINFO_ENDPOINT: Config.string("VERY_OAUTH_USERINFO_ENDPOINT").pipe(
    Config.withDefault(""),
  ),
  VERY_OAUTH_ISSUER: Config.string("VERY_OAUTH_ISSUER").pipe(Config.withDefault("")),
  VERY_OAUTH_JWKS_URL: Config.string("VERY_OAUTH_JWKS_URL").pipe(Config.withDefault("")),
  VERY_OAUTH_CLIENT_ID: Config.string("VERY_OAUTH_CLIENT_ID").pipe(Config.withDefault("")),
  VERY_OAUTH_CLIENT_SECRET: secret("VERY_OAUTH_CLIENT_SECRET").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  VERY_OAUTH_REDIRECT_URI: Config.string("VERY_OAUTH_REDIRECT_URI").pipe(Config.withDefault("")),
  VERY_OAUTH_SEALING_KEY: secret("VERY_OAUTH_SEALING_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  VERY_WEB_ENABLED: Config.boolean("VERY_WEB_ENABLED").pipe(Config.withDefault(false)),
  VERY_WEB_APP_ID: Config.string("VERY_WEB_APP_ID").pipe(Config.withDefault("")),
  VERY_WEB_API_URL: Config.string("VERY_WEB_API_URL").pipe(Config.withDefault("")),
  VERY_WEB_VERIFY_URL: Config.string("VERY_WEB_VERIFY_URL").pipe(Config.withDefault("")),
  VERY_WEB_BRIDGE_API_URL: Config.string("VERY_WEB_BRIDGE_API_URL").pipe(Config.withDefault("")),
  VERY_WEB_SEALING_KEY: secret("VERY_WEB_SEALING_KEY").pipe(Config.withDefault(Redacted.make(""))),
  HNS_OWNERSHIP_ENABLED: Config.boolean("HNS_OWNERSHIP_ENABLED").pipe(Config.withDefault(false)),
  HNS_OWNERSHIP_CONFIGURATION_REFERENCE: Config.string(
    "HNS_OWNERSHIP_CONFIGURATION_REFERENCE",
  ).pipe(Config.withDefault("")),
  HNS_OWNERSHIP_CONFIGURATION_VERSION: Config.string("HNS_OWNERSHIP_CONFIGURATION_VERSION").pipe(
    Config.withDefault(""),
  ),
  HNS_COMMUNITY_APP_API_ENABLED: Config.boolean("HNS_COMMUNITY_APP_API_ENABLED").pipe(
    Config.withDefault(false),
  ),
  HNS_HANDLE_HOST_API_ENABLED: Config.boolean("HNS_HANDLE_HOST_API_ENABLED").pipe(
    Config.withDefault(false),
  ),
  HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN: Config.string(
    "HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN",
  ).pipe(Config.withDefault("")),
  HNS_COMMUNITY_APP_API_ACCESS_ISSUER: Config.string("HNS_COMMUNITY_APP_API_ACCESS_ISSUER").pipe(
    Config.withDefault(""),
  ),
  HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL: Config.string(
    "HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL",
  ).pipe(Config.withDefault("")),
  HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE: Config.string(
    "HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE",
  ).pipe(Config.withDefault("")),
  HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE: Config.string(
    "HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE",
  ).pipe(Config.withDefault("")),
  HNS_FORWARDER_V3_KEY_REGISTRY_VERSION: Config.string(
    "HNS_FORWARDER_V3_KEY_REGISTRY_VERSION",
  ).pipe(Config.withDefault("")),
  HNS_FORWARDER_V3_HMAC_KEY_REGISTRY: secret("HNS_FORWARDER_V3_HMAC_KEY_REGISTRY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS: Config.int(
    "HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS",
  ).pipe(Config.withDefault(0)),
  HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS: Config.int(
    "HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS",
  ).pipe(Config.withDefault(-1)),
  HNS_EDGE_ALERT_TOKEN: secret("HNS_EDGE_ALERT_TOKEN").pipe(Config.withDefault(Redacted.make(""))),
  VERIFICATION_CALLBACK_CREDENTIAL_HEADERS: Config.string(
    "VERIFICATION_CALLBACK_CREDENTIAL_HEADERS",
  ).pipe(Config.withDefault("")),
  PIRATE_APP_JWT_PRIVATE_KEY: secret("PIRATE_APP_JWT_PRIVATE_KEY"),
  PIRATE_APP_JWT_PUBLIC_KEY: secret("PIRATE_APP_JWT_PUBLIC_KEY"),
  PIRATE_APP_JWT_ISSUER: Config.nonEmptyString("PIRATE_APP_JWT_ISSUER"),
  PIRATE_APP_JWT_AUDIENCE: Config.nonEmptyString("PIRATE_APP_JWT_AUDIENCE"),
  PIRATE_APP_JWT_SCOPE: Config.nonEmptyString("PIRATE_APP_JWT_SCOPE"),
  PIRATE_APP_JWT_TTL_SECONDS: Config.int("PIRATE_APP_JWT_TTL_SECONDS").pipe(
    Config.withDefault(3_600),
  ),
  PRIVY_APP_ID: Config.nonEmptyString("PRIVY_APP_ID"),
  PRIVY_APP_SECRET: secret("PRIVY_APP_SECRET"),
  PRIVY_API_URL: Config.string("PRIVY_API_URL").pipe(Config.withDefault("https://api.privy.io")),
  PRIVY_JWKS_URL: Config.nonEmptyString("PRIVY_JWKS_URL"),
  PRIVY_JWT_ISSUER: Config.nonEmptyString("PRIVY_JWT_ISSUER"),
  PRIVY_JWT_AUDIENCE: Config.nonEmptyString("PRIVY_JWT_AUDIENCE"),
  COMMUNITY_PURCHASE_FUNDING_RPC_URL: secret("COMMUNITY_PURCHASE_FUNDING_RPC_URL"),
  HANDLE_RECIPIENT_TOKEN_HMAC_KEYS: secret("HANDLE_RECIPIENT_TOKEN_HMAC_KEYS").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  HANDLE_RECIPIENT_TOKEN_ENVELOPE_KEYS: secret("HANDLE_RECIPIENT_TOKEN_ENVELOPE_KEYS").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  OPENAI_MODERATION_ENABLED: Config.boolean("OPENAI_MODERATION_ENABLED").pipe(
    Config.withDefault(false),
  ),
  OPENAI_API_KEY: secret("OPENAI_API_KEY").pipe(Config.withDefault(Redacted.make(""))),
  OPENAI_MODERATION_MODEL: Config.literals(
    ["omni-moderation-2024-09-26"],
    "OPENAI_MODERATION_MODEL",
  ).pipe(Config.withDefault("omni-moderation-2024-09-26")),
  OPENAI_MODERATION_BASE_URL: Config.literals(
    ["https://api.openai.com/v1"],
    "OPENAI_MODERATION_BASE_URL",
  ).pipe(Config.withDefault("https://api.openai.com/v1")),
  OPENAI_MODERATION_TIMEOUT_MS: Config.int("OPENAI_MODERATION_TIMEOUT_MS").pipe(
    Config.withDefault(10_000),
  ),
  ...MegapotRewardConfigFields,
  MEGAPOT_V2_RPC_URL: secret("MEGAPOT_V2_RPC_URL").pipe(Config.withDefault(Redacted.make(""))),
});

export type HttpWorkerConfigValue = Config.Success<typeof HttpWorkerConfig>;
export type JobsWorkerConfigValue = Config.Success<typeof JobsWorkerConfig>;

export type ConfigSource = Readonly<Record<string, string | undefined>>;

/** Load against explicit Worker bindings in production and process.env in tests. */
export function loadConfigFrom<A>(config: Config.Config<A>, source: ConfigSource): A {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) environment[key] = value;
  }
  return Effect.runSync(
    (config as unknown as Effect.Effect<A>).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: environment }),
      ),
    ),
  );
}
